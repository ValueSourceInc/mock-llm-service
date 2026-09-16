import test from 'node:test';
import assert from 'node:assert/strict';

test('rollFault uses cumulative configured probabilities', async () => {
  const original = Math.random;
  const { classifyFault } = await import('../lib/generator.js');
  try {
    Math.random = () => 0.05; assert.equal(classifyFault(Math.random(), { error429Rate: .1, error500Rate: .2, errorTimeoutRate: .3, errorRate: .4 }), '429');
    Math.random = () => 0.15; assert.equal(classifyFault(Math.random(), { error429Rate: .1, error500Rate: .2, errorTimeoutRate: .3, errorRate: .4 }), '500');
    Math.random = () => 0.35; assert.equal(classifyFault(Math.random(), { error429Rate: .1, error500Rate: .2, errorTimeoutRate: .3, errorRate: .4 }), 'timeout');
    Math.random = () => 0.75; assert.equal(classifyFault(Math.random(), { error429Rate: .1, error500Rate: .2, errorTimeoutRate: .3, errorRate: .4 }), '500');
  } finally { Math.random = original; }
});

test('generateText rejects invalid token targets', async () => {
  const { generateText } = await import('../lib/generator.js');
  assert.throws(() => generateText(0, ''), /token/i);
  assert.throws(() => generateText(1.5, ''), /token/i);
  assert.throws(() => generateText(100000, ''), /token/i);
});
