import { useMemo, useRef, useState } from 'react';
import { CalendarClock, CheckCircle2, CheckSquare, Circle, Flag, MoreHorizontal, Pencil, Plus, Repeat, Trash2 } from 'lucide-react';
import { reportError, useCore, useModuleT } from '@sfera/sdk';
import { api } from './api';
import * as planner from './store';
import { DUE_COLORS, dueState, formatDue } from './dates';
import { Avatar, Confirm, IconButton, MenuItem, PopMenu, inputStyle } from './ui';
import { PRIORITY_COLORS, type Column, type Project, type Task } from './types';

export interface TaskFilter {
  query: string;
  mine: boolean;
  priority: number | null;
}

export function filterTasks(tasks: Task[], f: TaskFilter, me: string) {
  const q = f.query.trim().toLowerCase();
  return tasks.filter(t =>
    (!q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.labels.some(l => l.toLowerCase().includes(q)))
    && (!f.mine || t.assignees.some(a => a.id === me))
    && (f.priority === null || t.priority === f.priority));
}

export function TaskMeta({ task, done }: { task: Task; done: boolean }) {
  const { language, currentServerIP } = useCore();
  const state = dueState(task.due_at, done);
  const checked = task.checklist.filter(i => i.done).length;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
      {task.due_at && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: DUE_COLORS[state], fontWeight: state === 'overdue' || state === 'today' ? 700 : 500 }}>
          <CalendarClock size={12} /> {formatDue(task.due_at, language, task.all_day)}
        </span>
      )}
      {task.recurrence !== 'none' && <Repeat size={12} />}
      {task.checklist.length > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: checked === task.checklist.length ? '#10b981' : undefined }}>
          <CheckSquare size={12} /> {checked}/{task.checklist.length}
        </span>
      )}
      {task.assignees.length > 0 && (
        <span style={{ display: 'inline-flex', marginLeft: 'auto' }}>
          {task.assignees.slice(0, 4).map((a, i) => (
            <span key={a.id} style={{ marginLeft: i ? -6 : 0 }}><Avatar user={a} size={20} ring serverIP={currentServerIP} /></span>
          ))}
          {task.assignees.length > 4 && <span style={{ marginLeft: 4 }}>+{task.assignees.length - 4}</span>}
        </span>
      )}
    </div>
  );
}

function TaskCard({ task, done, onOpen, draggable, onDragStart, dragging }: {
  task: Task; done: boolean; onOpen: () => void; draggable: boolean; onDragStart: (e: React.DragEvent) => void; dragging: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
      data-task-id={task.id}
      style={{
        position: 'relative', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 10,
        padding: '10px 12px 10px 14px', cursor: draggable ? 'grab' : 'pointer', opacity: dragging ? 0.4 : 1,
        boxShadow: 'var(--shadow-sm)', transition: 'border-color .15s, transform .1s', overflow: 'hidden',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(var(--accent-rgb), .6)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}
    >
      {task.priority > 0 && <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: PRIORITY_COLORS[task.priority] }} />}
      {task.labels.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {task.labels.map(l => (
            <span key={l} style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: 'rgba(139,92,246,.15)', color: '#8b5cf6' }}>{l}</span>
          ))}
        </div>
      )}
      <div style={{
        fontSize: 14, fontWeight: 600, lineHeight: 1.35, marginBottom: 6, wordBreak: 'break-word',
        color: done ? 'var(--text-tertiary)' : 'var(--text-primary)', textDecoration: done ? 'line-through' : 'none',
      }}>{task.title}</div>
      <TaskMeta task={task} done={done} />
    </div>
  );
}

function QuickAdd({ project, column }: { project: Project; column: Column }) {
  const t = useModuleT();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const submit = async () => {
    const v = title.trim();
    if (!v) { setOpen(false); return; }
    setTitle('');
    await planner.addTask(project.id, { title: v, column_id: column.id }).catch(reportError);
  };
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '8px 10px', borderRadius: 8, border: 'none',
        background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover-bg)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
        <Plus size={15} /> {t('pl_add_task')}
      </button>
    );
  }
  return (
    <textarea
      autoFocus
      value={title}
      rows={2}
      onChange={e => setTitle(e.target.value)}
      onBlur={() => void submit()}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
        if (e.key === 'Escape') { setTitle(''); setOpen(false); }
      }}
      placeholder={t('pl_quick_add_ph')}
      style={{ ...inputStyle(), resize: 'none', background: 'var(--bg-primary)' }}
    />
  );
}

