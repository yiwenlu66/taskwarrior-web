import type { Meta, Task } from './types';

export interface Token { raw: string; value: string; start: number; end: number }
export interface Suggestion { value: string; label: string; description: string; kind: string }
export interface Completion { start: number; end: number; suggestions: Suggestion[] }

/** Shell-like token boundaries only. No command is ever evaluated in the browser. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let start = -1, quote = '', escaped = false, value = '';
  for (let i = 0; i <= text.length; i++) {
    const character = text[i];
    if (i === text.length || (!quote && !escaped && /\s/.test(character))) {
      if (start !== -1) tokens.push({ raw: text.slice(start, i), value, start, end: i });
      start = -1; value = ''; escaped = false;
      continue;
    }
    if (start === -1) start = i;
    if (escaped) { value += character; escaped = false; }
    else if (character === '\\' && quote !== "'") escaped = true;
    else if (character === quote) quote = '';
    else if ((character === '"' || character === "'") && !quote) quote = character;
    else value += character;
  }
  return tokens;
}

const commands: [string, string][] = [
  ['add', 'Create a task'], ['modify', 'Modify selected tasks'], ['done', 'Complete selected tasks'],
  ['delete', 'Delete selected tasks · confirmation required'], ['start', 'Start selected tasks'],
  ['stop', 'Stop selected tasks'], ['toggle', 'Toggle start / stop per selected task'], ['annotate', 'Add an annotation'], ['denotate', 'Remove matching annotation'],
  ['undo', 'Undo the last change'], ['sync', 'Sync with the configured Taskwarrior server'], ['help', 'Keyboard reference'], ['report', 'Switch report'],
  ['filter', 'Set an additional Taskwarrior filter'], ['context', 'Switch active context'],
];
const dateFields = new Set(['due', 'wait', 'scheduled', 'until', 'entry', 'end', 'start']);
const attributes = ['description', 'project', 'priority', 'due', 'wait', 'scheduled', 'until', 'recur', 'tags', 'depends', 'status'];
const quoteValue = (value: string) => /\s|["'\\]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value;
const suggestion = (value: string, description: string, kind: string, label = value): Suggestion => ({ value, label, description, kind });

export function complete(text: string, caret: number, meta: Meta | null, tasks: Task[]): Completion {
  const tokens = tokenize(text);
  const active = tokens.find(token => token.start <= caret && caret <= token.end);
  const start = active?.start ?? caret;
  const end = active?.end ?? caret;
  const beforeCaret = tokenize(text.slice(start, caret))[0]?.value ?? '';
  const first = !tokens.length || (active === tokens[0]) || caret <= (tokens[0]?.start ?? 0);
  const command = (tokens[0]?.value ?? '').replace(/^:/, '');
  let prefix = beforeCaret;
  let suggestions: Suggestion[] = [];
  if (first) {
    prefix = prefix.replace(/^:/, '');
    const colon = text[start] === ':' ? ':' : '';
    suggestions = [
      ...commands.map(([name, description]) => suggestion(`${colon}${name}`, description, 'command', name)),
      ...(meta?.reports ?? []).map(report => suggestion(`${colon}${report.name}`, report.description, 'report', report.name)),
    ];
  } else if (['r', 'report'].includes(command)) {
    suggestions = (meta?.reports ?? []).map(report => suggestion(report.name, report.description, 'report'));
  } else if (['context', 'c'].includes(command)) {
    suggestions = ['none', ...(meta?.contexts ?? [])].map(context => suggestion(quoteValue(context), context === 'none' ? 'Disable context' : 'Active Taskwarrior context', 'context', context));
  } else if (prefix.includes(':')) {
    const colon = prefix.indexOf(':');
    const key = prefix.slice(0, colon + 1);
    const attribute = prefix.slice(0, colon).split('.')[0];
    prefix = prefix.slice(colon + 1);
    let values: Suggestion[] = [];
    if (dateFields.has(attribute)) {
      const date = new Date();
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      values = [
        suggestion('today', 'Today at midnight', 'date'), suggestion('tomorrow', 'Tomorrow at midnight', 'date'),
        suggestion('now+3d', 'Three days from now · Taskwarrior expression', 'date'),
        suggestion('monday', 'Next Monday · use monday, not “next monday”', 'date'),
        suggestion('eow', 'End of this week', 'date'), suggestion('eom', 'End of this month', 'date'),
        suggestion(iso, 'ISO date · YYYY-MM-DD', 'date'), suggestion('', 'Clear this date', 'date', '(clear)'),
      ];
    } else if (attribute === 'priority') {
      values = (meta?.priorities ?? ['H', 'M', 'L']).map(value => suggestion(value, `Priority ${value}`, 'priority'));
      values.push(suggestion('', 'Clear priority', 'priority', '(none)'));
    } else if (attribute === 'project') values = (meta?.projects ?? []).map(value => suggestion(value, 'Project', 'project'));
    else if (attribute === 'tags') values = (meta?.tags ?? []).map(value => suggestion(value, 'Tag', 'tag'));
    else if (attribute === 'status') values = ['pending', 'completed', 'deleted', 'recurring'].map(value => suggestion(value, 'Task status', 'status'));
    else if (attribute === 'recur') values = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly', '2weeks'].map(value => suggestion(value, 'Recurrence interval · also set due:', 'duration'));
    else if (/duration|estimate/.test(attribute)) values = ['15min', '30min', '1h', '2h', '1d', '1week'].map(value => suggestion(value, 'Taskwarrior duration', 'duration'));
    else if (attribute === 'depends') {
      const parts = prefix.split(',');
      const existing = parts.length > 1 ? `${parts.slice(0, -1).join(',')},` : '';
      prefix = parts.at(-1) ?? '';
      values = tasks.map(task => suggestion(`${existing}${task.uuid}`, task.description, 'dependency', `${task.id ?? '–'} · ${task.uuid}`));
      suggestions = values.filter(value => value.value.slice(existing.length).toLowerCase().startsWith(prefix.toLowerCase()) || value.label.startsWith(prefix)).map(value => ({ ...value, value: key + value.value }));
      return { start, end, suggestions };
    }
    suggestions = values.filter(value => value.value.toLowerCase().startsWith(prefix.toLowerCase())).map(value => ({ ...value, value: key + quoteValue(value.value) }));
    return { start, end, suggestions };
  } else if (/^[+-]/.test(prefix)) {
    const sign = prefix[0];
    prefix = prefix.slice(1);
    suggestions = (meta?.tags ?? []).map(tag => suggestion(sign + quoteValue(tag), 'Task tag', 'tag', tag));
  } else {
    suggestions = [...new Set([...attributes, ...(meta?.attributes ?? [])])].sort().map(attribute => suggestion(`${attribute}:`, 'Set or filter an attribute', 'attribute'));
    suggestions.push(...(meta?.tags ?? []).map(tag => suggestion(`+${quoteValue(tag)}`, 'Add or match a tag', 'tag', `+${tag}`)));
  }
  return { start, end, suggestions: suggestions.filter(value => value.label.toLowerCase().startsWith(prefix.toLowerCase())) };
}

export function insertCompletion(text: string, completion: Completion, value: string): { text: string; caret: number } {
  return { text: text.slice(0, completion.start) + value + text.slice(completion.end), caret: completion.start + value.length };
}
