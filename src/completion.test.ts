import { describe, expect, it } from 'vitest';
import { complete, insertCompletion, tokenize } from './completion';
import type { Meta, Task } from './types';
const meta: Meta = {
  version: '3.5', defaultReport: 'next', reports: [{ name: 'next', description: 'Most urgent', columns: [], labels: [] }, { name: 'external', description: 'External work', columns: [], labels: [] }],
  projects: ['work', 'work research'], tags: ['home', 'hot'], contexts: ['office'], attributes: ['estimate', 'tiebreak'], priorities: ['H', 'M', 'L'],
};
const tasks: Task[] = [{ uuid: 'abc-123', id: 1, description: 'A dependency', status: 'pending' }, { uuid: 'def-456', id: 2, description: 'Other task', status: 'pending' }];
const values = (text: string) => complete(text, text.length, meta, tasks).suggestions.map(item => item.value);

describe('contextual completion', () => {
  it('tokenizes quoted and escaped values with exact source spans', () => {
    expect(tokenize(':m project:"work research" description:\'don’t lose me\' +home')).toEqual([
      { start: 0, end: 2, raw: ':m', value: ':m' },
      { start: 3, end: 26, raw: 'project:"work research"', value: 'project:work research' },
      { start: 27, end: 54, raw: "description:'don’t lose me'", value: 'description:don’t lose me' },
      { start: 55, end: 60, raw: '+home', value: '+home' },
    ]);
  });
  it('offers Taskwarrior-supported date expressions and filters prefixes', () => {
    expect(values(':m due:')).toEqual(expect.arrayContaining(['due:today', 'due:tomorrow', 'due:now+3d', 'due:monday', 'due:eow', 'due:eom']));
    expect(values(':m due:to')).toEqual(['due:today', 'due:tomorrow']);
    expect(values(':m due:')).not.toContain('due:"next monday"');
  });
  it('replaces a token at the caret and preserves the rest of the command', () => {
    const text = ':m due:to project:work +home';
    const completion = complete(text, 9, meta, tasks);
    expect(insertCompletion(text, completion, 'due:tomorrow')).toEqual({ text: ':m due:tomorrow project:work +home', caret: 15 });
    expect(insertCompletion(text, completion, 'due:today').text).toBe(':m due:today project:work +home');
  });
  it('quotes multiword projects and handles an unclosed quoted token', () => {
    expect(values(':m project:work')).toEqual(['project:work', 'project:"work research"']);
    expect(values(':m project:"work r')).toEqual(['project:"work research"']);
  });
  it('completes reports, contexts, priorities, tags, UDAs and durations', () => {
    expect(values(':r ex')).toEqual(['external']);
    expect(values(':sy')).toEqual([':sync']);
    expect(values(':ex')).toEqual([':external']);
    expect(values(':context o')).toEqual(['office']);
    expect(values(':m priority:')).toContain('priority:H');
    expect(values(':m +ho')).toEqual(['+home', '+hot']);
    expect(values(':m -ho')).toEqual(['-home', '-hot']);
    expect(values(':m tie')).toEqual(['tiebreak:']);
    expect(values(':m estimate:1')).toEqual(['estimate:15min', 'estimate:1h', 'estimate:1d', 'estimate:1week']);
  });
  it('completes dependencies by UUID and preserves comma-separated dependencies', () => {
    expect(values(':m depends:a')).toEqual(['depends:abc-123']);
    expect(values(':m depends:abc-123,d')).toEqual(['depends:abc-123,def-456']);
  });
  it('does not duplicate colons and preserves a suffix while cycling the original span', () => {
    const text = ':m due: project:work';
    const completion = complete(text, 7, meta, tasks);
    const first = insertCompletion(text, completion, completion.suggestions[0].value);
    const next = insertCompletion(text, completion, completion.suggestions[1].value);
    expect(first.text).toBe(':m due:today project:work');
    expect(next.text).toBe(':m due:tomorrow project:work');
    expect(next.text).not.toContain('todaytomorrow');
  });
});
