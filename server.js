import http from 'node:http';
import { config } from './lib/config.js';
import { rollFault, requestOverrides } from './lib/generator.js';
import { snapshot, recordStart, recordEnd } from './lib/stats.js';
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
    // body.mock_fault forces a kind; otherwise roll the configured probabilities
    const ov = requestOverrides(body);
    const fault = ov.fault ?? rollFault();
    const faultModel = typeof body.model === 'string' ? body.model : 'unknown';
    if (fault === '429') {
      recordStart(faultModel);
      isOpenAI ? openai.sendError(429, 'rate_limit_error', 'mock rate limit', res)
               : anthropic.sendError(429, 'rate_limit_error', 'mock rate limit', res);
      recordEnd(faultModel, { ok: false, errorType: 'rate_limit' });
      return;
    }
    if (fault === '500') {
      recordStart(faultModel);
      isOpenAI ? openai.sendError(500, 'server_error', 'mock internal error', res)
               : anthropic.sendError(500, 'api_error', 'mock internal error', res);
      recordEnd(faultModel, { ok: false, errorType: 'server_error' });
      return;
    }
    if (fault === 'timeout') {
      recordStart(faultModel);
      let ended = false;
      const t = setTimeout(() => {
        if (ended) return;
        ended = true;
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock upstream timeout', type: 'timeout' } }));
        }
        recordEnd(faultModel, { ok: false, errorType: 'timeout' });
      }, config.timeoutMs);
      req.on('close', () => { if (!ended) { ended = true; clearTimeout(t); recordEnd(faultModel, { ok: false, errorType: 'client_abort' }); } });
      return;
    }

    if (isOpenAI) await openai.handleChat(body, res, { ...ov, fault });
    else await anthropic.handleMessages(body, res, { ...ov, fault });
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
  const rates = [
    ['429', config.error429Rate], ['500', config.error500Rate], ['timeout', config.errorTimeoutRate],
    ['disconnect', config.errorDisconnectRate], ['pause', config.errorPauseRate],
    ['heartbeat', config.errorHeartbeatRate], ['error_event', config.errorEventRate], ['generic', config.errorRate],
  ];
  const inj = rates.reduce((a, [, r]) => a + r, 0);
  console.log(`  fault injection: ${(inj * 100).toFixed(1)}% (${rates.map(([k, r]) => `${k}=${r}`).join(' ')})`);
});

// graceful shutdown: stop accepting, let in-flight streams finish, then dump final metrics
function shutdown(signal) {
  console.log(`\n${signal} received, draining in-flight requests...`);
  server.close(() => {
    console.log('all connections closed');
    console.log(JSON.stringify(snapshot(), null, 2));
    process.exit(0);
  });
  // hard cap: don't hang forever on stuck/heartbeat streams
  setTimeout(() => {
    console.log('drain deadline reached, forcing close');
    console.log(JSON.stringify(snapshot(), null, 2));
    process.exit(0);
  }, 15000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
