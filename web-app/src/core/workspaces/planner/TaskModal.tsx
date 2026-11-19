import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, CheckSquare, Flag, MessageSquare, Plus, Repeat, Send, Tag, Trash2, UserPlus, X } from 'lucide-react';
import { reportError, useCore, useModuleT } from '@sfera/sdk';
import { api } from './api';
import * as planner from './store';
import { fromLocalInput, toLocalInput } from './dates';
import { Avatar, Button, Confirm, Field, IconButton, Modal, displayName, inputStyle } from './ui';
import { PRIORITY_COLORS, type ChecklistItem, type Comment, type Project, type Recurrence, type Task } from './types';

const REMINDERS = [null, 0, 5, 15, 30, 60, 180, 1440];
const RECURRENCES: Recurrence[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];

const chip = (active: boolean, color?: string): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 999, fontSize: 12.5, fontWeight: 600,
  cursor: 'pointer', border: `1px solid ${active ? (color ?? 'var(--accent-primary)') : 'var(--border-color)'}`,
  background: active ? `color-mix(in srgb, ${color ?? 'var(--accent-primary)'} 16%, transparent)` : 'transparent',
  color: active ? (color ?? 'var(--accent-primary)') : 'var(--text-secondary)', fontFamily: 'inherit',
});

export function TaskModal({ task, project, onClose }: { task: Task; project: Project; onClose: () => void }) {
  const t = useModuleT();
  const { currentServerIP, authToken, language } = useCore();
  const readOnly = project.role === 'viewer';
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [newItem, setNewItem] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [comment, setComment] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pickAssignee, setPickAssignee] = useState(false);
  // The store copy stays current (remote edits included).
  const live = project.tasks.find(x => x.id === task.id) ?? task;
  const liveRef = useRef(live);
  liveRef.current = live;

  const save = useCallback((body: Parameters<typeof planner.updateTask>[1]) => {
    if (readOnly) return;
    planner.updateTask(liveRef.current, body).catch(reportError);
  }, [readOnly]);

  useEffect(() => { setTitle(live.title); }, [live.title]);
  useEffect(() => { setDescription(live.description); }, [live.description]);

  useEffect(() => {
    api.comments({ token: authToken, serverIP: currentServerIP }, task.id).then(setComments).catch(() => setComments([]));
  }, [task.id, authToken, currentServerIP]);

  const commitTitle = () => {
    const v = title.trim();
    if (v && v !== live.title) save({ title: v });
    else setTitle(live.title);
  };
  const commitDescription = () => { if (description !== live.description) save({ description }); };

  const setChecklist = (items: ChecklistItem[]) => save({ checklist: items });
  const addItem = () => {
    const text = newItem.trim();
    if (!text) return;
    setChecklist([...live.checklist, { id: Math.random().toString(36).slice(2, 12), text, done: false }]);
    setNewItem('');
  };
  const addLabel = () => {
    const v = newLabel.trim().replace(/^#/, '');
    if (v && !live.labels.includes(v)) save({ labels: [...live.labels, v] });
    setNewLabel('');
  };
  const sendComment = async () => {
    const text = comment.trim();
    if (!text) return;
    setComment('');
    try {
      setComments(await api.addComment({ token: authToken, serverIP: currentServerIP }, task.id, text));
    } catch (e) {
      reportError(e);
      setComment(text);
    }
  };

  const done = live.checklist.filter(i => i.done).length;
  const assigneeIds = live.assignees.map(a => a.id);
  const column = project.columns.find(c => c.id === live.column_id);

  return (
    <>
      <Modal
        width={640}
        onClose={() => { commitTitle(); commitDescription(); onClose(); }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 600 }}>
            <span style={{ width: 8, height: 8, borderRadius: 3, background: project.color }} />
            {project.name}
            {column && <span>· {column.title}</span>}
          </div>
        }
        footer={!readOnly && (
          <>
            <Button kind="plain" onClick={() => setConfirmDelete(true)} style={{ color: '#ef4444', marginRight: 'auto' }}>
              <Trash2 size={14} /> {t('pl_delete_task')}
            </Button>
            <Button kind="primary" onClick={() => { commitTitle(); commitDescription(); onClose(); }}>{t('pl_done_editing')}</Button>
          </>
        )}
      >
        <textarea
          value={title}
          readOnly={readOnly}
          onChange={e => setTitle(e.target.value.replace(/\n/g, ''))}
          onBlur={commitTitle}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }}
          rows={1}
          aria-label={t('pl_task_title')}
          style={{
            width: '100%', resize: 'none', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'inherit',
            fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', padding: 0, marginBottom: 12, fieldSizing: 'content',
          } as React.CSSProperties}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 12px' }}>
          <Field label={t('pl_column')}>
            <select disabled={readOnly} value={live.column_id} onChange={e => save({ column_id: e.target.value })} style={inputStyle()}>
              {project.columns.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </Field>
          <Field label={t('pl_due')}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                disabled={readOnly}
                type={live.all_day ? 'date' : 'datetime-local'}
                value={toLocalInput(live.due_at, live.all_day)}
                onChange={e => save({ due_at: fromLocalInput(e.target.value, live.all_day) })}
                style={inputStyle()}
              />
              {live.due_at && !readOnly && <IconButton title={t('pl_clear')} onClick={() => save({ due_at: null })}><X size={14} /></IconButton>}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
              <input type="checkbox" disabled={readOnly} checked={live.all_day} onChange={e => save({ all_day: e.target.checked })} />
              {t('pl_all_day')}
            </label>
          </Field>
        </div>

        <Field label={t('pl_priority')}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {[0, 1, 2, 3, 4].map(p => (
              <button key={p} type="button" disabled={readOnly} onClick={() => save({ priority: p })} style={chip(live.priority === p, p ? PRIORITY_COLORS[p] : undefined)}>
                {p > 0 && <Flag size={12} />} {t(`pl_priority_${p}`)}
              </button>
            ))}
          </div>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 12px' }}>
          <Field label={t('pl_reminder')}>
            <div style={{ position: 'relative' }}>
              <Bell size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-tertiary)' }} />
              <select
                disabled={readOnly || !live.due_at}
                value={live.reminder_minutes ?? ''}
                onChange={e => save({ reminder_minutes: e.target.value === '' ? null : Number(e.target.value) })}
                style={{ ...inputStyle(), paddingLeft: 30 }}
              >
                {REMINDERS.map(m => <option key={String(m)} value={m ?? ''}>{t(`pl_remind_${m ?? 'none'}`)}</option>)}
              </select>
            </div>
          </Field>
          <Field label={t('pl_repeat')}>
            <div style={{ position: 'relative' }}>
              <Repeat size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-tertiary)' }} />
              <select disabled={readOnly || !live.due_at} value={live.recurrence} onChange={e => save({ recurrence: e.target.value as Recurrence })} style={{ ...inputStyle(), paddingLeft: 30 }}>
                {RECURRENCES.map(r => <option key={r} value={r}>{t(`pl_repeat_${r}`)}</option>)}
              </select>
            </div>
          </Field>
        </div>

        <Field label={t('pl_assignees')}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {live.assignees.map(u => (
              <span key={u.id} style={{ ...chip(true), cursor: 'default' }}>
                <Avatar user={u} size={18} serverIP={currentServerIP} /> {displayName(u)}
                {!readOnly && <X size={12} style={{ cursor: 'pointer' }} onClick={() => save({ assignee_ids: assigneeIds.filter(id => id !== u.id), })} />}
              </span>
            ))}
            {!readOnly && (
              <div style={{ position: 'relative' }}>
                <button type="button" style={chip(false)} onClick={() => setPickAssignee(v => !v)}><UserPlus size={13} /> {t('pl_assign')}</button>
                {pickAssignee && <div style={{ position: 'fixed', inset: 0, zIndex: 4 }} onMouseDown={() => setPickAssignee(false)} />}
                {pickAssignee && (
                  <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 5, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md)', minWidth: 220, padding: 4 }}>
                    {project.members.filter(m => m.role !== 'viewer' || assigneeIds.includes(m.id)).map(m => {
                      const on = assigneeIds.includes(m.id);
                      return (
                        <button key={m.id} type="button" onClick={() => save({ assignee_ids: on ? assigneeIds.filter(id => id !== m.id) : [...assigneeIds, m.id] })}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px', border: 'none', borderRadius: 6, background: on ? 'rgba(var(--accent-rgb), .12)' : 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }}>
                          <Avatar user={m} size={22} serverIP={currentServerIP} /> <span style={{ flex: 1, textAlign: 'left' }}>{displayName(m)}</span>
                          {on && <CheckSquare size={14} color="var(--accent-primary)" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </Field>

        <Field label={t('pl_labels')}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {live.labels.map(l => (
              <span key={l} style={{ ...chip(true, '#8b5cf6'), cursor: 'default' }}>
                <Tag size={11} /> {l}
                {!readOnly && <X size={12} style={{ cursor: 'pointer' }} onClick={() => save({ labels: live.labels.filter(x => x !== l) })} />}
              </span>
            ))}
            {!readOnly && (
              <input
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addLabel(); } }}
                onBlur={addLabel}
                placeholder={t('pl_add_label')}
                style={{ ...inputStyle(), width: 150, padding: '5px 9px', fontSize: 12.5 }}
              />
            )}
          </div>
        </Field>

        <Field label={t('pl_description')}>
          <textarea
            value={description}
            readOnly={readOnly}
            onChange={e => setDescription(e.target.value)}
            onBlur={commitDescription}
            placeholder={t('pl_description_ph')}
            rows={4}
            style={{ ...inputStyle(), resize: 'vertical', lineHeight: 1.5 }}
          />
        </Field>

        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
            <CheckSquare size={13} /> {t('pl_checklist')}
            {live.checklist.length > 0 && <span style={{ color: 'var(--text-tertiary)' }}>{done}/{live.checklist.length}</span>}
          </div>
          {live.checklist.length > 0 && (
            <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-tertiary)', marginBottom: 8, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(done / live.checklist.length) * 100}%`, background: '#10b981', transition: 'width .2s' }} />
            </div>
          )}
          {live.checklist.map(item => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
              <input type="checkbox" disabled={readOnly} checked={item.done}
                onChange={() => setChecklist(live.checklist.map(i => (i.id === item.id ? { ...i, done: !i.done } : i)))} />
              <span style={{ flex: 1, fontSize: 14, color: item.done ? 'var(--text-tertiary)' : 'var(--text-primary)', textDecoration: item.done ? 'line-through' : 'none' }}>{item.text}</span>
              {!readOnly && <IconButton title={t('pl_remove')} onClick={() => setChecklist(live.checklist.filter(i => i.id !== item.id))} style={{ width: 24, height: 24 }}><X size={12} /></IconButton>}
            </div>
          ))}
          {!readOnly && (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input value={newItem} onChange={e => setNewItem(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addItem(); }}
                placeholder={t('pl_add_item')} style={{ ...inputStyle(), padding: '6px 10px', fontSize: 13 }} />
              <IconButton title={t('pl_add')} onClick={addItem}><Plus size={15} /></IconButton>
            </div>
          )}
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
            <MessageSquare size={13} /> {t('pl_comments')}
          </div>
          {comments?.map(c => (
            <div key={c.id} style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <Avatar user={c.author} size={28} serverIP={currentServerIP} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>
                  <b style={{ color: 'var(--text-primary)' }}>{displayName(c.author)}</b>{' '}
                  <span style={{ color: 'var(--text-tertiary)' }}>{new Date(c.created_at).toLocaleString(language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div style={{ fontSize: 13.5, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.text}</div>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6 }}>
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={1}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendComment(); } }}
              placeholder={t('pl_comment_ph')} style={{ ...inputStyle(), resize: 'none' }} />
            <IconButton title={t('pl_send')} onClick={() => void sendComment()} active={!!comment.trim()}><Send size={15} /></IconButton>
          </div>
        </div>
      </Modal>
      {confirmDelete && (
        <Confirm
          title={t('pl_delete_task')}
          message={t('pl_delete_task_hint').replace('{title}', live.title)}
          confirmLabel={t('pl_delete')}
          cancelLabel={t('pl_cancel')}
          onConfirm={async () => { setConfirmDelete(false); onClose(); await planner.deleteTask(live).catch(reportError); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}
