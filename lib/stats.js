// rolling per-model stats: counters + latency samples + percentiles

const stats = new Map(); // model -> { count, errors, tokens, ttft[], total[], inflight }

function bucket(model) {
  let s = stats.get(model);
  if (!s) {
    s = { count: 0, errors: 0, tokens: 0, ttft: [], total: [], inflight: 0, startedAt: Date.now() };
    stats.set(model, s);
  }
  return s;
}

const MAX_SAMPLES = 5000;

export function recordStart(model) {
  bucket(model).inflight++;
}

export function recordEnd(model, { ok, ttftMs, totalMs, outputTokens }) {
  const s = bucket(model);
  s.inflight--;
  if (!ok) { s.errors++; return; }
  s.count++;
  s.tokens += outputTokens;
  s.ttft.push(ttftMs); if (s.ttft.length > MAX_SAMPLES) s.ttft.shift();
  s.total.push(totalMs); if (s.total.length > MAX_SAMPLES) s.total.shift();
}

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
}

export function snapshot() {
  const models = {};
  let totCount = 0, totErrors = 0, totInflight = 0, totTokens = 0;
  for (const [model, s] of stats) {
    const elapsed = (Date.now() - s.startedAt) / 1000;
    models[model] = {
      requests: s.count,
      errors: s.errors,
      inflight: s.inflight,
      output_tokens: s.tokens,
      qps: +(s.count / Math.max(elapsed, 0.001)).toFixed(2),
      ttft_ms: { p50: pct(s.ttft, 50), p95: pct(s.ttft, 95), p99: pct(s.ttft, 99) },
      total_ms: { p50: pct(s.total, 50), p95: pct(s.total, 95), p99: pct(s.total, 99) },
    };
    totCount += s.count; totErrors += s.errors; totInflight += s.inflight; totTokens += s.tokens;
  }
  return { totals: { requests: totCount, errors: totErrors, inflight: totInflight, output_tokens: totTokens }, models };
}
