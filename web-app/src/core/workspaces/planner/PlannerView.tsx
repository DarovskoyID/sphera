import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  CalendarCheck, CalendarDays, ChevronDown, Columns3, Flag, FolderKanban, List, ListChecks, LogOut, MoreHorizontal,
  Pencil, Plus, Search, Trash2, UserMinus, Users, X,
} from 'lucide-react';
import { navigate, reportError, useCore, useModuleStore, useModuleT } from '@sfera/sdk';
import { api } from './api';
import * as planner from './store';
import { Board, ListView, TaskRow, filterTasks, type TaskFilter } from './Board';
import { CalendarView } from './CalendarView';
import { TaskModal } from './TaskModal';
import { addDays, fromLocalInput, startOfDay, toLocalInput } from './dates';
import {
  Avatar, Button, Confirm, Empty, Field, IconButton, MenuItem, Modal, PopMenu, Segmented, UserPicker, displayName, inputStyle, useIsMobile,
} from './ui';
import { PRIORITY_COLORS, PROJECT_COLORS, type Project, type ProjectBrief, type Role, type Task } from './types';

export const ROUTE = 'planner';
type ViewMode = 'board' | 'list' | 'calendar';

const VIEW_KEY = 'sfera.planner.view';
const loadView = (): ViewMode => {
  try { return (localStorage.getItem(VIEW_KEY) as ViewMode) || 'board'; } catch { return 'board'; }
};

function useConn() {
  const { authToken, currentServerIP } = useCore();
  return useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

export function ProjectDialog({ project, onClose, onSaved }: { project?: ProjectBrief; onClose: () => void; onSaved?: (p: ProjectBrief) => void }) {
  const t = useModuleT();
  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState(project?.color ?? PROJECT_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (project) {
        await planner.updateProject(project.id, { name: name.trim(), color });
        onSaved?.({ ...project, name: name.trim(), color });
      } else {
        onSaved?.(await planner.createProject(name.trim(), color));
      }
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={project ? t('pl_edit_project') : t('pl_new_project')} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>{t('pl_cancel')}</Button>
        <Button kind="primary" disabled={!name.trim() || busy} onClick={() => void submit()}>{project ? t('pl_save') : t('pl_create')}</Button>
      </>
    }>
      <Field label={t('pl_project_name')}>
        <input autoFocus value={name} maxLength={120} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
          placeholder={t('pl_project_name_ph')} style={inputStyle()} />
      </Field>
      <Field label={t('pl_color')}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {PROJECT_COLORS.map(c => (
            <button key={c} type="button" aria-label={c} onClick={() => setColor(c)} style={{
              width: 28, height: 28, borderRadius: 8, background: c, cursor: 'pointer',
              border: color === c ? '2px solid var(--text-primary)' : '2px solid transparent', boxShadow: color === c ? '0 0 0 2px var(--bg-secondary) inset' : 'none',
            }} />
          ))}
        </div>
      </Field>
    </Modal>
  );
}

function MembersDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const t = useModuleT();
  const conn = useConn();
  const { currentServerIP, userIDonServer } = useCore();
  const owner = project.role === 'owner';
  const [role, setRole] = useState<Role>('editor');
  const search = useCallback((q: string) => api.users(conn, q), [conn]);
  const run = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { reportError(e); }
    void planner.loadProject(project.id);
  };
  return (
    <Modal title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Users size={17} /> {t('pl_members')}</span>} onClose={onClose} width={480}>
      {owner && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <UserPicker search={search} serverIP={currentServerIP} exclude={project.members.map(m => m.id)} placeholder={t('pl_invite_ph')}
              onPick={u => void run(api.addMember(conn, project.id, u.id, role))} />
          </div>
          <select value={role} onChange={e => setRole(e.target.value as Role)} style={{ ...inputStyle(), width: 130 }}>
            <option value="editor">{t('pl_role_editor')}</option>
            <option value="viewer">{t('pl_role_viewer')}</option>
          </select>
        </div>
      )}
      {project.members.map(m => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
          <Avatar user={m} size={32} serverIP={currentServerIP} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{displayName(m)}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>@{m.username}</div>
          </div>
          {owner && m.role !== 'owner' ? (
            <>
              <select value={m.role} onChange={e => void run(api.setMemberRole(conn, project.id, m.id, e.target.value as Role))} style={{ ...inputStyle(), width: 120, padding: '5px 8px' }}>
                <option value="editor">{t('pl_role_editor')}</option>
                <option value="viewer">{t('pl_role_viewer')}</option>
              </select>
              <IconButton title={t('pl_remove_member')} onClick={() => void run(api.removeMember(conn, project.id, m.id))}><UserMinus size={15} /></IconButton>
            </>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 600 }}>{t(`pl_role_${m.role}`)}</span>
          )}
          {!owner && m.id === userIDonServer && (
            <IconButton title={t('pl_leave')} onClick={() => void api.removeMember(conn, project.id, m.id).then(() => { onClose(); void planner.refreshProjects(); navigateTo(''); }).catch(reportError)}>
              <LogOut size={15} />
            </IconButton>
          )}
        </div>
      ))}
    </Modal>
  );
}

