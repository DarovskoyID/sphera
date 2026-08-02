import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';
import { RichComposer } from './RichComposer';
import type { RichMessageType } from '../types';

/** A message the current user may edit: plain text or a to-do list. Polls are
 *  never passed here (the caller hides the edit action for them). */
export interface EditableMessage {
  id: string;
  content?: string;
  message_type?: string;
  // Loosely typed: callers pass ChatMessage/GuildMessage whose payload is a wider
  // RichPayload union; only the to-do shape (title/items) is read here.
  payload?: any;
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};
const sheet: React.CSSProperties = {
  width: '100%', maxWidth: 460, background: 'var(--bg-secondary, #2b2d31)',
  borderRadius: 14, padding: 18, border: '1px solid var(--border-color, rgba(255,255,255,.1))',
};
const textareaStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: 14, resize: 'vertical',
  border: '1px solid var(--border-color, rgba(255,255,255,.12))',
  background: 'var(--bg-tertiary, #1e1f22)', color: 'var(--text-primary)',
  outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.5,
};
const primaryBtn: React.CSSProperties = {
  flex: 1, padding: '9px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--accent-primary)', color: '#fff', fontWeight: 600, fontSize: 14,
};
const ghostBtn: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 14,
  border: '1px solid var(--border-color, rgba(255,255,255,.12))',
  background: 'transparent', color: 'var(--text-primary)',
};
const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2,
};

export const MessageEditModal: React.FC<{
  msg: EditableMessage;
  onCancel: () => void;
  /** Resolve to close; reject/throw to keep the dialog open on error. */
  onSave: (body: { content?: string; payload?: Record<string, unknown> }) => Promise<void>;
}> = ({ msg, onCancel, onSave }) => {
  const tr = useTranslation();
  const [text, setText] = useState(msg.content ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // To-do list → reuse the rich composer, prefilled with the current items.
  if (msg.message_type === 'todo') {
    const p = msg.payload || {};
    return (
      <RichComposer
        type={'todo' as RichMessageType}
        initialTodo={{
          title: p.title ?? '',
          items: Array.isArray(p.items) ? p.items.map((i: { text?: string }) => i.text ?? '') : [],
        }}
        onCancel={onCancel}
        onSubmit={async (_type, payload) => { await onSave({ payload }); }}
      />
    );
  }

  const save = async () => {
    if (!text.trim()) { setError(tr('chat_edit_empty')); return; }
    setBusy(true); setError('');
    try {
      await onSave({ content: text });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onMouseDown={onCancel}>
      <div style={sheet} onMouseDown={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15, color: 'var(--text-primary)' }}>{tr('chat_edit_title')}</h3>
          <button onClick={onCancel} style={iconBtn} aria-label={tr('cancel')}><X size={18} /></button>
        </div>
        <textarea
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }}
          style={textareaStyle}
          rows={4}
          maxLength={5000}
        />
        {error && <div style={{ color: '#ff6b6b', fontSize: 13, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={save} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>{tr('chat_edit_save')}</button>
          <button onClick={onCancel} style={ghostBtn}>{tr('cancel')}</button>
        </div>
      </div>
    </div>
  );
};

export default MessageEditModal;
