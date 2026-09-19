// Anthropic-compatible: POST /v1/messages (stream + non-stream)
import { config } from './config.js';
import { generateText, tokenizeForStream, estimateTokens, extractPrompt, sleep } from './generator.js';
import { recordStart, recordEnd } from './stats.js';

function msgId() {
  return 'msg_mock_' + Math.random().toString(36).slice(2, 14);
}

function sse(event, obj) {
  return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
}

export async function handleMessages(body, res, ov) {
  const model = body.model || 'mock-claude-sonnet';
  const stream = body.stream === true;
  const fault = ov.fault; // one of ok | disconnect | pause | heartbeat | error_event (429/500/timeout handled upstream)
  // token 上限取值链同 openai.js: max_tokens 是标准字段,能穿透 new-api relay
  const targetTokens = body.mock_max_tokens ?? body.max_tokens ?? body.max_completion_tokens ?? config.defaultOutputTokens;
  if (body.model !== undefined && typeof body.model !== 'string') throw new RangeError('model must be a string');
  if (body.mock_max_tokens !== undefined && (!Number.isInteger(body.mock_max_tokens) || body.mock_max_tokens < 1 || body.mock_max_tokens > config.maxOutputTokens)) throw new RangeError(`mock_max_tokens must be an integer from 1 to ${config.maxOutputTokens}`);
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > config.maxOutputTokens)) throw new RangeError(`max_tokens must be an integer from 1 to ${config.maxOutputTokens}`);
  recordStart(model);

  let bytesOut = 0;
  const finish = (ok, errorType, ttftMs, totalMs, outTokens) =>
    recordEnd(model, { ok, errorType, ttftMs, totalMs, outputTokens: outTokens, bytes: bytesOut });

  const text = generateText(targetTokens, extractPrompt(body).slice(0, 80));
  const chunks = tokenizeForStream(text);
  const promptTokens = estimateTokens(extractPrompt(body));
  const outTokens = estimateTokens(text);

  if (!stream) {
    if (fault === 'disconnect') {
      res.on('close', () => finish(false, 'disconnect'));
      res.socket?.destroy();
      return;
    }
    if (fault === 'error_event' || fault === 'heartbeat') {
      const payload = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mock mid-stream failure' } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      bytesOut = payload.length;
      res.end(payload);
      finish(false, fault === 'heartbeat' ? 'heartbeat' : 'error_event');
      return;
    }
    const totalMs = ov.ttftMs + chunks.length * ov.intervalMs;
    await sleep(totalMs);
    const payload = {
      id: msgId(), type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: promptTokens, output_tokens: outTokens },
    };
    const body_ = JSON.stringify(payload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    bytesOut = body_.length;
    res.end(body_);
    finish(true, null, ov.ttftMs, totalMs, outTokens);
    return;
  }

  // ---- streaming ----
  let closed = false;
  res.on('close', () => { closed = true; });
  const write = s => { bytesOut += s.length; res.write(s); };
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const id = msgId();
  const t0 = Date.now();
  write(sse('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: promptTokens, output_tokens: 0 } },
  }));

  if (fault === 'heartbeat') {
    // SSE comments only, no content events, then end without message_stop
    const deadline = Date.now() + config.heartbeatMs;
    while (Date.now() < deadline) {
      if (closed) return finish(false, 'client_abort');
      write(`: ping\n\n`);
      await sleep(config.heartbeatIntervalMs);
    }
    res.end();
    finish(false, 'heartbeat');
    return;
  }

  await sleep(ov.ttftMs);
  const ttft = ov.ttftMs;
  write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));

  const cutAt = fault === 'disconnect' || fault === 'error_event'
    ? Math.max(1, Math.floor(chunks.length * 0.3))
    : chunks.length;
  const pauseAt = fault === 'pause' ? Math.max(1, Math.floor(chunks.length * 0.4)) : -1;

  for (let i = 0; i < cutAt; i++) {
    if (closed) return finish(false, 'client_abort', ttft, Date.now() - t0 + ttft);
    write(sse('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunks[i] + ' ' },
    }));
    await sleep(ov.intervalMs);
    if (i + 1 === pauseAt) await sleep(config.pauseMs); // mid-stream stall, then resume
  }

  if (fault === 'disconnect') {
    res.destroy();
    finish(false, 'disconnect', ttft, Date.now() - t0 + ttft);
    return;
  }
  if (fault === 'error_event') {
    write(sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'mock mid-stream error' } }));
    res.end();
    finish(false, 'error_event', ttft, Date.now() - t0 + ttft);
    return;
  }

  write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
  write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outTokens } }));
  write(sse('message_stop', { type: 'message_stop' }));
  res.end();
  finish(true, null, ttft, Date.now() - t0 + ttft, outTokens);
}

export function sendError(status, type, message, res) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}