/** Order for a card dropped before `before` (or at the end). */
function orderAt(list: Task[], index: number) {
  const prev = list[index - 1]?.order;
  const next = list[index]?.order;
  if (prev === undefined && next === undefined) return 1;
  if (prev === undefined) return (next as number) - 1;
  if (next === undefined) return prev + 1;
  return (prev + next) / 2;
}

function ColumnView({ project, column, tasks, onOpen, drag, setDrag }: {
  project: Project; column: Column; tasks: Task[]; onOpen: (t: Task) => void;
  drag: string | null; setDrag: (id: string | null) => void;
}) {
  const t = useModuleT();
  const { authToken, currentServerIP } = useCore();
  const canEdit = project.role !== 'viewer';
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(column.title);
  const [confirm, setConfirm] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const conn = { token: authToken, serverIP: currentServerIP };

  const indexFromEvent = (e: React.DragEvent) => {
    const cards = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-task-id]') ?? [])]
      .filter(el => el.dataset.taskId !== drag);
    const i = cards.findIndex(el => {
      const r = el.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    return i === -1 ? cards.length : i;
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || drag;
    const index = indexFromEvent(e);
    setDropIndex(null);
    setDrag(null);
    const task = project.tasks.find(x => x.id === id);
    if (!task) return;
    const rest = tasks.filter(x => x.id !== id);
    const order = orderAt(rest, index);
    if (task.column_id === column.id && task.order === order) return;
    planner.updateTask(task, { column_id: column.id, order }).catch(reportError);
  };

  const rename = async () => {
    setRenaming(false);
    const v = title.trim();
    if (!v || v === column.title) { setTitle(column.title); return; }
    await api.updateColumn(conn, column.id, { title: v }).catch(reportError);
    void planner.loadProject(project.id);
  };

  return (
    <section
      aria-label={column.title}
      onDragOver={e => { if (!canEdit || !drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropIndex(indexFromEvent(e)); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropIndex(null); }}
      onDrop={onDrop}
      style={{
        width: 290, flexShrink: 0, display: 'flex', flexDirection: 'column', maxHeight: '100%',
        background: dropIndex !== null ? 'rgba(var(--accent-rgb), .06)' : 'var(--bg-secondary)',
        border: `1px solid ${dropIndex !== null ? 'rgba(var(--accent-rgb), .4)' : 'var(--border-color)'}`,
        borderRadius: 12, transition: 'background .15s, border-color .15s',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 8px 6px 12px' }}>
        {column.is_done ? <CheckCircle2 size={15} color="#10b981" /> : <Circle size={15} color="var(--text-tertiary)" />}
        {renaming ? (
          <input autoFocus value={title} onChange={e => setTitle(e.target.value)} onBlur={() => void rename()}
            onKeyDown={e => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') { setTitle(column.title); setRenaming(false); } }}
            style={{ ...inputStyle(), padding: '4px 8px', fontSize: 13.5, fontWeight: 700 }} />
        ) : (
          <h3 onDoubleClick={() => canEdit && setRenaming(true)} style={{ margin: 0, flex: 1, fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {column.title}
          </h3>
        )}
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)', borderRadius: 999, padding: '1px 8px' }}>{tasks.length}</span>
        {canEdit && <IconButton title={t('pl_column_menu')} onClick={e => setMenu({ x: e.clientX, y: e.clientY })}><MoreHorizontal size={16} /></IconButton>}
      </header>
      <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 8px', overflowY: 'auto', minHeight: 40 }}>
        {tasks.map((task, i) => (
          <div key={task.id}>
            {dropIndex === i && drag !== task.id && <div style={{ height: 3, borderRadius: 2, background: 'var(--accent-primary)', margin: '-5px 0 5px' }} />}
            <TaskCard
              task={task}
              done={column.is_done}
              onOpen={() => onOpen(task)}
              draggable={canEdit}
              dragging={drag === task.id}
              onDragStart={e => { e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; setDrag(task.id); }}
            />
          </div>
        ))}
        {dropIndex !== null && dropIndex >= tasks.filter(x => x.id !== drag).length && <div style={{ height: 3, borderRadius: 2, background: 'var(--accent-primary)' }} />}
      </div>
      {canEdit && <div style={{ padding: '4px 8px 8px' }}><QuickAdd project={project} column={column} /></div>}

      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem icon={<Pencil size={14} />} label={t('pl_rename')} onClick={() => { setMenu(null); setRenaming(true); }} />
          <MenuItem icon={<CheckCircle2 size={14} />} label={column.is_done ? t('pl_column_not_done') : t('pl_column_done')} onClick={async () => {
            setMenu(null);
            await api.updateColumn(conn, column.id, { is_done: !column.is_done }).catch(reportError);
            void planner.loadProject(project.id);
          }} />
          {project.columns.length > 1 && <MenuItem danger icon={<Trash2 size={14} />} label={t('pl_delete_column')} onClick={() => { setMenu(null); setConfirm(true); }} />}
        </PopMenu>
      )}
      {confirm && (
        <Confirm title={t('pl_delete_column')} message={t('pl_delete_column_hint')} confirmLabel={t('pl_delete')} cancelLabel={t('pl_cancel')}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            setConfirm(false);
            await api.deleteColumn(conn, column.id).catch(reportError);
            void planner.loadProject(project.id);
          }} />
      )}
    </section>
  );
}

export function Board({ project, filter, onOpen }: { project: Project; filter: TaskFilter; onOpen: (t: Task) => void }) {
  const t = useModuleT();
  const { authToken, currentServerIP, userIDonServer } = useCore();
  const [drag, setDrag] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newColumn, setNewColumn] = useState('');
  const visible = useMemo(() => filterTasks(project.tasks, filter, userIDonServer), [project.tasks, filter, userIDonServer]);

  const addColumn = async () => {
    const v = newColumn.trim();
    setAdding(false);
    setNewColumn('');
    if (!v) return;
    await api.addColumn({ token: authToken, serverIP: currentServerIP }, project.id, v).catch(reportError);
    void planner.loadProject(project.id);
  };

  return (
    <div onDragEnd={() => setDrag(null)} style={{ display: 'flex', gap: 12, padding: 16, overflowX: 'auto', height: '100%', alignItems: 'flex-start', boxSizing: 'border-box' }}>
      {project.columns.map(c => (
        <ColumnView key={c.id} project={project} column={c} onOpen={onOpen} drag={drag} setDrag={setDrag}
          tasks={visible.filter(x => x.column_id === c.id).sort((a, b) => a.order - b.order)} />
      ))}
      {project.role !== 'viewer' && (
        <div style={{ width: 260, flexShrink: 0 }}>
          {adding ? (
            <input autoFocus value={newColumn} onChange={e => setNewColumn(e.target.value)} onBlur={() => void addColumn()}
              onKeyDown={e => { if (e.key === 'Enter') void addColumn(); if (e.key === 'Escape') setAdding(false); }}
              placeholder={t('pl_column_name')} style={inputStyle()} />
          ) : (
            <button type="button" onClick={() => setAdding(true)} style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px', borderRadius: 12,
              border: '1px dashed var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13.5, fontFamily: 'inherit',
            }}>
              <Plus size={15} /> {t('pl_add_column')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskRow({ task, done, project, onOpen, showProject }: {
  task: Task; done: boolean; project?: { name: string; color: string }; onOpen: () => void; showProject?: boolean;
}) {
  const t = useModuleT();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-primary)' }}>
      <button
        type="button"
        aria-label={done ? t('pl_mark_open') : t('pl_mark_done')}
        title={done ? t('pl_mark_open') : t('pl_mark_done')}
        onClick={() => planner.updateTask(task, { done: !done }).catch(reportError)}
        style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', display: 'flex', color: done ? '#10b981' : 'var(--text-tertiary)' }}
      >
        {done ? <CheckCircle2 size={19} /> : <Circle size={19} />}
      </button>
      <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {task.priority > 0 && <Flag size={12} color={PRIORITY_COLORS[task.priority]} fill={PRIORITY_COLORS[task.priority]} />}
          <span style={{ fontSize: 14, fontWeight: 600, color: done ? 'var(--text-tertiary)' : 'var(--text-primary)', textDecoration: done ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
          {showProject && project && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: project.color }} /> {project.name}
            </span>
          )}
        </div>
        {(task.due_at || task.checklist.length > 0 || task.assignees.length > 0) && <div style={{ marginTop: 3 }}><TaskMeta task={task} done={done} /></div>}
      </div>
    </div>
  );
}

export function ListView({ project, filter, onOpen }: { project: Project; filter: TaskFilter; onOpen: (t: Task) => void }) {
  const { userIDonServer } = useCore();
  const visible = filterTasks(project.tasks, filter, userIDonServer);
  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      {project.columns.map(c => {
        const tasks = visible.filter(x => x.column_id === c.id).sort((a, b) => a.order - b.order);
        return (
          <div key={c.id} style={{ marginBottom: 18, border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--bg-secondary)', fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>
              {c.is_done ? <CheckCircle2 size={14} color="#10b981" /> : <Circle size={14} />} {c.title}
              <span style={{ color: 'var(--text-tertiary)', fontWeight: 600 }}>{tasks.length}</span>
            </div>
            {tasks.map(task => <TaskRow key={task.id} task={task} done={c.is_done} onOpen={() => onOpen(task)} />)}
          </div>
        );
      })}
    </div>
  );
}
