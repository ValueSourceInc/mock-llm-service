import test from 'node:test';
import assert from 'node:assert/strict';

const RATES = {
  error429Rate: .1, error500Rate: .2, errorTimeoutRate: .3,
  errorDisconnectRate: 0, errorPauseRate: 0, errorHeartbeatRate: 0, errorEventRate: 0,
  errorRate: .4,
};

test('rollFault uses cumulative configured probabilities', async () => {
  const original = Math.random;
  const { classifyFault } = await import('../lib/generator.js');
  try {
    Math.random = () => 0.05; assert.equal(classifyFault(Math.random(), RATES), '429');
    Math.random = () => 0.15; assert.equal(classifyFault(Math.random(), RATES), '500');
    Math.random = () => 0.35; assert.equal(classifyFault(Math.random(), RATES), 'timeout');
    Math.random = () => 0.75; assert.equal(classifyFault(Math.random(), RATES), '500');
  } finally {
    Math.random = original;
  }
});

test('new fault kinds roll in order after timeout', async () => {
  const { classifyFault } = await import('../lib/generator.js');
  const rates = { error429Rate: 0, error500Rate: 0, errorTimeoutRate: .1, errorDisconnectRate: .1, errorPauseRate: .1, errorHeartbeatRate: .1, errorEventRate: .1, errorRate: 0 };
  assert.equal(classifyFault(0.05, rates), 'timeout');
  assert.equal(classifyFault(0.15, rates), 'disconnect');
  assert.equal(classifyFault(0.25, rates), 'pause');
  assert.equal(classifyFault(0.35, rates), 'heartbeat');
  assert.equal(classifyFault(0.45, rates), 'error_event');
  assert.equal(classifyFault(0.99, rates), 'ok');
});

test('generateText rejects invalid token targets', async () => {
  const { generateText } = await import('../lib/generator.js');
  assert.throws(() => generateText(0, ''), /token/i);
  assert.throws(() => generateText(1.5, ''), /token/i);
  assert.throws(() => generateText(100000, ''), /token/i);
});

test('requestOverrides: forced fault, clamped latencies, defaults', async () => {
  const { requestOverrides } = await import('../lib/generator.js');
  // forced fault must be a known kind, unknown ignored
  assert.equal(requestOverrides({ mock_fault: 'disconnect' }).fault, 'disconnect');
  assert.equal(requestOverrides({ mock_fault: 'nope' }).fault, undefined);
  assert.equal(requestOverrides({}).fault, undefined);
  // per-request ttft/interval override
  assert.equal(requestOverrides({ mock_ttft_ms: 123, mock_interval_ms: 7 }).ttftMs, 123);
  assert.equal(requestOverrides({ mock_ttft_ms: 123, mock_interval_ms: 7 }).intervalMs, 7);
  // invalid values fall back to config defaults (.env may override, compare against config)
  const { config } = await import('../lib/config.js');
  const o = requestOverrides({ mock_ttft_ms: 1.5, mock_interval_ms: -3 });
  assert.equal(o.ttftMs, config.ttftMs);
  assert.equal(o.intervalMs, config.tokenIntervalMs);
});
