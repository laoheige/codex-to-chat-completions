/**
 * Codex Responses API → Chat Completions API 转接代理
 *
 * 将 codex CLI 的 Responses API 请求转换为标准 Chat Completions 格式，
 * 转发给任意 Chat Completions 后端，再将响应转回 Responses API SSE 流式格式。
 *
 * SSE 格式严格遵循 codex-rs/codex-api/src/sse/responses.rs 的解析逻辑:
 *   event: <type>\n
 *   data: {"type":"<type>", ...其他字段}\n
 *   \n
 *
 * 关键事件:
 *   response.created         → 需要 response 字段 (至少 {})
 *   response.output_item.added → 需要 item 字段 (ResponseItem)
 *   response.output_text.delta → 需要 delta 字段
 *   response.output_item.done → 需要 item 字段 (ResponseItem)
 *   response.completed       → 需要 response 字段, 其中必须有 id
 *
 * 用法: node proxy.js
 *   配置文件: config/config.json
 *   可配置项: port, host, backend_url, backend_api_key, model_map, models, timeouts
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');


// ─── 配置加载 ────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[WARN] Failed to load config/config.json, using defaults: ${e.message}`);
    return {
      port: 57321,
      host: '127.0.0.1',
      backend_url: 'https://api.deepseek.com/v1',
      model_map: {},
      models: [{ id: 'deepseek-v4-flash', owned_by: 'deepseek' }],
      context_max_tokens: 120000,
      timeouts: {
        client_request: 30000,
        backend_request: 60000,
        backend_idle: 300000,
      }
    };
  }
}

const config = loadConfig();

// ─── 配置展开（带默认值） ──────────────────────────────────────────
const CFG = {
  port:         config.port         ?? 57321,
  host:         config.host         ?? '127.0.0.1',
  backend_url:  config.backend_url  ?? 'https://api.deepseek.com/v1',
  backend_api_key: config.backend_api_key || '',
  model_map:    config.model_map    ?? {},
  default_model: config.default_model
    || (Array.isArray(config.models) && config.models[0]?.id)
    || 'deepseek-v4-flash',
  context_max_tokens: config.context_max_tokens ?? 120000,
  timeouts: {
    client_request:  config.timeouts?.client_request  ?? 30000,
    backend_request: config.timeouts?.backend_request  ?? 60000,
    backend_idle:    config.timeouts?.backend_idle     ?? 300000,
  },
  models: Array.isArray(config.models) && config.models.length > 0
    ? config.models
    : [{ id: 'deepseek-v4-flash', owned_by: 'deepseek' }],
};

// ─── 按日分组的日志系统 ─────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, 'logs');

/** 确保日志目录存在 */
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch (e) {
      console.error(`[FATAL] 无法创建日志目录 ${LOG_DIR}: ${e.message}`);
      process.exit(1);
    }
  }
}

/** 获取今天的日志文件路径 (按日分组) */
function getLogFilePath() {
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `${dateStr}.log`);
}

/** 写入日志：同时输出到控制台和当日日志文件 */
function writeLog(level, ...args) {
  const timestamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }) + '.' + String(new Date().getMilliseconds()).padStart(3, '0');
  const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `[${timestamp}] [${level}] ${message}`;

  // 控制台输出
  if (level === 'ERROR' || level === 'FATAL') {
    console.error(line);
  } else {
    console.log(line);
  }

  // 写入文件（追加模式）
  try {
    ensureLogDir();
    fs.appendFileSync(getLogFilePath(), line + '\n', 'utf-8');
  } catch (e) {
    console.error(`[${timestamp}] [FATAL] 日志写入失败: ${e.message}`);
  }
}

const log = {
  info: (...args) => writeLog('INFO', ...args),
  warn: (...args) => writeLog('WARN', ...args),
  error: (...args) => writeLog('ERROR', ...args),
  debug: (...args) => writeLog('DEBUG', ...args),
};

// ─── Responses API → Chat Completions 转换 ─────────────────────────

/**
 * 将 Responses API 的 input 数组转换为 Chat Completions 的 messages 数组
 *
 * Responses API input 格式:
 *   [{ type: "message", role: "developer"|"user"|"assistant", content: [{type:"input_text",text:"..."}] }]
 *   [{ type: "function_call_output", call_id: "...", output: "..." }]
 *
 * Chat Completions messages 格式:
 *   [{ role: "system"|"user"|"assistant"|"tool", content: "..." }]
 */
