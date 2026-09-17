// rolling per-model stats: counters + error classification + latency samples + percentiles

const stats = new Map(); // model -> { count, errors, errorTypes, tokens, bytes, ttft[], total[], inflight, startedAt }

function bucket(model) {
  let s = stats.get(model);
  if (!s) {
    s = {
      count: 0, errors: 0, errorTypes: {}, tokens: 0, bytes: 0,
      ttft: [], total: [], inflight: 0, startedAt: Date.now(),
    };
    stats.set(model, s);
  }
  return s;
}

const MAX_SAMPLES = 5000;

export function recordStart(model) {
  bucket(model).inflight++;
}

// ok requests: ttftMs/totalMs/outputTokens/bytes recorded
// failed requests: errorType one of rate_limit|server_error|timeout|disconnect|heartbeat|error_event|client_abort|bad_request|internal
export function recordEnd(model, { ok, errorType = null, ttftMs, totalMs, outputTokens = 0, bytes = 0 }) {
  const s = bucket(model);
  s.inflight--;
  s.bytes += bytes || 0;
  if (!ok) {
    s.errors++;
    const k = errorType || 'unknown';
    s.errorTypes[k] = (s.errorTypes[k] || 0) + 1;
    return;
  }
  s.count++;
  s.tokens += outputTokens;
  if (Number.isFinite(ttftMs)) {
    s.ttft.push(ttftMs); if (s.ttft.length > MAX_SAMPLES) s.ttft.shift();
  }
  if (Number.isFinite(totalMs)) {
    s.total.push(totalMs); if (s.total.length > MAX_SAMPLES) s.total.shift();
  }
}

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
}

export function snapshot() {
  const models = {};
  let totCount = 0, totErrors = 0, totInflight = 0, totTokens = 0, totBytes = 0;
  const totErrorTypes = {};
  for (const [model, s] of stats) {
    const elapsed = (Date.now() - s.startedAt) / 1000;
    models[model] = {
      requests: s.count,
      errors: s.errors,
      error_types: s.errorTypes,
      inflight: s.inflight,
      output_tokens: s.tokens,
      bytes_out: s.bytes,
      qps: +(s.count / Math.max(elapsed, 0.001)).toFixed(2),
      ttft_ms: { p50: pct(s.ttft, 50), p95: pct(s.ttft, 95), p99: pct(s.ttft, 99) },
      total_ms: { p50: pct(s.total, 50), p95: pct(s.total, 95), p99: pct(s.total, 99) },
    };
    totCount += s.count; totErrors += s.errors; totInflight += s.inflight; totTokens += s.tokens; totBytes += s.bytes;
    for (const [k, v] of Object.entries(s.errorTypes)) totErrorTypes[k] = (totErrorTypes[k] || 0) + v;
  }
  return {
    totals: { requests: totCount, errors: totErrors, error_types: totErrorTypes, inflight: totInflight, output_tokens: totTokens, bytes_out: totBytes },
    models,
  };
}
