// fault injection + token/text generation shared by both protocol handlers
import { config } from './config.js';

// returns 'ok' | '429' | '500' | 'timeout'
export function rollFault() {
  return classifyFault(Math.random(), config);
}

export function classifyFault(r, rates) {
  let boundary = rates.error429Rate;
  if (r < boundary) return '429';
  boundary += rates.error500Rate;
  if (r < boundary) return '500';
  boundary += rates.errorTimeoutRate;
  if (r < boundary) return 'timeout';
  boundary += rates.errorRate;
  if (r < boundary) return '500';
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