let navigateTo: (rest: string) => void = () => {};

/** New task with a chosen project, column and due date (calendar, «Мои задачи»). */
function NewTaskDialog({ projects, defaultProject, due, onClose }: { projects: ProjectBrief[]; defaultProject?: string; due?: Date; onClose: () => void }) {
  const t = useModuleT();
  const { userIDonServer } = useCore();
  const editable = projects.filter(p => p.role !== 'viewer');
  const [projectId, setProjectId] = useState(defaultProject && editable.some(p => p.id === defaultProject) ? defaultProject : editable[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState(due ? toLocalInput(new Date(due.getFullYear(), due.getMonth(), due.getDate(), 18).toISOString()) : '');
  const [priority, setPriority] = useState(0);
  const [assignMe, setAssignMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim() || !projectId || busy) return;
    setBusy(true);
    try {
      await planner.addTask(projectId, {
        title: title.trim(), due_at: fromLocalInput(dueAt), priority,
        assignee_ids: assignMe ? [userIDonServer] : [], reminder_minutes: dueAt ? 15 : null,
      });
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!editable.length) {
    return <Modal title={t('pl_new_task')} onClose={onClose}><p style={{ color: 'var(--text-secondary)', margin: 0 }}>{t('pl_need_project')}</p></Modal>;
  }
  return (
    <Modal title={t('pl_new_task')} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>{t('pl_cancel')}</Button>
        <Button kind="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>{t('pl_create')}</Button>
      </>
    }>
      <Field label={t('pl_task_title')}>
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submit(); }} placeholder={t('pl_quick_add_ph')} style={inputStyle()} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0 12px' }}>
        <Field label={t('pl_project')}>
          <select value={projectId} onChange={e => setProjectId(e.target.value)} style={inputStyle()}>
            {editable.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={t('pl_due')}>
          <input type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} style={inputStyle()} />
        </Field>
      </div>
      <Field label={t('pl_priority')}>
        <div style={{ display: 'flex', gap: 6 }}>
          {[0, 1, 2, 3, 4].map(p => (
            <IconButton key={p} title={t(`pl_priority_${p}`)} active={priority === p} onClick={() => setPriority(p)}>
              <Flag size={15} color={p ? PRIORITY_COLORS[p] : undefined} fill={p ? PRIORITY_COLORS[p] : 'none'} />
            </IconButton>
          ))}
        </div>
      </Field>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
        <input type="checkbox" checked={assignMe} onChange={e => setAssignMe(e.target.checked)} /> {t('pl_assign_me')}
      </label>
    </Modal>
  );
}

// ── Cross-project screens ────────────────────────────────────────────────────

function useAllTasks(scope?: 'all') {
  const conn = useConn();
  const revision = useModuleStore(planner.store, s => s.revision);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  useEffect(() => {
    let dead = false;
    api.my(conn, { scope }).then(r => { if (!dead) setTasks(r); }).catch(e => { if (!dead) { setTasks([]); reportError(e); } });
    return () => { dead = true; };
  }, [conn, scope, revision]);
  return tasks;
}

