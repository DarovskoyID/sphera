import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, Send, Trash2, X, Tag, BarChart3, CheckSquare, MapPin, User as UserIcon, NotebookPen, Paperclip, Pencil } from 'lucide-react';
import {
  CensorOff, HideSelectionButton, MessageEditModal, MessageText, RichComposer, RichMessage,
  useCore, useModuleStore, useModuleT, useT, type RichMessageType, type RichPayload,
} from '@sfera/sdk';
import * as diary from './store';
import type { DiaryEntry } from './types';

// Auth-fetched media (images / video) — the diary is private so attachments need
// the bearer token.
function AuthMedia({ url, contentType, filename }: { url: string; contentType: string; filename: string }) {
  const { currentServerIP, authToken } = useCore();
  const [blob, setBlob] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    fetch(`${currentServerIP}${url}`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.ok ? r.blob() : null)
      .then(b => { if (b && !dead) setBlob(URL.createObjectURL(b)); })
      .catch(() => {});
    return () => { dead = true; setBlob(prev => { if (prev) URL.revokeObjectURL(prev); return null; }); };
  }, [url, currentServerIP, authToken]);
  if (!blob) return <div style={{ width: 160, height: 100, borderRadius: 8, background: 'var(--bg-tertiary)' }} />;
  if (contentType.startsWith('image/')) return <img src={blob} alt={filename} style={{ maxWidth: 'min(360px,100%)', maxHeight: 300, borderRadius: 8, display: 'block' }} onClick={() => window.open(blob, '_blank')} />;
  if (contentType.startsWith('video/')) return <video src={blob} controls style={{ maxWidth: 'min(360px,100%)', maxHeight: 320, borderRadius: 8, display: 'block' }} />;
  if (contentType.startsWith('audio/')) return <audio src={blob} controls style={{ maxWidth: 320 }} />;
  return <a href={blob} download={filename} style={{ color: 'var(--accent-primary)', fontSize: 13 }}>{filename}</a>;
}

function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const h = (e: MediaQueryListEvent) => setM(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return m;
}

function entryDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const EMPTY: DiaryEntry[] = [];
const RICH_KINDS: readonly string[] = ['poll', 'todo', 'contact', 'location'];
function isRich(m: DiaryEntry) { return !!m.payload && !!m.message_type && RICH_KINDS.includes(m.message_type); }

// A TagInput used both in the composer and the search bar.
function TagChips({ tags, onRemove }: { tags: string[]; onRemove?: (t: string) => void }) {
  return (
    <>
      {tags.map(t => (
        <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '2px 8px', borderRadius: 999, background: 'rgba(139,92,246,0.16)', color: '#a855f7', fontWeight: 600 }}>
          #{t}
          {onRemove && <X size={11} style={{ cursor: 'pointer' }} onClick={() => onRemove(t)} />}
        </span>
      ))}
    </>
  );
}

