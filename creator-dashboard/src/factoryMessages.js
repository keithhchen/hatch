// Keep each call at its position in the assistant message, with its own receipt.
export function chatEntries(messages) {
  const latestUser = messages.findLastIndex(m => m.role === 'user');
  const results = new Map(messages.filter(m => m.role === 'toolResult' && m.toolCallId).map(m => [m.toolCallId, m]));
  const calls = new Set(messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'toolCall').map(c => c.id) : []));
  return messages.flatMap((message, i) => {
    if (message.role === 'toolResult') {
      return calls.has(message.toolCallId) ? [] : [{ key: `${i}`, type: 'tool', result: message }];
    }
    if (!Array.isArray(message.content)) return [{ key: `${i}`, type: 'message', message }];
    return message.content.flatMap((block, j) => {
      const key = `${i}:${j}`;
      if (block.type === 'toolCall') {
        const result = results.get(block.id);
        if (block.name === 'askuser') return [{ key, type: 'askUser', call: block, result, pending: i > latestUser }];
        return [{ key, type: 'tool', call: block, result, isCurrentTurn: i > latestUser }];
      }
      if (block.type === 'text' && block.text) return [{ key, type: 'message', message: { ...message, content: block.text } }];
      return [];
    });
  });
}

export function groupToolEntries(entries) {
  const grouped = [];
  for (const entry of entries) {
    if (entry.type !== 'tool') {
      grouped.push(entry);
      continue;
    }
    const previous = grouped.at(-1);
    if (previous?.type === 'toolGroup') {
      previous.items.push(entry);
      previous.isCurrentTurn ||= entry.isCurrentTurn;
    } else {
      grouped.push({ key: `tool-group:${entry.key}`, type: 'toolGroup', items: [entry], isCurrentTurn: entry.isCurrentTurn });
    }
  }
  return grouped.flatMap(entry => entry.type === 'toolGroup' && entry.items.length === 1 ? entry.items : [entry]);
}

// Plain-language view of one real tool call: which summary to show and with what target.
const baseName = value => String(value || '').split('/').filter(Boolean).at(-1) || String(value || '');
const hostOf = value => { try { return new URL(value).host || value; } catch { return value; } };

export function toolResultText(result) {
  if (!result) return '';
  if (typeof result.content === 'string') return result.content;
  return Array.isArray(result.content) ? result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function describeToolCall(call, result) {
  const name = String(call?.name || result?.toolName || '');
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const value = name.toLowerCase();
  if (value === 'list') {
    const files = parseJson(toolResultText(result));
    const count = Array.isArray(files) ? files.length : null;
    return args.directory && args.directory !== '.' ? { key: 'toolSumList', target: args.directory, count } : { key: 'toolSumListAll', count };
  }
  if (value === 'read') return { key: 'toolSumRead', target: baseName(args.path) };
  if (value === 'write' || value === 'file_write') return { key: 'toolSumWrite', target: baseName(args.path) };
  if (value === 'web_search' || value === 'search') return { key: 'toolSumSearch', target: args.query };
  if (value === 'web_scrape') return { key: 'toolSumScrape', target: hostOf(args.url) };
  if (value === 'youtube_transcript') return { key: 'toolSumTranscript', target: args.url };
  if (value === 'update_todo') return { key: 'toolSumTodo', count: Array.isArray(args.todos) ? args.todos.length : null };
  if (value.includes('corpus_upload')) return { key: 'toolSumPublish' };
  if (value.includes('evaluat')) return { key: 'toolSumEvaluate' };
  return { key: 'toolSumOther', target: name };
}

const isEmpty = value => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

/** Readable text for one value; never JSON braces. Empty values return null so the caller shows "None". */
export function toolValueText(value) {
  if (isEmpty(value)) return null;
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(item => item && typeof item === 'object' ? (item.title ?? item.path ?? item.content ?? item.question ?? toolPairsText(item)) : String(item)).join('\n');
  return toolPairsText(value);
}

function toolPairsText(value) {
  return Object.entries(value).filter(([, v]) => !isEmpty(v)).map(([k, v]) => `${humanKey(k)}: ${typeof v === 'object' ? toolValueText(v) : v}`).join('\n');
}

export const humanKey = key => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();

/** Rows for the details panel: arguments as key–value pairs; the result parsed when it is JSON. */
export function toolDetailRows(value) {
  if (isEmpty(value)) return [];
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).map(([key, item]) => ({ key, value: toolValueText(item) }));
  return [{ key: null, value: toolValueText(value) }];
}

export function toolResultRows(result) {
  const text = toolResultText(result).trim();
  if (!text) return [];
  const parsed = parseJson(text);
  return parsed === undefined ? [{ key: null, value: text }] : isEmpty(parsed) ? [] : toolDetailRows(parsed);
}