function convertInputToMessages(input) {
  if (!Array.isArray(input)) return [];

  const messages = [];
  let pendingReasoning = ''; // 待合并的推理内容

  for (const item of input) {
    if (item.type === 'message') {
      const role = item.role === 'developer' ? 'system' : item.role;

      // content 可能是字符串或数组
      let content;
      if (typeof item.content === 'string') {
        content = item.content;
      } else if (Array.isArray(item.content)) {
        // 拼接所有 input_text 类型的内容
        const textParts = item.content
          .filter(c => c.type === 'input_text' || c.type === 'output_text')
          .map(c => c.text);
        const imageParts = item.content
          .filter(c => c.type === 'input_image')
          .map(c => ({
            type: 'image_url',
            image_url: { url: c.image_url || c.url }
          }));

        if (imageParts.length > 0) {
          content = [
            ...textParts.map(t => ({ type: 'text', text: t })),
            ...imageParts
          ];
        } else {
          content = textParts.join('\n');
        }
      } else {
        content = String(item.content || '');
      }

      messages.push({ role, content });
      pendingReasoning = ''; // user/developer 消息后清空待合并推理
    } else if (item.type === 'function_call') {
      // Responses API 的 function_call → Chat Completions 的 assistant tool_calls
      // 多个 tool_calls 必须合并到同一条 assistant 消息（DeepSeek 等后端要求）
      const newToolCall = {
        id: item.call_id,
        type: 'function',
        function: {
          name: item.name,
          arguments: fixToolCallArgs(item.arguments)
        }
      };

      // 检查前一条消息是否也是 assistant tool_calls，如果是则合并
      const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.tool_calls) {
        lastMsg.tool_calls.push(newToolCall);
        // 合并 reasoning_content
        if (pendingReasoning) {
          lastMsg.reasoning_content = lastMsg.reasoning_content
            ? lastMsg.reasoning_content + '\n' + pendingReasoning
            : pendingReasoning;
          pendingReasoning = '';
        }
      } else {
        const msg = {
          role: 'assistant',
          content: null,
          tool_calls: [newToolCall]
        };
        if (pendingReasoning) {
          msg.reasoning_content = pendingReasoning;
          pendingReasoning = '';
        }
        messages.push(msg);
      }
    } else if (item.type === 'function_call_output') {
      // Responses API 的 function_call_output → Chat Completions 的 tool role
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
      });
    } else if (item.type === 'reasoning') {
      // Responses API 的 reasoning → 存储待合并到下一条 assistant 消息
      const reasoningText = item.summary
        ? (Array.isArray(item.summary)
            ? item.summary.map(s => typeof s === 'string' ? s : (s.text || '')).join('\n')
            : String(item.summary))
        : (item.content || '');
      if (reasoningText) {
        pendingReasoning = pendingReasoning
          ? pendingReasoning + '\n' + reasoningText
          : reasoningText;
      }
    } else if (!item.type && item.role) {
      // type 缺失但有 role 的条目 — 当作 message 处理
      // codex CLI 有时发送 { role: "user", content: "..." } 而不带 type 字段
      const role = item.role === 'developer' ? 'system' : item.role;
      let content;
      if (typeof item.content === 'string') {
        content = item.content;
      } else if (Array.isArray(item.content)) {
        const textParts = item.content
          .filter(c => c.type === 'input_text' || c.type === 'output_text')
          .map(c => c.text);
        content = textParts.join('\n') || String(item.content || '');
      } else {
        content = String(item.content || '');
      }
      messages.push({ role, content });
      pendingReasoning = '';
    } else if (!item.type) {
      // 既没有 type 也没有 role，记录警告
      log.warn(`  跳过无法识别的 input 条目 (无 type/role): ${JSON.stringify(item).substring(0, 200)}`);
    }
    // 忽略其他已知类型 (web_search_call, etc.)
  }

  // 处理最后剩余的 pendingReasoning（普通 assistant 消息）
  if (pendingReasoning && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === 'assistant' && !last.tool_calls) {
      last.reasoning_content = pendingReasoning;
    }
  }

  return messages;
}

