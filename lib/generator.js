// fault injection + token/text generation shared by both protocol handlers
import { config } from './config.js';

// fault kinds:
//   'ok'          normal completion
//   '429'         immediate 429
//   '500'         immediate 5xx
//   'timeout'     no response until TIMEOUT_MS, then 504
//   'disconnect'  200 + partial stream (or connection reset pre-body for non-stream), then socket destroyed
//   'pause'       200 + stream stalls PAUSE_MS mid-output, then resumes and completes
//   'heartbeat'   200 + SSE comments only, no content, until HEARTBEAT_MS then ends without body
//   'error_event' 200 + protocol error event mid-stream, no normal end marker
export const FAULTS = ['ok', '429', '500', 'timeout', 'disconnect', 'pause', 'heartbeat', 'error_event'];

export function rollFault() {
  return classifyFault(Math.random(), config);
}

export function classifyFault(r, rates = {}) {
  let boundary = 0;
  for (const [key, kind] of [
    ['error429Rate', '429'], ['error500Rate', '500'], ['errorTimeoutRate', 'timeout'],
    ['errorDisconnectRate', 'disconnect'], ['errorPauseRate', 'pause'],
    ['errorHeartbeatRate', 'heartbeat'], ['errorEventRate', 'error_event'], ['errorRate', '500'],
  ]) {
    boundary += rates[key] || 0;
    if (r < boundary) return kind;
  }
  return 'ok';
}

const WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna'];

export function estimateTokens(text) {
  // rough: ~4 chars per token for English-ish content
  return Math.max(1, Math.round(text.length / 4));
}

// generate text until we reach targetTokens
export function generateText(targetTokens, seed) {
  if (!Number.isInteger(targetTokens) || targetTokens < 1 || targetTokens > config.maxOutputTokens) {
    throw new RangeError(`target tokens must be an integer from 1 to ${config.maxOutputTokens}`);
  }
  let text = seed ? `${seed} ` : '';
  let tokens = estimateTokens(text);
  while (tokens < targetTokens) {
    const w = WORDS[Math.floor(Math.random() * WORDS.length)];
    text += w + ' ';
    tokens++;
  }
  return text.trim();
}

// split text into token-ish chunks for SSE streaming
export function tokenizeForStream(text) {
  const parts = text.split(' ');
  const chunks = [];
  for (let i = 0; i < parts.length; i += 3) {
    chunks.push(parts.slice(i, i + 3).join(' '));
  }
  return chunks;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function extractPrompt(body) {
  if (Array.isArray(body?.messages)) {
    const last = body.messages[body.messages.length - 1];
    if (typeof last?.content === 'string') return last.content;
    if (Array.isArray(last?.content)) {
      const t = last.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
      if (t) return t;
    }
  }
  if (typeof body?.prompt === 'string') return body.prompt;
  return '';
}

// per-request behavior overrides (test client controls fault/latency shape via body)
// returns { fault, ttftMs, intervalMs } with sane clamping; fault override must be a known kind
export function requestOverrides(body) {
  const int = (v, def, min, max) =>
    Number.isInteger(v) && v >= min && v <= max ? v : def;
  const fault = FAULTS.includes(body?.mock_fault) ? body.mock_fault : undefined;
  return {
    fault, // undefined => roll the dice
    ttftMs: int(body?.mock_ttft_ms, config.ttftMs, 0, 3600000),
    intervalMs: int(body?.mock_interval_ms, config.tokenIntervalMs, 0, 3600000),
  };
}
