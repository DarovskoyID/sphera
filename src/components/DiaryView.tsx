import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, Send, Trash2, X, Tag, BarChart3, CheckSquare, MapPin, User as UserIcon, NotebookPen, Paperclip } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { MessageText } from './EmojiPicker';
import { RichMessage } from './RichMessage';
import { RichComposer } from './RichComposer';
import type { GuildMessage, RichMessageType, RichPayload } from '../types';

// Auth-fetched media (images / video) — the diary is private so attachments need
// the bearer token.
function AuthMedia({ url, contentType, filename }: { url: string; contentType: string; filename: string }) {
  const { currentServerIP, authToken } = useApp();
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

function entryDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const RICH_KINDS: readonly string[] = ['poll', 'todo', 'contact', 'location'];
function isRich(m: GuildMessage) { return !!m.payload && !!m.message_type && RICH_KINDS.includes(m.message_type); }

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

export const DiaryView: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const {
    currentGuild, currentGuildChannel, guildMessages, currentServerIP, authToken,
    deleteGuildMessage, customEmojis, sendRichMessage, currentUser,
    votePoll, closePoll, toggleTodoItem, pushLiveLocation, fetchPollVoters,
  } = useApp();
  const tr = useTranslation();

  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const [richType, setRichType] = useState<RichMessageType | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const gid = currentGuild?.id;
  const cid = currentGuildChannel?.id;
  const scope = gid && cid ? { kind: 'guild' as const, guildId: gid, channelId: cid } : null;

  // Entries newest-first for a journal feel.
  const entries = useMemo(() => {
    const list = [...guildMessages].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const q = query.trim().toLowerCase();
    if (!q) return list;
    const bare = q.replace(/^#/, '');
    return list.filter(m =>
      (m.content || '').toLowerCase().includes(q) ||
      (m.tags || []).some(t => t.toLowerCase().includes(bare))
    );
  }, [guildMessages, query]);

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^#/, '').slice(0, 30);
    if (t && !tags.includes(t) && tags.length < 15) setTags(prev => [...prev, t]);
    setTagDraft('');
  };

  const uploadFiles = async (list: File[]): Promise<string[]> => {
    if (!scope) return [];
    const ids: string[] = [];
    for (const f of list) {
      const form = new FormData();
      form.append('file', f, f.name);
      const res = await fetch(`${currentServerIP}/api/guilds/${scope.guildId}/channels/${scope.channelId}/upload/`,
        { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: form });
      if (res.ok) ids.push((await res.json()).id);
    }
    return ids;
  };

  const post = async () => {
    if (!scope || (!text.trim() && files.length === 0)) return;
    setSending(true);
    try {
      const body = text.trim();
      const localFiles = [...files];
      const usedTags = [...tags];
      setText(''); setFiles([]); setTags([]);
      const attIds = localFiles.length ? await uploadFiles(localFiles) : [];
      await fetch(`${currentServerIP}/api/guilds/${scope.guildId}/channels/${scope.channelId}/messages/send/`, {
        method: 'POST', headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: body, attachment_ids: attIds, reply_to_id: null, tags: usedTags }),
      });
    } catch { /* surfaced by realtime absence */ }
    finally { setSending(false); }
  };

  if (!currentGuild) return null;

  const attachItems = [
    { key: 'file', icon: <Paperclip size={16} />, label: tr('attach_file'), run: () => fileRef.current?.click() },
    { key: 'todo', icon: <CheckSquare size={16} />, label: tr('attach_todo'), run: () => setRichType('todo') },
    { key: 'contact', icon: <UserIcon size={16} />, label: tr('attach_contact'), run: () => setRichType('contact') },
    { key: 'location', icon: <MapPin size={16} />, label: tr('attach_location'), run: () => setRichType('location') },
    { key: 'poll', icon: <BarChart3 size={16} />, label: tr('attach_poll'), run: () => setRichType('poll') },
  ] as const;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)', ...style }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg,#a855f7,#7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <NotebookPen size={18} color="#fff" />
        </div>
        <div style={{ minWidth: 0, flex: '0 1 auto' }}>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentGuild.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{tr('diary_private_note')}</div>
        </div>
        <div style={{ position: 'relative', marginLeft: 'auto', flex: '1 1 auto', maxWidth: 360 }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={tr('diary_search')}
            style={{ width: '100%', padding: '8px 12px 8px 34px', borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
          />
          {query && <X size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', cursor: 'pointer' }} onClick={() => setQuery('')} />}
        </div>
      </div>

      {/* Timeline */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
        {entries.length === 0 && (
          <div style={{ marginTop: 60, color: 'var(--text-tertiary)', textAlign: 'center' }}>
            <NotebookPen size={40} style={{ opacity: 0.4, marginBottom: 10 }} />
            <div style={{ fontSize: 15, fontWeight: 600 }}>{query ? tr('diary_nothing_found') : tr('diary_empty')}</div>
            {!query && <div style={{ fontSize: 13, marginTop: 4 }}>{tr('diary_empty_hint')}</div>}
          </div>
        )}
        {entries.map(m => {
          const media = (m.attachments || []).filter(a => a.content_type.startsWith('image/') || a.content_type.startsWith('video/') || a.content_type.startsWith('audio/'));
          const isOwn = !!currentUser && String(m.author?.id) === String(currentUser.id);
          return (
            <article key={m.id} style={{ width: '100%', maxWidth: 680, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 14, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{entryDate(m.created_at)}</span>
                <button onClick={() => setConfirmDel(String(m.id))} title={tr('pcf_delete')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 2 }}>
                  <Trash2 size={15} />
                </button>
              </div>
              {m.content && m.content.trim() && (
                <div style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                  <MessageText text={m.content} customEmojis={customEmojis} />
                </div>
              )}
              {isRich(m) && scope && (
                <div style={{ marginTop: 10 }}>
                  <RichMessage
                    type={m.message_type as RichMessageType}
                    payload={m.payload as RichPayload}
                    isOwn={isOwn}
                    canManage={isOwn}
                    onVote={(ids) => { void votePoll(scope.guildId, String(m.id), ids); }}
                    onClosePoll={() => { void closePoll(scope.guildId, String(m.id)); }}
                    onToggleTodo={(itemId) => { void toggleTodoItem(scope, String(m.id), itemId); }}
                    onStopLive={() => { void pushLiveLocation(scope, String(m.id), { stop: true }); }}
                    onFetchVoters={(oid, off, lim) => fetchPollVoters(scope.guildId, String(m.id), oid, off, lim)}
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
            <input ref={fileRef} type="file" multiple hidden accept="image/*,video/*,audio/*" onChange={e => { if (e.target.files) setFiles(prev => [...prev, ...Array.from(e.target.files!)]); e.target.value = ''; }} />
            <button onClick={() => setAttachMenu(v => !v)} title={tr('pcf_add')} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 10, width: 40, height: 40, flexShrink: 0, cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '6px 10px' }}>
              <textarea
                ref={taRef}
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void post(); } }}
                placeholder={tr('diary_write')}
                rows={1}
                style={{ resize: 'none', minHeight: 24, maxHeight: 200, border: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 14, outline: 'none', width: '100%', fontFamily: 'inherit' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderTop: '1px solid var(--border-color)', paddingTop: 5 }}>
                <Tag size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <input
                  value={tagDraft}
                  onChange={e => setTagDraft(e.target.value)}
                  onKeyDown={e => { if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && tagDraft.trim()) { e.preventDefault(); addTag(tagDraft); } else if (e.key === 'Backspace' && !tagDraft && tags.length) { setTags(prev => prev.slice(0, -1)); } }}
                  placeholder={tr('diary_add_tag')}
                  style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, outline: 'none' }}
                />
              </div>
            </div>
            <button onClick={() => void post()} disabled={sending || (!text.trim() && files.length === 0)} title={tr('diary_save')} style={{ background: 'var(--accent-primary)', border: 'none', borderRadius: 10, width: 44, height: 40, flexShrink: 0, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: (sending || (!text.trim() && files.length === 0)) ? 0.6 : 1 }}>
              <Send size={17} />
            </button>
          </div>
        </div>
      </div>

      {richType && scope && (
        <RichComposer
          type={richType}
          onCancel={() => setRichType(null)}
          onSubmit={async (type, payload) => { await sendRichMessage(scope, type, payload, tags); setTags([]); setRichType(null); }}
        />
      )}

      {confirmDel && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setConfirmDel(null)}>
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 22, maxWidth: 340, width: '100%', border: '1px solid var(--border-color)' }} onClick={e => e.stopPropagation()}>
            <p style={{ margin: '0 0 18px', color: 'var(--text-primary)', fontSize: 14 }}>{tr('diary_delete_entry')}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDel(null)} style={{ padding: '8px 16px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>{tr('cancel')}</button>
              <button onClick={() => { const id = confirmDel; setConfirmDel(null); if (id) void deleteGuildMessage(id); }} style={{ padding: '8px 16px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>{tr('pcf_delete')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DiaryView;