/** Opens a task from any project: loads the project it belongs to first. */
function useTaskOpener() {
  const full = useModuleStore(planner.store, s => s.full);
  const [open, setOpen] = useState<Task | null>(null);
  const openTask = async (task: Task) => {
    if (!planner.store.get().full[task.project_id]) {
      try { await planner.loadProject(task.project_id); } catch (e) { reportError(e); return; }
    }
    setOpen(task);
  };
  const project = open ? full[open.project_id] : undefined;
  const modal = open && project ? <TaskModal task={open} project={project} onClose={() => setOpen(null)} /> : null;
  return { openTask, modal };
}

function isDoneIn(full: Record<string, Project>, task: Task) {
  const p = full[task.project_id];
  const col = p?.columns.find(c => c.id === task.column_id);
  return col ? col.is_done : !!task.completed_at;
}

function MyTasks({ onNew }: { onNew: () => void }) {
  const t = useModuleT();
  const tasks = useAllTasks();
  const projects = useModuleStore(planner.store, s => s.projects);
  const full = useModuleStore(planner.store, s => s.full);
  const { openTask, modal } = useTaskOpener();
  const [showDone, setShowDone] = useState(false);

  const groups = useMemo(() => {
    const today = startOfDay(new Date());
    const tomorrow = addDays(today, 1);
    const week = addDays(today, 7);
    const out: Record<string, Task[]> = { overdue: [], today: [], tomorrow: [], week: [], later: [], nodate: [], done: [] };
    for (const task of tasks ?? []) {
      if (task.completed_at) { out.done.push(task); continue; }
      if (!task.due_at) { out.nodate.push(task); continue; }
      const due = new Date(task.due_at);
      if (due < new Date()) out.overdue.push(task);
      else if (due < tomorrow) out.today.push(task);
      else if (due < addDays(tomorrow, 1)) out.tomorrow.push(task);
      else if (due < week) out.week.push(task);
      else out.later.push(task);
    }
    out.done.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
    return out;
  }, [tasks]);

  const byId = Object.fromEntries(projects.map(p => [p.id, p]));
  const open = (tasks ?? []).filter(x => !x.completed_at).length;

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16, boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', flex: 1 }}>{t('pl_my_tasks')}</h1>
          <Button kind="primary" onClick={onNew}><Plus size={15} /> {t('pl_new_task')}</Button>
        </div>
        {tasks === null ? null : open === 0 && groups.done.length === 0 ? (
          <Empty icon={<ListChecks size={30} />} title={t('pl_my_empty')} hint={t('pl_my_empty_hint')} />
        ) : (
          (['overdue', 'today', 'tomorrow', 'week', 'later', 'nodate'] as const).filter(g => groups[g].length).map(g => (
            <div key={g} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6, color: g === 'overdue' ? '#ef4444' : g === 'today' ? '#f59e0b' : 'var(--text-tertiary)' }}>
                {t(`pl_group_${g}`)} · {groups[g].length}
              </div>
              <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden' }}>
                {groups[g].map(task => (
                  <TaskRow key={task.id} task={task} done={false} showProject project={byId[task.project_id]} onOpen={() => void openTask(task)} />
                ))}
              </div>
            </div>
          ))
        )}
        {groups.done.length > 0 && (
          <div>
            <Button kind="plain" small onClick={() => setShowDone(v => !v)}>
              <ChevronDown size={14} style={{ transform: showDone ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }} /> {t('pl_group_done')} · {groups.done.length}
            </Button>
            {showDone && (
              <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', marginTop: 6 }}>
                {groups.done.slice(0, 50).map(task => (
                  <TaskRow key={task.id} task={task} done={isDoneIn(full, task) || !!task.completed_at} showProject project={byId[task.project_id]} onOpen={() => void openTask(task)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {modal}
    </div>
  );
}

function AllCalendar() {
  const tasks = useAllTasks('all');
  const projects = useModuleStore(planner.store, s => s.projects);
  const full = useModuleStore(planner.store, s => s.full);
  const { openTask, modal } = useTaskOpener();
  const [newOn, setNewOn] = useState<Date | null>(null);
  const byId = Object.fromEntries(projects.map(p => [p.id, p]));
  return (
    <>
      <CalendarView
        tasks={tasks ?? []}
        isDone={task => !!task.completed_at || isDoneIn(full, task)}
        colorOf={task => byId[task.project_id]?.color ?? 'var(--accent-primary)'}
        canEdit={task => byId[task.project_id]?.role !== 'viewer'}
        onOpen={task => void openTask(task)}
        onCreate={day => setNewOn(day)}
      />
      {modal}
      {newOn && <NewTaskDialog projects={projects} due={newOn} onClose={() => setNewOn(null)} />}
    </>
  );
}

// ── Project screen ───────────────────────────────────────────────────────────

function ProjectScreen({ projectId, mobile }: { projectId: string; mobile: boolean }) {
  const t = useModuleT();
  const { userIDonServer } = useCore();
  const project = useModuleStore(planner.store, s => s.full[projectId]);
  const brief = useModuleStore(planner.store, s => s.projects.find(p => p.id === projectId));
  const [error, setError] = useState(false);
  const [view, setView] = useState<ViewMode>(loadView);
  const [filter, setFilter] = useState<TaskFilter>({ query: '', mine: false, priority: null });
  const [openId, setOpenId] = useState<string | null>(null);
  const [members, setMembers] = useState(false);
  const [newOn, setNewOn] = useState<Date | null | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setError(false);
    planner.loadProject(projectId).catch(() => setError(true));
  }, [projectId]);

  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ } }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      if ((e.key === 'n' || e.key === 'т') && !e.ctrlKey && !e.metaKey && project?.role !== 'viewer') { e.preventDefault(); setNewOn(null); }
      if (e.key === '1') setView('board');
      if (e.key === '2') setView('list');
      if (e.key === '3') setView('calendar');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project?.role]);

  if (error) return <Empty icon={<FolderKanban size={30} />} title={t('pl_project_missing')} action={<Button onClick={() => navigateTo('')}>{t('pl_back')}</Button>} />;
  if (!project) return <div style={{ flex: 1 }} />;

  const openTask = project.tasks.find(x => x.id === openId);
  const done = new Set(project.columns.filter(c => c.is_done).map(c => c.id));
  const visibleCount = filterTasks(project.tasks, filter, userIDonServer).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: mobile ? '10px 12px' : '12px 16px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
        <span style={{ width: 12, height: 12, borderRadius: 4, background: project.color, flexShrink: 0 }} />
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: mobile ? '50vw' : 320 }}>
          {brief?.name ?? project.name}
        </h1>
        <Segmented value={view} onChange={setView} options={[
          { id: 'board', label: mobile ? '' : t('pl_view_board'), icon: <Columns3 size={14} /> },
          { id: 'list', label: mobile ? '' : t('pl_view_list'), icon: <List size={14} /> },
          { id: 'calendar', label: mobile ? '' : t('pl_view_calendar'), icon: <CalendarDays size={14} /> },
        ]} />
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative', width: mobile ? '100%' : 220, order: mobile ? 10 : 0 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-tertiary)' }} />
          <input ref={searchRef} value={filter.query} onChange={e => setFilter(f => ({ ...f, query: e.target.value }))}
            placeholder={t('pl_search_ph')} style={{ ...inputStyle(), padding: '6px 28px 6px 30px', fontSize: 13 }} />
          {filter.query && <X size={14} onClick={() => setFilter(f => ({ ...f, query: '' }))} style={{ position: 'absolute', right: 9, top: 9, cursor: 'pointer', color: 'var(--text-tertiary)' }} />}
        </div>
        <IconButton title={t('pl_only_mine')} active={filter.mine} onClick={() => setFilter(f => ({ ...f, mine: !f.mine }))}><CalendarCheck size={16} /></IconButton>
        <select aria-label={t('pl_priority')} value={filter.priority ?? ''} onChange={e => setFilter(f => ({ ...f, priority: e.target.value === '' ? null : Number(e.target.value) }))}
          style={{ ...inputStyle(), width: 'auto', padding: '6px 8px', fontSize: 13 }}>
          <option value="">{t('pl_any_priority')}</option>
          {[4, 3, 2, 1, 0].map(p => <option key={p} value={p}>{t(`pl_priority_${p}`)}</option>)}
        </select>
        <button type="button" onClick={() => setMembers(true)} title={t('pl_members')} style={{ display: 'flex', alignItems: 'center', border: 'none', background: 'transparent', cursor: 'pointer', padding: 2 }}>
          {project.members.slice(0, 3).map((m, i) => <span key={m.id} style={{ marginLeft: i ? -8 : 0 }}><Avatar user={m} size={26} ring /></span>)}
          {project.members.length > 3 && <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 4 }}>+{project.members.length - 3}</span>}
        </button>
        {project.role !== 'viewer' && <Button kind="primary" small onClick={() => setNewOn(null)} title="N"><Plus size={14} /> {!mobile && t('pl_task')}</Button>}
      </header>
      {(filter.query || filter.mine || filter.priority !== null) && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '6px 16px 0' }}>{t('pl_filtered').replace('{n}', String(visibleCount))}</div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === 'board' && <Board project={project} filter={filter} onOpen={task => setOpenId(task.id)} />}
        {view === 'list' && <ListView project={project} filter={filter} onOpen={task => setOpenId(task.id)} />}
        {view === 'calendar' && (
          <CalendarView
            tasks={filterTasks(project.tasks, filter, userIDonServer)}
            isDone={task => done.has(task.column_id)}
            canEdit={() => project.role !== 'viewer'}
            onOpen={task => setOpenId(task.id)}
            onCreate={project.role !== 'viewer' ? day => setNewOn(day) : undefined}
          />
        )}
      </div>
      {openTask && <TaskModal task={openTask} project={project} onClose={() => setOpenId(null)} />}
      {members && <MembersDialog project={project} onClose={() => setMembers(false)} />}
      {newOn !== undefined && <NewTaskDialog projects={[project]} defaultProject={project.id} due={newOn ?? undefined} onClose={() => setNewOn(undefined)} />}
    </div>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────────

