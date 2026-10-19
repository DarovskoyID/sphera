import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { reportError, useCore, useModuleT } from '@sfera/sdk';
import * as planner from './store';
import { monthGrid, sameDay, startOfDay } from './dates';
import { Button, IconButton, useIsMobile } from './ui';
import { PRIORITY_COLORS, type Task } from './types';

/**
 * Month grid of tasks by due date. Drag a task to another day to move it (the
 * time of day is kept); click the empty part of a day to add a task there.
 */
export function CalendarView({ tasks, isDone, colorOf, canEdit, onOpen, onCreate }: {
  tasks: Task[];
  isDone: (t: Task) => boolean;
  colorOf?: (t: Task) => string;
  canEdit: (t: Task) => boolean;
  onOpen: (t: Task) => void;
  onCreate?: (day: Date) => void;
}) {
  const t = useModuleT();
  const { language } = useCore();
  const mobile = useIsMobile();
  const [month, setMonth] = useState(() => startOfDay(new Date()));
  const [over, setOver] = useState<number | null>(null);
  const days = useMemo(() => monthGrid(month), [month]);
  const today = new Date();
  const weekdays = useMemo(() => days.slice(0, 7).map(d => d.toLocaleDateString(language, { weekday: mobile ? 'narrow' : 'short' })), [days, language, mobile]);

  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.due_at) continue;
      const key = startOfDay(new Date(task.due_at)).toDateString();
      map.set(key, [...(map.get(key) ?? []), task]);
    }
    for (const list of map.values()) list.sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''));
    return map;
  }, [tasks]);

  const shift = (n: number) => setMonth(m => new Date(m.getFullYear(), m.getMonth() + n, 1));

  const moveTo = (id: string, day: Date) => {
    const task = tasks.find(x => x.id === id);
    if (!task?.due_at || !canEdit(task)) return;
    const due = new Date(task.due_at);
    if (sameDay(due, day)) return;
    const next = new Date(day);
    next.setHours(due.getHours(), due.getMinutes(), 0, 0);
    planner.updateTask(task, { due_at: next.toISOString() }).catch(reportError);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: mobile ? 8 : 16, boxSizing: 'border-box', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <IconButton title={t('pl_prev_month')} onClick={() => shift(-1)}><ChevronLeft size={18} /></IconButton>
        <IconButton title={t('pl_next_month')} onClick={() => shift(1)}><ChevronRight size={18} /></IconButton>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
          {month.toLocaleDateString(language, { month: 'long', year: 'numeric' })}
        </h2>
        <Button small onClick={() => setMonth(startOfDay(new Date()))} style={{ marginLeft: 'auto' }}>{t('pl_today')}</Button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 1, fontSize: 11.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: 4 }}>
        {weekdays.map((w, i) => <div key={i} style={{ padding: '0 6px' }}>{w}</div>)}
      </div>
      <div style={{
        flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gridTemplateRows: 'repeat(6, minmax(0, 1fr))',
        gap: 1, background: 'var(--border-color)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden',
      }}>
        {days.map((day, i) => {
          const list = byDay.get(day.toDateString()) ?? [];
          const inMonth = day.getMonth() === month.getMonth();
          const isToday = sameDay(day, today);
          return (
            <div
              key={i}
              onDragOver={e => { e.preventDefault(); setOver(i); }}
              onDragLeave={() => setOver(o => (o === i ? null : o))}
              onDrop={e => { e.preventDefault(); setOver(null); moveTo(e.dataTransfer.getData('text/plain'), day); }}
              onClick={e => { if (e.target === e.currentTarget && onCreate) onCreate(day); }}
              className="planner-day"
              style={{
                background: over === i ? 'rgba(var(--accent-rgb), .1)' : inMonth ? 'var(--bg-primary)' : 'var(--bg-secondary)',
                padding: 4, display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0, overflow: 'hidden', cursor: onCreate ? 'cell' : 'default',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', pointerEvents: 'none' }}>
                <span style={{
                  fontSize: 12, fontWeight: 700, width: 22, height: 22, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: isToday ? 'var(--accent-primary)' : 'transparent', color: isToday ? '#fff' : inMonth ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                }}>{day.getDate()}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', minHeight: 0 }}>
                {list.map(task => {
                  const done = isDone(task);
                  const color = colorOf?.(task) ?? PRIORITY_COLORS[task.priority] ?? 'var(--accent-primary)';
                  return mobile ? (
                    <span key={task.id} onClick={() => onOpen(task)} title={task.title}
                      style={{ height: 6, borderRadius: 3, background: color === 'transparent' ? 'var(--accent-primary)' : color, opacity: done ? 0.4 : 1, cursor: 'pointer' }} />
                  ) : (
                    <div
                      key={task.id}
                      draggable={canEdit(task)}
                      onDragStart={e => e.dataTransfer.setData('text/plain', task.id)}
                      onClick={() => onOpen(task)}
                      title={task.title}
                      style={{
                        fontSize: 11.5, fontWeight: 600, padding: '2px 6px', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        background: 'rgba(var(--accent-rgb), .12)', color: done ? 'var(--text-tertiary)' : 'var(--text-primary)',
                        borderLeft: `3px solid ${color === 'transparent' ? 'var(--accent-primary)' : color}`,
                        textDecoration: done ? 'line-through' : 'none',
                      }}
                    >
                      {!task.all_day && task.due_at && <span style={{ color: 'var(--text-tertiary)', marginRight: 4 }}>{new Date(task.due_at).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })}</span>}
                      {task.title}
                    </div>
                  );
                })}
              </div>
              {onCreate && !mobile && list.length === 0 && (
                <Plus size={13} className="planner-day-add" style={{ margin: 'auto', color: 'var(--text-tertiary)', opacity: 0, pointerEvents: 'none' }} />
              )}
            </div>
          );
        })}
      </div>
      <style>{'.planner-day:hover .planner-day-add{opacity:.7!important}'}</style>
    </div>
  );
}