/**
 * 将 Responses API 的 tools 转换为 Chat Completions 的 tools
 */
function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;

  const result = tools
    .filter(t => t.type === 'function')
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || {},
        ...(t.strict !== undefined ? { strict: t.strict } : {})
      }
    }));

  return result.length > 0 ? result : undefined;
}

/**
 * 将 Responses API 的 tool_choice 转为 Chat Completions 的 tool_choice
 *
 * Responses API: "auto" | "none" | "required" | { type: "function", name: "foo" }
 * Chat Compl.:   "auto" | "none" | "required" | { type: "function", function: { name: "foo" } }
 */
function convertToolChoice(choice) {
  if (typeof choice === 'string') return choice;
  if (choice && choice.type === 'function' && choice.name && !choice.function) {
    return { type: 'function', function: { name: choice.name } };
  }
  return choice;
}

/**
 * 将 Responses API 请求转换为 Chat Completions 请求
 */
function convertRequest(reqBody) {
  // 模型名映射
  let model = reqBody.model || CFG.default_model;
  if (CFG.model_map[model]) {
    model = CFG.model_map[model];
  }

  const messages = convertInputToMessages(reqBody.input);

  const result = {
    model,
    messages,
    stream: true, // 始终用流式
  };

  // 工具 - 只保留 function 类型
  const tools = convertTools(reqBody.tools);
  if (tools) {
    result.tools = tools;
    if (reqBody.tool_choice !== undefined) {
      result.tool_choice = convertToolChoice(reqBody.tool_choice);
    }
  }

  // 可选参数
  if (reqBody.temperature !== undefined) result.temperature = reqBody.temperature;
  if (reqBody.top_p !== undefined) result.top_p = reqBody.top_p;
  if (reqBody.max_output_tokens !== undefined) result.max_tokens = reqBody.max_output_tokens;
  if (reqBody.presence_penalty !== undefined) result.presence_penalty = reqBody.presence_penalty;
  if (reqBody.frequency_penalty !== undefined) result.frequency_penalty = reqBody.frequency_penalty;

  // 推理参数 - 不传 reasoning_effort 给后端，让后端自行决定

  return result;
}

/**
 * 修复工具调用的 arguments 字符串。
 */
function fixToolCallArgs(args) {
  if (!args || typeof args !== 'string') return '{}';
  const trimmed = args.trim();
  if (!trimmed) return '{}';
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return JSON.stringify({ value: typeof parsed === 'string' ? parsed : JSON.stringify(parsed) });
    }
    return trimmed;
  } catch (e) {
    return JSON.stringify({ value: trimmed });
  }
}

/**
 * 修复 tool_call 对象上的 arguments 字段（原地修改）
 */
function fixToolCallArguments(tc) {
  if (!tc) return;
  tc.arguments = fixToolCallArgs(tc.arguments);
}

// ─── Chat Completions → Responses API SSE 转换 ─────────────────────

/**
 * 创建一个 per-stream 的 SSE 发送器。
 * sequence_number 是按 Responses API 协议每个响应从 1 开始递增的字段，
 * 必须每个并发请求独立计数 —— 不能用模块级全局变量，否则并发请求互相污染。
 */
function makeSender(res) {
  let seq = 0;
  return function send(eventType, data) {
    seq++;
    const payload = { type: eventType, sequence_number: seq, ...data };
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    log.debug(`  SSE → event=${eventType} seq=${seq}`);
    try {
      if (!res.writableEnded && !res.destroyed) {
        res.write(msg);
      }
    } catch (e) {
      log.warn(`  SSE 写入失败 (${eventType}): ${e.message}`);
    }
  };
}

/**
 * 将 Chat Completions 的 SSE 流转换为 Responses API 的 SSE 流
 *
 * 设计要点（修复了若干 bug）：
 *  1. 三类 output_item（reasoning / message / function_call）懒创建，
 *     谁先来谁就占小 output_index，避免事件流与 response.completed.output 不一致。
 *  2. 每个 item 把自己的 output_index 存进 state，done 事件直接复用，
 *     不再用 `outputItemCount - toolCalls.size + idx` 这种脆弱算式。
 *  3. tool_call 的 name **不累加**：部分后端会在多个 chunk 中重复发完整名，
 *     用 += 会得到 `exec_commandexec_command` 导致 codex 报 "unsupported call"。
 *  4. tool_call 的真 id 后到时回填，确保所有 SSE 事件 item_id 一致。
 *  5. output_item.added 中 name/arguments 一律置空，全部走 delta + done。
 */
