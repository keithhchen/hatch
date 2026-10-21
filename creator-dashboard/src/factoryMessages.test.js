import test from 'node:test';
import assert from 'node:assert/strict';
import { chatEntries, describeToolCall, groupToolEntries, toolDetailRows, toolResultRows } from './factoryMessages.js';
import { createFactoryAgentTranslator } from './factoryAgentsI18n.js';

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

test('continuing a stopped chat does not mark its old unanswered calls as running', () => {
  const entries = chatEntries([
    { role: 'assistant', content: [{ type: 'toolCall', id: 'old', name: 'write', arguments: {} }] },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'new', name: 'read', arguments: {} }] },
  ]);
  assert.equal(entries[0].isCurrentTurn, false);
  assert.equal(entries[2].isCurrentTurn, true);
});

test('consecutive tool calls render as one expandable tool group without crossing text', () => {
  const entries = chatEntries([
    { role: 'assistant', content: [
      { type: 'toolCall', id: 'a', name: 'list', arguments: {} },
      { type: 'toolCall', id: 'b', name: 'read', arguments: {} },
      { type: 'text', text: '结果' },
      { type: 'toolCall', id: 'c', name: 'write', arguments: {} },
    ] },
  ]);
  const grouped = groupToolEntries(entries);
  assert.deepEqual(grouped.map(entry => entry.type), ['toolGroup', 'message', 'tool']);
  assert.deepEqual(grouped[0].items.map(entry => entry.call.name), ['list', 'read']);
  assert.equal(grouped[0].items.length, 2);
});

test('askuser is a single pending interaction block until the next user message', () => {
  const request = { role: 'assistant', content: [{ type: 'toolCall', id: 'ask-1', name: 'askuser', arguments: { questions: [{ id: 'audience', question: 'Who is this for?', options: [{ content: 'Creator' }] }] } }] };
  const receipt = { role: 'toolResult', toolCallId: 'ask-1', toolName: 'askuser', content: [{ type: 'text', text: 'Waiting for the user.' }] };
  const pending = chatEntries([{ role: 'user', content: 'Start' }, request, receipt]);
  assert.equal(pending[1].type, 'askUser');
  assert.equal(pending[1].pending, true);
  const answered = chatEntries([{ role: 'user', content: 'Start' }, request, receipt, { role: 'user', content: 'Creator' }]);
  assert.equal(answered[1].pending, false);
});

test('tool calls read as one plain line derived from the real name, arguments and result', () => {
  const zh = createFactoryAgentTranslator('zh');
  const list = describeToolCall({ name: 'list', arguments: { directory: 'output' } }, { content: [{ type: 'text', text: '[]' }] });
  assert.deepEqual(list, { key: 'toolSumList', target: 'output', count: 0 });
  assert.equal(zh(list.key, list.target), '查看资料目录：output');
  assert.deepEqual(describeToolCall({ name: 'read', arguments: { path: 'input/manual/a.md' } }), { key: 'toolSumRead', target: 'a.md' });
  assert.deepEqual(describeToolCall({ name: 'mystery_tool', arguments: {} }), { key: 'toolSumOther', target: 'mystery_tool' });
});

test('tool details become key–value rows without JSON braces; empty results have no rows', () => {
  assert.deepEqual(toolDetailRows({ directory: 'output' }), [{ key: 'directory', value: 'output' }]);
  assert.deepEqual(toolResultRows({ content: [{ type: 'text', text: '[]' }] }), []);
  assert.deepEqual(toolResultRows({ content: [{ type: 'text', text: '[{"path":"output/a.md","bytes":3}]' }] }), [{ key: null, value: 'output/a.md' }]);
  assert.deepEqual(toolResultRows({ content: 'plain text' }), [{ key: null, value: 'plain text' }]);
});
