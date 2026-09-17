// OpenAI-compatible: POST /v1/chat/completions, GET /v1/models
import { config } from './config.js';
import { generateText, tokenizeForStream, estimateTokens, extractPrompt, sleep } from './generator.js';
import { recordStart, recordEnd } from './stats.js';

export function handleModels(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: config.models.map(id => ({ id, object: 'model', owned_by: 'mock' })) }));
}

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function handleChat(body, res, ov) {
  const model = body.model || 'mock-gpt-4o';
  const stream = body.stream === true;
  const fault = ov.fault; // one of ok | disconnect | pause | heartbeat | error_event (429/500/timeout handled upstream)
  // request-level override of output length (leave out of forwarded JSON)
  const targetTokens = body.mock_max_tokens ?? config.defaultOutputTokens;
  if (body.model !== undefined && typeof body.model !== 'string') throw new RangeError('model must be a string');
  if (body.mock_max_tokens !== undefined && (!Number.isInteger(targetTokens) || targetTokens < 1 || targetTokens > config.maxOutputTokens)) throw new RangeError(`mock_max_tokens must be an integer from 1 to ${config.maxOutputTokens}`);
  recordStart(model);

  let bytesOut = 0;
  const finish = (ok, errorType, ttftMs, totalMs, outTokens) =>
    recordEnd(model, { ok, errorType, ttftMs, totalMs, outputTokens: outTokens, bytes: bytesOut });

  const text = generateText(targetTokens, extractPrompt(body).slice(0, 80));
  const chunks = tokenizeForStream(text);
  const promptTokens = estimateTokens(extractPrompt(body));
  const outTokens = estimateTokens(text);

  if (!stream) {
    // non-stream fault shapes
    if (fault === 'disconnect') {
      // connection reset before any response bytes
      res.on('close', () => finish(false, 'disconnect'));
      res.socket?.destroy();
      return;
    }
    if (fault === 'error_event' || fault === 'heartbeat') {
      // 200 with an error object in the body (no valid completion)
      const payload = JSON.stringify({ error: { message: 'mock mid-stream failure', type: 'server_error', code: 'mock_error_event' } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      bytesOut = payload.length;
      res.end(payload);
      finish(false, fault === 'heartbeat' ? 'heartbeat' : 'error_event');
      return;
    }
    const totalMs = ov.ttftMs + chunks.length * ov.intervalMs;
    await sleep(totalMs);
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: outTokens,
      total_tokens: promptTokens + outTokens,
    };
    const payload = {
      id: 'chatcmpl-mock-' + Math.random().toString(36).slice(2, 10),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage,
    };
    const body_ = JSON.stringify(payload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    bytesOut = body_.length;
    res.end(body_);
    finish(true, null, ov.ttftMs, totalMs, usage.completion_tokens);
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
  const id = 'chatcmpl-mock-' + Math.random().toString(36).slice(2, 10);
  const t0 = Date.now();
  const emitChunk = (delta, finishReason = null) =>
    write(sse({
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }));

  if (fault === 'heartbeat') {
    // SSE comments only, no content, then end without [DONE]
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
  emitChunk({ role: 'assistant' });
  const ttft = ov.ttftMs;

  const cutAt = fault === 'disconnect' || fault === 'error_event'
    ? Math.max(1, Math.floor(chunks.length * 0.3))
    : chunks.length;
  const pauseAt = fault === 'pause' ? Math.max(1, Math.floor(chunks.length * 0.4)) : -1;

  for (let i = 0; i < cutAt; i++) {
    if (closed) return finish(false, 'client_abort', ttft, Date.now() - t0 + ttft);
    emitChunk({ content: chunks[i] + ' ' });
    await sleep(ov.intervalMs);
    if (i + 1 === pauseAt) await sleep(config.pauseMs); // mid-stream stall, then resume
  }

  if (fault === 'disconnect') {
    // partial output, then the connection dies — no end marker
    res.destroy();
    finish(false, 'disconnect', ttft, Date.now() - t0 + ttft);
    return;
  }
  if (fault === 'error_event') {
    // protocol error event mid-stream, no [DONE]
    write(sse({ error: { message: 'mock mid-stream error', type: 'server_error', code: 'mock_error_event' } }));
    res.end();
    finish(false, 'error_event', ttft, Date.now() - t0 + ttft);
    return;
  }

  emitChunk({}, 'stop');
  if (body.stream_options?.include_usage === true || body.stream_options === true) {
    write(sse({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: outTokens, total_tokens: promptTokens + outTokens } }));
  }
  write('data: [DONE]\n\n');
  res.end();
  finish(true, null, ttft, Date.now() - t0 + ttft, outTokens);
}

export function sendError(status, code, message, res) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: code, code } }));
}
