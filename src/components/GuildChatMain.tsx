import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Hash, Send, Pin, Trash2, CornerUpLeft, Plus, MoreHorizontal, X, Download, FileText, FileImage, FileVideo, FileAudio, File, ChevronLeft, ChevronDown, Reply, Copy, Flag, Clock, Ban, UserX, VolumeX, Volume1, User, BarChart3, CheckSquare, MapPin, Pencil } from 'lucide-react';
import { MessageEditModal } from './MessageEditModal';
import { RichMessage } from './RichMessage';
import { RichComposer } from './RichComposer';
import { AccountBadge, accountDisplayName } from './BotBadge';
import { BotCommandsButton } from './BotCommandsButton';
import type { RichMessageType, RichPayload } from '../types';
import { useApp, reportError } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { MessageText } from './EmojiPicker';
import { BlurredMedia } from './BlurredMedia';
import { UnifiedPicker } from './StickerGifPicker';
import { ProfileModal, type ProfileUser } from './ProfileModal';
import ConfirmModal from './ConfirmModal';
import { getDraftText, setDraftText, getDraftFiles, setDraftFiles } from '../utils/drafts';
import type { GuildMessage, GuildMember, GuildRole } from '../types';
import { useAnchoredMenu } from './useAnchoredMenu';

const MAX_FILES = 10;

type PendingFile = { file: File; preview?: string };
type ScheduledItem = { id: string; send_at: string; content: string };

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(type: string) {
  if (type.startsWith('image/')) return <FileImage size={20} />;
  if (type.startsWith('video/')) return <FileVideo size={20} />;
  if (type.startsWith('audio/')) return <FileAudio size={20} />;
  if (type.includes('text') || type.includes('pdf')) return <FileText size={20} />;
  return <File size={20} />;
}

