import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommandBar } from './CommandBar';

function Harness({ initial = 'm due:', submit = vi.fn() }: { initial?: string; submit?: (value: string) => void }) {
  const [draft, setDraft] = useState(initial);
  return <><CommandBar open mode="command" draft={draft} onDraft={setDraft} onClose={vi.fn()} onSubmit={submit} meta={null} tasks={[]} busy={false} targetCount={1} /><button>Outside</button></>;
}

describe('command interaction', () => {
  it('cycles a stable token with Tab and Shift Tab without duplicating text', async () => {
    const user = userEvent.setup(); render(<Harness />);
    const input = screen.getByRole('combobox');
    await user.tab(); expect(input).toHaveValue('m due:today');
    await user.tab(); expect(input).toHaveValue('m due:tomorrow');
    await user.tab({ shift: true }); expect(input).toHaveValue('m due:today');
  });
  it('executes typed Enter immediately even with available hints', async () => {
    const submit = vi.fn(), user = userEvent.setup(); render(<Harness submit={submit} />);
    await user.keyboard('{Enter}'); expect(submit).toHaveBeenCalledWith('m due:');
  });
  it('runs the visible inserted hint with a single Enter after Tab', async () => {
    const submit = vi.fn(), user = userEvent.setup(); render(<Harness submit={submit} />);
    await user.tab(); expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox')).toHaveValue('m due:today');
    await user.keyboard('{Enter}'); expect(submit).toHaveBeenCalledExactlyOnceWith('m due:today');
  });
  it('only inserts an arrow-highlighted hint when Tab is pressed', async () => {
    const submit = vi.fn(), user = userEvent.setup(); render(<Harness submit={submit} />);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('combobox')).toHaveValue('m due:');
    await user.tab(); expect(screen.getByRole('combobox')).toHaveValue('m due:tomorrow');
    await user.keyboard('{Enter}'); expect(submit).toHaveBeenCalledExactlyOnceWith('m due:tomorrow');
  });
  it('allows normal Tab focus after Escape dismisses hints', async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.tab(); expect(screen.getByRole('button', { name: 'Run command' })).toHaveFocus();
  });
  it('does not consume IME composition Enter', () => {
    const submit = vi.fn(); render(<Harness submit={submit} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(submit).not.toHaveBeenCalled();
  });
});
