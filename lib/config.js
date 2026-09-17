import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// load .env if present (no deps)
// .env lives at repo root, this file is in lib/
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    // strip trailing inline comments ("KEY=value  # comment") before capturing the value
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)(\s+#.*)?$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
}

const num = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
};

const bounded = (name, def, min, max) => Math.min(max, Math.max(min, num(name, def)));

export const config = {
  host: process.env.HOST || '0.0.0.0', // 0.0.0.0 = 局域网可访问;只想本机用就 HOST=127.0.0.1
  port: bounded('PORT', 8787, 1, 65535),
  ttftMs: bounded('TTFT_MS', 500, 0, 3600000),
  tokenIntervalMs: bounded('TOKEN_INTERVAL_MS', 20, 0, 3600000),
  defaultOutputTokens: bounded('DEFAULT_OUTPUT_TOKENS', 512, 1, 8192),
  maxOutputTokens: bounded('MAX_OUTPUT_TOKENS', 8192, 1, 100000),
  // fault rates (cumulative roll): 429 / 500 / timeout / disconnect / pause / heartbeat / error_event / generic(->500)
  error429Rate: bounded('ERROR_429_RATE', 0, 0, 1),
  error500Rate: bounded('ERROR_500_RATE', 0, 0, 1),
  errorTimeoutRate: bounded('ERROR_TIMEOUT_RATE', 0, 0, 1),
  errorDisconnectRate: bounded('ERROR_DISCONNECT_RATE', 0, 0, 1),
  errorPauseRate: bounded('ERROR_PAUSE_RATE', 0, 0, 1),
  errorHeartbeatRate: bounded('ERROR_HEARTBEAT_RATE', 0, 0, 1),
  errorEventRate: bounded('ERROR_EVENT_RATE', 0, 0, 1),
  errorRate: bounded('ERROR_RATE', 0, 0, 1),
  // fault behavior tuning
  timeoutMs: bounded('TIMEOUT_MS', 30000, 1, 3600000),
  pauseMs: bounded('PAUSE_MS', 20000, 1, 3600000),       // mid-stream stall duration (then resume)
  heartbeatMs: bounded('HEARTBEAT_MS', 30000, 1, 3600000), // heartbeat-only duration before giving up
  heartbeatIntervalMs: bounded('HEARTBEAT_INTERVAL_MS', 1000, 1, 3600000),
  models: (process.env.MODELS || 'mock-gpt-4o,mock-gpt-4o-mini,mock-claude-sonnet,mock-claude-haiku')
    .split(',').map(s => s.trim()).filter(Boolean),
};