/** Fetches media with Authorization header and renders as blob URL (image or video) */
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
    return () => {
      cancelled = true;
      setBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    };
  }, [src, authToken]);

  if (!blobUrl) {
    return (
      <div style={{ width: 200, height: 120, borderRadius: 8, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 4 }}>
        <div style={{ width: 20, height: 20, border: '2px solid var(--accent-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }

  if (contentType.startsWith('image/')) {
    return (
      <BlurredMedia filename={filename} text={caption} authorId={authorId} src={blobUrl} mediaKey={src}>
        <img
          src={blobUrl}
          alt={filename}
          style={{ maxWidth: 'min(320px, 100%)', maxHeight: 240, borderRadius: 8, display: 'block', cursor: 'pointer', marginTop: 4, objectFit: 'contain' }}
          onClick={() => window.open(blobUrl, '_blank')}
        />
      </BlurredMedia>
    );
  }

  return (
    <BlurredMedia filename={filename} text={caption} authorId={authorId} src={blobUrl} mediaKey={src} isVideo>
      <video
        src={blobUrl}
        controls
        style={{ maxWidth: 'min(400px, 100%)', maxHeight: 280, borderRadius: 8, display: 'block', marginTop: 4 }}
      />
    </BlurredMedia>
  );
}

function AttachmentView({ att, caption, authorId }: { att: { id: string; filename: string; content_type: string; file_size: number; url: string }; caption?: string; authorId?: string }) {
  const { currentServerIP, authToken } = useApp();
  const tr = useTranslation();
  const isMedia = att.content_type.startsWith('image/') || att.content_type.startsWith('video/');
  const src = `${currentServerIP}${att.url}`;

  const handleDownload = async () => {
    try {
      const res = await fetch(src, { headers: { Authorization: `Bearer ${authToken}` } });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = att.filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { reportError(e); }
  };

  if (isMedia) {
    return <AuthMedia src={src} contentType={att.content_type} filename={att.filename} caption={caption} authorId={authorId} />;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-tertiary)', borderRadius: 8, padding: '8px 12px', marginTop: 4, maxWidth: 300 }}>
      <span style={{ color: 'var(--accent-primary)' }}>{getFileIcon(att.content_type)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.filename}</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{formatFileSize(att.file_size)}</div>
      </div>
      <button onClick={handleDownload} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4 }} title={tr('chat_download')}>
        <Download size={16} />
      </button>
    </div>
  );
}

const MSG_HEIGHT = 60;

function shouldShowDateSeparator(current: GuildMessage, prev?: GuildMessage): boolean {
  if (!prev) return true;
  const d1 = new Date(prev.created_at);
  const d2 = new Date(current.created_at);
  return d1.getFullYear() !== d2.getFullYear() || d1.getMonth() !== d2.getMonth() || d1.getDate() !== d2.getDate();
}

const DateSeparator: React.FC<{ label: string }> = ({ label }) => (
  <div className="date-separator">
    <span className="date-separator-label">{label}</span>
  </div>
);

type GuildCtxMenu = { x: number; y: number; msg: GuildMessage };

const GuildMessageContextMenu: React.FC<{
  menu: GuildCtxMenu;
  isOwn: boolean;
  myRole: string;
  authorRole: string;
  onClose: () => void;
  onReply: (msg: GuildMessage) => void;
  onEdit: (msg: GuildMessage) => void;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
  onCopy: (text: string) => void;
  onProfile: (msg: GuildMessage) => void;
  onKick: (userId: string) => void;
  onBlock: (userId: string) => void;
  onMute: (userId: string) => void;
  onUnmute: (userId: string) => void;
  authorMutedUntil?: string | null;
}> = ({ menu, isOwn, myRole, authorRole, onClose, onReply, onEdit, onDelete, onPin, onCopy, onProfile, onKick, onBlock, onMute, onUnmute, authorMutedUntil }) => {
  const tr = useTranslation();
  const { ref, style: position, portal } = useAnchoredMenu(menu, onClose);

  const isAdmin = myRole === 'owner' || myRole === 'admin';
  const canManageAuthor = isAdmin && !isOwn && authorRole !== 'owner' && !(myRole === 'admin' && authorRole === 'admin');
  const canPin = isAdmin;
  const canDelete = isOwn || isAdmin;

  const style: React.CSSProperties = {
    ...position,
    background: 'var(--bg-primary, #1a1a2e)',
    border: '1px solid var(--border-color, #333)',
    borderRadius: 10,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    minWidth: 180,
    padding: '4px 0',
  };

  const item = (icon: React.ReactNode, label: string, onClick: () => void, danger = false) => (
    <button
      key={label}
      onClick={() => { onClick(); onClose(); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', padding: '9px 14px', background: 'none',
        border: 'none', cursor: 'pointer', fontSize: 14,
        color: danger ? '#ff4444' : 'var(--text-primary, #fff)',
        textAlign: 'left',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary, #222)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
    >
      {icon}{label}
    </button>
  );

  const sep = <div style={{ height: 1, background: 'var(--border-color)', margin: '4px 0' }} />;

  return portal(
    <div ref={ref} style={style}>
      {item(<User size={15} />, tr('guild_view_profile'), () => onProfile(menu.msg))}
      {item(<Reply size={15} />, tr('chat_reply'), () => onReply(menu.msg))}
      {isOwn && (!menu.msg.message_type || menu.msg.message_type === 'text' || menu.msg.message_type === 'todo') &&
        item(<Pencil size={15} />, tr('chat_edit'), () => onEdit(menu.msg))}
      {item(<Copy size={15} />, tr('chat_copy_text'), () => onCopy(menu.msg.content))}
      {canPin && item(<Pin size={15} />, menu.msg.is_pinned ? tr('chat_unpin_msg') : tr('chat_pin'), () => onPin(menu.msg.id))}
      {canDelete && item(<Trash2 size={15} />, tr('chat_delete'), () => onDelete(menu.msg.id), true)}
      {canManageAuthor && sep}
      {canManageAuthor && authorMutedUntil && new Date(authorMutedUntil).getTime() > Date.now()
        ? item(<Volume1 size={15} />, tr('guild_unmute'), () => onUnmute(menu.msg.author.id))
        : canManageAuthor && item(<VolumeX size={15} />, tr('guild_mute_member'), () => onMute(menu.msg.author.id), true)}
      {canManageAuthor && item(<UserX size={15} />, tr('guild_kick'), () => onKick(menu.msg.author.id), true)}
      {canManageAuthor && item(<Ban size={15} />, tr('guild_block'), () => onBlock(menu.msg.author.id), true)}
    </div>
  );
};

// ── Rich messages (poll / checklist / contact / location) ───────────────────
const GUILD_RICH_KINDS: readonly string[] = ['poll', 'todo', 'contact', 'location'];

function isRichMsg(msg: GuildMessage): boolean {
  return !!msg.payload && !!msg.message_type && GUILD_RICH_KINDS.includes(msg.message_type);
}

const GuildRichCard: React.FC<{
  msg: GuildMessage;
  isOwn: boolean;
  showAuthor: boolean;
  displayName: string;
  onProfileClick: (author: GuildMessage['author']) => void;
}> = ({ msg, isOwn, showAuthor, displayName, onProfileClick }) => {
  const { currentGuild, currentGuildChannel, votePoll, closePoll, toggleTodoItem, pushLiveLocation, setCurrentChat, fetchPollVoters } = useApp();
  if (!currentGuild || !currentGuildChannel) return null;
  const scope = { kind: 'guild' as const, guildId: currentGuild.id, channelId: currentGuildChannel.id };
  const id = String(msg.id);
  const canManage = isOwn || currentGuild.my_role === 'owner' || currentGuild.my_role === 'admin';
  return (
    <div style={{ position: 'relative' }}>
      {showAuthor && (
        <div className="message-author-bubble" onClick={() => onProfileClick(msg.author)} style={{ cursor: 'pointer' }}>
          {displayName}
        </div>
      )}
      <RichMessage
        type={msg.message_type as RichMessageType}
        payload={msg.payload as RichPayload}
        isOwn={isOwn}
        authorId={msg.author?.id}
        canManage={canManage}
        onVote={(ids) => { void votePoll(currentGuild.id, id, ids); }}
        onClosePoll={() => { void closePoll(currentGuild.id, id); }}
        onFetchVoters={(optionId, offset, limit) => fetchPollVoters(currentGuild.id, id, optionId, offset, limit)}
        onToggleTodo={canManage ? (itemId) => { void toggleTodoItem(scope, id, itemId); } : undefined}
        onStopLive={() => { void pushLiveLocation(scope, id, { stop: true }); }}
        onMessageContact={(userId) => setCurrentChat(userId)}
      />
    </div>
  );
};

const GuildMessageRow = React.memo(({ msg, isOwn, isFirstInGroup, onContextMenu, onReply, onProfileClick, customEmojis, members, highlight }: {
  msg: GuildMessage;
  isOwn: boolean;
  isFirstInGroup: boolean;
  onContextMenu: (e: React.MouseEvent, msg: GuildMessage) => void;
  onReply: (msg: GuildMessage) => void;
  onProfileClick: (author: GuildMessage['author']) => void;
  customEmojis: any[];
  members: GuildMember[];
  highlight?: boolean;
}) => {
  const tr = useTranslation();
  const displayName = accountDisplayName(msg.author);
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const [avatarError, setAvatarError] = useState(false);
  // Long-press (mobile) opens the same context menu as right-click (desktop).
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpFired = useRef(false);
  const startLongPress = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    lpFired.current = false;
    const x = t.clientX, y = t.clientY;
    lpTimer.current = setTimeout(() => {
      lpFired.current = true;
      onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: x, clientY: y } as unknown as React.MouseEvent, msg);
    }, 450);
  };
  const cancelLongPress = () => { if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; } };

  return (
    <div
      data-msg-id={msg.id}
      className={`message-item ${isOwn ? 'own' : ''} ${isFirstInGroup ? '' : 'compact'}`}
      style={{
        minHeight: isFirstInGroup ? MSG_HEIGHT : undefined, position: 'relative',
        background: highlight
          ? 'rgba(0,112,243,0.18)'
          : msg.is_pinned ? 'rgba(0,112,243,0.08)' : undefined,
        transition: 'background 0.3s ease',
      }}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e, msg); }}
      onTouchStart={startLongPress}
      onTouchEnd={cancelLongPress}
      onTouchMove={cancelLongPress}
    >
      {msg.is_pinned && (
        <div style={{ position: 'absolute', top: 4, ...(isOwn ? { left: 4 } : { right: 4 }), color: 'var(--accent-primary)', opacity: 0.7, zIndex: 1 }}>
          <Pin size={12} />
        </div>
      )}
      <div className="message-avatar-slot" onClick={() => onProfileClick(msg.author)} style={{ cursor: 'pointer' }}>
        {isFirstInGroup
          ? (msg.author.avatar && !avatarError
              ? <img src={msg.author.avatar} alt={displayName} style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} onError={() => setAvatarError(true)} />
              : <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
                  {(displayName[0] || '?').toUpperCase()}
                </div>
            )
          : null
        }
      </div>
      <div className="message-content" style={{ flex: 1, minWidth: 0 }}>
        <div className="message-bubble">
          {msg.content && (
            <div className="message-text" style={{ position: 'relative' }}>
              {isFirstInGroup && (
                <div className="message-author-bubble" onClick={() => onProfileClick(msg.author)} style={{ cursor: 'pointer' }}>{displayName}<AccountBadge account={msg.author} /></div>
              )}
              {msg.reply_to && (
                <div className="message-reply-preview">
                  <span className="message-reply-author">
                    {msg.reply_to.author.nickname || msg.reply_to.author.username}
                  </span>
                  <span className="message-reply-text">
                    <MessageText text={msg.reply_to.content} customEmojis={customEmojis} members={members} authorId={msg.reply_to.author?.id} />
                  </span>
                </div>
              )}
              <div className="message-line">
                <span className="message-body">
                  <MessageText text={msg.content} customEmojis={customEmojis} members={members} authorId={msg.author?.id} />
                </span>
                <span className="message-timestamp">{msg.edited && <span style={{ marginRight: 4, opacity: 0.75 }}>{tr('msg_edited')}</span>}{time}</span>
              </div>
            </div>
          )}
          {isRichMsg(msg) && (
            <GuildRichCard
              msg={msg}
              isOwn={isOwn}
              showAuthor={isFirstInGroup && !msg.content}
              displayName={displayName}
              onProfileClick={onProfileClick}
            />
          )}
          {msg.attachments?.map(att => (
            <AttachmentView key={att.id} att={att} caption={msg.content} authorId={msg.author?.id} />
          ))}
          {!msg.content && ((msg.attachments?.length ?? 0) > 0 || isRichMsg(msg)) && (
            <span className="message-timestamp message-timestamp-standalone">
              {msg.edited && <span style={{ marginRight: 4, opacity: 0.75 }}>{tr('msg_edited')}</span>}
              {time}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

export const GuildChatMain: React.FC = () => {
  const {
    currentGuild, currentGuildChannel, guildMessages,
    sendGuildMessage, scheduleGuildMessage, loadOlderGuildMessages,
    userIDonServer, currentServerIP, authToken,
    setMobileActivePanel, deleteGuildMessage, pinGuildMessage, customEmojis,
    kickMember, blockUser, loadGuildRoles, sendRichMessage, friends, editMessage,
  } = useApp();
  const tr = useTranslation();
  // Text edits happen inline in the composer; to-do lists open the structured editor.
  const [editing, setEditing] = useState<GuildMessage | null>(null);
  const [editingTodo, setEditingTodo] = useState<GuildMessage | null>(null);
  const editingIdRef = useRef<string | null>(null);

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return tr('chat_today');
    if (d.toDateString() === yesterday.toDateString()) return tr('chat_yesterday');
    return d.toLocaleDateString();
  };

  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<GuildMessage | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const [richType, setRichType] = useState<RichMessageType | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [scheduledItems, setScheduledItems] = useState<ScheduledItem[]>([]);
  const [limitWarning, setLimitWarning] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<GuildCtxMenu | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [profileUser, setProfileUser] = useState<ProfileUser | null>(null);
  const [muteTarget, setMuteTarget] = useState<string | null>(null);
  const [muteMinutes, setMuteMinutes] = useState(5);
  const [guildRoles, setGuildRoles] = useState<GuildRole[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  const mutedUntil = currentGuild?.my_muted_until ? new Date(currentGuild.my_muted_until) : null;
  const isMuted = mutedUntil ? mutedUntil.getTime() > Date.now() : false;

  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);
  const wasAtBottom = useRef(true);
  const loadingOlderRef = useRef(false);
  const lastMsgIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const stickerSendGuard = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);

  // Local draft (text + files) per channel — survives switching channels.
  const draftScope = currentGuildChannel?.id ? `gc_${currentGuildChannel.id}` : '';
  useEffect(() => {
    setEditing(null); setEditingTodo(null);  // leaving a channel cancels any edit
    if (!draftScope) { setInput(''); setPendingFiles([]); return; }
    setInput(getDraftText(draftScope));
    setPendingFiles(getDraftFiles(draftScope).map(f => ({ file: f, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftScope]);
  // Saved imperatively (not in an effect) so the draft isn't clobbered on (re)mount / scope switch.
  const persistInput = useCallback((v: string) => { setInput(v); setDraftText(draftScope, v); }, [draftScope]);

  // Inline edit: load the message text into the composer; restore the draft on
  // cancel/save. setInput (not persistInput) keeps the stored draft intact.
  useEffect(() => {
    if (editing) {
      if (editingIdRef.current !== String(editing.id)) {
        editingIdRef.current = String(editing.id);
        setInput(editing.content || '');
      }
    } else if (editingIdRef.current !== null) {
      editingIdRef.current = null;
      setInput(getDraftText(draftScope));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, draftScope]);
  const persistPendingFiles = useCallback((updater: PendingFile[] | ((prev: PendingFile[]) => PendingFile[])) => {
    setPendingFiles(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      setDraftFiles(draftScope, next.map(p => p.file));
      return next;
    });
  }, [draftScope]);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    wasAtBottom.current = true;
    setAtBottom(true);
    setNewCount(0);
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const isInitialLoad = prevLenRef.current === 0;
    const added = guildMessages.length - prevLenRef.current;
    const shouldStickToBottom = wasAtBottom.current;
    prevLenRef.current = guildMessages.length;

    // Timing-proof "is this actually new?" check: only a changed tail id means a
    // message arrived at the bottom. Prepended history (scroll-up load) grows the
    // list without a new tail, so it must not bump the unread counter.
    const lastId = guildMessages.length ? String(guildMessages[guildMessages.length - 1].id) : null;
    const appendedAtBottom = lastId !== lastMsgIdRef.current;
    lastMsgIdRef.current = lastId;
    if (!appendedAtBottom || added <= 0) return;

    if (isInitialLoad || shouldStickToBottom) {
      requestAnimationFrame(() => {
        const current = listRef.current;
        if (current) current.scrollTop = current.scrollHeight;
      });
      wasAtBottom.current = true;
      setAtBottom(true);
      setNewCount(0);
      return;
    }

    wasAtBottom.current = false;
    setAtBottom(false);
    setNewCount(c => c + added);
  }, [guildMessages.length]);

  useEffect(() => {
    setHasMore(true);
    prevLenRef.current = 0;
    lastMsgIdRef.current = null;
    wasAtBottom.current = true;
    setAtBottom(true);
    setNewCount(0);
    setScheduledItems([]);
    setTimeout(() => bottomRef.current?.scrollIntoView(), 50);
  }, [currentGuildChannel?.id]);

  useEffect(() => {
    if (!currentGuild) return;
    loadGuildRoles(currentGuild.id).then(r => setGuildRoles(r || [])).catch(() => {});
  }, [currentGuild?.id]);

  const members = currentGuild?.members ?? [];

  const mentionSuggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const results: { label: string; insert: string; type: 'user' | 'role' | 'all' }[] = [];
    if ('everyone'.startsWith(q)) results.push({ label: '@everyone', insert: '@everyone', type: 'all' });
    for (const m of members) {
      const name = m.nickname || m.username;
      if (name.toLowerCase().startsWith(q) || m.username.toLowerCase().startsWith(q))
        results.push({ label: `@${name}`, insert: `@${m.username}`, type: 'user' });
    }
    for (const r of guildRoles) {
      if (r.name.toLowerCase().startsWith(q))
        results.push({ label: `@${r.name}`, insert: `@role:${r.name}`, type: 'role' });
    }
    return results.slice(0, 8);
  }, [mentionQuery, members, guildRoles]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    if (editing) setInput(val); else persistInput(val);
    const cursor = e.target.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const match = before.match(/@(\w*)$/);
    if (match) { setMentionQuery(match[1]); setMentionIdx(0); }
    else setMentionQuery(null);
  }, [persistInput, editing]);

  const insertMention = useCallback((insert: string) => {
    persistInput((() => {
      const match = input.match(/(.*?)@\w*$/s);
      return match ? match[1] + insert + ' ' : input + insert + ' ';
    })());
    setMentionQuery(null);
  }, [persistInput, input]);

  const openProfile = useCallback((author: GuildMessage['author']) => {
    setProfileUser({
      id: author.id,
      username: author.username,
      nickname: author.nickname,
      avatar: author.avatar,
      status: members.find(m => String(m.id) === String(author.id))?.status ?? 'offline',
    });
  }, [members]);

  const handleKick = useCallback((userId: string) => {
    if (!currentGuild) return;
    kickMember(currentGuild.id, userId);
  }, [currentGuild, kickMember]);

  const handleBlock = useCallback((userId: string) => {
    if (!currentGuild) return;
    kickMember(currentGuild.id, userId);
    blockUser(userId);
  }, [currentGuild, kickMember, blockUser]);

  const handleScroll = useCallback(async () => {
    const el = listRef.current;
    if (!el) return;

    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    wasAtBottom.current = nearBottom;
    setAtBottom(nearBottom);
    if (nearBottom) setNewCount(0);

    if (loadingOlderRef.current || loadingOlder || !hasMore) return;
    if (el.scrollTop < 100) {
      loadingOlderRef.current = true;
      setLoadingOlder(true);
      const prevHeight = el.scrollHeight;
      try {
        const more = await loadOlderGuildMessages();
        if (!more) setHasMore(false);
        requestAnimationFrame(() => {
          const current = listRef.current;
          if (current) current.scrollTop = current.scrollHeight - prevHeight;
        });
      } finally {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [loadingOlder, hasMore, loadOlderGuildMessages]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    e.target.value = '';
    if (!selected.length) return;
    persistPendingFiles(prev => {
      const available = MAX_FILES - prev.length;
      if (available <= 0) { setLimitWarning(true); setTimeout(() => setLimitWarning(false), 3000); return prev; }
      const allowed = selected.slice(0, available);
      if (selected.length > available) { setLimitWarning(true); setTimeout(() => setLimitWarning(false), 3000); }
      return [...prev, ...allowed.map(f => ({ file: f, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined }))];
    });
  }, [persistPendingFiles]);

  const removeFile = useCallback((i: number) => {
    persistPendingFiles(prev => {
      const entry = prev[i];
      if (entry?.preview) URL.revokeObjectURL(entry.preview);
      return prev.filter((_, idx) => idx !== i);
    });
  }, [persistPendingFiles]);

  const clearFiles = useCallback(() => {
    persistPendingFiles(prev => { prev.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); }); return []; });
  }, [persistPendingFiles]);

  const uploadFiles = useCallback(async (files: PendingFile[]): Promise<NonNullable<GuildMessage['attachments']>> => {
    if (!currentGuild || !currentGuildChannel || files.length === 0) return [];
    setUploading(true);
    const atts: NonNullable<GuildMessage['attachments']> = [];
    try {
      const results = await Promise.all(files.map(async ({ file }) => {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(
          `${currentServerIP}/api/guilds/${currentGuild.id}/channels/${currentGuildChannel.id}/upload/`,
          { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: form }
        );
        if (res.ok) { return await res.json(); }
        return null;
      }));
      results.forEach(a => { if (a != null) atts.push(a); });
    } catch (e) { reportError(e); }
    finally { setUploading(false); }
    return atts;
  }, [currentGuild, currentGuildChannel, currentServerIP, authToken]);

  const handleSend = useCallback(async () => {
    // Saving an inline edit — content only.
    if (editing) {
      const t = input.trim();
      if (!t || !currentGuild || !currentGuildChannel) return;
      try {
        await editMessage({ kind: 'guild', guildId: currentGuild.id, channelId: currentGuildChannel.id }, String(editing.id), { content: t });
      } catch { return; }
      setEditing(null);
      return;
    }
    if (!input.trim() && pendingFiles.length === 0) return;
    const text = input;
    const files = pendingFiles;
    const replyId = replyTo?.id;
    persistInput('');
    clearFiles();
    setReplyTo(null);
    const uploaded = await uploadFiles(files);
    const attachmentIds = uploaded.map(a => a.id);
    sendGuildMessage(text, replyId, attachmentIds.length ? attachmentIds : undefined, uploaded.length ? uploaded : undefined);
  }, [editing, currentGuild, currentGuildChannel, editMessage, input, pendingFiles, replyTo, uploadFiles, sendGuildMessage, clearFiles, persistInput]);

  const handleDelayedSend = useCallback(async (delayMs: number) => {
    if (!input.trim() && pendingFiles.length === 0) return;
    setShowPicker(false);
    const text = input;
    const files = [...pendingFiles];
    const replyId = replyTo?.id;
    persistInput('');
    clearFiles();
    setReplyTo(null);
    const attachmentIds = (await uploadFiles(files)).map(a => a.id);
    const result = await scheduleGuildMessage(text, Math.round(delayMs / 1000), replyId, attachmentIds.length ? attachmentIds : undefined);
    if (result) setScheduledItems(prev => [...prev, { id: result.id, send_at: result.send_at, content: text }]);
  }, [input, pendingFiles, replyTo, uploadFiles, scheduleGuildMessage, clearFiles, persistInput]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (mentionQuery !== null && mentionSuggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx(i => Math.min(i + 1, mentionSuggestions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); insertMention(mentionSuggestions[mentionIdx].insert); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return; }
    }
    // On phones (≤768px) Enter inserts a newline — sending is via the button.
    // Desktop keeps Enter-to-send (Shift+Enter for a newline).
    if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia('(max-width: 768px)').matches) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = input.trim().length > 0 || pendingFiles.length > 0;

  const openCtx = useCallback((e: React.MouseEvent, msg: GuildMessage) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, msg });
  }, []);

  const closeCtx = useCallback(() => setCtxMenu(null), []);

  if (!currentGuild) return null;

  if (!currentGuildChannel) {
    return (
      <div className="guild-chat-main guild-welcome">
        <Hash size={64} style={{ opacity: 0.15 }} />
        <h2>{currentGuild.name}</h2>
        <p style={{ opacity: 0.5 }}>{currentGuild.description || tr('guild_select_channel')}</p>
        <p style={{ opacity: 0.4, fontSize: 13 }}>
          {tr('guild_invite_code')}: <code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>{currentGuild.invite_code}</code>
        </p>
      </div>
    );
  }

  const myRole = currentGuild.my_role;
  const canPin = myRole === 'owner' || myRole === 'admin';

  return (
    <div className="guild-chat-main">
      {/* Profile modal */}
      {profileUser && <ProfileModal user={profileUser} onClose={() => setProfileUser(null)} />}
      {/* Delete confirm */}
      {deleteConfirmId && (
        <ConfirmModal
          title={tr('delete_message_title')}
          message={tr('delete_message_confirm')}
          confirmLabel={tr('delete_message_button')}
          cancelLabel={tr('cancel')}
          onConfirm={() => { deleteGuildMessage(deleteConfirmId); setDeleteConfirmId(null); }}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}
      {/* Mute modal */}
      {muteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9500 }}>
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 24, minWidth: 300, border: '1px solid var(--border-color)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>{tr('guild_mute_member')}</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {[5, 15, 30, 60, 1440].map(m => (
                <button key={m} onClick={() => setMuteMinutes(m)} style={{
                  padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border-color)',
                  background: muteMinutes === m ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                  color: muteMinutes === m ? '#fff' : 'var(--text-primary)', cursor: 'pointer', fontSize: 13,
                }}>
                  {m < 60 ? `${m} ${tr('guild_mute_min')}` : m === 60 ? `1 ${tr('guild_mute_hour')}` : `24 ${tr('guild_mute_hour')}`}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setMuteTarget(null)} style={{ padding: '8px 16px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 8, cursor: 'pointer', color: 'var(--text-primary)', fontSize: 14 }}>{tr('cancel')}</button>
              <button onClick={async () => {
                if (!currentGuild) return;
                try {
                  await fetch(`${currentServerIP}/api/guilds/${currentGuild.id}/members/${muteTarget}/mute/`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ duration_minutes: muteMinutes }),
                  });
                } catch {}
                setMuteTarget(null);
              }} style={{ padding: '8px 16px', background: '#ed4245', border: 'none', borderRadius: 8, cursor: 'pointer', color: '#fff', fontSize: 14, fontWeight: 600 }}>{tr('guild_mute_confirm')}</button>
            </div>
          </div>
        </div>
      )}
      {/* Context menu */}
      {ctxMenu && (() => {
        const authorMember = members.find(m => String(m.id) === String(ctxMenu.msg.author.id));
        return (
          <GuildMessageContextMenu
            menu={ctxMenu}
            isOwn={String(ctxMenu.msg.author.id) === String(userIDonServer)}
            myRole={myRole}
            authorRole={authorMember?.role ?? 'member'}
            onClose={closeCtx}
            onReply={msg => { setReplyTo(msg); closeCtx(); }}
            onEdit={msg => { if (msg.message_type === 'todo') setEditingTodo(msg); else setEditing(msg); closeCtx(); }}
            onDelete={id => { closeCtx(); setDeleteConfirmId(id); }}
            onPin={id => pinGuildMessage(id)}
            onCopy={text => navigator.clipboard.writeText(text).catch(() => {})}
            onProfile={msg => openProfile(msg.author)}
            onKick={handleKick}
            onBlock={handleBlock}
            onMute={userId => { closeCtx(); setMuteTarget(userId); }}
            onUnmute={async userId => {
              closeCtx();
              await fetch(`${currentServerIP}/api/guilds/${currentGuild.id}/members/${userId}/mute/`, {
                method: 'POST', headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ duration_minutes: 0 }),
              });
            }}
            authorMutedUntil={authorMember?.muted_until}
          />
        );
      })()}
      {editingTodo && currentGuild && currentGuildChannel && (
        <MessageEditModal
          msg={editingTodo}
          onCancel={() => setEditingTodo(null)}
          onSave={async body => {
            await editMessage({ kind: 'guild', guildId: currentGuild.id, channelId: currentGuildChannel.id }, String(editingTodo.id), body);
            setEditingTodo(null);
          }}
        />
      )}
      {/* Header */}
      <div className="chat-header">
        <button
          className="mobile-back-btn"
          style={{ display: 'none', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0 6px 0 0', alignItems: 'center' }}
          onPointerDown={e => {
            e.preventDefault();
            e.stopPropagation();
            setMobileActivePanel('guild-channels');
          }}
          onClick={e => {
            e.preventDefault();
            e.stopPropagation();
            setMobileActivePanel('guild-channels');
          }}
        >
          <ChevronLeft size={22} />
        </button>
        <Hash size={18} style={{ opacity: 0.7 }} className="desktop-only-icon" />
        <span className="chat-header-name">{currentGuildChannel.name}</span>
        {currentGuildChannel.topic && (
          <span className="chat-header-topic">{currentGuildChannel.topic}</span>
        )}
      </div>

      {/* Messages */}
      <div className="messages-container" ref={listRef} onScroll={handleScroll}>
        <div className="messages-list">
          {loadingOlder && <div className="loading-older">{tr('guild_loading_older')}</div>}
          {!hasMore && guildMessages.length > 0 && (
            <div className="channel-start">
              <Hash size={32} style={{ opacity: 0.3 }} />
              <p>{tr('guild_beginning')} <strong>#{currentGuildChannel.name}</strong></p>
            </div>
          )}
          {guildMessages.map((msg, i) => {
            const prev = guildMessages[i - 1];
            const showDate = shouldShowDateSeparator(msg, prev);
            const dateSep = showDate ? <DateSeparator key={`date-${msg.id || i}`} label={formatDate(msg.created_at)} /> : null;
            const isFirstInGroup = showDate || !prev || String(prev.author?.id) !== String(msg.author?.id);
            return (
              <React.Fragment key={msg.id || `tmp-${i}`}>
                {dateSep}
                <GuildMessageRow
                  msg={msg}
                  isOwn={String(msg.author.id) === String(userIDonServer)}
                  isFirstInGroup={isFirstInGroup}
                  onContextMenu={openCtx}
                  onReply={setReplyTo}
                  onProfileClick={openProfile}
                  customEmojis={customEmojis}
                  members={members}
                  highlight={highlightId === msg.id}
                />
              </React.Fragment>
            );
          })}
        </div>
        <div ref={bottomRef} />
      </div>
      {(!atBottom || newCount > 0) && (
        <button
          className="scroll-to-bottom-btn"
          onClick={scrollToBottom}
          title="Scroll to bottom"
          aria-label={newCount > 0 ? `Scroll to ${newCount} new messages` : 'Scroll to bottom'}
        >
          <ChevronDown size={20} />
          {newCount > 0 && <span className="scroll-to-bottom-count">{newCount}</span>}
        </button>
      )}

      {/* Scheduled items */}
      {scheduledItems.map(item => {
        const remaining = Math.max(0, Math.round((new Date(item.send_at).getTime() - Date.now()) / 1000));
        return (
          <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 8px 0', padding: '7px 12px', borderRadius: 8, background: 'rgba(88,101,242,0.15)', border: '1px solid var(--accent-primary)', flexShrink: 0 }}>
            <Clock size={14} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
            <span style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {tr('guild_schedule_send')} <b>{remaining}s</b>: {item.content || '[attachment]'}
            </span>
            <button onClick={() => setScheduledItems(prev => prev.filter(s => s.id !== item.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ff6666', fontSize: 12, padding: 0 }}>{tr('cancel')}</button>
          </div>
        );
      })}

      {/* Editing bar */}
      {editing && (
        <div className="reply-bar">
          <Pencil size={14} />
          <span>{tr('chat_edit_title')}: {editing.content.slice(0, 60)}</span>
          <button className="icon-btn" onClick={() => setEditing(null)}>✕</button>
        </div>
      )}

      {/* Reply bar */}
      {replyTo && (
        <div className="reply-bar">
          <CornerUpLeft size={14} />
          <span>{tr('guild_replying_to')} <strong>{replyTo.author.nickname || replyTo.author.username}</strong>: {replyTo.content.slice(0, 60)}</span>
          <button className="icon-btn" onClick={() => setReplyTo(null)}>✕</button>
        </div>
      )}

      {/* File limit warning */}
      {limitWarning && (
        <div style={{ margin: '4px 8px 0', padding: '6px 12px', borderRadius: 8, background: '#ff444422', border: '1px solid #ff4444', color: '#ff6666', fontSize: 13 }}>
          {tr('guild_max_files').replace('{n}', String(MAX_FILES))}
        </div>
      )}

      {/* Pending file previews */}
      {pendingFiles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 12px 0' }}>
          {pendingFiles.map((pf, i) => (
            <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-secondary)', borderRadius: 8, padding: '6px 10px', maxWidth: 200 }}>
              {pf.preview
                ? <img src={pf.preview} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                : <span style={{ color: 'var(--accent-primary)', flexShrink: 0 }}>{getFileIcon(pf.file.type)}</span>
              }
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>{pf.file.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{formatFileSize(pf.file.size)}</div>
              </div>
              <button onClick={() => removeFile(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2 }}><X size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {/* Mention autocomplete */}
      {mentionQuery !== null && mentionSuggestions.length > 0 && (
        <div style={{ margin: '0 12px', padding: '4px 0', background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border-color)', maxHeight: 200, overflowY: 'auto', flexShrink: 0 }}>
          {mentionSuggestions.map((s, i) => (
            <button
              key={s.insert}
              onClick={() => insertMention(s.insert)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px',
                background: i === mentionIdx ? 'var(--accent-primary)' : 'none', border: 'none', cursor: 'pointer',
                color: i === mentionIdx ? '#fff' : 'var(--text-primary)', fontSize: 14, textAlign: 'left',
              }}
              onMouseEnter={() => setMentionIdx(i)}
            >
              <span style={{ fontSize: 12, opacity: 0.6, minWidth: 50 }}>
                {s.type === 'all' ? '📢' : s.type === 'role' ? '🏷️' : '👤'}
              </span>
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="message-input-area" style={{ flexDirection: 'column', gap: 0, alignItems: 'stretch' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', width: '100%', position: 'relative' }}>
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
          <div className="composer-bar" style={{ opacity: isMuted ? 0.6 : 1 }}>
            <button className="composer-icon-btn" title={tr('guild_add_attachment')} onClick={() => setAttachMenu(v => !v)} disabled={uploading || isMuted}>
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
                    { key: 'file', icon: <Plus size={16} />, label: tr('guild_add_attachment'), run: () => fileInputRef.current?.click() },
                    { key: 'poll', icon: <BarChart3 size={16} />, label: tr('attach_poll'), run: () => setRichType('poll') },
                    { key: 'todo', icon: <CheckSquare size={16} />, label: tr('attach_todo'), run: () => setRichType('todo') },
                    { key: 'contact', icon: <User size={16} />, label: tr('attach_contact'), run: () => setRichType('contact') },
                    { key: 'location', icon: <MapPin size={16} />, label: tr('attach_location'), run: () => setRichType('location') },
                  ] as const).map(item => (
                    <button
                      key={item.key}
                      onClick={() => { setAttachMenu(false); item.run(); }}
                      disabled={item.key === 'file' && pendingFiles.length >= MAX_FILES}
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
              className="composer-input"
              placeholder={isMuted
                ? `${tr('guild_muted_until')} ${mutedUntil!.toLocaleString()}`
                : `${tr('guild_send_placeholder')}${currentGuildChannel.name}`}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKey}
              rows={1}
              maxLength={5000}
              disabled={uploading || isMuted}
            />
            <BotCommandsButton
              token={authToken}
              serverIP={currentServerIP}
              channelId={currentGuildChannel.id}
              onPick={cmd => persistInput(cmd)}
            />
            <button
              ref={pickerButtonRef}
              className={`composer-icon-btn ${showPicker ? 'active' : ''}`}
              title={tr('chat_emoji')}
              onClick={() => setShowPicker(v => !v)}
            >
              <MoreHorizontal size={20} />
            </button>
          </div>
          {showPicker && (
            <UnifiedPicker
              anchorRef={pickerButtonRef}
              onSelectEmoji={emoji => persistInput(input + emoji)}
              onSelectGif={url => {
                if (stickerSendGuard.current) return;
                stickerSendGuard.current = true;
                sendGuildMessage(url, replyTo?.id);
                setReplyTo(null);
                setShowPicker(false);
                setTimeout(() => { stickerSendGuard.current = false; }, 500);
              }}
              onSelectSticker={(url) => {
                if (stickerSendGuard.current) return;
                stickerSendGuard.current = true;
                sendGuildMessage(url, replyTo?.id);
                setReplyTo(null);
                setShowPicker(false);
                setTimeout(() => { stickerSendGuard.current = false; }, 500);
              }}
              onDelayedSend={ms => handleDelayedSend(ms)}
              canSchedule={canSend}
              onClose={() => setShowPicker(false)}
            />
          )}
          <button
            className="composer-send-circle"
            title={tr('chat_send')}
            onClick={handleSend}
            disabled={uploading || !canSend || isMuted}
          >
            {uploading
              ? <div style={{ width: 18, height: 18, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              : <Send size={20} />
            }
          </button>
        </div>
      </div>
    </div>
  );
};
