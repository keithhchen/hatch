// Keep each call at its position in the assistant message, with its own receipt.
export function chatEntries(messages) {
  const results = new Map(messages.filter(m => m.role === 'toolResult' && m.toolCallId).map(m => [m.toolCallId, m]));
  const calls = new Set(messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'toolCall').map(c => c.id) : []));
  return messages.flatMap((message, i) => {
    if (message.role === 'toolResult') {
      return calls.has(message.toolCallId) ? [] : [{ key: `${i}`, type: 'tool', result: message }];
    }
    if (!Array.isArray(message.content)) return [{ key: `${i}`, type: 'message', message }];
    return message.content.flatMap((block, j) => {
      const key = `${i}:${j}`;
      if (block.type === 'toolCall') return [{ key, type: 'tool', call: block, result: results.get(block.id) }];
      if (block.type === 'text' && block.text) return [{ key, type: 'message', message: { ...message, content: block.text } }];
      return [];
    });
  });
}
