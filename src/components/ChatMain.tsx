import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { Phone, PhoneOff, PhoneIncoming, PhoneMissed, Video, Search, Menu, ArrowLeft, Plus, Send, FileText, FileImage, FileVideo, FileAudio, File, Download, X, MoreHorizontal, Reply, Copy, Trash2, Flag, Pin, Ban, Check, CheckCheck, ChevronUp, ChevronDown, Mic, Circle, Play, Square, Pause } from 'lucide-react';
import type { ChatAttachment, ChatMessage as ChatMessageType } from '../types';
import { useApp, reportError } from '../context/AppContext';
import { Settings } from './Settings';
import { CallWindow } from './CallWindow';
import { useTranslation } from '../i18n/useTranslation';
import { MessageText } from './EmojiPicker';
import { UnifiedPicker } from './StickerGifPicker';
import type { CustomEmoji } from '../types';
import ConfirmModal from './ConfirmModal';
import { getDraftText, setDraftText, getDraftFiles, setDraftFiles } from '../utils/drafts';
import { pickRecorderFormat, mediaUnsupportedReason, describeMediaError } from '../utils/recording';

// Maps a settings page key to its translation key, so the mobile settings
// header shows a translated title instead of the raw page id.
const SETTINGS_PAGE_TITLE: Record<string, string> = {
  profile: 'settings_my_account',
  content: 'settings_privacy',
  data: 'settings_data',
  devices: 'settings_devices',
  servers: 'settings_servers',
  family: 'settings_family',
  integration: 'settings_integration',
  notifications: 'settings_notifications',
  apps: 'settings_apps',
  nitro: 'settings_nitro',
  subscribes: 'settings_subscribes',
  gifts: 'settings_gifts',
  payments: 'settings_payments',
  view: 'settings_appearance',
  special: 'settings_special',
  voiceAndVideo: 'settings_voice_video',
  chat: 'settings_chat',
  formatting: 'settings_formatting',
  binds: 'settings_binds',
  language: 'settings_language',
  exportImport: 'settings_export_import',
  streamer: 'settings_streamer',
  more: 'settings_more',
  privacyOfActivity: 'settings_activity_privacy',
  games: 'settings_games',
};

export const ChatMain: React.FC = () => {
  const { currentView, currentChat, currentSettingsPage, setMobileActivePanel } = useApp();
  const tr = useTranslation();

  if (currentView === 'settings') {
    if (!currentSettingsPage) {
      return (
        <main className="chat-main">
          <SettingsView />
        </main>
      );
    }
    return (
      <main className="chat-main">
        <header className="chat-header glass-panel settings-mobile-header">
          <button className="icon-btn glass-btn mobile-back-btn" onClick={() => setMobileActivePanel('chat-list')} title={tr('nav_back')}>
            <ArrowLeft size={20} />
          </button>
          <h3>{SETTINGS_PAGE_TITLE[currentSettingsPage] ? tr(SETTINGS_PAGE_TITLE[currentSettingsPage] as any) : currentSettingsPage}</h3>
        </header>
        <Settings />
      </main>
    );
  }

  if (currentView === 'home') {
    if (!currentChat) {
      return (
        <main className="chat-main">
          <WelcomeScreen />
        </main>
      );
    }
    return <ChatView />;
  }

  if (currentView === 'server') {
    return <ChatView />;
  }

  return null;
};

const ChatHeader: React.FC<{
  onSearchToggle: () => void;
  searchOpen: boolean;
  onPinnedToggle: () => void;
  pinnedOpen: boolean;
  pinnedCount: number;
}> = ({ onSearchToggle, searchOpen, onPinnedToggle, pinnedOpen, pinnedCount }) => {
  const { isCallActive, currentChat, friends, blockedContacts, toggleMobileSidebar, setCallActive, setVideoActive, setCallTargetId, setMobileActivePanel } = useApp();
  const tr = useTranslation();

  const friend = friends.find(f => String(f.id) === String(currentChat));
  const blockedUser = !friend ? blockedContacts.find(u => String(u.id) === String(currentChat)) : null;
  const chatUser = friend ?? blockedUser;

  if (isCallActive) {
    return <CallWindow inline />;
  }

  if (!chatUser) return null;

  const displayName = chatUser.nickname || chatUser.username || '?';

  const startCall = (withVideo = false) => {
    // Prevent camera from turning on when starting a voice call (state can persist from a previous call)
    setVideoActive(withVideo);
    setCallTargetId(chatUser.id);
    setCallActive(true);
  };

  return (
    <header className="chat-header glass-panel">
      <button className="icon-btn glass-btn mobile-back-btn" onClick={() => setMobileActivePanel('chat-list')} title={tr('nav_back')}>
        <ArrowLeft size={20} />
      </button>
      <div className="chat-header-info">
        <div className="header-avatar">
          {chatUser.avatar
            ? <img src={chatUser.avatar} alt={displayName} />
            : <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
                {displayName[0].toUpperCase()}
              </div>
          }
          {blockedUser
            ? <span style={{ position: 'absolute', bottom: 0, right: 0, width: 10, height: 10, borderRadius: '50%', background: '#f97316', border: '2px solid var(--bg-secondary)' }} />
            : <span className={`status-indicator ${chatUser.status ?? 'offline'}`} />
          }
        </div>
        <div>
          <h3>{displayName}</h3>
          {blockedUser
            ? <p style={{ color: '#f97316' }}>{tr('status_blocked')}</p>
            : <p>@{chatUser.username}</p>
          }
        </div>
      </div>
      <div className="chat-header-actions">
        {!blockedUser && <>
          <button className="icon-btn glass-btn" onClick={() => startCall(false)} title={tr('chat_voice_call')}>
            <Phone size={20} />
          </button>
          <button className="icon-btn glass-btn" onClick={() => startCall(true)} title={tr('chat_video_call')}>
            <Video size={20} />
          </button>
        </>}
        {pinnedCount > 0 && (
          <button
            className="icon-btn glass-btn"
            title={tr('chat_pinned_messages')}
            onClick={onPinnedToggle}
            style={{ color: pinnedOpen ? 'var(--accent-primary)' : undefined, position: 'relative' }}
          >
            <Pin size={20} />
            <span style={{
              position: 'absolute', top: 2, right: 2,
              background: 'var(--accent-primary)', color: '#fff',
              fontSize: 9, fontWeight: 700, borderRadius: '50%',
              width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{pinnedCount}</span>
          </button>
        )}
        <button
          className="icon-btn glass-btn"
          title={tr('chat_search')}
          onClick={onSearchToggle}
          style={{ color: searchOpen ? 'var(--accent-primary)' : undefined }}
        >
          <Search size={20} />
        </button>
        <button className="icon-btn glass-btn mobile-menu-btn" onClick={toggleMobileSidebar}>
          <Menu size={20} />
        </button>
      </div>
    </header>
  );
};

// ── ChatView — holds reply state, wires header + messages + input ─────────────

type ScheduledItem = { id: string; send_at: string; content: string };

const MessageSearchBar: React.FC<{
  query: string;
  onChange: (q: string) => void;
  onClose: () => void;
  matchCount: number;
}> = ({ query, onChange, onClose, matchCount }) => {
  const tr = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 12px', background: 'var(--bg-secondary)',
      borderBottom: '1px solid var(--border-color)', flexShrink: 0,
    }}>
      <Search size={15} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
      <input
        ref={inputRef}
        className="field-input"
        type="text"
        placeholder={tr('chat_search_messages')}
        value={query}
        onChange={e => onChange(e.target.value)}
        style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 14 }}
      />
      {query && (
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
          {matchCount} {matchCount !== 1 ? tr('chat_results') : tr('chat_result')}
        </span>
      )}
      <button
        onClick={onClose}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', padding: 2 }}
      >
        <X size={15} />
      </button>
    </div>
  );
};

