import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { Meta, Task, TaskResponse } from './types';

const meta: Meta = {
  version: '3.5.0', defaultReport: 'next', projects: ['work'], tags: ['home'], contexts: [], attributes: ['due', 'project', 'external', 'tiebreak'], priorities: ['H', 'M', 'L'],
  reports: [
    { name: 'next', description: 'Most urgent tasks', columns: ['id', 'priority', 'project', 'recur', 'description', 'external'], labels: ['ID', 'P', 'Project', 'Recur', 'Description', 'Link'], sort: 'urgency-' },
    { name: 'completed', description: 'Completed tasks', columns: ['id', 'description'], labels: ['ID', 'Description'] },
  ],
};
const originalTasks: Task[] = [
  { uuid: 'uuid-one', id: 1, description: 'First fixture task', status: 'pending', project: 'work', priority: 'H', external: 'https://example.com/issue', annotations: [{ entry: '20261101T120000Z', description: 'Fixture annotation' }] },
  { uuid: 'uuid-two', id: 2, description: 'Second fixture task', status: 'pending', project: 'work' },
];
class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners = new Map<string, (() => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { MockEventSource.instances.push(this); }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
  emit(name: string) { this.listeners.get(name)?.forEach(callback => callback()); }
  close() {}
}
function response(tasks: Task[], report = 'next'): TaskResponse {
  return { tasks, report: meta.reports.find(item => item.name === report)!, revision: 'fixture', context: '' };
}
let currentTasks: Task[];
let commandError = false;
let commands: { command: string; uuids: string[] }[];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  localStorage.clear(); currentTasks = [...originalTasks]; commands = []; commandError = false; MockEventSource.instances = [];
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/api/meta') return json(meta);
    if (path.startsWith('/api/tasks')) return json(response(currentTasks, new URL(path, 'http://local').searchParams.get('report') || 'next'));
    if (path === '/api/command') {
      commands.push(JSON.parse(String(options?.body)));
      return commandError ? json({ error: 'Invalid date fixture' }, 400) : json({ changed: true, output: 'Fixture action applied' });
    }
    throw new Error(`Unexpected path ${path}`);
  }));
});
async function ready() { render(<App />); await screen.findByText('First fixture task'); }
function list() { return screen.getByRole('region', { name: /Task list/ }); }
function selectedDescription() { return document.querySelector('tr[aria-selected="true"] .column-description')?.textContent; }