export const DiaryView: React.FC<{ style?: React.CSSProperties; diaryId: string }> = ({ style, diaryId }) => {
  const { customEmojis, currentUser } = useCore();
  const tr = useT();
  const t = useModuleT();
  const current = useModuleStore(diary.store, s => s.diaries.find(d => d.id === diaryId));
  const guildMessages = useModuleStore(diary.store, s => s.entries[diaryId]) ?? EMPTY;
  useEffect(() => { void diary.openDiary(diaryId).catch(() => {}); }, [diaryId]);
  const isMobile = useIsMobile();

  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const [showTag, setShowTag] = useState(false);
  const [richType, setRichType] = useState<RichMessageType | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [editing, setEditing] = useState<DiaryEntry | null>(null);
  const [editingTodo, setEditingTodo] = useState<DiaryEntry | null>(null);
  const editingIdRef = useRef<string | null>(null);
  const priorTextRef = useRef('');
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Inline edit: load the entry text into the note field; restore the previous
  // draft on cancel/save.
  useEffect(() => {
    if (editing) {
      if (editingIdRef.current !== String(editing.id)) {
        if (editingIdRef.current === null) priorTextRef.current = text;
        editingIdRef.current = String(editing.id);
        setText(editing.content || '');
        requestAnimationFrame(() => taRef.current?.focus());
      }
    } else if (editingIdRef.current !== null) {
      editingIdRef.current = null;
      setText(priorTextRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Auto-grow the note field so it never shows an ugly inner scrollbar.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 134) + 'px';
  }, [text]);


  // Oldest first → newest at the bottom, like a journal / chat.
  const entries = useMemo(() => {
    const list = [...guildMessages].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const q = query.trim().toLowerCase();
    if (!q) return list;
    const bare = q.replace(/^#/, '');
    return list.filter(m =>
      (m.content || '').toLowerCase().includes(q) ||
      (m.tags || []).some(t => t.toLowerCase().includes(bare))
    );
  }, [guildMessages, query]);

  // Keep the newest entry in view (initial load + when a new one arrives).
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [guildMessages.length]);

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^#/, '').slice(0, 30);
    if (t && !tags.includes(t) && tags.length < 15) setTags(prev => [...prev, t]);
    setTagDraft('');
  };

  const post = async () => {
    // Saving an inline edit — content only.
    if (editing) {
      const body = text.trim();
      if (!body) return;
      try {
        await diary.editEntry(String(editing.id), { content: body });
      } catch { return; }
      setEditing(null);
      return;
    }
    if (!text.trim() && files.length === 0) return;
    setSending(true);
    const body = text.trim();
    const localFiles = [...files];
    const usedTags = [...tags];
    setText(''); setFiles([]); setTags([]);
    try {
      await diary.addEntry(diaryId, body, usedTags, localFiles);
    } catch {
      // Give the draft back rather than losing it.
      setText(body); setFiles(localFiles); setTags(usedTags);
    } finally { setSending(false); }
  };

  if (!current) return null;

  const attachItems = [
    { key: 'file', icon: <Paperclip size={16} />, label: tr('attach_file'), run: () => fileRef.current?.click() },
    { key: 'todo', icon: <CheckSquare size={16} />, label: tr('attach_todo'), run: () => setRichType('todo') },
    { key: 'contact', icon: <UserIcon size={16} />, label: tr('attach_contact'), run: () => setRichType('contact') },
    { key: 'location', icon: <MapPin size={16} />, label: tr('attach_location'), run: () => setRichType('location') },
    { key: 'poll', icon: <BarChart3 size={16} />, label: tr('attach_poll'), run: () => setRichType('poll') },
  ] as const;

  return (
    // The diary is a private note to self: the reader is the author, so there
    // is nobody to shield and nothing here is masked.
    <CensorOff>
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)', height: isMobile ? 'calc(100% - 60px)' : '100%', minHeight: 0, ...style }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg,#a855f7,#7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <NotebookPen size={18} color="#fff" />
        </div>
        <div style={{ minWidth: 0, flex: '0 1 auto' }}>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('diary_private_note')}</div>
        </div>
        <div style={{ position: 'relative', marginLeft: 'auto', flex: '1 1 auto', maxWidth: 360 }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('diary_search')}
            style={{ width: '100%', padding: '8px 12px 8px 34px', borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
          />
          {query && <X size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', cursor: 'pointer' }} onClick={() => setQuery('')} />}
        </div>
      </div>

      {/* Timeline */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
        {entries.length === 0 && (
          <div style={{ marginTop: 60, color: 'var(--text-tertiary)', textAlign: 'center' }}>
            <NotebookPen size={40} style={{ opacity: 0.4, marginBottom: 10 }} />
            <div style={{ fontSize: 15, fontWeight: 600 }}>{query ? t('diary_nothing_found') : t('diary_empty')}</div>
            {!query && <div style={{ fontSize: 13, marginTop: 4 }}>{t('diary_empty_hint')}</div>}
          </div>
        )}
        {entries.map(m => {
          // Every attachment is shown: AuthMedia renders media inline and falls
          // back to a download link for documents and archives.
          const media = m.attachments || [];
          const isOwn = !!currentUser && String(m.author?.id) === String(currentUser.id);
          return (
            <article key={m.id} style={{ width: '100%', maxWidth: 680, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 14, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{entryDate(m.created_at)}{m.edited && ` · ${tr('msg_edited')}`}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  {isOwn && (!m.message_type || m.message_type === 'text' || m.message_type === 'todo') && (
                    <button onClick={() => { if (m.message_type === 'todo') setEditingTodo(m); else setEditing(m); }} title={tr('chat_edit')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 2 }}>
                      <Pencil size={15} />
                    </button>
                  )}
                  <button onClick={() => setConfirmDel(String(m.id))} title={tr('pcf_delete')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 2 }}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              {m.content && m.content.trim() && (
                <div style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                  <MessageText text={m.content} customEmojis={customEmojis} authorId={m.author?.id} />
                </div>
              )}
              {isRich(m) && (
                <div style={{ marginTop: 10 }}>
                  <RichMessage
                    type={m.message_type as RichMessageType}
                    payload={m.payload as RichPayload}
                    isOwn={isOwn}
                    canManage={isOwn}
                    onVote={(ids) => { void diary.votePoll(diaryId, m.id, ids); }}
                    onClosePoll={() => { void diary.closePoll(diaryId, m.id); }}
                    onToggleTodo={(itemId) => { void diary.toggleTodo(diaryId, m.id, itemId); }}
                    onStopLive={() => { void diary.stopLive(diaryId, m.id); }}
                  />
                </div>
              )}
              {media.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                  {media.map(a => <AuthMedia key={a.id} url={a.url} contentType={a.content_type} filename={a.filename} />)}
                </div>
              )}
              {(m.tags && m.tags.length > 0) && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                  {m.tags.map(t => (
                    <span key={t} onClick={() => setQuery('#' + t)} style={{ cursor: 'pointer', fontSize: 12, padding: '2px 8px', borderRadius: 999, background: 'rgba(139,92,246,0.16)', color: '#a855f7', fontWeight: 600 }}>#{t}</span>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {/* Composer */}
      <div style={{ borderTop: '1px solid var(--border-color)', padding: '12px 20px', flexShrink: 0, background: 'var(--bg-primary)' }}>
        <div style={{ maxWidth: 680, margin: '0 auto' }}>
          {editing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-tertiary)', borderLeft: '3px solid var(--accent-primary)' }}>
              <Pencil size={13} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: 'var(--accent-primary)' }}>{tr('chat_edit_title')}</span>
              <X size={14} style={{ cursor: 'pointer', color: 'var(--text-secondary)' }} onClick={() => setEditing(null)} />
            </div>
          )}
          {(tags.length > 0) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              <TagChips tags={tags} onRemove={t => setTags(prev => prev.filter(x => x !== t))} />
            </div>
          )}
          {files.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {files.map((f, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 8px', borderRadius: 8, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                  {f.name.slice(0, 24)}
                  <X size={12} style={{ cursor: 'pointer' }} onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} />
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, position: 'relative' }}>
            <input ref={fileRef} type="file" multiple hidden onChange={e => {
              // Snapshot the list first: the state updater runs after the input
              // is cleared, so reading e.target.files inside it yields nothing.
              const picked = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = '';
              if (picked.length) setFiles(prev => [...prev, ...picked]);
            }} />
            <div className="composer-bar">
              <button className="composer-icon-btn" title={tr('pcf_add')} onClick={() => setAttachMenu(v => !v)}>
                <Plus size={20} />
              </button>
              {attachMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setAttachMenu(false)} />
                  <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 8, zIndex: 41, background: 'var(--bg-secondary)', borderRadius: 10, padding: 5, minWidth: 190, border: '1px solid var(--border-color)', boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>
                    {attachItems.map(it => (
                      <button key={it.key} onClick={() => { setAttachMenu(false); it.run(); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 14, textAlign: 'left' }}>
                        {it.icon}{it.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <textarea
                ref={taRef}
                className="composer-input"
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void post(); } }}
                placeholder={t('diary_write')}
                rows={1}
              />
              <HideSelectionButton inputRef={taRef} value={text} onChange={setText} />
              <button className="composer-icon-btn" title={t('diary_add_tag')} onClick={() => setShowTag(v => !v)} style={{ position: 'relative', color: showTag ? '#a855f7' : undefined }}>
                <Tag size={19} />
                {tags.length > 0 && <span style={{ position: 'absolute', top: 0, right: 0, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 8, background: '#a855f7', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{tags.length}</span>}
              </button>
              {showTag && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => { if (tagDraft.trim()) addTag(tagDraft); setShowTag(false); }} />
                  <div style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: 10, zIndex: 41, width: 240, background: 'var(--bg-secondary)', borderRadius: 10, padding: 10, border: '1px solid var(--border-color)', boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: .3, textTransform: 'uppercase', color: 'var(--text-muted, #949ba4)', marginBottom: 6 }}>{tr('pcf_tags')}</div>
                    {tags.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                        <TagChips tags={tags} onRemove={t => setTags(prev => prev.filter(x => x !== t))} />
                      </div>
                    )}
                    <input
                      autoFocus
                      value={tagDraft}
                      onChange={e => setTagDraft(e.target.value)}
                      // No physical Enter on mobile — a space commits the tag, and
                      // whatever's left is committed on blur / when the popover closes.
                      onKeyDown={e => { if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && tagDraft.trim()) { e.preventDefault(); addTag(tagDraft); } else if (e.key === 'Backspace' && !tagDraft && tags.length) { setTags(prev => prev.slice(0, -1)); } }}
                      onBlur={() => { if (tagDraft.trim()) addTag(tagDraft); }}
                      placeholder={t('diary_add_tag')}
                      style={{ width: '100%', padding: '7px 9px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                    />
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 5 }}>{t('diary_tag_hint')}</div>
                  </div>
                </>
              )}
            </div>
            <button className="composer-send-btn" onClick={() => void post()} disabled={sending || (!text.trim() && files.length === 0)} title={t('diary_save')} style={{ padding: '0 16px', opacity: (sending || (!text.trim() && files.length === 0)) ? 0.6 : 1 }}>
              <Send size={17} />
            </button>
          </div>
        </div>
      </div>

      {richType && (
        <RichComposer
          type={richType}
          onCancel={() => setRichType(null)}
          onSubmit={async (type, payload) => { await diary.addRich(diaryId, type, payload, tags); setTags([]); setRichType(null); }}
        />
      )}

      {editingTodo && (
        <MessageEditModal
          msg={editingTodo}
          onCancel={() => setEditingTodo(null)}
          onSave={async body => { await diary.editEntry(String(editingTodo.id), body); setEditingTodo(null); }}
        />
      )}

      {confirmDel && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setConfirmDel(null)}>
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 22, maxWidth: 340, width: '100%', border: '1px solid var(--border-color)' }} onClick={e => e.stopPropagation()}>
            <p style={{ margin: '0 0 18px', color: 'var(--text-primary)', fontSize: 14 }}>{t('diary_delete_entry')}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDel(null)} style={{ padding: '8px 16px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>{tr('cancel')}</button>
              <button onClick={() => { const id = confirmDel; setConfirmDel(null); if (id) void diary.deleteEntry(diaryId, id); }} style={{ padding: '8px 16px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>{tr('pcf_delete')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </CensorOff>
  );
};