const PinnedBar: React.FC<{
  onClose: () => void;
  onScrollTo: (msgId: string) => void;
}> = ({ onClose, onScrollTo }) => {
  const { chatMessages, pinMessage } = useApp();
  const tr = useTranslation();
  const pinned = chatMessages.filter(m => m.is_pinned);
  const [idx, setIdx] = useState(0);

  useEffect(() => { setIdx(0); }, [pinned.length]);

  if (pinned.length === 0) return null;

  const current = pinned[Math.min(idx, pinned.length - 1)];
  const preview = current.content?.slice(0, 80) || tr('chat_attachment_label');

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 12px', background: 'var(--bg-secondary)',
      borderBottom: '1px solid var(--border-color)', flexShrink: 0,
      minHeight: 40,
    }}>
      <Pin size={14} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
      <div
        style={{ flex: 1, minWidth: 0, cursor: 'pointer', overflow: 'hidden' }}
        onClick={() => onScrollTo(current.id)}
      >
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{preview}</div>
      </div>
      {pinned.length > 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, flexShrink: 0 }}>
          <button
            onClick={() => setIdx(i => (i - 1 + pinned.length) % pinned.length)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 0, lineHeight: 1, display: 'flex' }}
          ><ChevronUp size={14} /></button>
          <button
            onClick={() => setIdx(i => (i + 1) % pinned.length)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 0, lineHeight: 1, display: 'flex' }}
          ><ChevronDown size={14} /></button>
        </div>
      )}
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
        {pinned.length > 1 ? `${Math.min(idx, pinned.length - 1) + 1}/${pinned.length}` : ''}
      </span>
      <button
        onClick={() => pinMessage(current.id)}
        title={tr('chat_unpin')}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 2, display: 'flex', flexShrink: 0 }}
      ><X size={14} /></button>
      <button
        onClick={onClose}
        title={tr('chat_close')}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 2, display: 'flex', flexShrink: 0 }}
      ><X size={16} /></button>
    </div>
  );
};

