import React, { useEffect, useRef, useState } from 'react';
import { Send, Plus, X, FileText } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { MessageText } from './EmojiPicker';
import type { GuildMessage } from '../types';

const QUICK_REACTIONS = ['👍', '❤️', '🔥', '😂', '😮', '👏', '🎉'];

function formatDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function AuthMedia({ src, contentType, filename }: { src: string; contentType: string; filename: string }) {
  const { authToken } = useApp();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src, { headers: { Authorization: `Bearer ${authToken}` } });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (!cancelled) setBlobUrl(URL.createObjectURL(blob));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; setBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; }); };
  }, [src, authToken]);

  if (!blobUrl) return <div style={{ width: '100%', maxWidth: 500, height: 200, borderRadius: 12, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ width: 24, height: 24, border: '3px solid var(--accent-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
  </div>;

  if (contentType.startsWith('image/'))
    return <img src={blobUrl} alt={filename} style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 12, display: 'block', cursor: 'pointer' }} onClick={() => window.open(blobUrl, '_blank')} />;
  if (contentType.startsWith('video/'))
    return <video src={blobUrl} controls style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 12, display: 'block' }} />;
  return null;
}

function PostCard({ msg, guildId, serverIP }: { msg: GuildMessage; guildId: string; serverIP: string }) {
  const { toggleReaction, currentUser } = useApp();
  const [showReactions, setShowReactions] = useState(false);
  const reactions = msg.reactions || [];

  const handleReaction = (emoji: string) => {
    toggleReaction(guildId, msg.id, emoji);
    setShowReactions(false);
  };

  const avatarUrl = msg.author.avatar ? (msg.author.avatar.startsWith('http') ? msg.author.avatar : serverIP + msg.author.avatar) : '';

  return (
    <article style={{
      background: 'var(--bg-secondary)',
      borderRadius: 16,
      border: '1px solid var(--border-color)',
      overflow: 'hidden',
      maxWidth: 600,
      width: '100%',
    }}>
      {/* Header */}
      <div style={{ padding: '16px 20px 0', display: 'flex', alignItems: 'center', gap: 12 }}>
        {avatarUrl ? (
          <img src={avatarUrl} alt="" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }} />
        ) : (
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16 }}>
            {(msg.author.nickname || msg.author.username)[0]?.toUpperCase()}
          </div>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{msg.author.nickname || msg.author.username}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{formatDate(msg.created_at)}</div>
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: '12px 20px' }}>
        {msg.content && (
          <div style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            <MessageText text={msg.content} />
          </div>
        )}
      </div>

      {/* Attachments */}
      {msg.attachments && msg.attachments.length > 0 && (
        <div style={{ padding: '0 20px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {msg.attachments.map(att => {
            const url = att.url.startsWith('http') ? att.url : serverIP + att.url;
            if (att.content_type.startsWith('image/') || att.content_type.startsWith('video/')) {
              return <AuthMedia key={att.id} src={url} contentType={att.content_type} filename={att.filename} />;
            }
            return (
              <div key={att.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                <FileText size={18} style={{ color: 'var(--text-secondary)' }} />
                <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.filename}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Reactions */}
      <div style={{ padding: '0 20px 14px', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {reactions.map(r => (
          <button
            key={r.emoji}
            onClick={() => handleReaction(r.emoji)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 20,
              background: r.me ? 'rgba(88,101,242,0.15)' : 'var(--bg-tertiary)',
              border: r.me ? '1px solid rgba(88,101,242,0.4)' : '1px solid var(--border-color)',
              cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)',
              transition: 'all 0.15s',
            }}
          >
            <span>{r.emoji}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: r.me ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>{r.count}</span>
          </button>
        ))}
        <button
          onClick={() => setShowReactions(!showReactions)}
          style={{
            width: 32, height: 28, borderRadius: 14, border: '1px solid var(--border-color)',
            background: 'var(--bg-tertiary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-secondary)', fontSize: 14, transition: 'background 0.15s',
          }}
        >
          +
        </button>
        {showReactions && (
          <div style={{
            display: 'flex', gap: 4, padding: '4px 8px', background: 'var(--bg-primary)',
            borderRadius: 20, border: '1px solid var(--border-color)', boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          }}>
            {QUICK_REACTIONS.map(e => (
              <button key={e} onClick={() => handleReaction(e)} style={{
                background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, padding: '2px 4px',
                borderRadius: 6, transition: 'background 0.1s',
              }}>
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

export const PersonalChannelFeed: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const { currentGuild, currentGuildChannel, guildMessages, currentServerIP, authToken, currentUser, sendGuildMessage } = useApp();
  const tr = useTranslation();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isOwner = currentGuild && currentUser && currentGuild.owner_id === currentUser.id;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [guildMessages.length]);

  const handleSend = async () => {
    if (!input.trim() && files.length === 0) return;
    if (!currentGuild || !currentGuildChannel) return;
    setSending(true);

    let attachmentIds: string[] = [];
    for (const f of files) {
      const form = new FormData();
      form.append('file', f);
      try {
        const res = await fetch(
          `${currentServerIP}/api/guilds/${currentGuild.id}/channels/${currentGuildChannel.id}/upload/`,
          { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: form }
        );
        if (res.ok) { const d = await res.json(); attachmentIds.push(d.id); }
      } catch { /* ignore */ }
    }

    sendGuildMessage(input.trim(), undefined, attachmentIds.length ? attachmentIds : undefined);
    setInput('');
    setFiles([]);
    setSending(false);
  };

  if (!currentGuild || !currentGuildChannel) return null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)', ...style }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>

      {/* Header */}
      <div style={{
        padding: '14px 24px', borderBottom: '1px solid var(--border-color)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--accent-primary), #7c3aed)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 700, fontSize: 15,
        }}>
          {currentGuild.icon ? (
            <img src={currentGuild.icon.startsWith('http') ? currentGuild.icon : currentServerIP + currentGuild.icon} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
          ) : currentGuild.name[0]?.toUpperCase()}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>{currentGuild.name}</div>
          {currentGuild.description && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{currentGuild.description}</div>}
        </div>
      </div>

      {/* Feed */}
      <div ref={scrollRef} style={{
        flex: 1, overflow: 'auto', padding: '24px 16px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
      }}>
        {guildMessages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-tertiary)' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📝</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>No posts yet</div>
            {isOwner && <div style={{ fontSize: 13, marginTop: 4 }}>Write your first post below</div>}
          </div>
        ) : (
          guildMessages.map(msg => (
            <PostCard key={msg.id} msg={msg} guildId={currentGuild.id} serverIP={currentServerIP} />
          ))
        )}
      </div>

      {/* Composer (only for owner) */}
      {isOwner && (
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-color)', background: 'var(--bg-secondary)' }}>
          {files.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              {files.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', background: 'var(--bg-tertiary)', borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
                  <span style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <button onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 0 }}><X size={12} /></button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 8 }}
            >
              <Plus size={20} />
            </button>
            <input ref={fileInputRef} type="file" multiple hidden onChange={e => {
              if (e.target.files) setFiles(prev => [...prev, ...Array.from(e.target.files!)]);
              e.target.value = '';
            }} />
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Write a post..."
              style={{
                flex: 1, resize: 'none', padding: '10px 14px', borderRadius: 12,
                border: '1px solid var(--border-color)', background: 'var(--bg-primary)',
                color: 'var(--text-primary)', fontSize: 14, outline: 'none',
                minHeight: 40, maxHeight: 120,
                fontFamily: 'inherit',
              }}
              rows={1}
            />
            <button
              onClick={handleSend}
              disabled={sending || (!input.trim() && files.length === 0)}
              style={{
                background: 'var(--accent-primary)', border: 'none', borderRadius: 10,
                padding: '10px 16px', cursor: 'pointer', color: '#fff',
                display: 'flex', alignItems: 'center', gap: 6,
                opacity: sending || (!input.trim() && files.length === 0) ? 0.5 : 1,
                fontWeight: 600, fontSize: 13,
              }}
            >
              <Send size={16} /> Post
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
