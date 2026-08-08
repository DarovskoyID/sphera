import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { RichComposer } from './RichComposer';
import { RichMessage } from './RichMessage';
import type { RichMessageType, RichPayload } from '../types';
import { Send, Plus, X, FileText, Camera, Mic, Circle, Music, Square, ChevronLeft, ChevronRight, Image as ImageIcon, Eye, MessageCircle, Trash2, Settings, MoreVertical, Bell, BellOff, LogOut, SmilePlus, Smile, Play, Pause, BarChart3, CheckSquare, MapPin, User, Pencil } from 'lucide-react';
import { MessageEditModal } from './MessageEditModal';
import { EmojiPicker } from './EmojiPicker';
import { UnifiedPicker } from './StickerGifPicker';
import { useApp, reportError } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { MessageText, CensoredPlainText } from './EmojiPicker';
import { BlurredMedia } from './BlurredMedia';
import { getDraftText, setDraftText, getDraftFiles, setDraftFiles, clearDraft } from '../utils/drafts';
import { pickRecorderFormat, mediaUnsupportedReason, describeMediaError } from '../utils/recording';
import ConfirmModal from './ConfirmModal';
import { VoiceMessagePlayer, VideoCirclePlayer } from './ChatMain';
import type { Guild } from '../types';

const QUICK_REACTIONS = ['👍', '❤️', '🔥', '😂', '😮', '👏', '🎉'];

// Thumbnail for a pending attachment in the composer. Images show a preview;
// voice notes and video circles are playable so the author can review before posting.
const PendingThumb: React.FC<{ file: File; onRemove: () => void }> = ({ file, onRemove }) => {
  const tr = useTranslation();
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const [playing, setPlaying] = useState(false);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  const isVoice = file.name.startsWith('voice_') || (!isImage && !isVideo && file.type.startsWith('audio/'));

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const m = mediaRef.current;
    if (!m) return;
    if (playing) m.pause();
    else { const p = m.play(); if (p && typeof p.then === 'function') p.catch(() => {}); }
  };

  return (
    <div style={{ position: 'relative', width: 80, height: 80, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)' }}>
      {isImage ? (
        <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : isVideo ? (
        <>
          <video
            ref={el => { mediaRef.current = el; }}
            src={url}
            playsInline
            onClick={toggle}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'pointer' }}
          />
          {!playing && (
            <div onClick={toggle} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)', cursor: 'pointer' }}>
              <Play size={22} color="#fff" style={{ marginLeft: 2 }} />
            </div>
          )}
        </>
      ) : (
        <>
          <audio ref={el => { mediaRef.current = el; }} src={url} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
          <button onClick={toggle} style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4 }}>
            {playing ? <Pause size={22} color="var(--accent-primary)" /> : <Play size={22} style={{ marginLeft: 2 }} />}
            <span style={{ maxWidth: 72, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isVoice ? tr('pcf_voice') : file.name}</span>
          </button>
        </>
      )}
      <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{
        position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%',
        background: 'rgba(0,0,0,0.6)', border: 'none', cursor: 'pointer', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
      }}><X size={10} /></button>
    </div>
  );
};

function formatDate(iso: string, tr: (k: string) => string) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return tr('time_just_now');
  if (diff < 3600000) return `${Math.floor(diff / 60000)} ${tr('time_min_ago')}`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} ${tr('time_hour_ago')}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function useIsMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return mobile;
}

function extractHashtags(text?: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /#(\w{1,32})/gu;
  let m;
  while ((m = re.exec(text))) {
    const t = m[1].toLowerCase();
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, 20);
}

function isAudioAttachment(att: { content_type: string; filename: string }) {
  return att.content_type.startsWith('audio/') || (att.filename.startsWith('voice_') && att.filename.endsWith('.webm'));
}
function isVoiceNote(att: { filename: string }) {
  return att.filename.startsWith('voice_') && att.filename.endsWith('.webm');
}
function isVideoCircle(att: { filename: string }) {
  return att.filename.startsWith('video_') && att.filename.endsWith('.webm');
}

function AuthMedia({ src, contentType, filename, caption, authorId }: { src: string; contentType: string; filename: string; caption?: string; authorId?: string }) {
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
    return <BlurredMedia filename={filename} text={caption} authorId={authorId} src={blobUrl} mediaKey={src}><img src={blobUrl} alt={filename} style={{ maxWidth: 'min(400px, 100%)', maxHeight: 300, borderRadius: 12, display: 'block', cursor: 'pointer', objectFit: 'contain' }} onClick={() => window.open(blobUrl, '_blank')} /></BlurredMedia>;
  if (contentType.startsWith('video/'))
    return <BlurredMedia filename={filename} text={caption} authorId={authorId} src={blobUrl} mediaKey={src} isVideo><video src={blobUrl} controls style={{ maxWidth: 'min(400px, 100%)', maxHeight: 300, borderRadius: 12, display: 'block' }} /></BlurredMedia>;
  return null;
}

type Att = { id: string; filename: string; content_type: string; file_size: number; url: string };

function useAuthBlob(src: string | null) {
  const { authToken } = useApp();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!src) return;
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
  return blobUrl;
}

