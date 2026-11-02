import type { Task } from './types';

export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const iso = value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
/** VIT's compact duration ladder; preserve the sign across midnight. */
export function formatDuration(seconds: number): string {
  const magnitude = Math.abs(seconds);
  const units: [number, number, string][] = [
    [60, 1, 's'], [3600, 60, 'm'], [86400, 3600, 'h'],
    [86400 * 14, 86400, 'd'], [86400 * 90, 86400 * 7, 'w'],
    [86400 * 365, 86400 * 30, 'mo'], [Infinity, 86400 * 365, 'y'],
  ];
  const [, divisor, label] = units.find(([threshold]) => magnitude <= threshold)!;
  return `${seconds < 0 ? '-' : ''}${Math.floor(magnitude / divisor)}${label}`;
}
export function relativeDate(value: unknown): string {
  const date = parseDate(value);
  return date ? formatDuration((date.getTime() - Date.now()) / 1000) : '—';
}
export function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (Array.isArray(value)) return value.map(displayValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
const dateFields = new Set(['entry', 'modified', 'start', 'end', 'due', 'wait', 'scheduled', 'until']);
/** Working-set IDs of the blockers that still exist as open tasks, ascending. */
export function blockedBy(task: Task, dependencyIds: Record<string, number>): number[] {
  const value = task.depends;
  if (!Array.isArray(value)) return [];
  return value.map(uuid => dependencyIds[String(uuid).toLowerCase()])
    .filter((id): id is number => typeof id === 'number' && id > 0)
    .sort((left, right) => left - right);
}
export function columnValue(task: Task, column: string, dependencyIds: Record<string, number> = {}): string {
  const [attribute, modifier] = column.split('.');
  const value = task[attribute];
  if (attribute === 'id') return typeof value === 'number' && value > 0 ? String(value) : task.uuid.slice(0, 8);
  if (attribute === 'description') {
    if (['count', 'truncated_count'].includes(modifier)) return `${task.description}${task.annotations?.length ? ` [${task.annotations.length}]` : ''}`;
    if (modifier === 'truncated') return task.description;
    return task.description;
  }
  if (modifier === 'indicator') return value && (!Array.isArray(value) || value.length) ? ({ depends: '↳', recur: '↻', tags: '+', annotations: '≡' }[attribute] ?? '●') : '';
  if (modifier === 'count' && Array.isArray(value)) return value.length ? String(value.length) : '';
  if (attribute === 'project' && modifier === 'parent') return typeof value === 'string' ? value.split('.').slice(0, -1).join('.') : '';
  if (attribute === 'status' && modifier === 'short') return typeof value === 'string' ? value[0].toUpperCase() : '';
  if (attribute === 'start' && modifier === 'active') return value ? '▶' : '';
  if (attribute === 'urgency' && typeof value === 'number') return value.toFixed(1);
  if (attribute === 'uuid' && modifier === 'short') return task.uuid.slice(0, 8);
  if (dateFields.has(attribute)) {
    const date = parseDate(value);
    if (!date) return '—';
    if (modifier === 'age') return formatDuration((Date.now() - date.getTime()) / 1000);
    if (modifier === 'relative') return relativeDate(value);
    // VIT omits elapsed countdown/remaining fields, but signed relative dates stay visible.
    if (['countdown', 'remaining'].includes(modifier)) return date.getTime() < Date.now() ? '' : relativeDate(value);
    if (modifier === 'iso') return date.toISOString();
    if (modifier === 'epoch') return String(Math.floor(date.getTime() / 1000));
    if (modifier === 'julian') return String(Math.floor(date.getTime() / 86400000 + 2440587.5));
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  }
  if (attribute === 'annotations' && Array.isArray(value)) return value.map(annotation => (annotation as { description: string }).description).join(' · ');
  // Only resolvable blockers get IDs. A completed dependency has no working-set ID
  // and is omitted, as the native Deps column omits it; a UUID fragment is never shown.
  if (attribute === 'depends' && Array.isArray(value)) {
    const blockers = blockedBy(task, dependencyIds);
    return blockers.length ? blockers.join(', ') : '—';
  }
  return displayValue(value);
}
/** Started and still open. Taskwarrior keeps `start` on some completed tasks. */
export function inProgress(task: Task): boolean {
  return task.status === 'pending' && !!task.start;
}
export function isOverdue(task: Task): boolean {
  const due = parseDate(task.due);
  return !!due && due.getTime() < Date.now() && task.status === 'pending';
}
export function safeLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}
