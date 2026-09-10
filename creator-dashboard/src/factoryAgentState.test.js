import assert from 'node:assert/strict';
import test from 'node:test';
import { agentDependencyGaps, agentStateKey, localizeAgentText } from './factoryAgentState.js';

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