const ChatView: React.FC = () => {
  const { chatConversationId, listScheduled, cancelScheduledMessage, chatMessages, currentChat, blockedContacts, chatBlockedByOther } = useApp();
  const tr = useTranslation();
  const isBlockedByMe = blockedContacts.some(u => String(u.id) === String(currentChat));
  const blockedName = isBlockedByMe ? (blockedContacts.find(u => String(u.id) === String(currentChat))?.nickname || blockedContacts.find(u => String(u.id) === String(currentChat))?.username || '') : '';
  const [replyTo, setReplyTo] = useState<ChatMessageType | null>(null);
  const [scheduled, setScheduled] = useState<ScheduledItem[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pinnedBarOpen, setPinnedBarOpen] = useState(false);
  const scrollToMsgRef = useRef<((id: string) => void) | null>(null);

  // Load pending scheduled messages when conversation opens
  useEffect(() => {
    if (!chatConversationId) return;
    listScheduled(chatConversationId).then(setScheduled);
  }, [chatConversationId]);

  const handleCancelScheduled = useCallback(async (id: string) => {
    await cancelScheduledMessage(id);
    setScheduled(prev => prev.filter(s => s.id !== id));
  }, [cancelScheduledMessage]);

  // Remove from list once the countdown expires (server will deliver it)
  useEffect(() => {
    if (scheduled.length === 0) return;
    const nearest = Math.min(...scheduled.map(s => new Date(s.send_at).getTime()));
    const delay = nearest - Date.now();
    if (delay <= 0) {
      setScheduled(prev => prev.filter(s => new Date(s.send_at).getTime() > Date.now()));
      return;
    }
    const t = setTimeout(() => {
      setScheduled(prev => prev.filter(s => new Date(s.send_at).getTime() > Date.now()));
    }, delay + 500);
    return () => clearTimeout(t);
  }, [scheduled]);

  const searchMatches = searchQuery.trim()
    ? chatMessages.filter(m =>
        m.content?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : [];

  return (
    <main className="chat-main">
      <ChatHeader
        onSearchToggle={() => { setSearchOpen(v => !v); setSearchQuery(''); }}
        searchOpen={searchOpen}
        onPinnedToggle={() => setPinnedBarOpen(v => !v)}
        pinnedOpen={pinnedBarOpen}
        pinnedCount={chatMessages.filter(m => m.is_pinned).length}
      />
      {pinnedBarOpen && (
        <PinnedBar
          onClose={() => setPinnedBarOpen(false)}
          onScrollTo={id => scrollToMsgRef.current?.(id)}
        />
      )}
      {searchOpen && (
        <MessageSearchBar
          query={searchQuery}
          onChange={setSearchQuery}
          onClose={() => { setSearchOpen(false); setSearchQuery(''); }}
          matchCount={searchMatches.length}
        />
      )}
      {scheduled.map(s => (
        <ScheduledBanner key={s.id} item={s} onCancel={handleCancelScheduled} />
      ))}
      <MessagesContainer
        onReply={setReplyTo}
        searchQuery={searchQuery}
        scrollToRef={scrollToMsgRef}
      />
      {isBlockedByMe
        ? <div style={{
            padding: '14px 20px', background: 'var(--bg-secondary)',
            borderTop: '1px solid var(--border-color)',
            display: 'flex', alignItems: 'center', gap: 10,
            color: '#f97316', fontSize: 14, flexShrink: 0,
          }}>
            <Ban size={16} />
            {tr('chat_blocked_messaging')} <strong style={{ marginLeft: 3 }}>{blockedName}</strong> {tr('chat_blocked_messaging_suffix')}
          </div>
        : chatBlockedByOther
        ? <div style={{
            padding: '14px 20px', background: 'var(--bg-secondary)',
            borderTop: '1px solid var(--border-color)',
            display: 'flex', alignItems: 'center', gap: 10,
            color: 'var(--text-secondary)', fontSize: 14, flexShrink: 0,
          }}>
            <Ban size={16} />
            {tr('chat_cannot_send')}
          </div>
        : <MessageInput replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onScheduled={item => setScheduled(prev => [...prev, item])} />
      }
    </main>
  );
};

const ScheduledBanner: React.FC<{ item: ScheduledItem; onCancel: (id: string) => void }> = ({ item, onCancel }) => {
  const tr = useTranslation();
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.round((new Date(item.send_at).getTime() - Date.now()) / 1000)));

  useEffect(() => {
    const iv = setInterval(() => {
      setRemaining(Math.max(0, Math.round((new Date(item.send_at).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(iv);
  }, [item.send_at]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 8px 0', padding: '7px 12px', borderRadius: 8, background: 'rgba(88,101,242,0.15)', border: '1px solid var(--accent-primary)', flexShrink: 0 }}>
      <Clock size={14} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
      <span style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {tr('chat_sending_in')} <b>{remaining}s</b>: {item.content || tr('chat_attachment_label')}
      </span>
      <button onClick={() => onCancel(item.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ff6666', fontSize: 12, padding: 0, flexShrink: 0 }}>{tr('cancel')}</button>
    </div>
  );
};

function getDateLabel(dateStr: string, tr: (key: any) => string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (msgDay.getTime() === today.getTime()) return tr('chat_today');
  if (msgDay.getTime() === yesterday.getTime()) return tr('chat_yesterday');
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function shouldShowDateSeparator(current: ChatMessageType, prev?: ChatMessageType): boolean {
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

const MSG_HEIGHT = 60;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(contentType: string) {
  if (contentType.startsWith('image/')) return <FileImage size={20} />;
  if (contentType.startsWith('video/')) return <FileVideo size={20} />;
  if (contentType.startsWith('audio/')) return <FileAudio size={20} />;
  if (contentType === 'application/pdf' || contentType.startsWith('text/')) return <FileText size={20} />;
  return <File size={20} />;
}

// Fetches media with auth token and renders as blob URL
const AuthMedia: React.FC<{ url: string; contentType: string; filename: string }> = ({ url, contentType, filename }) => {
  const { authToken, currentServerIP } = useApp();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let revoked = false;
    (async () => {
      try {
        const res = await fetch(`${currentServerIP}${url}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (revoked) return;
        const bu = URL.createObjectURL(blob);
        blobUrlRef.current = bu;
        setBlobUrl(bu);
      } catch { /* ignore */ }
    })();
    return () => {
      revoked = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [url, authToken, currentServerIP]);

  if (!blobUrl) {
    return (
      <div style={{ width: 200, height: 120, borderRadius: 8, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 6 }}>
        <div style={{ width: 20, height: 20, border: '2px solid var(--accent-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }

  if (contentType.startsWith('image/')) {
    return (
      <img
        src={blobUrl}
        alt={filename}
        style={{ maxWidth: 320, maxHeight: 300, borderRadius: 8, display: 'block', cursor: 'pointer', marginTop: 6 }}
        onClick={() => window.open(blobUrl, '_blank')}
      />
    );
  }

  return (
    <video
      src={blobUrl}
      controls
      style={{ maxWidth: 400, maxHeight: 280, borderRadius: 8, display: 'block', marginTop: 6 }}
    />
  );
};

// ── Voice Message Player ─────────────────────────────────────────────────────

export const VoiceMessagePlayer: React.FC<{ url: string }> = ({ url }) => {
  const { authToken, currentServerIP } = useApp();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bars, setBars] = useState<number[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    let revoked = false;
    (async () => {
      try {
        const res = await fetch(`${currentServerIP}${url}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (revoked) return;
        const bu = URL.createObjectURL(blob);
        setBlobUrl(bu);

        try {
          const ac = new AudioContext();
          const ab = await ac.decodeAudioData(await blob.arrayBuffer());
          const raw = ab.getChannelData(0);
          const count = 40;
          const step = Math.floor(raw.length / count);
          const result: number[] = [];
          for (let i = 0; i < count; i++) {
            let sum = 0;
            for (let j = 0; j < step; j++) sum += Math.abs(raw[i * step + j]);
            result.push(sum / step);
          }
          const mx = Math.max(...result, 0.01);
          setBars(result.map(v => Math.max(0.08, v / mx)));
          ac.close();
        } catch {
          setBars(Array.from({ length: 40 }, () => 0.15 + Math.random() * 0.85));
        }
      } catch { /* ignore */ }
    })();
    return () => { revoked = true; };
  }, [url, authToken, currentServerIP]);

  useEffect(() => {
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [blobUrl]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    };
  }, []);

  const tick = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.duration) {
      setProgress(a.currentTime / a.duration);
      setDuration(a.duration);
    }
    if (!a.paused) rafRef.current = requestAnimationFrame(tick);
  }, []);

  const toggle = useCallback(() => {
    if (!blobUrl) return;
    if (!audioRef.current) {
      const a = document.createElement('audio');
      a.src = blobUrl;
      a.onended = () => { setPlaying(false); setProgress(0); };
      a.onloadedmetadata = () => setDuration(a.duration);
      audioRef.current = a;
    }
    const a = audioRef.current;
    if (playing) { a.pause(); setPlaying(false); cancelAnimationFrame(rafRef.current); }
    else { a.play(); setPlaying(true); rafRef.current = requestAnimationFrame(tick); }
  }, [blobUrl, playing, tick]);

  const seek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !a.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    a.currentTime = p * a.duration;
    setProgress(p);
  }, []);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

  if (!blobUrl) {
    return (
      <div style={{ width: 240, height: 48, borderRadius: 20, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 6 }}>
        <div style={{ width: 16, height: 16, border: '2px solid var(--accent-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, padding: '8px 12px', borderRadius: 20, background: 'var(--bg-secondary)', maxWidth: 320, minWidth: 220 }}>
      <button onClick={toggle} style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-primary)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#fff' }}>
        {playing ? <Pause size={16} /> : <Play size={16} style={{ marginLeft: 2 }} />}
      </button>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div onClick={seek} style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 28, cursor: 'pointer' }}>
          {bars.map((h, i) => {
            const filled = i / bars.length < progress;
            return (
              <div key={i} style={{
                flex: 1, minWidth: 2, maxWidth: 4, borderRadius: 2,
                height: `${Math.max(15, h * 100)}%`,
                background: filled ? 'var(--accent-primary)' : 'var(--text-secondary)',
                opacity: filled ? 1 : 0.35,
                transition: 'background 0.1s',
              }} />
            );
          })}
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', userSelect: 'none' }}>
          {playing || progress > 0 ? fmt(duration * progress) : fmt(duration)}
        </span>
      </div>
    </div>
  );
};

// ── Video Circle Player ──────────────────────────────────────────────────────

export const VideoCirclePlayer: React.FC<{ url: string }> = ({ url }) => {
  const { authToken, currentServerIP } = useApp();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDown = useRef(false);
  const lastTouchRef = useRef(0);

  useEffect(() => {
    let revoked = false;
    (async () => {
      try {
        const res = await fetch(`${currentServerIP}${url}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (!revoked) setBlobUrl(URL.createObjectURL(blob));
      } catch { /* ignore */ }
    })();
    return () => { revoked = true; };
  }, [url, authToken, currentServerIP]);

  useEffect(() => {
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [blobUrl]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    };
  }, []);

  const tick = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.duration) setProgress(v.currentTime / v.duration);
    if (!v.paused) rafRef.current = requestAnimationFrame(tick);
  }, []);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) { v.pause(); setPlaying(false); cancelAnimationFrame(rafRef.current); }
    else {
      const p = v.play();
      if (p && typeof p.then === 'function') p.then(() => { setPlaying(true); rafRef.current = requestAnimationFrame(tick); }).catch(() => { setPlaying(false); });
      else { setPlaying(true); rafRef.current = requestAnimationFrame(tick); }
    }
  }, [playing, tick]);

  const seekFromEvent = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    const v = videoRef.current;
    if (!el || !v || !v.duration) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let angle = Math.atan2(clientY - cy, clientX - cx) + Math.PI / 2;
    if (angle < 0) angle += 2 * Math.PI;
    const p = angle / (2 * Math.PI);
    v.currentTime = p * v.duration;
    setProgress(p);
  }, []);

  const onDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const isTouch = 'touches' in e;
    // Ignore the synthetic mouse events the browser fires right after a touch —
    // otherwise onDown/onUp run twice and toggle() plays then instantly pauses.
    if (isTouch) lastTouchRef.current = Date.now();
    else if (Date.now() - lastTouchRef.current < 700) return;
    isDown.current = true;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const dist = Math.sqrt((clientX - cx) ** 2 + (clientY - cy) ** 2);
    const r = rect.width / 2;

    if (dist > r * 0.82) {
      setSeeking(true);
      seekFromEvent(clientX, clientY);
      return;
    }

    holdTimer.current = setTimeout(() => {
      setHolding(true);
      const v = videoRef.current;
      if (v) { v.playbackRate = 2; if (v.paused) { v.play(); setPlaying(true); rafRef.current = requestAnimationFrame(tick); } }
    }, 300);
  }, [tick, seekFromEvent]);

  const onMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!seeking) return;
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    seekFromEvent(clientX, clientY);
  }, [seeking, seekFromEvent]);

  const onUp = useCallback(() => {
    if (!isDown.current) return;
    isDown.current = false;
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (seeking) {
      setSeeking(false);
      return;
    }
    if (holding) {
      setHolding(false);
      const v = videoRef.current;
      if (v) v.playbackRate = 1;
    } else {
      toggle();
    }
  }, [holding, seeking, toggle]);

  useEffect(() => {
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove);
    return () => {
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onMove);
    };
  }, [onUp, onMove]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const ringW = 4;
    const s = 200 + ringW * 2;
    if (el.width !== s * 2) { el.width = s * 2; el.height = s * 2; }
    const c = s;
    const r = 200 / 2 + ringW / 2;
    const scale = 2;
    ctx.clearRect(0, 0, s * 2, s * 2);
    ctx.lineWidth = ringW * scale;
    // bg track
    ctx.beginPath();
    ctx.arc(c, c, r * scale, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.stroke();
    // progress
    if (progress > 0.001) {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim() || '#3a8ee6';
      ctx.beginPath();
      ctx.arc(c, c, r * scale, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.strokeStyle = holding ? '#ff4444' : accent;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }, [progress, holding]);

  const size = 200;
  const ringWidth = 4;
  const accentColor = holding ? '#ff4444' : `var(--accent-primary)`;
  const progressDeg = progress * 360;

  const thumbAngle = (progress * 360 - 90) * (Math.PI / 180);
  const thumbR = size / 2 + ringWidth / 2;
  const thumbX = size / 2 + thumbR * Math.cos(thumbAngle);
  const thumbY = size / 2 + thumbR * Math.sin(thumbAngle);

  if (!blobUrl) {
    return (
      <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 6 }}>
        <div style={{ width: 20, height: 20, border: '2px solid var(--accent-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative', width: size, height: size, marginTop: 6,
        cursor: 'pointer', userSelect: 'none',
        WebkitTapHighlightColor: 'transparent', WebkitTouchCallout: 'none', outline: 'none',
      }}
      onMouseDown={e => { e.preventDefault(); onDown(e); }}
      onTouchStart={e => { onDown(e); }}
    >
      <video
        ref={el => {
          videoRef.current = el;
          if (el) el.onended = () => { setPlaying(false); setProgress(0); };
        }}
        src={blobUrl}
        playsInline
        style={{
          width: size, height: size,
          borderRadius: '50%', objectFit: 'cover', background: '#000',
          display: 'block', pointerEvents: 'none',
          WebkitTapHighlightColor: 'transparent', outline: 'none',
        }}
      />
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', top: -ringWidth, left: -ringWidth,
          width: size + ringWidth * 2, height: size + ringWidth * 2,
          pointerEvents: 'none',
        }}
      />
      {/* Thumb */}
      <div style={{
        position: 'absolute',
        width: seeking ? 14 : 10, height: seeking ? 14 : 10,
        borderRadius: '50%',
        background: accentColor,
        border: '2px solid #fff',
        boxShadow: '0 0 4px rgba(0,0,0,0.5)',
        top: thumbY - (seeking ? 7 : 5),
        left: thumbX - (seeking ? 7 : 5),
        pointerEvents: 'none',
      }} />
      {!playing && progress === 0 && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0,
          width: size, height: size,
          borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.35)',
        }}>
          <Play size={40} style={{ color: '#fff', marginLeft: 4 }} />
        </div>
      )}
      {holding && (
        <div style={{ position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 10 }}>
          ×2
        </div>
      )}
    </div>
  );
};

const AttachmentView: React.FC<{ att: ChatAttachment }> = ({ att }) => {
  const isImage = att.content_type.startsWith('image/');
  const isVideo = att.content_type.startsWith('video/');
  const isVoice = att.filename.startsWith('voice_') && att.filename.endsWith('.webm');
  const isVideoCircle = att.filename.startsWith('video_') && att.filename.endsWith('.webm');

  if (isVoice) return <VoiceMessagePlayer url={att.url} />;
  if (isVideoCircle) return <VideoCirclePlayer url={att.url} />;

  if (isImage || isVideo) {
    return <AuthMedia url={att.url} contentType={att.content_type} filename={att.filename} />;
  }

  return (
    <div style={{
      marginTop: 6,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      background: 'var(--bg-secondary)',
      borderRadius: 8,
      padding: '10px 14px',
      maxWidth: 320,
    }}>
      <div style={{ color: 'var(--accent-primary)', flexShrink: 0 }}>
        {getFileIcon(att.content_type)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {att.filename}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
          {formatFileSize(att.file_size)}
        </div>
      </div>
      <AuthDownloadButton url={att.url} filename={att.filename} />
    </div>
  );
};

const AuthDownloadButton: React.FC<{ url: string; filename: string }> = ({ url, filename }) => {
  const { authToken, currentServerIP } = useApp();
  const tr = useTranslation();
  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${currentServerIP}${url}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch { /* ignore */ }
  };
  return (
    <button onClick={handleDownload} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4, flexShrink: 0 }} title={tr('chat_download')}>
      <Download size={16} />
    </button>
  );
};

// ── Context Menu ──────────────────────────────────────────────────────────────

type CtxMenu = { x: number; y: number; msg: ChatMessageType };

const MessageContextMenu: React.FC<{
  menu: CtxMenu;
  isOwn: boolean;
  onClose: () => void;
  onReply: (msg: ChatMessageType) => void;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
  onReport: (id: string) => void;
  onCopy: (text: string) => void;
}> = ({ menu, isOwn, onClose, onReply, onDelete, onPin, onReport, onCopy }) => {
  const tr = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const [adjustedPos, setAdjustedPos] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight - 68;
    setAdjustedPos({
      x: Math.min(Math.max(menu.x, 8), vw - width - 8),
      y: Math.min(Math.max(menu.y, 8), vh - height),
    });
  }, [menu.x, menu.y]);

  const style: React.CSSProperties = {
    position: 'fixed',
    top: adjustedPos.y,
    left: adjustedPos.x,
    zIndex: 9000,
    background: 'var(--bg-primary, #1a1a2e)',
    border: '1px solid var(--border-color, #333)',
    borderRadius: 10,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    minWidth: 180,
    overflow: 'hidden',
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

  return (
    <div ref={ref} style={style}>
      {item(<Reply size={15} />, tr('chat_reply'), () => onReply(menu.msg))}
      {item(<Copy size={15} />, tr('chat_copy_text'), () => onCopy(menu.msg.content))}
      {item(<Pin size={15} />, menu.msg.is_pinned ? tr('chat_unpin_msg') : tr('chat_pin'), () => onPin(menu.msg.id))}
      {!isOwn && item(<Flag size={15} />, tr('chat_report'), () => onReport(menu.msg.id))}
      {isOwn && item(<Trash2 size={15} />, tr('chat_delete'), () => onDelete(menu.msg.id), true)}
    </div>
  );
};

// ── Message Row ───────────────────────────────────────────────────────────────

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: 'rgba(255,200,0,0.4)', color: 'inherit', borderRadius: 2 }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// ── Read receipt indicator ────────────────────────────────────────────────────
// ✓        = sent (server has the id)
// ✓        = clock if id missing (still sending)
// ✓✓       = delivered to recipient (their chat WS connected)
// ✓✓ blue  = read (recipient opened the chat)
const ReadReceipt: React.FC<{ msg: ChatMessageType }> = ({ msg }) => {
  if (!msg.id || String(msg.id).startsWith('tmp-')) {
    return <Clock size={13} style={{ marginLeft: 4, color: 'var(--text-tertiary)', verticalAlign: 'middle' }} />;
  }
  if (msg.read_at) {
    return <CheckCheck size={14} style={{ marginLeft: 4, width: 15, color: '#3a8ee6', verticalAlign: 'middle' }} />;
  }
  if (msg.delivered_at) {
    return <CheckCheck size={14} style={{ marginLeft: 4, width: 15, color: 'var(--text-tertiary)', verticalAlign: 'middle' }} />;
  }
  return <Check size={14} style={{ marginLeft: 4, width: 15, color: 'var(--text-tertiary)', verticalAlign: 'middle' }} />;
};

function formatCallDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const CallMessageRow: React.FC<{
  msg: ChatMessageType;
  isOwn: boolean;
  onStartCall: (withVideo: boolean) => void;
}> = ({ msg, isOwn, onStartCall }) => {
  const tr = useTranslation();
  const info = msg.call_info!;
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const statusMap: Record<string, string> = {
    completed: tr('call_msg_completed'),
    missed: tr('call_msg_missed'),
    declined: tr('call_msg_declined'),
    cancelled: tr('call_msg_cancelled'),
    no_answer: tr('call_msg_no_answer'),
  };
  const statusText = statusMap[info.status] || info.status;
  const typeText = info.video ? tr('call_msg_video') : tr('call_msg_voice');

  const isBad = info.status === 'missed' || info.status === 'declined' || info.status === 'no_answer';
  // The "call back" button belongs to the person who did NOT start the call
  // (the recipient who missed/declined it). The initiator (author / isOwn)
  // never sees it.
  const isUnconnected = isBad || info.status === 'cancelled';
  const showCallback = isUnconnected && !isOwn;
  const accentColor = isBad ? '#ff4444' : '#44cc44';

  const Icon = info.status === 'missed' ? PhoneMissed
    : info.status === 'declined' || info.status === 'cancelled' ? PhoneOff
    : info.status === 'no_answer' ? PhoneMissed
    : info.video ? Video : Phone;

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      padding: '0 16px',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 18px',
        borderRadius: 12,
        background: 'var(--bg-secondary)',
        border: `1px solid ${isBad ? 'rgba(255,68,68,0.25)' : 'var(--border-color)'}`,
        maxWidth: 380,
        width: '100%',
      }}>
        <div style={{
          width: 38,
          height: 38,
          borderRadius: '50%',
          background: `${accentColor}20`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon size={18} style={{ color: accentColor }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
            {statusText}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{typeText}</span>
            {info.duration != null && info.duration > 0 && (
              <span>{formatCallDuration(info.duration)}</span>
            )}
          </div>
        </div>
        {showCallback && (
          <button
            onClick={() => onStartCall(!!info.video)}
            style={{
              background: 'none',
              border: '1px solid var(--accent-primary)',
              borderRadius: 8,
              padding: '5px 12px',
              cursor: 'pointer',
              color: 'var(--accent-primary)',
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {tr('call_msg_callback')}
          </button>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', alignSelf: 'flex-end', flexShrink: 0 }}>{time}</span>
      </div>
    </div>
  );
};

const MessageRow = React.memo(({ msg, isOwn, isFirstInGroup, onContextMenu, onReply, customEmojis, searchQuery, highlight }: {
  msg: ChatMessageType;
  isOwn: boolean;
  isFirstInGroup: boolean;
  onContextMenu: (e: React.MouseEvent, msg: ChatMessageType) => void;
  onReply: (msg: ChatMessageType) => void;
  customEmojis: CustomEmoji[];
  searchQuery?: string;
  highlight?: boolean;
}) => {
  const tr = useTranslation();
  const { currentUser, friends, blockedContacts, currentChat } = useApp();
  // Server sometimes omits author name on the first message — resolve it from
  // who we already know: ourselves (own messages) or the chat partner.
  const known = isOwn
    ? currentUser
    : friends.find(f => String(f.id) === String(msg.author?.id))
      ?? blockedContacts.find(u => String(u.id) === String(msg.author?.id))
      ?? friends.find(f => String(f.id) === String(currentChat))
      ?? blockedContacts.find(u => String(u.id) === String(currentChat));
  const displayName =
    msg.author?.nickname || msg.author?.username ||
    known?.nickname || known?.username || '?';
  const avatarSrc = msg.author?.avatar || known?.avatar;
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

  const isSearchMatch = !!(searchQuery?.trim() && msg.content?.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <div
      data-msg-id={msg.id}
      className={`message-item ${isOwn ? 'own' : ''} ${isFirstInGroup ? '' : 'compact'}`}
      style={{
        minHeight: isFirstInGroup ? MSG_HEIGHT : undefined, position: 'relative',
        background: highlight
          ? 'rgba(0,112,243,0.18)'
          : isSearchMatch
          ? 'rgba(255,200,0,0.07)'
          : msg.is_pinned ? 'rgba(0,112,243,0.08)' : undefined,
        transition: 'background 0.3s ease',
      }}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e, msg); }}
      onTouchStart={startLongPress}
      onTouchEnd={cancelLongPress}
      onTouchMove={cancelLongPress}
      onContextMenuCapture={e => { if (lpFired.current) e.preventDefault(); }}
    >
      {msg.is_pinned && (
        <div style={{ position: 'absolute', top: 4, ...(isOwn ? { left: 4 } : { right: 4 }), color: 'var(--accent-primary)', opacity: 0.7, zIndex: 1 }}>
          <Pin size={12} />
        </div>
      )}
      <div className="message-avatar-slot">
        {isFirstInGroup
          ? (avatarSrc && !avatarError
              ? <img src={avatarSrc} alt={displayName} style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} onError={() => setAvatarError(true)} />
              : <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
                  {displayName[0].toUpperCase()}
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
                <div className="message-author-bubble">{displayName}</div>
              )}
              {msg.reply_to && (
                <div className="message-reply-preview">
                  {msg.reply_to.deleted ? (
                    <span style={{ fontStyle: 'italic', opacity: 0.6 }}>{tr('chat_message_deleted')}</span>
                  ) : (
                    <>
                      <span className="message-reply-author">
                        {msg.reply_to.author.nickname || msg.reply_to.author.username}
                      </span>
                      <span className="message-reply-text">
                        <MessageText text={msg.reply_to.content} customEmojis={customEmojis} />
                      </span>
                    </>
                  )}
                </div>
              )}
              <div className="message-line">
                <span className="message-body">
                  {searchQuery?.trim()
                    ? highlightText(msg.content, searchQuery)
                    : <MessageText text={msg.content} customEmojis={customEmojis} />
                  }
                </span>
                <span className="message-timestamp">{time}</span>
                {isOwn && <ReadReceipt msg={msg} />}
              </div>
            </div>
          )}
          {msg.attachments?.map(att => (
            <AttachmentView key={att.id} att={att} />
          ))}
          {!msg.content && !msg.attachments?.length && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 16, background: 'var(--bg-secondary)', maxWidth: 240, animation: 'pulse 1.5s ease-in-out infinite' }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--border-color)', flexShrink: 0 }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ height: 10, borderRadius: 4, background: 'var(--border-color)', width: '80%' }} />
                <div style={{ height: 8, borderRadius: 4, background: 'var(--border-color)', width: '50%' }} />
              </div>
            </div>
          )}
          {!msg.content && (msg.attachments?.length ?? 0) > 0 && (
            <span className="message-timestamp message-timestamp-standalone">
              {time}
              {isOwn && <ReadReceipt msg={msg} />}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

const MessagesContainer: React.FC<{
  onReply: (msg: ChatMessageType) => void;
  searchQuery: string;
  scrollToRef?: React.MutableRefObject<((id: string) => void) | null>;
}> = ({ onReply, searchQuery, scrollToRef }) => {
  const { chatMessages, userIDonServer, loadOlderMessages, deleteMessage, pinMessage, reportMessage, customEmojis, currentChat, setCallActive, setVideoActive, setCallTargetId } = useApp();
  const filteredMessages = searchQuery.trim()
    ? chatMessages.filter(m => m.content?.toLowerCase().includes(searchQuery.toLowerCase()))
    : chatMessages;
  const tr = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);
  const loadingOlder = useRef(false);
  const prevLenRef = useRef(0);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Floating "jump to bottom" button: shown when the user has scrolled up;
  // the badge counts messages that arrived while they were reading history.
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    wasAtBottom.current = true;
    setAtBottom(true);
    setNewCount(0);
  }, []);

  // Reset tracking when switching conversations so a new chat opens at the
  // bottom with no stale "new messages" count.
  useEffect(() => {
    prevLenRef.current = 0;
    wasAtBottom.current = true;
    setAtBottom(true);
    setNewCount(0);
  }, [currentChat]);

  useEffect(() => {
    if (scrollToRef) {
      scrollToRef.current = (id: string) => {
        const el = containerRef.current;
        if (!el) return;
        const target = el.querySelector(`[data-msg-id="${id}"]`) as HTMLElement | null;
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setHighlightId(id);
          setTimeout(() => setHighlightId(null), 1500);
        }
      };
    }
  }, [scrollToRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const isInitialLoad = prevLenRef.current === 0;
    const added = chatMessages.length - prevLenRef.current;
    prevLenRef.current = chatMessages.length;
    if (added <= 0 || loadingOlder.current) return; // older messages prepended, or a deletion

    if (isInitialLoad) {
      el.scrollTop = el.scrollHeight;
      wasAtBottom.current = true;
      setAtBottom(true);
      setNewCount(0);
      return;
    }

    wasAtBottom.current = false;
    setAtBottom(false);
    setNewCount(c => c + added);
  }, [chatMessages.length]);

  const handleScroll = async () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    wasAtBottom.current = nearBottom;
    setAtBottom(nearBottom);
    if (nearBottom) setNewCount(0);
    if (el.scrollTop < 100 && !loadingOlder.current && chatMessages.length > 0) {
      loadingOlder.current = true;
      const prevHeight = el.scrollHeight;
      const loaded = await loadOlderMessages();
      if (loaded) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - prevHeight; });
      loadingOlder.current = false;
    }
  };

  const openCtx = useCallback((e: React.MouseEvent, msg: ChatMessageType) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, msg });
  }, []);

  const closeCtx = useCallback(() => setCtxMenu(null), []);

  const handleStartCall = useCallback((withVideo: boolean) => {
    if (!currentChat) return;
    setVideoActive(withVideo);
    setCallTargetId(String(currentChat));
    setCallActive(true);
  }, [currentChat, setCallActive, setVideoActive, setCallTargetId]);

  return (
    <>
      {deleteConfirmId && (
        <ConfirmModal
          title={tr('delete_message_title')}
          message={tr('delete_message_confirm')}
          confirmLabel={tr('delete_message_button')}
          cancelLabel={tr('cancel')}
          onConfirm={() => { deleteMessage(deleteConfirmId); setDeleteConfirmId(null); }}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}
      {ctxMenu && (
        <MessageContextMenu
          menu={ctxMenu}
          isOwn={String(ctxMenu.msg.author.id) === String(userIDonServer)}
          onClose={closeCtx}
          onReply={msg => { onReply(msg); closeCtx(); }}
          onDelete={id => { closeCtx(); setDeleteConfirmId(id); }}
          onPin={id => pinMessage(id)}
          onReport={id => reportMessage(id)}
          onCopy={text => navigator.clipboard.writeText(text).catch(() => {})}
        />
      )}
      <div className="messages-container" ref={containerRef} onScroll={handleScroll}>
        <div className="messages-list">
          {filteredMessages.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
              {searchQuery.trim() ? tr('chat_no_search_results') : tr('chat_no_messages')}
            </div>
          )}
          {filteredMessages.map((msg, i) => {
            const prev = filteredMessages[i - 1];
            const showDate = !searchQuery.trim() && shouldShowDateSeparator(msg, prev);
            const dateSep = showDate ? <DateSeparator key={`date-${msg.id || i}`} label={getDateLabel(msg.created_at, tr)} /> : null;

            if (msg.message_type === 'call' && msg.call_info) {
              return (
                <React.Fragment key={msg.id || `call-${i}`}>
                  {dateSep}
                  <CallMessageRow
                    msg={msg}
                    isOwn={String(msg.author.id) === String(userIDonServer)}
                    onStartCall={handleStartCall}
                  />
                </React.Fragment>
              );
            }
            const isFirstInGroup = showDate || !prev || String(prev.author.id) !== String(msg.author.id) || prev.message_type === 'call';
            return (
              <React.Fragment key={msg.id || `tmp-${i}`}>
                {dateSep}
                <MessageRow
                  msg={msg}
                  isOwn={String(msg.author.id) === String(userIDonServer)}
                  isFirstInGroup={isFirstInGroup}
                  onContextMenu={openCtx}
                  onReply={onReply}
                  customEmojis={customEmojis}
                  searchQuery={searchQuery}
                  highlight={highlightId === msg.id}
                />
              </React.Fragment>
            );
          })}
        </div>
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
    </>
  );
};

const MAX_FILES = 5;

type PendingFile = { file: File; preview?: string };

type RecordMode = 'idle' | 'voice' | 'video';
type RecordState = 'idle' | 'recording' | 'preview';

const MessageInput: React.FC<{ replyTo: ChatMessageType | null; onCancelReply: () => void; onScheduled: (item: ScheduledItem) => void }> = ({ replyTo, onCancelReply, onScheduled }) => {
  const { sendChatMessage, chatConversationId, currentServerIP, authToken, scheduleMessage } = useApp();
  const tr = useTranslation();
  const [message, setMessage] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [limitWarning, setLimitWarning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const stickerSendGuard = useRef(false);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the composer textarea up to 6 lines, then let it scroll.
  const MAX_COMPOSER_LINES = 6;
  const autoResizeComposer = useCallback(() => {
    const el = composerInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 20;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const maxH = lh * MAX_COMPOSER_LINES + pad;
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  }, []);

  // Local draft (text + files) per conversation — survives switching chats.
  // Restored in an effect; saved imperatively via the persist* helpers so the
  // draft isn't clobbered by effects re-running on (re)mount / scope switch.
  const draftScope = chatConversationId ? `dm_${chatConversationId}` : '';
  useEffect(() => {
    if (!draftScope) { setMessage(''); setPendingFiles([]); return; }
    setMessage(getDraftText(draftScope));
    setPendingFiles(getDraftFiles(draftScope).map(f => ({ file: f, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftScope]);
  const persistMessage = useCallback((v: string) => { setMessage(v); setDraftText(draftScope, v); }, [draftScope]);
  // Keep the textarea height in sync with its content (incl. draft restore / send).
  useLayoutEffect(() => { autoResizeComposer(); }, [message, autoResizeComposer]);
  const persistPendingFiles = useCallback((updater: PendingFile[] | ((prev: PendingFile[]) => PendingFile[])) => {
    setPendingFiles(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      setDraftFiles(draftScope, next.map(p => p.file));
      return next;
    });
  }, [draftScope]);

  const [recordMode, setRecordMode] = useState<RecordMode>('voice');
  const [recordState, setRecordState] = useState<RecordState>('idle');
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [recordDuration, setRecordDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);

  const stopMediaStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    mediaStreamRef.current = null;
  }, []);

  const cleanupRecording = useCallback(() => {
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
    if (mediaRecorderRef.current?.state !== 'inactive') {
      try { mediaRecorderRef.current?.stop(); } catch {}
    }
    mediaRecorderRef.current = null;
    stopMediaStream();
    chunksRef.current = [];
  }, [stopMediaStream]);

  const startRecording = useCallback(async (mode: RecordMode) => {
    const unsupported = mediaUnsupportedReason();
    if (unsupported) { setRecordError(unsupported); setTimeout(() => setRecordError(null), 6000); return; }
    try {
      const constraints = mode === 'video'
        ? { audio: true, video: { width: 240, height: 240, facingMode: 'user' } }
        : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;
      const { mimeType } = pickRecorderFormat(mode === 'video' ? 'video' : 'voice');
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const actualType = recorder.mimeType || mimeType || '';
      chunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: actualType });
        const url = URL.createObjectURL(blob);
        setRecordedBlob(blob);
        setRecordedUrl(url);
        setRecordState('preview');
        stopMediaStream();
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecordState('recording');
      setRecordDuration(0);
      recordTimerRef.current = setInterval(() => setRecordDuration(d => d + 1), 1000);
    } catch (e) {
      reportError(e);
      setRecordError(describeMediaError(e));
      setTimeout(() => setRecordError(null), 6000);
      stopMediaStream();
    }
  }, [stopMediaStream]);

  const stopRecording = useCallback(() => {
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  // Tap-to-start / tap-to-stop (mobile-friendly; replaces press-and-hold).
  const toggleRecord = useCallback((mode: RecordMode) => {
    if (recordState === 'recording') { stopRecording(); return; }
    if (recordState === 'preview') return;
    setRecordMode(mode);
    startRecording(mode);
  }, [recordState, stopRecording, startRecording]);

  const discardRecording = useCallback(() => {
    cleanupRecording();
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecordedBlob(null);
    setRecordedUrl(null);
    setRecordState('idle');
    setRecordDuration(0);
    setIsPlaying(false);
  }, [cleanupRecording, recordedUrl]);

  const liveVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (recordState === 'recording' && recordMode === 'video' && liveVideoRef.current && mediaStreamRef.current) {
      liveVideoRef.current.srcObject = mediaStreamRef.current;
    }
  }, [recordState, recordMode]);

  const togglePlayback = useCallback(() => {
    if (!recordedUrl) return;
    if (recordMode === 'video') {
      const vid = videoPreviewRef.current;
      if (!vid) return;
      if (isPlaying) { vid.pause(); setIsPlaying(false); }
      else { vid.play(); setIsPlaying(true); }
    } else {
      if (!audioPreviewRef.current) {
        const a = document.createElement('audio');
        a.src = recordedUrl;
        a.onended = () => setIsPlaying(false);
        audioPreviewRef.current = a;
      }
      if (isPlaying) { audioPreviewRef.current.pause(); setIsPlaying(false); }
      else { audioPreviewRef.current.play(); setIsPlaying(true); }
    }
  }, [recordedUrl, isPlaying, recordMode]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    e.target.value = '';
    if (!selected.length) return;

    persistPendingFiles(prev => {
      const available = MAX_FILES - prev.length;
      if (available <= 0) {
        setLimitWarning(true);
        setTimeout(() => setLimitWarning(false), 3000);
        return prev;
      }
      const allowed = selected.slice(0, available);
      if (selected.length > available) {
        setLimitWarning(true);
        setTimeout(() => setLimitWarning(false), 3000);
      }
      const newEntries: PendingFile[] = allowed.map(f => ({
        file: f,
        preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      }));
      return [...prev, ...newEntries];
    });
  }, [persistPendingFiles]);

  const removeFile = useCallback((index: number) => {
    persistPendingFiles(prev => {
      const entry = prev[index];
      if (entry?.preview) URL.revokeObjectURL(entry.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, [persistPendingFiles]);

  const clearFiles = useCallback(() => {
    persistPendingFiles(prev => {
      prev.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); });
      return [];
    });
  }, [persistPendingFiles]);

  const uploadFiles = useCallback(async (files: PendingFile[]): Promise<string[]> => {
    if (!chatConversationId || files.length === 0) return [];
    setUploading(true);
    const attachmentIds: string[] = [];
    try {
      const results = await Promise.all(
        files.map(async ({ file }) => {
          const form = new FormData();
          form.append('file', file);
          const res = await fetch(
            `${currentServerIP}/api/conversations/${chatConversationId}/upload/`,
            { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: form }
          );
          if (res.ok) { const d = await res.json(); return d.id as string; }
          return null;
        })
      );
      results.forEach(id => { if (id != null) attachmentIds.push(id); });
    } catch (e) { reportError(e); }
    finally { setUploading(false); }
    return attachmentIds;
  }, [chatConversationId, currentServerIP, authToken]);

  const doSend = useCallback(async (text: string, files: PendingFile[], replyId?: number) => {
    const attachmentIds = await uploadFiles(files);
    sendChatMessage(text, attachmentIds.length > 0 ? attachmentIds : undefined, replyId);
  }, [uploadFiles, sendChatMessage]);

  const handleSend = useCallback(async () => {
    if (!message.trim() && pendingFiles.length === 0) return;
    const text = message;
    const files = pendingFiles;
    const replyId = replyTo?.id;
    persistMessage('');
    clearFiles();
    onCancelReply();
    await doSend(text, files, replyId);
  }, [message, pendingFiles, replyTo, doSend, clearFiles, onCancelReply, persistMessage]);

  const handleDelayedSend = useCallback(async (delayMs: number) => {
    if (!message.trim() && pendingFiles.length === 0) return;
    if (!chatConversationId) return;
    setShowPicker(false);
    const text = message;
    const files = [...pendingFiles];
    const replyId = replyTo?.id;
    persistMessage('');
    clearFiles();
    onCancelReply();

    // Upload files first, then schedule on server
    const attachmentIds = await uploadFiles(files);
    const result = await scheduleMessage(
      chatConversationId, text, attachmentIds,
      Math.round(delayMs / 1000), replyId,
    );
    if (!result) return;
    onScheduled({ id: result.id, send_at: result.send_at, content: text });
  }, [message, pendingFiles, replyTo, chatConversationId, uploadFiles, scheduleMessage, clearFiles, onCancelReply, onScheduled, persistMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const sendRecording = useCallback(async () => {
    if (!recordedBlob || !chatConversationId) return;
    setUploading(true);
    try {
      const ext = recordedBlob.type.includes('mp4') ? (recordMode === 'video' ? 'mp4' : 'm4a') : recordedBlob.type.includes('aac') ? 'aac' : 'webm';
      const fileName = recordMode === 'video' ? `video_${Date.now()}.${ext}` : `voice_${Date.now()}.${ext}`;
      const form = new FormData();
      form.append('file', recordedBlob, fileName);
      const res = await fetch(
        `${currentServerIP}/api/conversations/${chatConversationId}/upload/`,
        { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: form }
      );
      if (res.ok) {
        const d = await res.json();
        sendChatMessage('', [d.id], replyTo?.id);
        onCancelReply();
      }
    } catch (e) { reportError(e); }
    finally { setUploading(false); }
    discardRecording();
  }, [recordedBlob, chatConversationId, currentServerIP, authToken, sendChatMessage, replyTo, onCancelReply, discardRecording, recordMode]);

  const cleanupRef = useRef(cleanupRecording);
  cleanupRef.current = cleanupRecording;
  const recordedUrlRef = useRef(recordedUrl);
  recordedUrlRef.current = recordedUrl;

  useEffect(() => {
    return () => {
      cleanupRef.current();
      if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current);
      if (audioPreviewRef.current) { audioPreviewRef.current.pause(); audioPreviewRef.current = null; }
    };
  }, []);

  const canSend = message.trim().length > 0 || pendingFiles.length > 0;
  const hasText = message.trim().length > 0;
  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  return (
    <div className="message-input-container glass-panel" style={{ flexDirection: 'column', gap: 0, alignItems: 'stretch' }}>
      {/* Reply preview */}
      {replyTo && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 8px 0', padding: '6px 12px', borderRadius: 8, background: 'var(--bg-secondary)', borderLeft: '3px solid var(--accent-primary)' }}>
          <Reply size={13} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-primary)' }}>
              {replyTo.author.nickname || replyTo.author.username}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 200, verticalAlign: 'middle' }}>
              {replyTo.content || tr('chat_attachment_label')}
            </span>
          </div>
          <button onClick={onCancelReply} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2, flexShrink: 0 }}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* File limit warning */}
      {limitWarning && (
        <div style={{ margin: '8px 8px 0', padding: '8px 12px', borderRadius: 8, background: '#ff444422', border: '1px solid #ff4444', color: '#ff6666', fontSize: 13 }}>
          {tr('chat_max_files').replace('{n}', String(MAX_FILES))}
        </div>
      )}

      {/* Pending file previews */}
      {pendingFiles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 12px 0' }}>
          {pendingFiles.map((pf, i) => (
            <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-secondary)', borderRadius: 8, padding: '6px 10px', maxWidth: 200 }}>
              {pf.preview
                ? <img src={pf.preview} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                : <div style={{ color: 'var(--accent-primary)', flexShrink: 0 }}>{getFileIcon(pf.file.type || 'application/octet-stream')}</div>
              }
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>{pf.file.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{formatFileSize(pf.file.size)}</div>
              </div>
              <button onClick={() => removeFile(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2, flexShrink: 0 }} title={tr('chat_remove')}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Recording preview */}
      {recordState === 'preview' && recordedUrl && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 8px 0', padding: '8px 12px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
          {recordMode === 'video' ? (
            <video
              ref={videoPreviewRef}
              src={recordedUrl}
              onEnded={() => setIsPlaying(false)}
              style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover', background: '#000', flexShrink: 0 }}
            />
          ) : (
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Mic size={18} style={{ color: '#fff' }} />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              {recordMode === 'video' ? tr('chat_video_circle') : tr('chat_voice_message')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{formatTime(recordDuration)}</div>
          </div>
          <button onClick={togglePlayback} className="icon-btn glass-btn" title={isPlaying ? tr('chat_pause') : tr('chat_play')}>
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button onClick={discardRecording} className="icon-btn glass-btn" title={tr('chat_record_cancel')} style={{ color: '#ff4444' }}>
            <Trash2 size={18} />
          </button>
          <button onClick={sendRecording} className="icon-btn glass-btn send-btn" title={tr('chat_record_send')} disabled={uploading}>
            <Send size={18} />
          </button>
        </div>
      )}

      {/* Recording indicator */}
      {recordState === 'recording' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 8px 0', padding: '8px 12px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid #ff4444' }}>
          {recordMode === 'video' ? (
            <video
              ref={liveVideoRef}
              autoPlay muted playsInline
              style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', background: '#000', flexShrink: 0, border: '2px solid #ff4444' }}
            />
          ) : (
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff4444', animation: 'pulse 1s infinite', flexShrink: 0 }} />
          )}
          <span style={{ fontSize: 13, color: '#ff4444', fontWeight: 600 }}>{tr('chat_recording')}</span>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', marginLeft: 'auto' }}>{formatTime(recordDuration)}</span>
        </div>
      )}

      {recordError && (
        <div style={{ margin: '0 8px 8px', padding: '8px 12px', borderRadius: 10, background: 'rgba(237,66,69,0.12)', color: '#ed4245', fontSize: 13, fontWeight: 500, lineHeight: 1.4 }}>
          {recordError}
        </div>
      )}

      {/* Input row */}
      <div style={{ display: 'flex', gap : 8, alignItems: 'flex-end', width: '100%', position: 'relative' }}>
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
        <div className="composer-bar">
          <button className="composer-icon-btn" title={tr('chat_attachment')} onClick={() => fileInputRef.current?.click()} disabled={uploading || pendingFiles.length >= MAX_FILES}>
            <Plus size={20} />
          </button>
          <textarea
            ref={composerInputRef}
            rows={1}
            className="composer-input"
            placeholder={tr('chat_type_message')}
            value={message}
            maxLength={5000}
            onChange={e => persistMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={uploading || recordState !== 'idle'}
          />
          {message.length > 4000 && (
            <span style={{
              alignSelf: 'center', flexShrink: 0,
              fontSize: 11, color: message.length >= 4900 ? '#ff4444' : 'var(--text-secondary)',
              pointerEvents: 'none', userSelect: 'none',
            }}>
              {message.length}/5000
            </span>
          )}
          {!hasText && pendingFiles.length === 0 && recordState !== 'preview' && (
            <>
              <button
                className="composer-icon-btn"
                title={tr('chat_voice_message')}
                onClick={() => toggleRecord('voice')}
                disabled={uploading || (recordState === 'recording' && recordMode === 'video')}
                style={recordState === 'recording' && recordMode === 'voice' ? { color: '#ed4245' } : undefined}
              >
                {recordState === 'recording' && recordMode === 'voice' ? <Square size={18} /> : <Mic size={20} />}
              </button>
              <button
                className="composer-icon-btn"
                title={tr('chat_video_circle')}
                onClick={() => toggleRecord('video')}
                disabled={uploading || (recordState === 'recording' && recordMode === 'voice')}
                style={recordState === 'recording' && recordMode === 'video' ? { color: '#ed4245' } : undefined}
              >
                {recordState === 'recording' && recordMode === 'video' ? <Square size={18} /> : <Circle size={20} />}
              </button>
            </>
          )}
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
            onSelectEmoji={emoji => persistMessage(message + emoji)}
            onSelectGif={url => {
              if (stickerSendGuard.current) return;
              stickerSendGuard.current = true;
              sendChatMessage(url, undefined, replyTo?.id);
              onCancelReply();
              setShowPicker(false);
              setTimeout(() => { stickerSendGuard.current = false; }, 500);
            }}
            onSelectSticker={(url) => {
              if (stickerSendGuard.current) return;
              stickerSendGuard.current = true;
              sendChatMessage(url, undefined, replyTo?.id);
              onCancelReply();
              setShowPicker(false);
              setTimeout(() => { stickerSendGuard.current = false; }, 500);
            }}
            onDelayedSend={ms => handleDelayedSend(ms)}
            canSchedule={canSend}
            onClose={() => setShowPicker(false)}
          />
        )}

        {(hasText || pendingFiles.length > 0) && (
          <button
            className="composer-send-circle"
            onClick={handleSend}
            title={tr('chat_send')}
            disabled={uploading || !canSend}
          >
            {uploading
              ? <div style={{ width: 18, height: 18, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              : <Send size={20} />
            }
          </button>
        )}
      </div>
    </div>
  );
};

const WelcomeScreen: React.FC = () => {
  const tr = useTranslation();
  return (
    <div className="messages-container">
      <div className="welcome-screen active">
        <div className="welcome-screen-inner">
          <div className="welcome-hero">
            <div className="welcome-hero-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
              </svg>
            </div>
            <h2>{tr('welcome_title')}</h2>
            <p>{tr('welcome_desc')}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

const SettingsView: React.FC = () => {
  const tr = useTranslation();
  return (
    <div className="settings-welcome-screen">
      <div className="welcome-screen-inner">
        <div className="welcome-hero">
          <div className="welcome-hero-icon settings-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
          </div>
          <h2>{tr('nav_settings')}</h2>
          <p>{tr('settings_welcome')}</p>
        </div>
      </div>
    </div>
  );
};