function convertSSEStream(backendRes, clientRes) {
  const responseId = 'resp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  const msgId = 'msg_' + Date.now();
  const reasoningId = 'rs_' + Date.now();

  // 懒创建的三类 item 状态
  let nextOutputIndex = 0;
  let reasoningState = null;   // { outputIndex, fullText }
  let messageState = null;     // { outputIndex, fullText }
  const toolCalls = new Map(); // idx → { outputIndex, id, name, arguments, idLocked }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let buffer = '';
  let finished = false;

  // per-stream 的 SSE 发送器（独立的 sequence_number 计数器）
  const sse = makeSender(clientRes);

  // ── response.created ──
  sse('response.created', {
    response: {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: CFG.default_model,
      status: 'in_progress',
      output: []
    }
  });

  // ── 处理后端 SSE 流 ──
  backendRes.on('data', (chunk) => {
    if (finished) return;
    resetIdleTimer();
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 保留最后的不完整行

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const data = trimmed.slice(6);
      if (data === '[DONE]') {
        doFinish();
        return;
      }

      try {
        handleChunk(JSON.parse(data));
      } catch (e) {
        log.warn('SSE 解析错误:', e.message, 'data:', data.substring(0, 200));
      }
    }
  });

  backendRes.on('end', () => {
    clearTimeout(idleTimer);
    if (finished) return;
    if (buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6);
      if (data !== '[DONE]') {
        try { handleChunk(JSON.parse(data)); } catch {}
      }
    }
    doFinish();
  });

  backendRes.on('error', (err) => {
    clearTimeout(idleTimer);
    log.error('后端连接错误:', err.message);
    if (!finished) doFinish();
  });

  // 后端流空闲超时：90 秒没有新 chunk 就强制收尾，防止请求泄漏
  let idleTimer;
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (finished) return;
      log.warn('后端流空闲超时 (90s)，强制结束');
      try { backendRes.destroy(); } catch {}
      doFinish();
    }, CFG.timeouts.backend_idle); // 5分钟空闲超时，适应长推理场景
  }
  resetIdleTimer();

  // ── 懒创建：reasoning item ──
  function ensureReasoningStarted() {
    if (reasoningState) return;
    reasoningState = { outputIndex: nextOutputIndex++, fullText: '' };
    sse('response.output_item.added', {
      output_index: reasoningState.outputIndex,
      item: {
        type: 'reasoning',
        id: reasoningId,
        summary: [],
        encrypted_content: null
      }
    });
    sse('response.reasoning_summary_part.added', {
      output_index: reasoningState.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' }
    });
  }

  // ── 懒创建：message item ──
  function ensureMessageStarted() {
    if (messageState) return;
    messageState = { outputIndex: nextOutputIndex++, fullText: '' };
    sse('response.output_item.added', {
      output_index: messageState.outputIndex,
      item: {
        type: 'message',
        id: msgId,
        status: 'in_progress',
        role: 'assistant',
        content: []
      }
    });
    sse('response.content_part.added', {
      output_index: messageState.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    });
  }

  // ── 懒创建：function_call item ──
  function ensureToolCall(idx, incomingId) {
    let tc = toolCalls.get(idx);
    if (tc) {
      // 先用 fake id 起的，真 id 后到时回填 + 标记锁定
      if (incomingId && !tc.idLocked) {
        tc.id = incomingId;
        tc.idLocked = true;
      }
      return tc;
    }
    const callId = incomingId || `call_${idx}`;
    tc = {
      outputIndex: nextOutputIndex++,
      id: callId,
      idLocked: !!incomingId,
      name: '',
      arguments: ''
    };
    toolCalls.set(idx, tc);
    sse('response.output_item.added', {
      output_index: tc.outputIndex,
      item: {
        type: 'function_call',
        id: callId,
        call_id: callId,
        name: '',         // 全部交给 done 事件
        arguments: '',    // 全部交给 delta 累积
        status: 'in_progress'
      }
    });
    return tc;
  }

  function handleChunk(chunk) {
    // usage 可能出现在最后一个空 choices 的 chunk 中
    if (chunk.usage) {
      totalInputTokens = chunk.usage.prompt_tokens ?? totalInputTokens;
      totalOutputTokens = chunk.usage.completion_tokens ?? totalOutputTokens;
      totalReasoningTokens =
        chunk.usage.completion_tokens_details?.reasoning_tokens ?? totalReasoningTokens;
    }

    if (!chunk.choices || chunk.choices.length === 0) return;
    const choice = chunk.choices[0];
    if (!choice.delta) return;

    // 推理增量
    const reasoningDelta = choice.delta.reasoning || choice.delta.reasoning_content;
    if (reasoningDelta) {
      ensureReasoningStarted();
      reasoningState.fullText += reasoningDelta;
      sse('response.reasoning_summary_text.delta', {
        output_index: reasoningState.outputIndex,
        summary_index: 0,
        delta: reasoningDelta
      });
    }

    // 文本增量
    if (choice.delta.content) {
      ensureMessageStarted();
      messageState.fullText += choice.delta.content;
      sse('response.output_text.delta', {
        output_index: messageState.outputIndex,
        content_index: 0,
        delta: choice.delta.content
      });
    }

    // 工具调用增量
    if (Array.isArray(choice.delta.tool_calls)) {
      for (const dtc of choice.delta.tool_calls) {
        const idx = (typeof dtc.index === 'number') ? dtc.index : 0;
        const tc = ensureToolCall(idx, dtc.id);

        // name: 只取一次（部分后端会在每个 chunk 重发完整 name，必须去重）
        if (dtc.function?.name && !tc.name) {
          tc.name = dtc.function.name;
        }

        // arguments: 真正的增量字段，按片段拼接
        const argDelta = dtc.function?.arguments;
        if (argDelta) {
          tc.arguments += argDelta;
          sse('response.function_call_arguments.delta', {
            output_index: tc.outputIndex,
            item_id: tc.id,
            delta: argDelta
          });
        }
      }
    }
  }

  function doFinish() {
    if (finished) return;
    finished = true;

    const reasoningLen = reasoningState ? reasoningState.fullText.length : 0;
    const messageLen = messageState ? messageState.fullText.length : 0;
    log.info(`  流结束, 文本长度=${messageLen}, 推理长度=${reasoningLen}, 工具调用数=${toolCalls.size}`);

    // ── 闭合 reasoning ──
    if (reasoningState) {
      sse('response.reasoning_summary_text.done', {
        output_index: reasoningState.outputIndex,
        summary_index: 0,
        text: reasoningState.fullText
      });
      sse('response.reasoning_summary_part.done', {
        output_index: reasoningState.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: reasoningState.fullText }
      });
      sse('response.output_item.done', {
        output_index: reasoningState.outputIndex,
        item: {
          type: 'reasoning',
          id: reasoningId,
          summary: [{ type: 'summary_text', text: reasoningState.fullText }],
          encrypted_content: null
        }
      });
    }

    // ── 闭合 message ──
    if (messageState) {
      sse('response.content_part.done', {
        output_index: messageState.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: "", annotations: [] }
      });
      sse('response.output_text.done', {
        output_index: messageState.outputIndex,
        content_index: 0,
        text: messageState.fullText
      });
      sse('response.output_item.done', {
        output_index: messageState.outputIndex,
        item: {
          type: 'message',
          id: msgId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: messageState.fullText, annotations: [] }]
        }
      });
    }

    // ── 修复 tool_call arguments 后再闭合 ──
    for (const [, tc] of toolCalls) {
      fixToolCallArguments(tc);
      sse('response.function_call_arguments.done', {
        output_index: tc.outputIndex,
        item_id: tc.id,
        arguments: tc.arguments
      });
      sse('response.output_item.done', {
        output_index: tc.outputIndex,
        item: {
          type: 'function_call',
          id: tc.id,
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: 'completed'
        }
      });
    }

    // ── response.completed：output 顺序与流事件严格一致 ──
    const outputItems = [];
    const orderedItems = [];
    if (reasoningState) orderedItems.push({ outputIndex: reasoningState.outputIndex, kind: 'reasoning' });
    if (messageState) orderedItems.push({ outputIndex: messageState.outputIndex, kind: 'message' });
    for (const [, tc] of toolCalls) {
      orderedItems.push({ outputIndex: tc.outputIndex, kind: 'tool', tc });
    }
    orderedItems.sort((a, b) => a.outputIndex - b.outputIndex);

    for (const it of orderedItems) {
      if (it.kind === 'reasoning') {
        outputItems.push({
          type: 'reasoning',
          id: reasoningId,
          summary: [{ type: 'summary_text', text: reasoningState.fullText }],
          encrypted_content: null
        });
      } else if (it.kind === 'message') {
        outputItems.push({
          type: 'message',
          id: msgId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: messageState.fullText, annotations: [] }]
        });
      } else if (it.kind === 'tool') {
        outputItems.push({
          type: 'function_call',
          id: it.tc.id,
          call_id: it.tc.id,
          name: it.tc.name,
          arguments: it.tc.arguments,
          status: 'completed'
        });
      }
    }

    sse('response.completed', {
      response: {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: CFG.default_model,
        status: 'completed',
        output: outputItems,
        usage: {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          output_tokens_details: { reasoning_tokens: totalReasoningTokens },
          total_tokens: totalInputTokens + totalOutputTokens + totalReasoningTokens
        }
      }
    });

    try {
      if (!clientRes.writableEnded) clientRes.end();
    } catch (e) {
      log.warn(`关闭连接时出错: ${e.message}`);
    }
    log.debug('  SSE 流已关闭');
  }
}

