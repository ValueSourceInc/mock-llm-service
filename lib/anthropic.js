// Anthropic-compatible: POST /v1/messages (stream + non-stream)
import { config } from './config.js';
import { generateText, tokenizeForStream, estimateTokens, extractPrompt, sleep } from './generator.js';
import { recordStart, recordEnd } from './stats.js';

function msgId() {
  return 'msg_mock_' + Math.random().toString(36).slice(2, 14);
}

export async function handleMessages(body, res) {
  const model = body.model || 'mock-claude-sonnet';
  const stream = body.stream === true;
  const targetTokens = body.mock_max_tokens ?? (body.max_tokens && body.max_tokens < config.defaultOutputTokens ? body.max_tokens : config.defaultOutputTokens);
  if (body.model !== undefined && typeof body.model !== 'string') throw new RangeError('model must be a string');
  if (body.mock_max_tokens !== undefined && (!Number.isInteger(body.mock_max_tokens) || body.mock_max_tokens < 1 || body.mock_max_tokens > config.maxOutputTokens)) throw new RangeError(`mock_max_tokens must be an integer from 1 to ${config.maxOutputTokens}`);
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > config.maxOutputTokens)) throw new RangeError(`max_tokens must be an integer from 1 to ${config.maxOutputTokens}`);
  recordStart(model);

  const finish = (ok, ttftMs, totalMs, outTokens) =>
    recordEnd(model, { ok, ttftMs, totalMs, outputTokens: outTokens });

  const text = generateText(targetTokens, extractPrompt(body).slice(0, 80));
  const chunks = tokenizeForStream(text);

  if (stream) {
    let closed = false;
    res.on('close', () => { closed = true; });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const id = msgId();
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } },
    })}\n\n`);
    await sleep(config.ttftMs);
    const ttft = config.ttftMs;
    const t0 = Date.now();
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
    for (const chunk of chunks) {
      if (closed) return finish(false, ttft, Date.now() - t0 + ttft, 0);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk + ' ' },
      })}\n\n`);
      await sleep(config.tokenIntervalMs);
    }
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
    const outTokens = estimateTokens(text);
    res.write(`event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outTokens },
    })}\n\n`);
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    res.end();
    finish(true, ttft, Date.now() - t0 + ttft, outTokens);
  } else {
    await sleep(config.ttftMs + chunks.length * config.tokenIntervalMs);
    const outTokens = estimateTokens(text);
    const payload = {
      id: msgId(), type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: estimateTokens(extractPrompt(body)), output_tokens: outTokens },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    finish(true, config.ttftMs, config.ttftMs + chunks.length * config.tokenIntervalMs, outTokens);
  }
}

export function sendError(status, type, message, res) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}