const navItem = (active: boolean): CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
  fontSize: 14, fontWeight: 600, fontFamily: 'inherit', textAlign: 'left',
  background: active ? 'rgba(var(--accent-rgb), .14)' : 'transparent', color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
});

export function PlannerView({ style }: { style?: CSSProperties }) {
  const t = useModuleT();
  const { currentServer, setCurrentServer, userIDonServer } = useCore();
  const conn = useConn();
  const mobile = useIsMobile();
  const rest = navigate.parseModuleRoute(currentServer, ROUTE) ?? '';
  const projects = useModuleStore(planner.store, s => s.projects);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProjectBrief | null>(null);
  const [deleting, setDeleting] = useState<ProjectBrief | null>(null);
  const [menu, setMenu] = useState<{ p: ProjectBrief; x: number; y: number } | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [drawer, setDrawer] = useState(false);

  navigateTo = r => setCurrentServer(navigate.moduleRoute(ROUTE, r));
  const go = (r: string) => { navigateTo(r); setDrawer(false); };
  const section = rest === '' ? 'my' : rest;
  const current = projects.find(p => p.id === section);

  const sidebar = (
    <nav aria-label={t('pl_title')} style={{
      width: mobile ? '100%' : 240, flexShrink: 0, borderRight: mobile ? 'none' : '1px solid var(--border-color)', background: 'var(--bg-secondary)',
      display: 'flex', flexDirection: 'column', padding: 10, gap: 2, overflowY: 'auto', boxSizing: 'border-box',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 12px' }}>
        <div style={{ width: 30, height: 30, borderRadius: 9, background: 'linear-gradient(135deg,#10b981,#0ea5e9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <CalendarCheck size={17} color="#fff" />
        </div>
        <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>{t('pl_title')}</span>
      </div>
      <button type="button" style={navItem(section === 'my')} onClick={() => go('')}><ListChecks size={16} /> {t('pl_my_tasks')}</button>
      <button type="button" style={navItem(section === 'calendar')} onClick={() => go('calendar')}><CalendarDays size={16} /> {t('pl_calendar')}</button>
      <div style={{ display: 'flex', alignItems: 'center', padding: '14px 6px 4px', fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-tertiary)' }}>
        <span style={{ flex: 1 }}>{t('pl_projects')}</span>
        <IconButton title={t('pl_new_project')} onClick={() => setCreating(true)} style={{ width: 24, height: 24 }}><Plus size={15} /></IconButton>
      </div>
      {projects.length === 0 && (
        <button type="button" onClick={() => setCreating(true)} style={{ ...navItem(false), border: '1px dashed var(--border-color)', fontWeight: 500, fontSize: 13 }}>
          <Plus size={14} /> {t('pl_first_project')}
        </button>
      )}
      {projects.map(p => (
        <div key={p.id} style={{ position: 'relative' }} className="planner-project"
          onContextMenu={e => { e.preventDefault(); setMenu({ p, x: e.clientX, y: e.clientY }); }}>
          <button type="button" style={{ ...navItem(section === p.id), paddingRight: 34 }} onClick={() => go(p.id)}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: p.color, flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
          </button>
          <IconButton title={t('pl_project_menu')} onClick={e => setMenu({ p, x: e.clientX, y: e.clientY })}
            style={{ position: 'absolute', right: 4, top: 4, width: 26, height: 26 }}>
            <MoreHorizontal size={15} />
          </IconButton>
        </div>
      ))}
    </nav>
  );

  return (
    <div style={{ display: 'flex', flexDirection: mobile ? 'column' : 'row', height: '100%', minHeight: 0, background: 'var(--bg-primary)', overflow: 'hidden', ...style }}>
      {mobile ? (
        <>
          <button type="button" onClick={() => setDrawer(v => !v)} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', border: 'none', borderBottom: '1px solid var(--border-color)',
            background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 15, fontWeight: 700, fontFamily: 'inherit',
          }}>
            <CalendarCheck size={17} color="var(--accent-primary)" />
            {current ? current.name : section === 'calendar' ? t('pl_calendar') : t('pl_my_tasks')}
            <ChevronDown size={16} style={{ marginLeft: 'auto', transform: drawer ? 'rotate(180deg)' : 'none' }} />
          </button>
          {drawer && <div style={{ maxHeight: '60vh', display: 'flex', borderBottom: '1px solid var(--border-color)' }}>{sidebar}</div>}
        </>
      ) : sidebar}
      <main style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {section === 'my' && <MyTasks onNew={() => setNewTask(true)} />}
        {section === 'calendar' && <AllCalendar />}
        {section !== 'my' && section !== 'calendar' && <ProjectScreen key={section} projectId={section} mobile={mobile} />}
      </main>

      {creating && <ProjectDialog onClose={() => setCreating(false)} onSaved={p => go(p.id)} />}
      {editing && <ProjectDialog project={editing} onClose={() => setEditing(null)} />}
      {newTask && <NewTaskDialog projects={projects} onClose={() => setNewTask(false)} />}
      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.p.role !== 'viewer' && <MenuItem icon={<Pencil size={14} />} label={t('pl_edit_project')} onClick={() => { setEditing(menu.p); setMenu(null); }} />}
          {menu.p.role === 'owner' && <MenuItem danger icon={<Trash2 size={14} />} label={t('pl_delete_project')} onClick={() => { setDeleting(menu.p); setMenu(null); }} />}
          {menu.p.role !== 'owner' && <MenuItem icon={<LogOut size={14} />} label={t('pl_leave')} onClick={() => {
            const p = menu.p;
            setMenu(null);
            api.removeMember(conn, p.id, userIDonServer)
              .then(() => { void planner.refreshProjects(); if (section === p.id) go(''); })
              .catch(reportError);
          }} />}
        </PopMenu>
      )}
      {deleting && (
        <Confirm title={t('pl_delete_project')} message={t('pl_delete_project_hint').replace('{name}', deleting.name)}
          confirmLabel={t('pl_delete')} cancelLabel={t('pl_cancel')} onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const p = deleting;
            setDeleting(null);
            try {
              await planner.deleteProject(p.id);
              if (section === p.id) go('');
            } catch (e) { reportError(e); }
          }} />
      )}
    </div>
  );
}