// ─── 全局错误处理（防止进程崩溃）─────────────────────────────────────
process.on('uncaughtException', (err) => {
  log.error('未捕获的异常:', err.message, err.stack || '');
  // 不要退出进程，让服务器继续运行
});

process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝:', reason instanceof Error ? reason.message : String(reason));
});

// ─── HTTP 代理服务器 ─────────────────────────────────────────────────

const server = http.createServer((clientReq, clientRes) => {
  log.info(`${clientReq.method} ${clientReq.url}`);

  // 禁用 Nagle 算法，确保 SSE 数据即时推送，不缓冲
  clientReq.socket?.setNoDelay(true);

  // 设置客户端请求超时（30 秒无数据则断开）
  clientReq.setTimeout(CFG.timeouts.client_request, () => {
    log.warn(`客户端请求超时: ${clientReq.url}`);
    clientReq.destroy();
    if (!clientRes.headersSent) {
      clientRes.writeHead(408, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { message: 'Request timeout', type: 'timeout_error' } }));
    }
  });

  // 客户端请求错误时记录日志（不主动关闭，防止误判）
  clientReq.on('error', (err) => {
    log.warn(`客户端连接错误: ${err.message}`);
  });

  // ── /v1/responses — 核心转换路由 ──
  if (clientReq.url === '/v1/responses' && clientReq.method === 'POST') {
    let body = '';
    clientReq.on('data', chunk => { body += chunk; });
    clientReq.on('end', () => {
      let reqBody;
      try {
        reqBody = JSON.parse(body);
      } catch (e) {
        clientRes.writeHead(400, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
        return;
      }

      log.info(`  模型: ${reqBody.model}, 消息数: ${reqBody.input?.length || 0}, 工具数: ${reqBody.tools?.length || 0}`);
      if (reqBody.input) {
        for (const item of reqBody.input) {
          if (item.type) {
            log.debug(`    input: type=${item.type} role=${item.role || '-'} call_id=${item.call_id || '-'}`);
          } else {
            // type 缺失时打印更多信息以便调试
            log.warn(`    input: type=undefined role=${item.role || '-'} call_id=${item.call_id || '-'} keys=${Object.keys(item).join(',')} content_preview=${JSON.stringify(item.content || item.text || item.output || '').substring(0, 100)}`);
          }
        }
      }

      // 转换请求
      const chatReq = convertRequest(reqBody);

      // 安全检查：messages 为空则返回错误，避免后端 400
      if (!chatReq.messages || chatReq.messages.length === 0) {
        log.warn('  转换后 messages 为空，可能是 input 条目类型不被识别');
        log.warn(`  原始 input 类型列表: ${(reqBody.input || []).map(i => i.type || 'undefined').join(', ')}`);
        clientRes.writeHead(400, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({
          error: {
            message: 'No valid messages after conversion. Input types: ' + (reqBody.input || []).map(i => i.type || 'undefined').join(', '),
            type: 'invalid_request_error',
            code: 'empty_messages'
          }
        }));
        return;
      }

      log.info(`  → 转换后: model=${chatReq.model}, messages=${chatReq.messages?.length}, tools=${chatReq.tools?.length || 0}`);
      for (const msg of chatReq.messages) {
        const preview = typeof msg.content === 'string'
          ? msg.content.substring(0, 80).replace(/\n/g, '\\n')
          : JSON.stringify(msg.content)?.substring(0, 80);
        log.debug(`    msg: role=${msg.role} content="${preview}..."`);
      }

      // 发送到后端
      function sendRequest(msgs) {
        chatReq.messages = msgs;
        const backendUrl = new URL('/v1/chat/completions', CFG.backend_url);
        const postData = JSON.stringify(chatReq);
        log.info(`  → 发送到后端: ${backendUrl.href}, 数据长度: ${postData.length}, 消息数: ${msgs.length}`);

        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'Connection': 'close', // 禁用 keep-alive，避免后端 HPE 解析错误
          };
          if (CFG.backend_api_key) {
            headers['Authorization'] = `Bearer ${CFG.backend_api_key}`;
          }
          const options = {
            hostname: backendUrl.hostname,
            port: backendUrl.port || (backendUrl.protocol === 'https:' ? 443 : 80),
            path: backendUrl.pathname,
            method: 'POST',
            headers,
            agent: false, // 每个请求独立连接，避免连接复用导致响应头错乱
          };

        const httpModule = backendUrl.protocol === 'https:' ? https : http;
        let responded = false; // 防止重复响应

        const backendReq = httpModule.request(options, (backendRes) => {
          if (responded) {
            // 已经用 502 响应了客户端，drain 掉后端残余数据防止内存泄漏
            backendRes.resume();
            return;
          } // 已在 error 中处理过
          log.info(`  ← 后端状态: ${backendRes.statusCode}`);

          if (backendRes.statusCode !== 200) {
            let errBody = '';
            backendRes.on('data', c => { errBody += c; });
            backendRes.on('end', () => {
              if (responded) return;

              responded = true;
              log.error(`  ← 后端错误响应: ${errBody.substring(0, 500)}`);
              if (!clientRes.headersSent) {
                clientRes.writeHead(backendRes.statusCode, { 'Content-Type': 'application/json' });
                clientRes.end(errBody);
              }
            });
            return;
          }

          // 始终按流式处理
          responded = true;
          if (clientRes.destroyed || clientRes.writableEnded || clientRes.headersSent) {
            log.warn('客户端连接已不可写，跳过 SSE 响应');
            backendRes.resume(); // drain 后端数据
            return;
          }
          // SSE 建立后清掉请求超时，否则长推理会被误杀
          clientReq.setTimeout(0);
          backendReq.setTimeout(0); // 同步禁用后端超时，防止60s后强制destroy
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
          convertSSEStream(backendRes, clientRes);
        });

        backendReq.on('error', (err) => {
          if (responded) return;
          responded = true;
          log.error(`  ← 后端连接失败: ${err.message}`, err.code || '');
          if (!clientRes.destroyed && !clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({ error: { message: `后端连接失败: ${err.message}`, type: 'backend_error' } }));
          }
        });

        // 后端响应流本身也可能出错（如 HPE 解析错误后收到的数据）
        backendReq.on('response', (incoming) => {
          incoming.on('error', (streamErr) => {
            if (responded) return;
            responded = true;
            log.error(`  ← 后端响应流错误: ${streamErr.message}`);
            if (!clientRes.destroyed && !clientRes.headersSent) {
              clientRes.writeHead(502, { 'Content-Type': 'application/json' });
              clientRes.end(JSON.stringify({ error: { message: `后端响应异常: ${streamErr.message}`, type: 'backend_error' } }));
            }
          });
        });

        backendReq.on('timeout', () => {
          log.error('  ← 后端请求超时 (60s)');
          backendReq.destroy();
        });

        backendReq.setTimeout(CFG.timeouts.backend_request); // 60秒超时

        backendReq.write(postData);
        backendReq.end();
      }

      // 首次发送（完整上下文）
      sendRequest(chatReq.messages);
    });
    return;
  }

  // ── /v1/chat/completions — 直接转发 ──
  if (clientReq.url === '/v1/chat/completions' && clientReq.method === 'POST') {
    let body = '';
    clientReq.on('data', chunk => { body += chunk; });
    clientReq.on('end', () => {
      const backendUrl = new URL('/v1/chat/completions', CFG.backend_url);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'close',
      };
      if (CFG.backend_api_key) {
        headers['Authorization'] = `Bearer ${CFG.backend_api_key}`;
      }
      const options = {
        hostname: backendUrl.hostname,
        port: backendUrl.port || (backendUrl.protocol === 'https:' ? 443 : 80),
        path: backendUrl.pathname,
        method: 'POST',
        headers,
        agent: false,
      };
      const backendReq = http.request(options, (backendRes) => {
        clientRes.writeHead(backendRes.statusCode, backendRes.headers);
        backendRes.pipe(clientRes);
      });
      backendReq.on('error', (err) => {
        log.error(`聊天转发后端连接失败: ${err.message}`);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ error: { message: err.message } }));
        }
      });
      backendReq.setTimeout(CFG.timeouts.client_request, () => {
        log.error('聊天转发后端请求超时');
        backendReq.destroy();
      });
      backendReq.write(body);
      backendReq.end();
    });
    return;
  }

  // ── /v1/models — 返回模型列表 ──
  if (clientReq.url === '/v1/models' || clientReq.url.startsWith('/v1/models?')) {
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      object: 'list',
      data: CFG.models.map(m => ({ id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.owned_by || 'unknown' }))
    }));
    return;
  }

  // ── 健康检查 ──
  if (clientReq.url === '/' || clientReq.url === '/health') {
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      status: 'ok',
      proxy: 'codex-responses-proxy',
      backend: CFG.backend_url,
      port: CFG.port,
      log_dir: LOG_DIR
    }));
    return;
  }

  // ── 404 ──
  if (!clientRes.headersSent) {
    clientRes.writeHead(404, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: { message: `Not found: ${clientReq.url}`, type: 'not_found' } }));
  }
});

