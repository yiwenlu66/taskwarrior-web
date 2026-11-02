import { afterEach, describe, expect, it, vi } from 'vitest';
import { columnValue, formatDuration, relativeDate, safeLink } from './format';
import type { Task } from './types';
const task: Task = { uuid: 'aaaaaaaa-1111', id: 4, description: 'Fixture', status: 'pending' };
afterEach(() => vi.useRealTimers());

describe('VIT column formatting', () => {
  it('keeps signed hours for near-midnight future and overdue dates', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T23:00:00Z'));
    expect(relativeDate('20261103T020000Z')).toBe('3h');
    expect(relativeDate('20261102T200000Z')).toBe('-3h');
    expect(columnValue({ ...task, due: '20261103T020000Z' }, 'due.relative')).toBe('3h');
  });
  it('matches the duration ladder and only shows future countdown / remaining fields', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T23:00:00Z'));
    expect(formatDuration(-45)).toBe('-45s');
    expect(formatDuration(3 * 86400)).toBe('3d');
    expect(formatDuration(28 * 86400)).toBe('4w');
    expect(columnValue({ ...task, scheduled: '20261103T020000Z' }, 'scheduled.countdown')).toBe('3h');
    expect(columnValue({ ...task, until: '20261102T200000Z' }, 'until.remaining')).toBe('');
  });
  it('maps dependencies to ephemeral IDs and falls back to short UUIDs', () => {
    const dependency = { ...task, id: 12 };
    expect(columnValue({ ...task, depends: [task.uuid, 'missing-uuid-2222'] }, 'depends', [dependency])).toBe('12, missing-');
    expect(columnValue({ ...task, id: undefined }, 'id')).toBe('aaaaaaaa');
    expect(columnValue({ ...task, id: 0 }, 'id')).toBe('aaaaaaaa');
  });
  it('supports common report modifiers and safe external URLs', () => {
    expect(columnValue({ ...task, tags: ['a', 'b'] }, 'tags.count')).toBe('2');
    expect(columnValue({ ...task, project: 'work.research' }, 'project.parent')).toBe('work');
    expect(columnValue(task, 'status.short')).toBe('P');
    expect(safeLink('javascript:alert(1)')).toBeUndefined();
    expect(safeLink('https://example.com/')).toBe('https://example.com/');
  });
});
