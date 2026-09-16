// OpenAI-compatible: POST /v1/chat/completions, GET /v1/models
import { config } from './config.js';
import { generateText, tokenizeForStream, estimateTokens, extractPrompt, sleep } from './generator.js';
import { recordStart, recordEnd } from './stats.js';

export function handleModels(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: config.models.map(id => ({ id, object: 'model', owned_by: 'mock' })) }));
}

export async function handleChat(body, res) {
  const model = body.model || 'mock-gpt-4o';
  const stream = body.stream === true;
  // request-level override of output length (leave out of forwarded JSON)
  const targetTokens = body.mock_max_tokens ?? config.defaultOutputTokens;
  if (body.model !== undefined && typeof body.model !== 'string') throw new RangeError('model must be a string');
  if (body.mock_max_tokens !== undefined && (!Number.isInteger(targetTokens) || targetTokens < 1 || targetTokens > config.maxOutputTokens)) throw new RangeError(`mock_max_tokens must be an integer from 1 to ${config.maxOutputTokens}`);
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
    await sleep(config.ttftMs);
    const ttft = config.ttftMs;
    const t0 = Date.now();
    for (const chunk of chunks) {
      if (closed) return finish(false, ttft, Date.now() - t0 + ttft, 0);
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-mock-' + Math.random().toString(36).slice(2, 10),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: chunk + ' ' }, finish_reason: null }],
      })}\n\n`);
      await sleep(config.tokenIntervalMs);
    }
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    finish(true, ttft, Date.now() - t0 + ttft, estimateTokens(text));
  } else {
    await sleep(config.ttftMs + chunks.length * config.tokenIntervalMs);
    const usage = {
      prompt_tokens: estimateTokens(extractPrompt(body)),
      completion_tokens: estimateTokens(text),
      total_tokens: 0,
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const payload = {
      id: 'chatcmpl-mock-' + Math.random().toString(36).slice(2, 10),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    finish(true, config.ttftMs, config.ttftMs + chunks.length * config.tokenIntervalMs, usage.completion_tokens);
  }
}

export function sendError(status, code, message, res) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: code, code } }));
}