// ─── 优雅关闭 ──────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  log.info(`收到 ${signal} 信号，正在关闭服务器...`);
  server.close(() => {
    log.info('服务器已关闭');
    process.exit(0);
  });
  // 5 秒后强制退出
  setTimeout(() => {
    log.warn('强制退出');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ─── 启动服务器 ──────────────────────────────────────────────────────────
function startServer() {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`端口 ${CFG.port} 已被占用，请检查是否有其他进程在监听该端口`);
      log.info('提示: 可以使用不同端口启动，如: node proxy.js 57322');
      process.exit(1);
    } else if (err.code === 'EACCES') {
      log.error(`没有权限监听端口 ${CFG.port}，请使用更高端口或以管理员身份运行`);
      process.exit(1);
    } else {
      log.error(`服务器启动失败: ${err.message}`);
      process.exit(1);
    }
  });

  // 所有新连接禁用 Nagle 算法（SSE 流式输出必须即时推送）
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  server.listen(CFG.port, CFG.host, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   Codex Responses API → Chat Completions 转接代理       ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║   监听:    http://${CFG.host}:${CFG.port}                      ║`);
    console.log(`║   后端:    ${CFG.backend_url.padEnd(44)}║`);
    console.log(`║   日志:    ${LOG_DIR.padEnd(47)}║`);
    console.log('║                                                          ║');
    console.log('║   路由:                                                  ║');
    console.log('║     POST /v1/responses        → 转换后转发              ║');
    console.log('║     POST /v1/chat/completions → 直接转发                ║');
    console.log('║     GET  /v1/models           → 返回模型列表            ║');
    console.log('║     GET  /health              → 健康检查                ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    log.info('代理已就绪，等待 codex 连接...');
  });
}

startServer();
