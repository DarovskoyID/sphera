import type { UserBrief } from './ui';

export type Role = 'owner' | 'editor' | 'viewer';
export type Recurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  project_id: string;
  column_id: string;
  title: string;
  description: string;
  priority: number;
  start_at: string | null;
  due_at: string | null;
  all_day: boolean;
  reminder_minutes: number | null;
  recurrence: Recurrence;
  order: number;
  labels: string[];
  checklist: ChecklistItem[];
  assignees: UserBrief[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  project_name?: string;
}

export interface Column {
  id: string;
  title: string;
  order: number;
  is_done: boolean;
}

export interface ProjectBrief {
  id: string;
  name: string;
  color: string;
  role: Role;
  created_at: string;
}

export interface Project extends ProjectBrief {
  columns: Column[];
  members: (UserBrief & { role: Role })[];
  tasks: Task[];
}

export interface Comment {
  id: string;
  text: string;
  author: UserBrief;
  created_at: string;
}

export const PRIORITY_COLORS = ['transparent', '#64748b', '#3b82f6', '#f59e0b', '#ef4444'];
export const PROJECT_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6'];
