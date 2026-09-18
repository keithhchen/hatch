import assert from 'node:assert/strict';
import test from 'node:test';
import { agentDependencyGaps, agentStateKey, changedDependencies, localizeAgentText } from './factoryAgentState.js';

test('Agent state presentation follows the server state without inventing readiness', () => {
  assert.equal(agentStateKey(undefined), 'loadingAgentState');
  for (const [state, key] of Object.entries({ locked: 'agentNeedsPreparation', ready: 'agentReady', running: 'agentRunning', complete: 'agentComplete', update_available: 'agentHasUpdates', failed: 'agentNeedsAttention' })) {
    assert.equal(agentStateKey({ state }), key);
  }
});

test('locked Agent guidance preserves required work and normal alternatives', () => {
  assert.deepEqual(agentDependencyGaps({
    dependencies: { normal: ['voice', 'evaluator'] },
    availability: { missingRequired: ['research', 'research'], normal: { required: true, satisfied: false } }
  }), { required: ['research'], alternatives: ['voice', 'evaluator'] });
});

test('database Agent copy uses current locale and falls back only to English', () => {
  const copy = { en: 'Research', zh: '深度研究' };
  assert.equal(localizeAgentText(copy, 'zh'), '深度研究');
  assert.equal(localizeAgentText(copy, 'ja'), 'Research');
  assert.equal(localizeAgentText({ zh: '研究' }, 'ja'), '');
});

test('dependency badges are derived separately from upstream output timestamps', () => {
  const generation = { role: 'generation', outputUpdatedAt: '2026-09-10T03:00:00.000Z', dependencies: { required: [], normal: ['research', 'voice'] } };
  const agents = [
    { role: 'research', outputUpdatedAt: '2026-09-10T04:00:00.000Z' },
    { role: 'voice', outputUpdatedAt: '2026-09-10T05:00:00.000Z' },
    generation,
  ];
  assert.deepEqual(changedDependencies(generation, agents), ['research', 'voice']);
  generation.outputUpdatedAt = '2026-09-10T06:00:00.000Z';
  assert.deepEqual(changedDependencies(generation, agents), []);
});
