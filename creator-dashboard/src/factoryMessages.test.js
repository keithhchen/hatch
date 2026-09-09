import test from 'node:test';
import assert from 'node:assert/strict';
import { chatEntries } from './factoryMessages.js';

test('text and calls stay interleaved, including parallel receipts returned out of order', () => {
  const messages = [
    { role: 'user', content: '开始' },
    { role: 'assistant', content: [
      { type: 'text', text: '先读取' },
      { type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'input/a.md' } },
      { type: 'text', text: '再搜索' },
      { type: 'toolCall', id: 'b', name: 'search', arguments: { query: 'creator' } },
    ] },
    { role: 'toolResult', toolCallId: 'b', toolName: 'search', isError: true, content: [{ type: 'text', text: '失败原因' }] },
    { role: 'toolResult', toolCallId: 'a', toolName: 'read', content: [{ type: 'text', text: '原文' }] },
    { role: 'assistant', content: [{ type: 'text', text: '结论' }] },
  ];
  const entries = chatEntries(messages);
  assert.deepEqual(entries.map(e => e.type === 'tool' ? e.call.name : e.message.content), ['开始', '先读取', 'read', '再搜索', 'search', '结论']);
  assert.equal(entries[2].call.arguments.path, 'input/a.md');
  assert.equal(entries[2].result, messages[3]);
  assert.equal(entries[4].result.isError, true);
  assert.deepEqual(chatEntries(JSON.parse(JSON.stringify(messages))), entries, 'reload retains the same order');
});

test('pending calls retain their position and orphan receipts remain visible', () => {
  const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write', arguments: {} }] };
  const pending = chatEntries([call]);
  assert.equal(pending[0].result, undefined);
  const receipt = { role: 'toolResult', toolCallId: 'a', toolName: 'write', content: [] };
  assert.equal(chatEntries([call, receipt])[0].key, pending[0].key);
  assert.equal(chatEntries([receipt])[0].result, receipt);
});