describe('task workspace', () => {
  it('renders configured columns, external links, hidden empty columns and annotation details', async () => {
    await ready();
    expect(screen.getByRole('columnheader', { name: 'Link' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Recur' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /example.com/ })).toHaveAttribute('href', 'https://example.com/issue');
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(screen.getByRole('complementary', { name: 'Task details' })).toHaveTextContent('Fixture annotation');
    fireEvent.keyDown(list(), { key: 'q' }); expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
  it('preserves UUID selection and command draft while live updates reorder numeric IDs', async () => {
    const user = userEvent.setup(); await ready();
    fireEvent.keyDown(list(), { key: 'j' }); expect(selectedDescription()).toBe('Second fixture task');
    fireEvent.keyDown(list(), { key: ':' }); await user.type(screen.getByRole('combobox', { name: 'Task command' }), 'm due:to');
    currentTasks = [{ ...originalTasks[1], id: 8 }, { ...originalTasks[0], id: 9 }];
    act(() => MockEventSource.instances.at(-1)!.emit('change'));
    await screen.findByRole('button', { name: 'Mark task 8' });
    expect(selectedDescription()).toBe('Second fixture task');
    expect(screen.getByRole('combobox', { name: 'Task command' })).toHaveValue('m due:to');
    expect(screen.getByRole('combobox', { name: 'Task command' })).toHaveFocus();
    expect(JSON.parse(localStorage.getItem('taskwarrior.view')!)).toEqual({ report: 'next', theme: 'system' });
  });
  it.each(['m', ':'])('keeps the %s prompt target after the task disappears and another row is clicked', async key => {
    const user = userEvent.setup(); await ready();
    fireEvent.keyDown(list(), { key });
    const input = screen.getByRole('combobox', { name: 'Task command' });
    await user.type(input, key === 'm' ? 'due:tomorrow' : 'm due:tomorrow');
    currentTasks = [originalTasks[1]];
    act(() => MockEventSource.instances.at(-1)!.emit('change'));
    await waitFor(() => expect(selectedDescription()).toBe('Second fixture task'));
    expect(screen.getByLabelText('Command entry')).toHaveTextContent('1 task targeted · uuid-one');
    await user.click(screen.getByText('Second fixture task'));
    await user.click(input); await user.keyboard('{Enter}');
    await waitFor(() => expect(commands[0]).toMatchObject({ command: 'm due:tomorrow', uuids: ['uuid-one'] }));
    expect(currentTasks[0]).toEqual(originalTasks[1]);
  });
  it('keeps the nearest row when the focused UUID disappears during triage', async () => {
    currentTasks = [...originalTasks, { ...originalTasks[0], id: 3, uuid: 'uuid-three', description: 'Third fixture task' }];
    await ready(); fireEvent.keyDown(list(), { key: 'j' });
    currentTasks = [currentTasks[0], currentTasks[2]];
    act(() => MockEventSource.instances.at(-1)!.emit('change'));
    await waitFor(() => expect(selectedDescription()).toBe('Third fixture task'));
    currentTasks = [currentTasks[0]];
    act(() => MockEventSource.instances.at(-1)!.emit('change'));
    await waitFor(() => expect(selectedDescription()).toBe('First fixture task'));
  });
  it('submits per-task toggle for a mixed marked selection and preserves UUID capture', async () => {
    const user = userEvent.setup(); currentTasks = [{ ...originalTasks[0], start: '20261102T120000Z' }, originalTasks[1]];
    await ready();
    await user.click(screen.getByRole('button', { name: 'Mark task 1' }));
    await user.click(screen.getByRole('button', { name: 'Mark task 2' }));
    fireEvent.keyDown(list(), { key: 'b' });
    currentTasks = [originalTasks[1]]; act(() => MockEventSource.instances.at(-1)!.emit('change'));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(commands[0]).toMatchObject({ command: 'toggle', uuids: ['uuid-one', 'uuid-two'] }));
  });
  it('opens additive/removal tag syntax without replacing the full tag set', async () => {
    await ready(); fireEvent.keyDown(list(), { key: 'T' });
    expect(screen.getByRole('combobox', { name: 'Task command' })).toHaveValue('m ');
    expect(screen.getByText('Tags: +tag adds and -tag removes; other tags stay unchanged.')).toBeInTheDocument();
  });
  it('rejects stale in-flight report responses even when fetch ignores abort', async () => {
    await ready();
    let resolveOld!: (value: Response) => void;
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((path: string, options?: RequestInit) => {
      if (path.includes('report=completed')) return new Promise<Response>(resolve => { resolveOld = resolve; });
      return base(path, options);
    }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Report' }), { target: { value: 'completed' } });
    await waitFor(() => expect(resolveOld).toBeDefined());
    fireEvent.change(screen.getByRole('combobox', { name: 'Report' }), { target: { value: 'next' } });
    await screen.findByText('First fixture task');
    await act(async () => resolveOld(json(response([{ ...originalTasks[0], description: 'Stale completed result' }], 'completed'))));
    expect(screen.queryByText('Stale completed result')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Report' })).toHaveValue('next');
  });
  it('keeps failed mutation errors and editable draft across background refresh', async () => {
    const user = userEvent.setup(); await ready(); commandError = true;
    fireEvent.keyDown(list(), { key: ':' });
    const input = screen.getByRole('combobox', { name: 'Task command' });
    await user.type(input, 'm due:invalid'); await user.keyboard('{Enter}');
    await screen.findByRole('alert'); expect(screen.getByRole('alert')).toHaveTextContent('Invalid date fixture');
    act(() => MockEventSource.instances.at(-1)!.emit('change'));
    await waitFor(() => expect(screen.getByRole('region', { name: /Task list/ })).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid date fixture'); expect(input).toHaveValue('m due:invalid');
    await user.type(input, 'x'); expect(input).toHaveValue('m due:invalidx');
  });
  it('confirms done with captured UUID, while undo remains direct', async () => {
    const user = userEvent.setup(); await ready(); fireEvent.keyDown(list(), { key: 'd' });
    expect(commands).toHaveLength(0);
    const dialog = screen.getByRole('dialog', { name: 'Complete selected tasks?' });
    currentTasks = [originalTasks[1]]; act(() => MockEventSource.instances.at(-1)!.emit('change'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(commands[0]).toMatchObject({ command: 'd', uuids: ['uuid-one'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.keyDown(list(), { key: 'u' }); await waitFor(() => expect(commands[1]?.command).toBe('undo'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('dispatches default VIT S directly to sync without task UUIDs or confirmation', async () => {
    await ready(); fireEvent.keyDown(list(), { key: 'S' });
    await waitFor(() => expect(commands[0]).toMatchObject({ command: 'sync', uuids: [] }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('retains browser shortcuts and never handles navigation letters in regular inputs', async () => {
    const user = userEvent.setup(); await ready(); const filter = screen.getByRole('textbox', { name: 'Task filter' });
    await user.type(filter, 'j'); expect(filter).toHaveValue('j'); expect(selectedDescription()).toBe('First fixture task');
    const key = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true });
    list().dispatchEvent(key); expect(key.defaultPrevented).toBe(false);
    fireEvent.keyDown(list(), { key: ' ', isComposing: true }); expect(selectedDescription()).toBe('First fixture task');
  });
  it('uses b to start and Space to navigate, with ? reserved for reverse search', async () => {
    await ready(); fireEvent.keyDown(list(), { key: ' ' }); expect(selectedDescription()).toBe('Second fixture task');
    expect(screen.getByRole('button', { name: 'Mark task 2' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(list(), { key: 'b' }); expect(screen.getByRole('dialog', { name: 'Toggle start / stop?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(list(), { key: '?' }); expect(screen.getByRole('textbox', { name: 'Search query' })).toHaveFocus();
    expect(screen.queryByRole('dialog', { name: 'Keyboard reference' })).not.toBeInTheDocument();
  });
});
