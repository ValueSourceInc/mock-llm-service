import http from 'node:http';
import { config } from './lib/config.js';
import { rollFault } from './lib/generator.js';
import { snapshot } from './lib/stats.js';
import * as openai from './lib/openai.js';
import * as anthropic from './lib/anthropic.js';

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  try {
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      return openai.handleModels(res);
    }
    if (req.method === 'GET' && url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(snapshot(), null, 2));
    }

    const isOpenAI = url === '/v1/chat/completions' || url === '/chat/completions';
    const isAnthropic = url === '/v1/messages' || url === '/messages';
    if (req.method !== 'POST' || !(isOpenAI || isAnthropic)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${url}` } }));
    }

    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'request body must be an object', type: 'invalid_request_error' } }));
    }

    // fault injection (shared logic, protocol-specific error shape)
    const fault = rollFault();
    if (fault === '429') {
      isOpenAI ? openai.sendError(429, 'rate_limit_error', 'mock rate limit', res)
               : anthropic.sendError(429, 'rate_limit_error', 'mock rate limit', res);
      return;
    }
    if (fault === '500') {
      isOpenAI ? openai.sendError(500, 'server_error', 'mock internal error', res)
               : anthropic.sendError(500, 'api_error', 'mock internal error', res);
      return;
    }
    if (fault === 'timeout') {
      const t = setTimeout(() => {
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock upstream timeout', type: 'timeout' } }));
        }
      }, config.timeoutMs);
      req.on('close', () => clearTimeout(t));
      return;
    }

    if (isOpenAI) await openai.handleChat(body, res);
    else await anthropic.handleMessages(body, res);
  } catch (err) {
    if (!res.headersSent) {
      const status = err instanceof RangeError ? 400 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message, type: status === 400 ? 'invalid_request_error' : 'server_error' } }));
    } else {
      res.end();
    }
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`mock-llm-service listening on http://localhost:${config.port}`);
  console.log(`  ttft=${config.ttftMs}ms interval=${config.tokenIntervalMs}ms tokens=${config.defaultOutputTokens} models=[${config.models.join(', ')}]`);
  const inj = config.error429Rate + config.error500Rate + config.errorTimeoutRate + config.errorRate;
  console.log(`  fault injection: ${(inj * 100).toFixed(1)}% (429=${config.error429Rate} 500=${config.error500Rate} timeout=${config.errorTimeoutRate} generic=${config.errorRate})`);
});
