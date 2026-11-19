export const DAY = 24 * 60 * 60 * 1000;

export function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Value for <input type="datetime-local"> / "date" in local time. */
export function toLocalInput(iso: string | null, dateOnly = false) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return dateOnly ? date : `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string, dateOnly = false): string | null {
  if (!value) return null;
  const d = dateOnly ? new Date(`${value}T23:59:00`) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'none';

export function dueState(iso: string | null, done: boolean): DueState {
  if (!iso || done) return 'none';
  const due = new Date(iso);
  const now = new Date();
  if (due.getTime() < now.getTime()) return 'overdue';
  if (sameDay(due, now)) return 'today';
  if (due.getTime() - now.getTime() < 3 * DAY) return 'soon';
  return 'later';
}

export const DUE_COLORS: Record<DueState, string> = {
  overdue: '#ef4444', today: '#f59e0b', soon: 'var(--accent-primary)', later: 'var(--text-tertiary)', none: 'var(--text-tertiary)',
};

export function formatDue(iso: string, lang: string, allDay: boolean) {
  const d = new Date(iso);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  const date = d.toLocaleDateString(lang, opts);
  return allDay ? date : `${date}, ${d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })}`;
}

/** Monday-first 6×7 grid for the month containing `month`. */
export function monthGrid(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const shift = (first.getDay() + 6) % 7;
  const start = addDays(first, -shift);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
