import { createModuleStore, reportError } from '@sfera/sdk';
import { api, type Conn, type TaskPatch } from './api';
import type { Project, ProjectBrief, Task } from './types';

interface State {
  loaded: boolean;
  projects: ProjectBrief[];
  full: Record<string, Project>;
  /** Bumped when tasks change anywhere, so cross-project views re-read. */
  revision: number;
}

export const store = createModuleStore<State>({ loaded: false, projects: [], full: {}, revision: 0 });

let conn: Conn | null = null;

export const need = () => {
  if (!conn) throw new Error('planner: not connected');
  return conn;
};

export function connect(next: Conn | null) {
  const changed = conn?.token !== next?.token || conn?.serverIP !== next?.serverIP;
  conn = next;
  if (!next) {
    store.reset();
    return;
  }
  if (changed) void refreshProjects();
}

export async function refreshProjects() {
  try {
    const projects = await api.projects(need());
    store.set({ loaded: true, projects });
  } catch (e) {
    store.set({ loaded: true });
    reportError(e);
  }
}

export async function loadProject(id: string) {
  const p = await api.project(need(), id);
  store.set(s => ({ full: { ...s.full, [id]: p } }));
  return p;
}

const bump = () => store.set(s => ({ revision: s.revision + 1 }));

function patchProject(id: string, fn: (p: Project) => Project) {
  store.set(s => (s.full[id] ? { full: { ...s.full, [id]: fn(s.full[id]) } } : {}));
}

export async function createProject(name: string, color: string) {
  const p = await api.createProject(need(), name, color);
  store.set(s => ({ projects: [...s.projects, p], full: { ...s.full, [p.id]: p } }));
  return p;
}

export async function updateProject(id: string, body: { name?: string; color?: string }) {
  const p = await api.updateProject(need(), id, body);
  store.set(s => ({ projects: s.projects.map(x => (x.id === id ? { ...x, ...p } : x)) }));
  patchProject(id, x => ({ ...x, ...p }));
}

export async function deleteProject(id: string) {
  await api.deleteProject(need(), id);
  dropProject(id);
}

function dropProject(id: string) {
  store.set(s => {
    const full = { ...s.full };
    delete full[id];
    return { projects: s.projects.filter(p => p.id !== id), full };
  });
  bump();
}

export async function addTask(projectId: string, body: TaskPatch) {
  const t = await api.addTask(need(), projectId, body);
  patchProject(projectId, p => ({ ...p, tasks: [...p.tasks.filter(x => x.id !== t.id), t] }));
  bump();
  return t;
}

/** Optimistic: the card moves at once, the server answer replaces it. */
export async function updateTask(task: Task, body: TaskPatch) {
  const { assignee_ids: _ignored, ...fields } = body;
  void _ignored;
  patchProject(task.project_id, p => ({ ...p, tasks: p.tasks.map(x => (x.id === task.id ? { ...x, ...fields } as Task : x)) }));
  try {
    const t = await api.updateTask(need(), task.id, body);
    patchProject(task.project_id, p => ({
      ...p,
      tasks: [...p.tasks.map(x => (x.id === t.id ? t : x)), ...(t.next ? [t.next] : [])],
    }));
    bump();
    return t;
  } catch (e) {
    patchProject(task.project_id, p => ({ ...p, tasks: p.tasks.map(x => (x.id === task.id ? task : x)) }));
    throw e;
  }
}

export async function deleteTask(task: Task) {
  patchProject(task.project_id, p => ({ ...p, tasks: p.tasks.filter(x => x.id !== task.id) }));
  await api.deleteTask(need(), task.id);
  bump();
}

/** Someone changed a project: re-read it if it is open, refresh the list otherwise. */
export function onRemoteChanged(frame: { project_id?: string }) {
  if (!conn) return;
  const id = frame.project_id;
  if (id && store.get().full[id]) void loadProject(id).catch(() => dropProject(id));
  if (id && !store.get().projects.some(p => p.id === id)) void refreshProjects();
  bump();
}

export function onRemoteRemoved(frame: { project_id?: string }) {
  if (frame.project_id) dropProject(frame.project_id);
}
