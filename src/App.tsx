import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Check, ChevronDown, CircleHelp, Command, ExternalLink, Filter, Moon, Plus, RefreshCw, Sun, Terminal, X } from 'lucide-react';
import { api } from './api';
import { CommandBar, type InputMode } from './CommandBar';
import { Modal } from './Modal';
import { columnValue, displayValue, isOverdue, parseDate, safeLink } from './format';
import { tokenize } from './completion';
import type { CommandResponse, Meta, Task, TaskResponse } from './types';

type Theme = 'system' | 'light' | 'dark';
interface Preferences { report?: string; theme: Theme }
function readPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem('taskwarrior.view') || '{}');
    return { report: typeof stored.report === 'string' ? stored.report : undefined, theme: ['light', 'dark', 'system'].includes(stored.theme) ? stored.theme : 'system' };
  } catch { return { theme: 'system' }; }
}
function confirmationTitle(command: string): string {
  const name = tokenize(command.trim().replace(/^:/, ''))[0]?.value;
  if (['D', 'delete'].includes(name)) return 'Delete selected tasks?';
  if (['d', 'done'].includes(name)) return 'Complete selected tasks?';
  if (['toggle', 'b', 's'].includes(name)) return 'Toggle start / stop?';
  return name === 'stop' ? 'Stop selected tasks?' : 'Start selected tasks?';
}
const keyboardGroups = [
  ['Move', [['j / k · ↓ / ↑', 'Next / previous task'], ['gg / 0 · G', 'First / last task'], ['Ctrl F / Ctrl B · PgDn / PgUp', 'Page down / up'], ['H / M / L · C', 'Viewport top / middle / bottom · center row'], ['Enter / =', 'Show task details']]],
  ['Task actions', [['a · m', 'Add · modify'], ['d · D', 'Done · delete (confirm)'], ['b', 'Start / stop (confirm)'], ['A · E', 'Annotate · denotate'], ['P / p / T / w', 'Priority / project / tags / wait'], ['u', 'Undo the most recent change']]],
  ['Find & commands', [[':', 'Taskwarrior command entry'], ['/ · ?', 'Search forward · backward'], ['n · N', 'Repeat search · reverse'], ['f · c', 'Filter · context command'], ['Tab / Shift Tab', 'Insert / cycle command hints'], ['Esc', 'Dismiss hints, then close entry']]],
  ['Browser additions', [['r · R', 'Choose report · next report'], ['v · V', 'Toggle mark · clear all marks'], ['+ / −', 'Tiebreak ±1 (when configured)'], ['q / Esc', 'Close details or overlay'], ['F1', 'This keyboard reference'], ['Refresh button', 'Re-read tasks (Ctrl L stays browser-owned)']]],
] as const;