const Spinner = () => (
  <div style={{ width: 24, height: 24, border: '3px solid var(--border-color)', borderTopColor: 'var(--accent-primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
);

function GalleryThumb({ src, onClick, overlay, filename, caption, authorId }: { src: string; onClick: () => void; overlay?: string; filename?: string; caption?: string; authorId?: string }) {
  const blobUrl = useAuthBlob(src);
  return (
    <BlurredMedia filename={filename} text={caption} authorId={authorId} src={blobUrl ?? undefined} mediaKey={src}>
    <div onClick={onClick} style={{ position: 'relative', width: '100%', height: '100%', cursor: 'pointer', background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
      {blobUrl
        ? <img src={blobUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></div>}
      {overlay && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 26, fontWeight: 700 }}>
          {overlay}
        </div>
      )}
    </div>
    </BlurredMedia>
  );
}

function Lightbox({ srcs, index, onClose, onIndex }: { srcs: string[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const blobUrl = useAuthBlob(srcs[index] ?? null);
  const prev = useCallback(() => onIndex((index - 1 + srcs.length) % srcs.length), [index, srcs.length, onIndex]);
  const next = useCallback(() => onIndex((index + 1) % srcs.length), [index, srcs.length, onIndex]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, prev, next]);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(0,0,0,0.92)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <button onClick={onClose} style={{ position: 'absolute', top: 20, right: 24, background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%', width: 44, height: 44, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <X size={24} />
      </button>
      {srcs.length > 1 && (
        <div style={{ position: 'absolute', top: 24, left: 24, color: 'rgba(255,255,255,0.7)', fontSize: 14, fontWeight: 600 }}>
          {index + 1} / {srcs.length}
        </div>
      )}
      {srcs.length > 1 && (
        <button onClick={e => { e.stopPropagation(); prev(); }} style={{ position: 'absolute', left: 16, background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%', width: 52, height: 52, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
          <ChevronLeft size={30} />
        </button>
      )}
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '88vw', maxHeight: '88vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {blobUrl
          ? <img src={blobUrl} alt="" style={{ maxWidth: '88vw', maxHeight: '88vh', objectFit: 'contain', borderRadius: 8, display: 'block' }} />
          : <Spinner />}
      </div>
      {srcs.length > 1 && (
        <button onClick={e => { e.stopPropagation(); next(); }} style={{ position: 'absolute', right: 16, background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%', width: 52, height: 52, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ChevronRight size={30} />
        </button>
      )}
    </div>
  );
}

function CountBadge({ n }: { n: number }) {
  return (
    <div style={{
      position: 'absolute', top: 10, right: 10, zIndex: 2,
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '4px 9px', borderRadius: 20,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      color: '#fff', fontSize: 12, fontWeight: 700, pointerEvents: 'none',
    }}>
      <ImageIcon size={13} />
      {n}
    </div>
  );
}

function PhotoGallery({ images, serverIP, caption, authorId }: { images: Att[]; serverIP: string; caption?: string; authorId?: string }) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const srcs = images.map(a => (a.url.startsWith('http') ? a.url : serverIP + a.url));
  const n = images.length;

  const lb = lightbox !== null && <Lightbox srcs={srcs} index={lightbox} onClose={() => setLightbox(null)} onIndex={setLightbox} />;

  // Single image
  if (n === 1) {
    return (
      <>
        <div style={{ borderRadius: 12, overflow: 'hidden', maxWidth: '100%' }}>
          <GalleryThumb src={srcs[0]} onClick={() => setLightbox(0)} filename={images[0].filename} caption={caption} authorId={authorId} />
        </div>
        {lb}
      </>
    );
  }

  // Two images — side by side
  if (n === 2) {
    return (
      <>
        <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, borderRadius: 12, overflow: 'hidden' }}>
          <CountBadge n={n} />
          {srcs.map((s, i) => (
            <div key={images[i].id} style={{ height: 200 }}>
              <GalleryThumb src={s} onClick={() => setLightbox(i)} filename={images[i].filename} caption={caption} authorId={authorId} />
            </div>
          ))}
        </div>
        {lb}
      </>
    );
  }

  // 3+ — Telegram-style: first image full width, rest in a 2-column grid below
  const restMax = 4;                       // up to 4 tiles in the lower grid
  const rest = images.slice(1);
  const restVisible = Math.min(rest.length, restMax);
  const hiddenCount = rest.length - restVisible;

  return (
    <>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 3, borderRadius: 12, overflow: 'hidden' }}>
        <CountBadge n={n} />
        {/* Hero image */}
        <div style={{ height: 240 }}>
          <GalleryThumb src={srcs[0]} onClick={() => setLightbox(0)} filename={images[0].filename} caption={caption} authorId={authorId} />
        </div>
        {/* Lower grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 3 }}>
          {Array.from({ length: restVisible }).map((_, i) => {
            const idx = i + 1; // offset by hero
            const isLast = i === restVisible - 1 && hiddenCount > 0;
            return (
              <div key={images[idx].id} style={{ height: 130 }}>
                <GalleryThumb src={srcs[idx]} onClick={() => setLightbox(idx)} overlay={isLast ? `+${hiddenCount + 1}` : undefined} filename={images[idx].filename} caption={caption} authorId={authorId} />
              </div>
            );
          })}
        </div>
      </div>
      {lb}
    </>
  );
}

function AttachmentBlock({ att, caption, authorId }: { att: { id: string; filename: string; content_type: string; file_size: number; url: string }; caption?: string; authorId?: string }) {
  const tr = useTranslation();
  const { currentServerIP } = useApp();
  // players prefix currentServerIP internally, so they get the raw path
  const rawUrl = att.url; // e.g. /api/guild-attachments/{id}/

  if (isVideoCircle(att)) {
    return <VideoCirclePlayer url={rawUrl} />;
  }
  if (isAudioAttachment(att)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 600 }}>
          <Music size={13} />
          {isVoiceNote(att) ? tr('pcf_voice_message') : `${tr('pcf_audio_file')} · ${att.filename}`}
        </div>
        <VoiceMessagePlayer url={rawUrl} />
      </div>
    );
  }
  if (att.content_type.startsWith('image/') || att.content_type.startsWith('video/')) {
    const fullUrl = att.url.startsWith('http') ? att.url : currentServerIP + att.url;
    return <AuthMedia src={fullUrl} contentType={att.content_type} filename={att.filename} caption={caption} authorId={authorId} />;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
      <FileText size={18} style={{ color: 'var(--text-secondary)' }} />
      <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.filename}</span>
    </div>
  );
}

function CommentsModal({ guild, messageId, serverIP, onClose }: { guild: Guild; messageId: string; serverIP: string; onClose: () => void }) {
  const tr = useTranslation();
  const { loadPostComments, addPostComment, deletePostComment, currentUser, postCommentHandler } = useApp();
  const [comments, setComments] = useState<import('../types').PostComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const c = await loadPostComments(guild.id, messageId);
    setComments(c);
    setLoading(false);
  }, [guild.id, messageId, loadPostComments]);

  useEffect(() => { refresh(); }, [refresh]);

  // Real-time: append/remove comments as other users post/delete them.
  useEffect(() => {
    postCommentHandler.current = (ev) => {
      if (ev.messageId !== messageId) return;
      if (ev.type === 'added' && ev.comment) {
        const c = ev.comment;
        setComments(prev => prev.some(x => x.id === c.id) ? prev : [...prev, c]);
        setTimeout(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, 30);
      } else if (ev.type === 'deleted') {
        setComments(prev => prev.filter(x => x.id !== ev.commentId));
      }
    };
    return () => { postCommentHandler.current = null; };
  }, [messageId, postCommentHandler]);

  const send = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    const c = await addPostComment(guild.id, messageId, input.trim());
    if (c) { setComments(prev => prev.some(x => x.id === c.id) ? prev : [...prev, c]); setInput(''); setTimeout(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, 30); }
    setSending(false);
  };

  const remove = async (id: string) => {
    await deletePostComment(guild.id, id);
    setComments(prev => prev.filter(c => c.id !== id));
  };

  const fmt = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 99000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 460, maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-primary)', borderRadius: 16, border: '1px solid var(--border-color)', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <MessageCircle size={18} style={{ color: 'var(--accent-primary)' }} />
          <span style={{ fontWeight: 700, fontSize: 15, flex: 1, color: 'var(--text-primary)' }}>{tr('pcf_comments')} {comments.length > 0 ? `· ${comments.length}` : ''}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4 }}><X size={18} /></button>
        </div>

        {/* List */}
        <div ref={listRef} style={{ flex: '1 1 auto', minHeight: 120, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 30 }}><Spinner /></div>
          ) : comments.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13, padding: '30px 10px' }}>{tr('pcf_no_comments')}</div>
          ) : comments.map(c => {
            const av = c.author.avatar ? (c.author.avatar.startsWith('http') ? c.author.avatar : serverIP + c.author.avatar) : '';
            const canDelete = currentUser && c.author.id === currentUser.id;
            return (
              <div key={c.id} style={{ display: 'flex', gap: 10 }}>
                {av ? <img src={av} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                  : <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{(c.author.nickname || c.author.username)[0]?.toUpperCase()}</div>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{c.author.nickname || c.author.username}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{fmt(c.created_at)}</span>
                    {canDelete && <button onClick={() => remove(c.id)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 2 }}><Trash2 size={13} /></button>}
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.4, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}><CensoredPlainText text={c.content} authorId={c.author?.id} /></div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Input */}
        {guild.comments_enabled ? (
          <div style={{ padding: 12, borderTop: '1px solid var(--border-color)', display: 'flex', gap: 8, flexShrink: 0 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
              placeholder={tr('pcf_write_comment')}
              autoFocus
              style={{ flex: 1, padding: '10px 14px', borderRadius: 20, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 14, outline: 'none' }}
            />
            <button onClick={send} disabled={!input.trim() || sending} style={{ background: 'var(--accent-primary)', border: 'none', borderRadius: '50%', width: 40, height: 40, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: !input.trim() || sending ? 0.5 : 1 }}><Send size={16} /></button>
          </div>
        ) : (
          <div style={{ padding: 14, borderTop: '1px solid var(--border-color)', textAlign: 'center', fontSize: 13, color: 'var(--text-tertiary)', flexShrink: 0 }}>{tr('pcf_comments_disabled')}</div>
        )}
      </div>
    </div>
  );
}

const POST_RICH_KINDS: readonly string[] = ['poll', 'todo', 'contact', 'location'];
function postIsRich(msg: import('../types').GuildMessage): boolean {
  return !!msg.payload && !!msg.message_type && POST_RICH_KINDS.includes(msg.message_type);
}

function PostCard({ msg, guild, serverIP, onEdit }: { msg: import('../types').GuildMessage; guild: Guild; serverIP: string; onEdit?: (msg: import('../types').GuildMessage) => void }) {
  const tr = useTranslation();
  const { toggleReaction, registerMessageView, deleteGuildMessage, currentUser, customEmojis,
    currentGuildChannel, votePoll, closePoll, toggleTodoItem, pushLiveLocation, setCurrentChat, fetchPollVoters } = useApp();
  const [showReactions, setShowReactions] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [confirmDeletePost, setConfirmDeletePost] = useState(false);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const reactions = msg.reactions || [];
  const isOptimistic = msg.id.startsWith('optimistic-');
  const isOwner = currentUser && guild.owner_id === currentUser.id;

  // Register a view once when the post first renders (optimistic, deduped server-side per user)
  useEffect(() => {
    if (!msg.id.startsWith('optimistic-')) registerMessageView(guild.id, msg.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg.id]);

  const myReactionCount = reactions.filter(r => r.me).length;
  const canAddReaction = myReactionCount < 3;

  const handleReaction = (emoji: string) => {
    toggleReaction(guild.id, msg.id, emoji);
    setShowReactions(false);
  };

  // Show CHANNEL identity (name + icon), not the posting user
  const channelAvatar = guild.icon ? (guild.icon.startsWith('http') ? guild.icon : serverIP + guild.icon) : '';

  // Loading skeleton while the author's post uploads (optimistic placeholder).
  if (isOptimistic) {
    const count = (msg as unknown as { pending_count?: number }).pending_count || 0;
    const cols = Math.min(count || 1, 3);
    return (
      <article style={{ background: 'var(--bg-secondary)', borderRadius: 16, border: '1px solid var(--border-color)', overflow: 'hidden', maxWidth: 450, width: '100%', flexShrink: 0, opacity: 0.85 }}>
        <div style={{ padding: '16px 20px 8px', display: 'flex', alignItems: 'center', gap: 12 }}>
          {channelAvatar ? (
            <img src={channelAvatar} alt="" style={{ width: 40, height: 40, borderRadius: 12, objectFit: 'cover' }} />
          ) : (
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--bg-tertiary)' }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{guild.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
              <div style={{ width: 12, height: 12, border: '2px solid var(--accent-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              {tr('pcf_publishing')}
            </div>
          </div>
        </div>
        {msg.content && <div style={{ padding: '0 20px 12px', color: 'var(--text-primary)', fontSize: 14, whiteSpace: 'pre-wrap' }}><CensoredPlainText text={msg.content} authorId={msg.author?.id} /></div>}
        {count > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 3, padding: '0 3px 3px' }}>
            {Array.from({ length: Math.min(count, 6) }).map((_, i) => (
              <div key={i} style={{ aspectRatio: '1 / 1', background: 'var(--bg-tertiary)', animation: 'pulse 1.5s ease-in-out infinite' }} />
            ))}
          </div>
        )}
      </article>
    );
  }

  return (
    <article style={{
      background: 'var(--bg-secondary)',
      borderRadius: 16,
      border: '1px solid var(--border-color)',
      overflow: 'hidden',
      maxWidth: 450,
      width: '100%',
      flexShrink: 0,
    }}>
      {/* Header — channel identity */}
      <div style={{ padding: '16px 20px 8px', display: 'flex', alignItems: 'center', gap: 12 }}>
        {channelAvatar ? (
          <img src={channelAvatar} alt="" style={{ width: 40, height: 40, borderRadius: 12, objectFit: 'cover' }} />
        ) : (
          <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg, var(--accent-primary), #7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16 }}>
            {guild.name[0]?.toUpperCase()}
          </div>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{guild.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{formatDate(msg.created_at, tr as (k: string) => string)}{msg.edited && ` · ${tr('msg_edited')}`}</div>
        </div>
        {isOwner && !isOptimistic && onEdit && (!msg.message_type || msg.message_type === 'text' || msg.message_type === 'todo') && (
          <button
            onClick={() => onEdit(msg)}
            title={tr('chat_edit')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 6, borderRadius: 6, display: 'flex' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent-primary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
          >
            <Pencil size={16} />
          </button>
        )}
        {isOwner && !isOptimistic && (
          <button
            onClick={() => setConfirmDeletePost(true)}
            title={tr('pcf_delete_post')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 6, borderRadius: 6, display: 'flex' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#ed4245')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>

      {/* Content */}
      {msg.content && msg.content.trim() ? (
        <div style={{ padding: '12px 20px 0', fontSize: 15, lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <MessageText text={msg.content} customEmojis={customEmojis} authorId={msg.author?.id} />
        </div>
      ) : null}

      {/* Rich post (poll / checklist / contact / location) */}
      {postIsRich(msg) && (
        <div style={{ padding: '12px 20px 0' }}>
          <RichMessage
            type={msg.message_type as RichMessageType}
            payload={msg.payload as RichPayload}
            isOwn={!!currentUser && String(msg.author?.id) === String(currentUser.id)}
            canManage={!!currentUser && (String(msg.author?.id) === String(currentUser.id) || guild.owner_id === currentUser.id)}
            onVote={(ids) => { void votePoll(guild.id, String(msg.id), ids); }}
            onClosePoll={() => { void closePoll(guild.id, String(msg.id)); }}
            onFetchVoters={(optionId, offset, limit) => fetchPollVoters(guild.id, String(msg.id), optionId, offset, limit)}
            onToggleTodo={
              (!!currentUser && (String(msg.author?.id) === String(currentUser.id) || guild.owner_id === currentUser.id))
                ? (itemId) => { if (currentGuildChannel) void toggleTodoItem({ kind: 'guild', guildId: guild.id, channelId: currentGuildChannel.id }, String(msg.id), itemId); }
                : undefined
            }
            onStopLive={() => { if (currentGuildChannel) void pushLiveLocation({ kind: 'guild', guildId: guild.id, channelId: currentGuildChannel.id }, String(msg.id), { stop: true }); }}
            onMessageContact={(userId) => setCurrentChat(userId)}
          />
        </div>
      )}

      {/* Hashtags written by the author — searchable */}
      {(() => {
        const tags = extractHashtags(msg.content);
        if (!tags.length) return null;
        return (
          <div style={{ padding: '8px 20px 0', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tags.map(t => (
              <span key={t} style={{ fontSize: 12, fontWeight: 600, padding: '2px 9px', borderRadius: 12, background: 'rgba(88,101,242,0.12)', color: 'var(--accent-primary)' }}>#{t}</span>
            ))}
          </div>
        );
      })()}

      {/* Attachments */}
      {msg.attachments && msg.attachments.length > 0 && (() => {
        const images = msg.attachments.filter(a => a.content_type.startsWith('image/'));
        const others = msg.attachments.filter(a => !a.content_type.startsWith('image/'));
        return (
          <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {images.length > 0 && <PhotoGallery images={images} serverIP={serverIP} caption={msg.content} authorId={msg.author?.id} />}
            {others.map(att => <AttachmentBlock key={att.id} att={att} caption={msg.content} authorId={msg.author?.id} />)}
          </div>
        );
      })()}

      {/* Reactions */}
      <div className="post-reactions" style={{ padding: '8px 20px 14px', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
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
        {canAddReaction && (
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
        )}
        {canAddReaction && showReactions && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', background: 'var(--bg-primary)',
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
            <button
              ref={emojiBtnRef}
              onClick={() => { setShowReactions(false); setShowEmojiPicker(true); }}
              title={tr('pcf_all_emoji')}
              style={{ background: 'var(--bg-tertiary)', border: 'none', cursor: 'pointer', borderRadius: '50%', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', marginLeft: 2 }}
            >
              <SmilePlus size={16} />
            </button>
          </div>
        )}
        {showEmojiPicker && (
          <EmojiPicker
            anchorRef={emojiBtnRef}
            onSelect={(e) => { handleReaction(e); setShowEmojiPicker(false); }}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}
        {/* View counter */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-tertiary)', fontSize: 12, fontWeight: 600 }}>
          <Eye size={14} />
          {msg.views ?? 0}
        </div>
      </div>

      {/* Comments button (Telegram-style) */}
      {guild.comments_enabled && !isOptimistic && (
        <button
          onClick={() => setShowComments(true)}
          style={{
            width: '100%', padding: '11px 20px', border: 'none', borderTop: '1px solid var(--border-color)',
            background: 'transparent', cursor: 'pointer', color: 'var(--accent-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            fontSize: 13, fontWeight: 600, transition: 'background 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <MessageCircle size={16} />
          {msg.comments_count ? `${tr('pcf_comments')} · ${msg.comments_count}` : tr('pcf_comment_action')}
        </button>
      )}

      {showComments && <CommentsModal guild={guild} messageId={msg.id} serverIP={serverIP} onClose={() => setShowComments(false)} />}

      {confirmDeletePost && (
        <ConfirmModal
          title={tr('pcf_delete_post')}
          message={tr('pcf_delete_post_confirm')}
          confirmLabel={tr('pcf_delete')}
          cancelLabel={tr('cancel')}
          onConfirm={() => { deleteGuildMessage(msg.id); setConfirmDeletePost(false); }}
          onCancel={() => setConfirmDeletePost(false)}
        />
      )}
    </article>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} style={{
      width: 44, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', flexShrink: 0,
      background: on ? 'var(--accent-primary)' : 'var(--bg-tertiary)', position: 'relative', transition: 'background 0.2s',
    }}>
      <span style={{
        position: 'absolute', top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: '50%',
        background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      }} />
    </button>
  );
}

function ChannelSettingsModal({ guild, serverIP, onClose }: { guild: Guild; serverIP: string; onClose: () => void }) {
  const tr = useTranslation();
  const { updateGuild, deleteGuild } = useApp();
  const [comments, setComments] = useState(guild.comments_enabled);
  const [discoverable, setDiscoverable] = useState(guild.is_discoverable);
  const [name, setName] = useState(guild.name);
  const [tags, setTags] = useState<string[]>(guild.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const channelAvatar = guild.icon ? (guild.icon.startsWith('http') ? guild.icon : serverIP + guild.icon) : '';

  const addTag = (value?: string) => {
    const t = (value ?? tagInput).trim().replace(/^#/, '').replace(/\s+/g, '').slice(0, 24);
    if (t && !tags.includes(t) && tags.length < 10) setTags(prev => [...prev, t]);
    setTagInput('');
  };

  const save = async () => {
    setSaving(true);
    await updateGuild(guild.id, {
      name: name.trim() || guild.name,
      comments_enabled: comments,
      is_discoverable: discoverable,
      tags: JSON.stringify(tags),
    });
    setSaving(false);
    onClose();
  };

  const confirmDelete = async () => {
    if (!deletePassword) return;
    setDeleting(true);
    setDeleteError('');
    const ok = await deleteGuild(guild.id, deletePassword);
    setDeleting(false);
    if (ok) onClose();
    else setDeleteError(tr('pcf_wrong_password'));
  };

  const changePhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !f.type.startsWith('image/')) return;
    await updateGuild(guild.id, { icon: f });
  };

  const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-color)' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 99000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 420, background: 'var(--bg-primary)', borderRadius: 16, border: '1px solid var(--border-color)', overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Settings size={18} style={{ color: 'var(--accent-primary)' }} />
          <span style={{ fontWeight: 700, fontSize: 15, flex: 1, color: 'var(--text-primary)' }}>{tr('pcf_channel_settings')}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '8px 18px 18px' }}>
          {/* Photo */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '16px 0' }}>
            <div onClick={() => photoInputRef.current?.click()} style={{ position: 'relative', width: 80, height: 80, borderRadius: 20, cursor: 'pointer', overflow: 'hidden', background: 'linear-gradient(135deg, var(--accent-primary), #7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 30 }}>
              {channelAvatar ? <img src={channelAvatar} alt="" style={{ width: 80, height: 80, objectFit: 'cover' }} /> : guild.name[0]?.toUpperCase()}
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Camera size={22} color="#fff" /></div>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{tr('pcf_change_photo')}</span>
            <input ref={photoInputRef} type="file" hidden accept="image/*" onChange={changePhoto} />
          </div>

          <input value={name} onChange={e => setName(e.target.value)} placeholder={tr('pcf_channel_name')} maxLength={100}
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px 14px', borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 14, outline: 'none', marginBottom: 4 }} />

          <Row label={tr('pcf_comments')} hint={tr('pcf_comments_hint')}>
            <Toggle on={comments} onChange={setComments} />
          </Row>
          <Row label={tr('pcf_discoverable')} hint={tr('pcf_discoverable_hint')}>
            <Toggle on={discoverable} onChange={setDiscoverable} />
          </Row>

          {/* Tags */}
          <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border-color)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>{tr('pcf_tags')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8 }}>{tr('pcf_tags_hint')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {tags.map(t => (
                <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12, background: 'rgba(88,101,242,0.15)', color: 'var(--accent-primary)', fontSize: 12, fontWeight: 600 }}>
                  #{t}
                  <button onClick={() => setTags(prev => prev.filter(x => x !== t))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-primary)', padding: 0, display: 'flex' }}><X size={11} /></button>
                </span>
              ))}
            </div>
            {tags.length < 10 && (
              <input
                value={tagInput}
                onChange={e => {
                  const v = e.target.value;
                  // Commit the tag as soon as the user types a space (or comma)
                  if (/[\s,]/.test(v)) addTag(v);
                  else setTagInput(v);
                }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } }}
                onBlur={() => addTag()}
                placeholder={tr('pcf_tag_placeholder')}
                maxLength={24}
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, outline: 'none' }}
              />
            )}
          </div>

          <button onClick={save} disabled={saving} style={{ width: '100%', marginTop: 16, padding: '11px', borderRadius: 10, border: 'none', background: 'var(--accent-primary)', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? tr('pcf_saving') : tr('pcf_save')}
          </button>

          {/* Danger zone — delete channel */}
          {!showDelete ? (
            <button onClick={() => setShowDelete(true)} style={{ width: '100%', marginTop: 10, padding: '11px', borderRadius: 10, border: '1px solid rgba(237,66,69,0.4)', background: 'transparent', color: '#ed4245', fontWeight: 600, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Trash2 size={15} /> {tr('guild_delete_channel')}
            </button>
          ) : (
            <div style={{ marginTop: 10, padding: 12, borderRadius: 10, border: '1px solid rgba(237,66,69,0.4)', background: 'rgba(237,66,69,0.06)' }}>
              <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 8 }}>{tr('pcf_delete_channel_hint')}</div>
              <input
                type="password"
                value={deletePassword}
                onChange={e => { setDeletePassword(e.target.value); setDeleteError(''); }}
                onKeyDown={e => { if (e.key === 'Enter') confirmDelete(); }}
                placeholder={tr('pcf_password')}
                autoFocus
                style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 8, border: `1px solid ${deleteError ? '#ed4245' : 'var(--border-color)'}`, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 14, outline: 'none' }}
              />
              {deleteError && <div style={{ color: '#ed4245', fontSize: 12, marginTop: 6 }}>{deleteError}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => { setShowDelete(false); setDeletePassword(''); setDeleteError(''); }} style={{ flex: 1, padding: '9px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>{tr('cancel')}</button>
                <button onClick={confirmDelete} disabled={!deletePassword || deleting} style={{ flex: 1, padding: '9px', borderRadius: 8, border: 'none', background: '#ed4245', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: !deletePassword || deleting ? 0.6 : 1 }}>
                  {deleting ? tr('pcf_deleting') : tr('pcf_delete')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const PersonalChannelFeed: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const tr = useTranslation();
  const { currentGuild, currentGuildChannel, guildMessages, currentServerIP, authToken, currentUser, customEmojis, guilds, joinGuild, sendGuildMessage, scheduleGuildMessage, updateGuild, leaveGuild, toggleGuildNotifications, addOptimisticGuildPost, removeOptimisticGuildPost, resolveGuildPost, sendRichMessage, editMessage, friends } = useApp();
  const [attachMenu, setAttachMenu] = useState(false);
  const [richType, setRichType] = useState<RichMessageType | null>(null);
  // Text edits happen inline in the composer; to-do posts open the structured editor.
  const [editingPost, setEditingPost] = useState<import('../types').GuildMessage | null>(null);
  const [editingTodoPost, setEditingTodoPost] = useState<import('../types').GuildMessage | null>(null);
  const editingIdRef = useRef<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const channelId = currentGuildChannel?.id ? `ch_${currentGuildChannel.id}` : '';

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showMemberMenu, setShowMemberMenu] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showPicker, setShowPicker] = useState(false);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const stickerSendGuard = useRef(false);
  const [scheduledNote, setScheduledNote] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);

  // Grow the composer with its content up to a max height, then scroll.
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    // Show the scrollbar only once the content exceeds the max height.
    el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden';
  }, []);

  // Restore the locally-saved draft (text + files) whenever the channel changes.
  // Saving is done imperatively (see persistInput/persistFiles) rather than in an
  // effect, so the stale composer state isn't written into the wrong channel on
  // switch, and the draft isn't cleared by effects re-running on (re)mount.
  useEffect(() => {
    setEditingPost(null); setEditingTodoPost(null);  // leaving a channel cancels any edit
    if (!channelId) { setInput(''); setFiles([]); return; }
    setInput(getDraftText(channelId));
    setFiles(getDraftFiles(channelId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Inline edit: load the post text into the composer; restore the draft on
  // cancel/save. setInput (not persistInput) keeps the stored draft intact.
  useEffect(() => {
    if (editingPost) {
      if (editingIdRef.current !== String(editingPost.id)) {
        editingIdRef.current = String(editingPost.id);
        setInput(editingPost.content || '');
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    } else if (editingIdRef.current !== null) {
      editingIdRef.current = null;
      setInput(getDraftText(channelId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingPost, channelId]);

  // Keep the textarea height in sync with restored / typed text.
  useEffect(() => { autoResize(); }, [input, autoResize]);

  const persistInput = useCallback((v: string) => {
    setInput(v);
    setDraftText(channelId, v);
  }, [channelId]);

  const persistFiles = useCallback((updater: File[] | ((prev: File[]) => File[])) => {
    setFiles(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      setDraftFiles(channelId, next);
      return next;
    });
  }, [channelId]);

  // Recording state
  const [recording, setRecording] = useState<null | 'voice' | 'video'>(null);
  const [recDuration, setRecDuration] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);

  const isOwner = currentGuild && currentUser && currentGuild.owner_id === currentUser.id;
  const isMember = !!currentGuild && guilds.some(g => String(g.id) === String(currentGuild.id));

  const handleSubscribe = async () => {
    if (!currentGuild?.invite_code) return;
    setSubscribing(true);
    try { await joinGuild(currentGuild.invite_code); } finally { setSubscribing(false); }
  };
  const isMobile = useIsMobile();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [guildMessages.length]);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const startRecording = useCallback(async (mode: 'voice' | 'video') => {
    const unsupported = mediaUnsupportedReason();
    if (unsupported) { setRecordError(unsupported); setTimeout(() => setRecordError(null), 6000); return; }
    try {
      const constraints = mode === 'video'
        ? { audio: true, video: { width: 320, height: 320, facingMode: 'user' } }
        : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      const { mimeType, ext } = pickRecorderFormat(mode);
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const actualType = recorder.mimeType || mimeType || '';
      chunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: actualType });
        const name = mode === 'video' ? `video_${Date.now()}.${ext}` : `voice_${Date.now()}.${ext}`;
        const file = new File([blob], name, { type: actualType });
        persistFiles(prev => [...prev, file]);
        stopStream();
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(mode);
      setRecDuration(0);
      recTimerRef.current = setInterval(() => setRecDuration(d => d + 1), 1000);
      if (mode === 'video') {
        setTimeout(() => { if (liveVideoRef.current) liveVideoRef.current.srcObject = stream; }, 50);
      }
    } catch (e) { reportError(e); setRecordError(describeMediaError(e)); setTimeout(() => setRecordError(null), 6000); stopStream(); }
  }, [stopStream]);

  const stopRecording = useCallback(() => {
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    recorderRef.current = null;
    setRecording(null);
  }, []);

  const cancelRecording = useCallback(() => {
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.ondataavailable = null;
      recorderRef.current.onstop = null;
      try { recorderRef.current.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    chunksRef.current = [];
    stopStream();
    setRecording(null);
  }, [stopStream]);

  useEffect(() => () => { cancelRecording(); }, [cancelRecording]);

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !currentGuild) return;
    if (!f.type.startsWith('image/')) return;
    await updateGuild(currentGuild.id, { icon: f });
  };

  const uploadFiles = async (list: File[]): Promise<Att[]> => {
    if (!currentGuild || !currentGuildChannel) return [];
    const atts: Att[] = [];
    for (const f of list) {
      const form = new FormData();
      form.append('file', f, f.name);
      const res = await fetch(
        `${currentServerIP}/api/guilds/${currentGuild.id}/channels/${currentGuildChannel.id}/upload/`,
        { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: form }
      );
      if (res.ok) { atts.push(await res.json()); }
    }
    return atts;
  };

  // Post over HTTP (reliable) rather than the chat WS, which can be stale-OPEN
  // after uploads and silently drop the frame — the reason attachment-heavy
  // posts sometimes never appeared. Persists synchronously and broadcasts.
  const postToChannel = async (text: string, attachmentIds: string[]): Promise<import('../types').GuildMessage | null> => {
    if (!currentGuild || !currentGuildChannel) return null;
    const res = await fetch(
      `${currentServerIP}/api/guilds/${currentGuild.id}/channels/${currentGuildChannel.id}/messages/send/`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, attachment_ids: attachmentIds, reply_to_id: null }),
      },
    );
    return res.ok ? await res.json() : null;
  };

  const handleSend = async () => {
    // Saving an inline edit — content only.
    if (editingPost) {
      const t = input.trim();
      if (!t || !currentGuild || !currentGuildChannel) return;
      try {
        await editMessage({ kind: 'guild', guildId: currentGuild.id, channelId: currentGuildChannel.id }, String(editingPost.id), { content: t });
      } catch { return; }
      setEditingPost(null);
      return;
    }
    if (!input.trim() && files.length === 0) return;
    if (!currentGuild || !currentGuildChannel) return;
    setSending(true);
    try {
      const text = input.trim();
      const localFiles = [...files];
      setInput('');
      setFiles([]);
      clearDraft(channelId);
      if (localFiles.length === 0) {
        await postToChannel(text, []);
      } else {
        // Immediate skeleton so the author sees the post is uploading.
        const optId = addOptimisticGuildPost(text, localFiles.length);
        try {
          const uploaded = await uploadFiles(localFiles);
          const ids = uploaded.map(a => a.id);
          // Too many attachments for one post — split into batches of 15 (the
          // first post carries the text). Add each real post straight from the
          // response so the author sees it even if the WS bridge missed them.
          const reals: import('../types').GuildMessage[] = [];
          for (let i = 0; i < ids.length; i += 15) {
            const real = await postToChannel(i === 0 ? text : '', ids.slice(i, i + 15));
            if (real) reals.push(real);
          }
          resolveGuildPost(optId, reals);
        } catch (e) {
          removeOptimisticGuildPost(optId);
          throw e;
        }
      }
    } catch (e) { reportError(e); }
    finally { setSending(false); }
  };

  // Schedule the current draft to post after a delay (handled server-side).
  const handleDelayedSend = async (delayMs: number) => {
    if (!input.trim() && files.length === 0) return;
    if (!currentGuild || !currentGuildChannel) return;
    setShowPicker(false);
    setSending(true);
    try {
      const attachmentIds = (await uploadFiles(files)).map(a => a.id);
      const result = await scheduleGuildMessage(input.trim(), Math.round(delayMs / 1000), undefined, attachmentIds.length ? attachmentIds : undefined);
      if (result) {
        setInput('');
        setFiles([]);
        clearDraft(channelId);
        const when = new Date(result.send_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        setScheduledNote(`${tr('pcf_scheduled_for')} ${when}`);
        setTimeout(() => setScheduledNote(null), 4000);
      }
    } finally {
      setSending(false);
    }
  };

  // Send a sticker/GIF as its own post immediately.
  const sendStickerPost = (url: string) => {
    if (stickerSendGuard.current) return;
    stickerSendGuard.current = true;
    sendGuildMessage(url, undefined, undefined);
    setShowPicker(false);
    setTimeout(() => { stickerSendGuard.current = false; }, 500);
  };

  if (!currentGuild || !currentGuildChannel) return null;

  const channelAvatar = currentGuild.icon ? (currentGuild.icon.startsWith('http') ? currentGuild.icon : currentServerIP + currentGuild.icon) : '';
  const fmtDur = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)', height: isMobile ? 'calc(100% - 60px)' : '100%', minHeight: 0, ...style }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } } @keyframes recpulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      {/* Header */}
      <div style={{
        padding: '14px 24px', borderBottom: '1px solid var(--border-color)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <div
          onClick={() => { if (isOwner) avatarInputRef.current?.click(); }}
          title={isOwner ? tr('pcf_change_avatar') : undefined}
          style={{
            position: 'relative', width: 40, height: 40, borderRadius: 12,
            background: 'linear-gradient(135deg, var(--accent-primary), #7c3aed)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 16, flexShrink: 0,
            cursor: isOwner ? 'pointer' : 'default', overflow: 'hidden',
          }}
        >
          {channelAvatar ? (
            <img src={channelAvatar} alt="" style={{ width: 40, height: 40, borderRadius: 12, objectFit: 'cover' }} />
          ) : currentGuild.name[0]?.toUpperCase()}
          {isOwner && (
            <div style={{
              position: 'absolute', inset: 0, borderRadius: 12, background: 'rgba(0,0,0,0.45)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0,
              transition: 'opacity 0.15s',
            }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0')}
            >
              <Camera size={16} color="#fff" />
            </div>
          )}
        </div>
        <input ref={avatarInputRef} type="file" hidden accept="image/*" onChange={handleAvatarChange} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>{currentGuild.name}</div>
          {currentGuild.description && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{currentGuild.description}</div>}
        </div>
        {isOwner ? (
          <button onClick={() => setShowSettings(true)} title={tr('pcf_channel_settings')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 8, borderRadius: 8, display: 'flex' }}>
            <Settings size={20} />
          </button>
        ) : (
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowMemberMenu(v => !v)} title={tr('pcf_menu')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 8, borderRadius: 8, display: 'flex' }}>
              <MoreVertical size={20} />
            </button>
            {showMemberMenu && (
              <>
                <div onClick={() => setShowMemberMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 51, minWidth: 220,
                  background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 10,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.3)', overflow: 'hidden', padding: 4,
                }}>
                  <button
                    onClick={() => { toggleGuildNotifications(currentGuild.id); setShowMemberMenu(false); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 14, borderRadius: 6, textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                  >
                    {currentGuild.my_notifications_muted ? <Bell size={16} /> : <BellOff size={16} />}
                    {currentGuild.my_notifications_muted ? tr('guild_notifications_on') : tr('guild_notifications_off')}
                  </button>
                  <button
                    onClick={() => { setShowMemberMenu(false); setConfirmLeave(true); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer', color: '#ed4245', fontSize: 14, borderRadius: 6, textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(237,66,69,0.1)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                  >
                    <LogOut size={16} />
                    {tr('pcf_leave_channel')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {showSettings && currentGuild && <ChannelSettingsModal guild={currentGuild} serverIP={currentServerIP} onClose={() => setShowSettings(false)} />}

      {/* Feed */}
      <div ref={scrollRef} style={{
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '24px 16px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
      }}>
        {guildMessages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-tertiary)' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📝</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{tr('pcf_no_posts')}</div>
            {isOwner && <div style={{ fontSize: 13, marginTop: 4 }}>{tr('pcf_write_first')}</div>}
          </div>
        ) : (
          guildMessages.map(msg => (
            <PostCard key={msg.id} msg={msg} guild={currentGuild} serverIP={currentServerIP} onEdit={m => { if (m.message_type === 'todo') setEditingTodoPost(m); else setEditingPost(m); }} />
          ))
        )}
      </div>

      {/* Composer (only for owner) */}
      {isOwner && (
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-color)', background: 'var(--bg-secondary)', flexShrink: 0 }}>
          {/* Recording overlay */}
          {recording && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 12 }}>
              {recording === 'video' && (
                <video ref={liveVideoRef} autoPlay muted playsInline style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover' }} />
              )}
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ed4245', animation: 'recpulse 1s infinite' }} />
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
                {recording === 'video' ? tr('pcf_recording_circle') : tr('pcf_recording_voice')} · {fmtDur(recDuration)}
              </span>
              <button onClick={cancelRecording} title={tr('cancel')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 6 }}><X size={18} /></button>
              <button onClick={stopRecording} title={tr('pcf_done')} style={{ background: 'var(--accent-primary)', border: 'none', cursor: 'pointer', color: '#fff', borderRadius: 8, padding: '6px 8px', display: 'flex', alignItems: 'center' }}><Square size={16} /></button>
            </div>
          )}

          {files.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{files.length}</span>
                {files.length > 1 && (
                  <button onClick={() => persistFiles(() => [])} title={tr('pcf_clear')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, padding: 2 }}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                {files.map((f, i) => (
                  <div key={i} style={{ flexShrink: 0 }}>
                    <PendingThumb file={f} onRemove={() => persistFiles(prev => prev.filter((_, idx) => idx !== i))} />
                  </div>
                ))}
              </div>
            </div>
          )}
          {scheduledNote && (
            <div style={{ margin: '0 0 8px', padding: '6px 12px', borderRadius: 8, background: 'rgba(59,165,93,0.12)', color: '#3ba55d', fontSize: 13, fontWeight: 600 }}>
              {scheduledNote}
            </div>
          )}
          {recordError && (
            <div style={{ margin: '0 0 8px', padding: '8px 12px', borderRadius: 8, background: 'rgba(237,66,69,0.12)', color: '#ed4245', fontSize: 13, fontWeight: 500, lineHeight: 1.4 }}>
              {recordError}
            </div>
          )}
          <input ref={fileInputRef} type="file" multiple hidden accept="image/*,video/*,audio/*" onChange={e => {
            if (e.target.files) {
              const allowed = Array.from(e.target.files).filter(f =>
                f.type.startsWith('image/') || f.type.startsWith('video/') || f.type.startsWith('audio/')
              );
              if (allowed.length) persistFiles(prev => [...prev, ...allowed]);
            }
            e.target.value = '';
          }} />
          {editingPost && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px', padding: '6px 12px', borderRadius: 8, background: 'var(--bg-secondary)', borderLeft: '3px solid var(--accent-primary)' }}>
              <Pencil size={13} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: 'var(--accent-primary)' }}>{tr('chat_edit_title')}</span>
              <button onClick={() => setEditingPost(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2, flexShrink: 0 }}>
                <X size={14} />
              </button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', position: 'relative' }}>
            {/* Single rounded input bar holding the textarea + inline action icons */}
            <div className="composer-bar">
              <button className="composer-icon-btn" onClick={() => setAttachMenu(v => !v)} disabled={!!recording} title={tr('pcf_add')}>
                <Plus size={20} />
              </button>
              {attachMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setAttachMenu(false)} />
                  <div style={{
                    position: 'absolute', bottom: '100%', left: 0, marginBottom: 8, zIndex: 41,
                    background: 'var(--bg-secondary, #2b2d31)', borderRadius: 10, padding: 5, minWidth: 190,
                    border: '1px solid var(--border-color, rgba(255,255,255,.1))',
                    boxShadow: '0 8px 24px rgba(0,0,0,.35)',
                  }}>
                    {([
                      { key: 'file', icon: <Plus size={16} />, label: tr('attach_file'), run: () => fileInputRef.current?.click() },
                      { key: 'poll', icon: <BarChart3 size={16} />, label: tr('attach_poll'), run: () => setRichType('poll') },
                      { key: 'todo', icon: <CheckSquare size={16} />, label: tr('attach_todo'), run: () => setRichType('todo') },
                      { key: 'contact', icon: <User size={16} />, label: tr('attach_contact'), run: () => setRichType('contact') },
                      { key: 'location', icon: <MapPin size={16} />, label: tr('attach_location'), run: () => setRichType('location') },
                    ] as const).map(item => (
                      <button
                        key={item.key}
                        onClick={() => { setAttachMenu(false); item.run(); }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px',
                          borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer',
                          color: 'var(--text-primary)', fontSize: 14, textAlign: 'left',
                        }}
                      >
                        {item.icon}{item.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {richType && currentGuild && currentGuildChannel && (
                <RichComposer
                  type={richType}
                  contacts={friends}
                  onCancel={() => setRichType(null)}
                  onSubmit={async (type, payload) => {
                    await sendRichMessage(
                      { kind: 'guild', guildId: currentGuild.id, channelId: currentGuildChannel.id },
                      type, payload,
                    );
                    setRichType(null);
                  }}
                />
              )}
              <textarea
                ref={textareaRef}
                className="composer-input"
                value={input}
                onChange={e => { if (editingPost) setInput(e.target.value); else persistInput(e.target.value); }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                placeholder={editingPost ? tr('chat_edit_title') : tr('pcf_write_post')}
                rows={1}
              />
              <button className="composer-icon-btn" onClick={() => recording === 'voice' ? stopRecording() : startRecording('voice')} disabled={recording === 'video'} title={tr('pcf_voice_message')}
                style={recording === 'voice' ? { color: '#ed4245' } : undefined}>
                <Mic size={19} />
              </button>
              <button className="composer-icon-btn" onClick={() => recording === 'video' ? stopRecording() : startRecording('video')} disabled={recording === 'voice'} title={tr('pcf_video_circle')}
                style={recording === 'video' ? { color: '#ed4245' } : undefined}>
                <Circle size={19} />
              </button>
              <button
                ref={pickerButtonRef}
                className={`composer-icon-btn ${showPicker ? 'active' : ''}`}
                onClick={() => setShowPicker(v => !v)}
                disabled={!!recording}
                title={tr('pcf_picker_title')}>
                <Smile size={19} />
              </button>
            </div>
            {showPicker && (
              <UnifiedPicker
                anchorRef={pickerButtonRef}
                onSelectEmoji={emoji => persistInput(input + emoji)}
                onSelectGif={url => sendStickerPost(url)}
                onSelectSticker={url => sendStickerPost(url)}
                onDelayedSend={ms => handleDelayedSend(ms)}
                canSchedule={!!input.trim() || files.length > 0}
                onClose={() => setShowPicker(false)}
              />
            )}
            <button
              className="composer-send-btn"
              onClick={handleSend}
              disabled={sending || (!input.trim() && files.length === 0)}
              title={tr('pcf_publish')}
            >
              <Send size={16} /> {tr('pcf_post')}
            </button>
          </div>
        </div>
      )}

      {/* Non-members previewing the channel get a Subscribe bar instead of a composer */}
      {!isOwner && !isMember && (
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-color)', background: 'var(--bg-secondary)', flexShrink: 0 }}>
          <button
            onClick={handleSubscribe}
            disabled={subscribing}
            style={{
              width: '100%', padding: '11px 0', borderRadius: 22, border: 'none',
              background: 'var(--accent-primary)', color: '#fff', fontWeight: 600, fontSize: 14,
              cursor: subscribing ? 'default' : 'pointer', opacity: subscribing ? 0.6 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {subscribing
              ? <div style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              : <SmilePlus size={18} />}
            {subscribing ? tr('pcf_subscribing') : tr('pcf_subscribe')}
          </button>
        </div>
      )}

      {confirmLeave && (
        <ConfirmModal
          title={tr('pcf_leave_channel')}
          message={`${tr('pcf_unsub_confirm')} «${currentGuild.name}»?`}
          confirmLabel={tr('pcf_leave')}
          cancelLabel={tr('cancel')}
          onConfirm={() => { leaveGuild(currentGuild.id); setConfirmLeave(false); }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
      {editingTodoPost && currentGuild && currentGuildChannel && (
        <MessageEditModal
          msg={editingTodoPost}
          onCancel={() => setEditingTodoPost(null)}
          onSave={async body => {
            await editMessage({ kind: 'guild', guildId: currentGuild.id, channelId: currentGuildChannel.id }, String(editingTodoPost.id), body);
            setEditingTodoPost(null);
          }}
        />
      )}
    </div>
  );
};
