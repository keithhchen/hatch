import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILD_NEEDS, agentStateKey, localizeAgentText, updatedSources } from './factoryAgentState.js';

test('Agent state presentation follows the server state without inventing readiness', () => {
  assert.equal(agentStateKey(undefined), 'loadingAgentState');
  for (const [state, key] of Object.entries({ locked: 'agentNeedsPreparation', ready: 'agentReady', running: 'agentRunning', complete: 'agentComplete', update_available: 'agentHasUpdates', failed: 'agentNeedsAttention' })) {
    assert.equal(agentStateKey({ state }), key);
  }
});

test('a locked Build asks for uploads or the interview', () => {
  assert.deepEqual([...BUILD_NEEDS], ['uploads', 'voice']);
});

test('database Agent copy uses current locale and falls back only to English', () => {
  const copy = { en: 'Research', zh: '深度研究' };
  assert.equal(localizeAgentText(copy, 'zh'), '深度研究');
  assert.equal(localizeAgentText(copy, 'ja'), 'Research');
  assert.equal(localizeAgentText({ zh: '研究' }, 'ja'), '');
});

test('only an updated interview makes Build stale', () => {
  assert.deepEqual(updatedSources({ state: 'update_available' }), ['voice']);
  assert.deepEqual(updatedSources({ state: 'complete' }), []);
});