export default function App() {
  const [preferences] = useState(readPreferences);
  const [theme, setTheme] = useState<Theme>(preferences.theme);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [report, setReport] = useState(preferences.report ?? '');
  const [filter, setFilter] = useState('');
  const [filterInput, setFilterInput] = useState('');
  const [snapshot, setSnapshot] = useState<{ key: string; data: TaskResponse } | null>(null);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const [selected, setSelected] = useState<string | null>(null);
  const [marks, setMarks] = useState<Set<string>>(new Set());
  const marksRef = useRef(marks); marksRef.current = marks;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [detail, setDetail] = useState(false);
  const [help, setHelp] = useState(false);
  const [reportPicker, setReportPicker] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [mode, setMode] = useState<InputMode>('command');
  const [draft, setDraft] = useState('');
  const [commandIntent, setCommandIntent] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [lastSearch, setLastSearch] = useState({ value: '', direction: 1 });
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ command: string; uuids: string[]; fromInput: boolean } | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const table = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const metadataRequest = useRef(0);
  const mutationPending = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const currentQuery = useRef('');
  const query = JSON.stringify([report, filter]);
  currentQuery.current = query;
  const tasks = snapshot?.key === query ? snapshot.data.tasks : [];
  const task = tasks.find(task => task.uuid === selected);
  const visibleMarks = tasks.filter(task => marks.has(task.uuid)).map(task => task.uuid);
  const targets = visibleMarks.length ? visibleMarks : task ? [task.uuid] : [];
  const currentReport = snapshot?.key === query ? snapshot.data.report : meta?.reports.find(item => item.name === report);
  const configuredColumns = currentReport?.columns?.length ? currentReport.columns : ['id', 'project', 'priority', 'due', 'description', 'urgency'];
  const columns = configuredColumns.filter(column => meta?.printEmptyColumns || !tasks.length || tasks.some(item => {
    const value = item[column.split('.')[0]];
    return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
  }));

  const loadMeta = useCallback(async () => {
    const generation = ++metadataRequest.current;
    try {
      const data = await api<Meta>('meta');
      if (generation !== metadataRequest.current) return;
      setMeta(data);
      setReport(previous => data.reports.some(item => item.name === previous) ? previous : data.defaultReport);
    } catch (reason) { if (generation === metadataRequest.current) { setReadError((reason as Error).message); setLoading(false); } }
  }, []);
  useEffect(() => { void loadMeta(); }, [loadMeta]);

  const refresh = useCallback(async () => {
    if (!report) return;
    abort.current?.abort();
    const controller = new AbortController(); abort.current = controller;
    const generation = ++request.current;
    const key = JSON.stringify([report, filter]);
    setLoading(true);
    try {
      const data = await api<TaskResponse>(`tasks?${new URLSearchParams({ report, filter })}`, { signal: controller.signal });
      if (generation !== request.current || key !== currentQuery.current) return;
      const previousTasks = snapshotRef.current?.key === key ? snapshotRef.current.data.tasks : [];
      setSnapshot({ key, data });
      setSelected(previous => {
        if (data.tasks.some(task => task.uuid === previous)) return previous;
        const previousIndex = Math.max(0, previousTasks.findIndex(task => task.uuid === previous));
        return data.tasks[Math.min(previousIndex, data.tasks.length - 1)]?.uuid ?? null;
      });
      const removedMarks = [...marksRef.current].filter(uuid => !data.tasks.some(task => task.uuid === uuid));
      setMarks(previous => new Set([...previous].filter(uuid => data.tasks.some(task => task.uuid === uuid))));
      if (removedMarks.length) setNotice(`${removedMarks.length} marked task${removedMarks.length === 1 ? '' : 's'} left this view and ${removedMarks.length === 1 ? 'was' : 'were'} removed from the selection.`);
      setReadError(''); setLastUpdated(new Date());
    } catch (reason) {
      if ((reason as Error).name !== 'AbortError' && generation === request.current && key === currentQuery.current) setReadError((reason as Error).message);
    } finally { if (generation === request.current && key === currentQuery.current) setLoading(false); }
  }, [report, filter]);
  useEffect(() => { void refresh(); return () => { abort.current?.abort(); request.current++; }; }, [refresh]);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    const source = new EventSource('/api/events');
    const ready = () => { setConnection('live'); void refreshRef.current(); void loadMeta(); };
    source.addEventListener('ready', ready);
    source.addEventListener('change', () => { void refreshRef.current(); void loadMeta(); });
    source.onopen = () => { setConnection('live'); void refreshRef.current(); };
    source.onerror = () => setConnection('offline');
    const online = () => { void refreshRef.current(); void loadMeta(); };
    const offline = () => setConnection('offline');
    const visible = () => { if (document.visibilityState === 'visible') online(); };
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshRef.current(); }, 60000);
    window.addEventListener('online', online); window.addEventListener('offline', offline); window.addEventListener('focus', online);
    document.addEventListener('visibilitychange', visible);
    return () => {
      source.close(); window.clearInterval(timer); window.removeEventListener('online', online); window.removeEventListener('offline', offline); window.removeEventListener('focus', online); document.removeEventListener('visibilitychange', visible);
    };
  }, [loadMeta]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const resolved = theme === 'system' ? media.matches ? 'dark' : 'light' : theme;
      document.documentElement.dataset.mode = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#171717' : '#f9f9f9');
    };
    update(); media.addEventListener('change', update);
    // Only view preferences are persisted. Drafts, filters, descriptions and history stay in memory.
    try { localStorage.setItem('taskwarrior.view', JSON.stringify({ report, theme })); } catch { /* Private browsing can disable storage. */ }
    return () => media.removeEventListener('change', update);
  }, [theme, report]);
  useEffect(() => { if (selected) document.getElementById(`task-${selected}`)?.scrollIntoView({ block: 'nearest' }); }, [selected]);

  function focusTable() { table.current?.focus(); }
  function openCommand(value?: string, nextMode: InputMode = 'command', intent = '') {
    if (value !== undefined) { if (nextMode === 'command') setDraft(value); else setSearchDraft(value); }
    setCommandIntent(intent); setMode(nextMode); setInputOpen(true); setNotice('');
  }
  function closeCommand() { setInputOpen(false); focusTable(); }
  function move(delta: number, absolute = false) {
    const index = tasks.findIndex(task => task.uuid === selected);
    const next = Math.max(0, Math.min(tasks.length - 1, absolute ? delta : index + delta));
    if (tasks[next]) setSelected(tasks[next].uuid);
  }
  function toggleMark(uuid: string) {
    setMarks(previous => { const next = new Set(previous); if (next.has(uuid)) next.delete(uuid); else next.add(uuid); return next; });
  }
  function find(value: string, direction: number) {
    if (!value) return;
    const index = tasks.findIndex(task => task.uuid === selected);
    for (let offset = 1; offset <= tasks.length; offset++) {
      const candidate = tasks[(index + direction * offset + tasks.length * 2) % tasks.length];
      if (Object.values(candidate).map(displayValue).join(' ').toLowerCase().includes(value.toLowerCase())) {
        setSelected(candidate.uuid); setNotice(`Found “${value}”${index + direction * offset >= tasks.length || index + direction * offset < 0 ? ' · wrapped' : ''}`); return;
      }
    }
    setNotice(`No visible tasks match “${value}”.`);
  }
  async function execute(command: string, uuids: string[], fromInput = false) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setBusy(true); setNotice(''); setError('');
    const viewAtStart = currentQuery.current;
    try {
      const result = await api<CommandResponse>('command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, uuids, report }) });
      setNotice(result.output || 'Command completed.');
      if (currentQuery.current === viewAtStart) {
        if (result.report !== undefined) setReport(result.report);
        if (result.filter !== undefined) { setFilter(result.filter); setFilterInput(result.filter); }
      }
      if (fromInput && draftRef.current === command) { setDraft(''); setInputOpen(false); focusTable(); }
      setConfirmation(null);
      void refreshRef.current(); void loadMeta();
    } catch (reason) { setError((reason as Error).message); setConfirmation(null); }
    finally { mutationPending.current = false; setBusy(false); }
  }
  function requestCommand(command: string, uuids: string[], fromInput = false) {
    const name = tokenize(command.trim().replace(/^:/, ''))[0]?.value;
    if (['D', 'delete', 'd', 'done', 'b', 's', 'toggle', 'start', 'stop'].includes(name)) setConfirmation({ command, uuids: [...uuids], fromInput });
    else void execute(command, uuids, fromInput);
  }
  function submit(value: string) {
    if (mode !== 'command') {
      const direction = mode === 'reverse' ? -1 : 1;
      setLastSearch({ value, direction }); find(value, direction); closeCommand(); return;
    }
    if (!value.trim() || busy) return;
    const name = tokenize(value.trim().replace(/^:/, ''))[0]?.value;
    if (['help', 'h'].includes(name)) { setHelp(true); closeCommand(); return; }
    if (name === 'q') { setDetail(false); closeCommand(); return; }
    if (meta?.reports.some(item => item.name === name)) {
      const raw = value.trim().replace(/^:/, '').trim();
      const afterName = tokenize(raw)[0]?.end ?? raw.length;
      const nextFilter = raw.slice(afterName).trim();
      setReport(name); setFilter(nextFilter); setFilterInput(nextFilter); setMarks(new Set());
      setDraft(''); closeCommand(); return;
    }
    if (/^\d+$/.test(name)) {
      const match = tasks.find(item => item.id === Number(name));
      if (match) { setSelected(match.uuid); closeCommand(); } else setError(`Task ID ${name} is not in the current view.`);
      return;
    }
    const mutation = !['r', 'report', 'f', 'filter', 'context', 'c', ...(meta?.reports.map(report => report.name) ?? [])].includes(name);
    if (loading && mutation) { setError('Wait for the current task view before changing tasks.'); return; }
    requestCommand(value, targets, true);
  }

  const keyPrefix = useRef({ key: '', at: 0 });
  useLayoutEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.isComposing || event.keyCode === 229 || target.closest('input, textarea, select, [contenteditable="true"], button, a, [role="dialog"]') || help || confirmation || reportPicker) return;
      if (event.metaKey || event.altKey) return;
      const page = Math.max(1, Math.floor((table.current?.clientHeight ?? 450) / 32) - 2);
      if (event.ctrlKey) {
        if (['f', 'b'].includes(event.key.toLowerCase())) { event.preventDefault(); move(event.key.toLowerCase() === 'f' ? page : -page); }
        return; // Browser Ctrl L, Ctrl R, Ctrl W, Ctrl D, Ctrl U etc. remain untouched.
      }
      const previous = keyPrefix.current;
      keyPrefix.current = { key: event.key, at: Date.now() };
      const keys: Record<string, () => void> = {
        j: () => move(1), ArrowDown: () => move(1), ' ': () => move(1), k: () => move(-1), ArrowUp: () => move(-1),
        PageDown: () => move(page), PageUp: () => move(-page), G: () => move(tasks.length - 1, true), '0': () => move(0, true),
        H: () => move(Math.floor((table.current?.scrollTop ?? 0) / 32), true), M: () => move(Math.floor(((table.current?.scrollTop ?? 0) + (table.current?.clientHeight ?? 0) / 2) / 32), true), L: () => move(Math.floor(((table.current?.scrollTop ?? 0) + (table.current?.clientHeight ?? 0)) / 32) - 2, true),
        g: () => { if (previous.key === 'g' && Date.now() - previous.at < 700) move(0, true); },
        Enter: () => { if (task) setDetail(true); }, '=': () => { if (task) setDetail(true); },
        ':': () => openCommand(), a: () => openCommand('a '), m: () => openCommand('m '), A: () => openCommand('A '), E: () => openCommand('denotate '),
        d: () => { if (task && !loading && !busy) requestCommand('d', targets); }, D: () => { if (task && !loading && !busy) requestCommand('D', targets); },
        b: () => { if (task && !loading && !busy) requestCommand('toggle', targets); }, u: () => requestCommand('undo', []),
        P: () => openCommand('m priority:'), p: () => openCommand('m project:'), T: () => openCommand('m ', 'command', 'Tags: +tag adds and -tag removes; other tags stay unchanged.'), w: () => openCommand('m wait:'),
        f: () => openCommand(`f ${filter}`), c: () => openCommand('context '), r: () => setReportPicker(true), R: () => setReport('next'),
        C: () => { if (selected) document.getElementById(`task-${selected}`)?.scrollIntoView({ block: 'center' }); },
        '+': () => { if (task && !loading && meta?.attributes.includes('tiebreak')) void execute('tiebreak 1', targets); },
        '-': () => { if (task && !loading && meta?.attributes.includes('tiebreak')) void execute('tiebreak -1', targets); },
        '/': () => openCommand('', 'search'), '?': () => openCommand('', 'reverse'), n: () => find(lastSearch.value, lastSearch.direction), N: () => find(lastSearch.value, -lastSearch.direction),
        v: () => { if (task) toggleMark(task.uuid); }, V: () => setMarks(new Set()),
        q: () => { setDetail(false); setInputOpen(false); }, Escape: () => { setDetail(false); setInputOpen(false); setNotice(''); }, F1: () => setHelp(true),
      };
      if (keys[event.key]) { event.preventDefault(); keys[event.key](); }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><Terminal size={20} strokeWidth={1.7} /><h1>Taskwarrior</h1><span className="brand-divider" /><span className="workspace-label">workspace</span></div>
      <div className="top-actions"><span className={`live-status ${connection}`} role="status"><span className="status-dot" />{connection === 'live' ? 'Live' : connection === 'offline' ? 'Reconnecting' : 'Connecting'}</span>
        <button type="button" className="icon-button" aria-label={`Theme: ${theme}. Change theme`} title={`Theme: ${theme}`} onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}>{theme === 'dark' ? <Moon size={16} /> : <Sun size={17} />}</button>
        <button type="button" className="icon-button" aria-label="Keyboard help" title="Keyboard help (F1)" onClick={() => setHelp(true)}><CircleHelp size={17} /></button>
      </div>
    </header>
    <section className="toolbar" aria-label="Task view controls">
      <div className="report-control"><label htmlFor="report-select">REPORT</label><div className="select-wrap"><select id="report-select" aria-label="Report" value={report} onChange={event => { setReport(event.target.value); setMarks(new Set()); }}>
        {!meta && <option value="">Loading…</option>}{meta?.reports.map(item => <option value={item.name} key={item.name}>{item.name}</option>)}
      </select><ChevronDown size={13} /></div></div>
      <div className="context-control"><label htmlFor="context-select">CONTEXT</label><div className="select-wrap"><select id="context-select" aria-label="Context" value={snapshot?.data.context || 'none'} disabled={busy || !meta} onChange={event => void execute(`context ${event.target.value}`, [])}>
        <option value="none">none</option>{meta?.contexts.map(context => <option value={context} key={context}>{context}</option>)}
        {snapshot?.data.context && !meta?.contexts.includes(snapshot.data.context) && <option value={snapshot.data.context}>{snapshot.data.context}</option>}
      </select><ChevronDown size={13} /></div></div>
      <form className="filter-form" onSubmit={event => { event.preventDefault(); setFilter(filterInput); setMarks(new Set()); }}><Filter size={14} /><input aria-label="Task filter" value={filterInput} onChange={event => setFilterInput(event.target.value)} placeholder="Filter tasks…  project:work +tag" autoComplete="off" spellCheck={false} />{filterInput && <button type="button" className="icon-button small" aria-label="Clear filter" onClick={() => { setFilterInput(''); setFilter(''); }}><X size={13} /></button>}<button type="submit" className="filter-apply">Apply</button></form>
      <button type="button" className={`icon-button ${loading ? 'refreshing' : ''}`} aria-label="Refresh tasks" title="Refresh tasks" onClick={() => { void refresh(); void loadMeta(); }}><RefreshCw size={16} /></button>
      <button type="button" className="primary add-button" onClick={() => openCommand('a ')}><Plus size={15} />Add task<kbd>a</kbd></button>
    </section>
    <div className="report-summary"><div><strong>{currentReport?.description || report || 'Tasks'}</strong><span className="count">{tasks.length}</span>{filter && <span className="applied-filter">{filter}</span>}</div><span>{visibleMarks.length ? <button type="button" className="text-button" onClick={() => setMarks(new Set())}>{visibleMarks.length} marked · clear</button> : lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Reading task database…'}</span></div>
    {connection === 'offline' && <div className="connection-banner" role="status">Live connection interrupted. Showing the last received view; reconnecting automatically. <button type="button" className="text-button" onClick={() => void refresh()}>Refresh now</button></div>}
    {(error || readError) && <div className="message error" role="alert"><span>{error || readError}</span><button type="button" className="icon-button small" aria-label="Dismiss error" onClick={() => { setError(''); setReadError(''); }}><X size={14} /></button></div>}
    {notice && <div className="message notice" role="status"><pre>{notice}</pre><button type="button" className="icon-button small" aria-label="Dismiss command output" onClick={() => setNotice('')}><X size={14} /></button></div>}
    <main className={`workspace ${detail && task ? 'has-detail' : ''}`}>
      <div className="task-region" ref={table} tabIndex={0} role="region" aria-label="Task list. Use j and k to navigate, Enter for details." aria-busy={loading}>
        <table className="task-table" aria-label={`${report || 'Task'} report`}>
          <thead><tr><th className="mark-cell"><span className="sr-only">Mark</span></th>{columns.map((column, index) => <th key={`${column}-${index}`} className={`column-${column.split('.')[0]}`} scope="col">{currentReport?.labels[configuredColumns.indexOf(column)] || column.split('.')[0]}{currentReport?.sort?.split(',').some(sort => sort.replace(/[+-]/g, '') === column.split('.')[0]) && <ArrowDown size={10} className="sort-indicator" />}</th>)}</tr></thead>
          <tbody>{tasks.map(item => <tr id={`task-${item.uuid}`} key={item.uuid} tabIndex={-1} aria-selected={selected === item.uuid} className={`${selected === item.uuid ? 'selected' : ''} ${marks.has(item.uuid) ? 'marked' : ''} ${item.start ? 'started' : ''}`} onClick={() => { setSelected(item.uuid); focusTable(); }} onDoubleClick={() => { setSelected(item.uuid); setDetail(true); }}>
            <td className="mark-cell"><button type="button" className={`mark-button ${marks.has(item.uuid) ? 'checked' : ''}`} aria-label={`Mark task ${item.id ?? item.uuid.slice(0, 8)}`} aria-pressed={marks.has(item.uuid)} onClick={event => { event.stopPropagation(); toggleMark(item.uuid); focusTable(); }}><Check size={11} /></button></td>
            {columns.map((column, index) => {
              const attribute = column.split('.')[0], value = columnValue(item, column, tasks), link = safeLink(item[attribute]);
              return <td key={`${column}-${index}`} className={`column-${attribute} ${attribute === 'due' && isOverdue(item) ? 'overdue' : ''} ${attribute === 'priority' && item.priority ? `priority-${item.priority}` : ''}`} title={attribute === 'description' ? item.description : displayValue(item[attribute])}>
                {link ? <a href={link} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>{value}<ExternalLink size={10} /></a> : value}
              </td>;
            })}
          </tr>)}</tbody>
        </table>
        {!tasks.length && <div className="empty-state"><Terminal size={26} strokeWidth={1.2} /><h2>{loading ? 'Reading tasks…' : readError ? 'Unable to load this view' : 'No tasks in this view'}</h2><p>{loading ? 'Fetching your configured report.' : readError ? 'Check the error above, then refresh.' : 'Try another report, clear the filter, or add your next task.'}</p>{!loading && !readError && <button type="button" className="secondary" onClick={() => openCommand('a ')}><Plus size={14} />Add task</button>}</div>}
      </div>
      {detail && task && <aside className="detail-panel" aria-label="Task details"><div className="detail-header"><span>TASK {task.id ?? '—'}</span><button type="button" className="icon-button" aria-label="Close task details" onClick={() => { setDetail(false); focusTable(); }}><X size={17} /></button></div><h2>{task.description}</h2><div className="detail-actions"><button type="button" className="secondary" disabled={busy || loading} onClick={() => openCommand('m ')}>Modify<kbd>m</kbd></button><button type="button" className="secondary" disabled={busy || loading} onClick={() => requestCommand('done', [task.uuid])}><Check size={14} />Done</button><button type="button" className="secondary" disabled={busy || loading} onClick={() => openCommand('A ')}>Annotate</button></div><dl className="detail-fields">{Object.entries(task).filter(([key]) => !['description', 'annotations'].includes(key)).map(([key, value]) => {
        const link = safeLink(value), date = parseDate(value);
        return <div key={key}><dt>{key}</dt><dd>{link ? <a href={link} target="_blank" rel="noreferrer">{displayValue(value)}<ExternalLink size={11} /></a> : date && /^\d{8}T/.test(String(value)) ? date.toLocaleString() : displayValue(value)}</dd></div>;
      })}</dl><div className="annotation-heading"><h3>Annotations</h3><span>{task.annotations?.length ?? 0}</span></div>{task.annotations?.length ? <ol className="annotations">{task.annotations.map((annotation, index) => <li key={`${annotation.entry}-${index}`}><time>{parseDate(annotation.entry)?.toLocaleString() ?? annotation.entry}</time><p>{annotation.description}</p></li>)}</ol> : <p className="muted">No annotations. Press <kbd>A</kbd> to add one.</p>}<p className="detail-note"><kbd>j</kbd><kbd>k</kbd> navigate · <kbd>q</kbd> close</p></aside>}
    </main>
    <CommandBar open={inputOpen} mode={mode} draft={mode === 'command' ? draft : searchDraft} onDraft={mode === 'command' ? setDraft : setSearchDraft} onClose={closeCommand} onSubmit={submit} meta={meta} tasks={tasks} busy={busy} targetCount={targets.length} intent={commandIntent} />
    <footer className="footer"><div className="keyboard-hints"><span><kbd>j</kbd><kbd>k</kbd> move</span><span><kbd>↵</kbd> details</span><span><kbd>m</kbd> modify</span><span><kbd>b</kbd> start / stop</span><span><kbd>/</kbd> find</span></div><button type="button" className="command-trigger" onClick={() => openCommand()}><Command size={13} /><span>{draft ? 'Resume command' : 'Command'}</span><kbd>:</kbd></button><span className="footer-count">{task ? `${tasks.findIndex(item => item.uuid === task.uuid) + 1} / ${tasks.length}` : `0 / ${tasks.length}`}</span></footer>
    {help && <Modal title="Keyboard reference" onClose={() => setHelp(false)} className="help-modal"><p className="modal-intro">VIT 2.3 default navigation and task keys. Shortcuts work when the task list is focused; normal inputs keep their own keys.</p><div className="key-groups">{keyboardGroups.map(([name, bindings]) => <section key={name}><h3>{name}</h3><dl>{bindings.map(([keys, description]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{description}</dd></div>)}</dl></section>)}</div><p className="modal-footnote">VIT’s external editor, terminal task prompt, sync and quit actions are not bound here. Ctrl L remains the browser address bar. Reports and columns come from your Taskwarrior configuration. :m / :add and other task commands are web extensions; VIT uses bare task-action keys. :ID selects a visible task; :help opens this reference.</p></Modal>}
    {reportPicker && <Modal title="Choose report" onClose={() => setReportPicker(false)}><div className="report-options">{meta?.reports.map(item => <button type="button" key={item.name} onClick={() => { setReport(item.name); setReportPicker(false); setMarks(new Set()); }}><span><strong>{item.name}</strong><small>{item.description}</small></span>{report === item.name && <Check size={15} />}</button>)}</div></Modal>}
    {confirmation && <Modal title={confirmationTitle(confirmation.command)} onClose={() => { if (!busy) setConfirmation(null); }}><p className="confirm-description">{`Apply this action to ${confirmation.uuids.length} selected task${confirmation.uuids.length === 1 ? '' : 's'}? Selection is captured by UUID.`}</p><code className="confirm-command">:{confirmation.command.replace(/^:/, '')}</code><div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={() => void execute(confirmation.command, confirmation.uuids, confirmation.fromInput)}>{busy ? 'Working…' : 'Confirm'}</button></div></Modal>}
  </div>;
}
