import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { complete, insertCompletion, type Completion } from './completion';
import type { Meta, Task } from './types';

export type InputMode = 'command' | 'search' | 'reverse';
interface Props {
  open: boolean;
  mode: InputMode;
  draft: string;
  onDraft: (value: string) => void;
  onClose: () => void;
  onSubmit: (value: string) => void;
  meta: Meta | null;
  tasks: Task[];
  busy: boolean;
  targetCount: number;
  intent?: string;
}

export function CommandBar({ open, mode, draft, onDraft, onClose, onSubmit, meta, tasks, busy, targetCount, intent }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(draft.length);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const cycle = useRef<{ text: string; completion: Completion; index: number } | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const composing = useRef(false);
  const result = complete(draft, caret, meta, tasks);
  const show = open && mode === 'command' && !dismissed && result.suggestions.length > 0;
  // A completion cycle keeps its original range: repeated Tab replaces, never appends.
  const visible = cycle.current?.completion.suggestions ?? result.suggestions;

  useEffect(() => {
    if (open) {
      input.current?.focus();
      input.current?.setSelectionRange(draft.length, draft.length);
      setCaret(draft.length); setDismissed(false); setActive(-1); cycle.current = null;
    }
  }, [open, mode]); // Draft edits and live refresh must not refocus or move the caret.
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && input.current) {
      input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });
  useEffect(() => {
    document.getElementById(`completion-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function apply(completion: Completion, text: string, index: number) {
    const next = insertCompletion(text, completion, completion.suggestions[index].value);
    pendingCaret.current = next.caret;
    onDraft(next.text); setCaret(next.caret); setActive(index);
  }

  if (!open) return null;
  return <section className="command-area" aria-label={mode === 'command' ? 'Command entry' : 'Search tasks'}>
    {show && <div className="completions">
      <div className="completion-heading"><span>{cycle.current ? 'Cycling suggestions' : 'Suggestions'}</span><span>Tab / ⇧Tab insert & cycle · Enter runs · Esc dismisses</span></div>
      <ul id="command-completions" role="listbox" aria-label="Command suggestions">
        {visible.map((item, index) => <li key={`${item.kind}-${item.value}`} role="option" aria-selected={active === index} id={`completion-${index}`}>
          <button type="button" tabIndex={-1} className={active === index ? 'completion active' : 'completion'} onMouseDown={event => event.preventDefault()} onClick={() => {
            const base = cycle.current;
            apply(base?.completion ?? result, base?.text ?? draft, index);
            cycle.current = null; setDismissed(true); setActive(-1); input.current?.focus();
          }}><span className="completion-value">{item.label}</span><span className="completion-description">{item.description}</span><span className="completion-kind">{item.kind}</span></button>
        </li>)}
      </ul>
    </div>}
    <div className="command-meta"><span>{mode === 'command' ? `${targetCount} task${targetCount === 1 ? '' : 's'} targeted · UUID selection` : mode === 'reverse' ? 'Search backward · local visible tasks' : 'Search forward · local visible tasks'}</span><span>{mode === 'command' ? 'Taskwarrior syntax · no shell' : 'Enter to find · n / N repeat'}</span></div>
    <form onSubmit={event => { event.preventDefault(); if (!busy && !composing.current) onSubmit(draft); }} className="command-form">
      <span className="command-prompt" aria-hidden="true">{mode === 'command' ? ':' : mode === 'reverse' ? '?' : '/'}</span>
      <input ref={input} aria-label={mode === 'command' ? 'Task command' : 'Search query'} role={mode === 'command' ? 'combobox' : undefined} aria-autocomplete={mode === 'command' ? 'list' : undefined} aria-expanded={mode === 'command' ? show : undefined} aria-controls={show ? 'command-completions' : undefined} aria-activedescendant={show && active >= 0 ? `completion-${active}` : undefined} autoComplete="off" autoCapitalize="off" spellCheck={false} value={draft} placeholder={mode === 'command' ? intent || 'add a task · modify due:tomorrow · report next' : 'Find in visible tasks…'}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onChange={event => { onDraft(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); cycle.current = null; setActive(-1); setDismissed(false); }}
        onSelect={event => { const position = event.currentTarget.selectionStart ?? draft.length; if (position !== caret) { setCaret(position); cycle.current = null; setActive(-1); } }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation();
            if (show) { setDismissed(true); cycle.current = null; setActive(-1); } else onClose();
          } else if (mode === 'command' && event.key === 'Tab' && show) {
            event.preventDefault();
            const base = cycle.current ?? { text: draft, completion: result, index: active >= 0 ? active - (event.shiftKey ? -1 : 1) : event.shiftKey ? 0 : -1 };
            const index = (base.index + (event.shiftKey ? -1 : 1) + base.completion.suggestions.length) % base.completion.suggestions.length;
            cycle.current = { ...base, index }; apply(base.completion, base.text, index);
          } else if (show && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length);
          }
        }} />
      <button type="submit" className="icon-button" aria-label={mode === 'command' ? 'Run command' : 'Find task'} disabled={busy || !draft.trim()}><ArrowRight size={17} /></button>
      <button type="button" className="icon-button" aria-label="Close command entry" onClick={onClose}><X size={16} /></button>
    </form>
    <div className="command-note">{intent || (show ? 'Escape dismisses suggestions, then Tab moves focus normally.' : 'Enter runs · Esc closes · draft stays until submitted')}</div>
  </section>;
}
