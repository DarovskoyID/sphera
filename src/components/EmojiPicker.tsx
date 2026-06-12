import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Plus, Trash2 } from 'lucide-react';
import { EMOJI_CATEGORIES } from '../data/emojis';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import type { CustomEmoji } from '../types';

/** @deprecated use CustomEmoji from types */
export type CustomEmojiData = CustomEmoji;

interface Props {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

const RECENTLY_KEY = 'recentEmojis';
const MAX_RECENT = 32;

function getRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTLY_KEY) || '[]'); } catch { return []; }
}
function addRecent(emoji: string) {
  const list = [emoji, ...getRecent().filter(e => e !== emoji)].slice(0, MAX_RECENT);
  localStorage.setItem(RECENTLY_KEY, JSON.stringify(list));
}

export const EmojiPicker: React.FC<Props> = ({ onSelect, onClose, anchorRef }) => {
  const { authToken, currentServerIP, currentUser, customEmojis, loadCustomEmojis } = useApp();
  const tr = useTranslation();
  const [tab, setTab] = useState('recent');
  const [search, setSearch] = useState('');
  const [recent, setRecent] = useState<string[]>(getRecent);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createFile, setCreateFile] = useState<File | null>(null);
  const [createPreview, setCreatePreview] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);

  const PICKER_W = 320;
  const PICKER_H = 380;
  const MARGIN = 8;

  type DesktopPos = { top?: number; bottom?: number; right: number };
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 540);
  const [desktopPos, setDesktopPos] = useState<DesktopPos>({ bottom: 0, right: MARGIN });

  const calcPos = useCallback(() => {
    const mobile = window.innerWidth < 540;
    setIsMobile(mobile);
    if (mobile || !anchorRef.current) return;

    const rect = anchorRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: align picker's right edge to button's right edge, clamp to margin
    const right = Math.max(MARGIN, vw - rect.right);

    // Vertical: prefer above the button, fall back to below
    const spaceAbove = rect.top - MARGIN;
    if (spaceAbove >= PICKER_H) {
      setDesktopPos({ bottom: vh - rect.top + MARGIN, right });
    } else {
      setDesktopPos({ top: rect.bottom + MARGIN, right });
    }
  }, [anchorRef]);

  useEffect(() => {
    calcPos();
    window.addEventListener('resize', calcPos);
    return () => window.removeEventListener('resize', calcPos);
  }, [calcPos]);

  // Tab bar: convert vertical wheel to horizontal scroll (non-passive so preventDefault works)
  useEffect(() => {
    const el = tabBarRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, anchorRef]);

  const handleSelect = useCallback((emoji: string) => {
    addRecent(emoji);
    setRecent(getRecent());
    onSelect(emoji);
  }, [onSelect]);

  const handleCreateFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type)) {
      setCreateError(tr('emoji_file_type'));
      e.target.value = '';
      return;
    }
    if (f.size > 2 * 1024 * 1024) {
      setCreateError(tr('emoji_file_size'));
      e.target.value = '';
      return;
    }
    setCreateError('');
    setCreateFile(f);
    if (createPreview) URL.revokeObjectURL(createPreview);
    setCreatePreview(URL.createObjectURL(f));
    e.target.value = '';
  };

  const handleCreate = async () => {
    if (!createName.trim() || !createFile) { setCreateError(tr('emoji_name_required')); return; }
    if (!/^[a-z0-9_]+$/.test(createName)) { setCreateError(tr('emoji_name_invalid')); return; }
    setCreating(true);
    setCreateError('');
    try {
      const form = new FormData();
      form.append('name', createName);
      form.append('image', createFile);
      const res = await fetch(`${currentServerIP}/api/auth/emojis/create/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: form,
      });
      if (res.ok) {
        await loadCustomEmojis();
        setCreateName('');
        setCreateFile(null);
        if (createPreview) URL.revokeObjectURL(createPreview);
        setCreatePreview(null);
        setShowCreate(false);
        setTab('custom');
      } else {
        const data = await res.json();
        setCreateError(data.error || tr('emoji_create_failed'));
      }
    } catch { setCreateError(tr('error_network')); }
    finally { setCreating(false); }
  };

  const handleDeleteCustom = async (id: string) => {
    await fetch(`${currentServerIP}/api/auth/emojis/${id}/`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    loadCustomEmojis();
  };

  // Filter by search
  const searchLower = search.toLowerCase();
  let displayEmojis: { type: 'unicode'; emoji: string }[] | { type: 'custom'; emoji: CustomEmojiData }[] = [];
  if (search) {
    const matched: { type: 'unicode'; emoji: string }[] = [];
    for (const cat of EMOJI_CATEGORIES) {
      for (const e of cat.emojis) {
        matched.push({ type: 'unicode', emoji: e });
      }
    }
    const customMatched = customEmojis.filter(e => e.name.includes(searchLower));
    displayEmojis = [
      ...customMatched.map(e => ({ type: 'custom' as const, emoji: e })),
      ...matched.slice(0, 100),
    ] as any;
  }

  const BASE = {
    background: 'var(--bg-primary, #1a1a2e)',
    border: '1px solid var(--border-color, #2a2a3e)',
    color: 'var(--text-primary, #fff)',
  };
  const BTN: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer',
    padding: '5px 7px', borderRadius: 6, fontSize: 20, lineHeight: 1,
    transition: 'background 0.12s',
  };

  const allTabs = [
    { id: 'recent', icon: '🕐', label: tr('emoji_recent') },
    ...EMOJI_CATEGORIES.map(c => ({ id: c.id, icon: c.icon, label: c.label })),
    { id: 'custom', icon: '⭐', label: tr('emoji_custom') },
  ];

  const currentCat = EMOJI_CATEGORIES.find(c => c.id === tab);

  const containerStyle: React.CSSProperties = isMobile
    ? {
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        width: '100%',
        height: '60vh',
        minHeight: 300,
        maxHeight: 520,
        ...BASE,
        borderRadius: '16px 16px 0 0',
        boxShadow: '0 -8px 40px rgba(0,0,0,0.7)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 8000,
        overflow: 'hidden',
      }
    : {
        position: 'fixed',
        top: desktopPos.top,
        bottom: desktopPos.bottom,
        right: desktopPos.right,
        width: PICKER_W,
        height: PICKER_H,
        ...BASE,
        borderRadius: 12,
        boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 8000,
        overflow: 'hidden',
      };

  return (
    <>
      {isMobile && (
        <div
          onClick={onClose}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 7999 }}
        />
      )}
    <div
      ref={pickerRef}
      style={containerStyle}
    >
      {/* Mobile handle + close */}
      {isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 12px 0', flexShrink: 0, position: 'relative' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-color, #444)' }} />
          <button onClick={onClose} style={{ position: 'absolute', right: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary, #888)', display: 'flex', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
      )}

      {/* Search */}
      <div style={{ padding: '10px 10px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-secondary, #222)', borderRadius: 8, padding: '6px 10px' }}>
          <Search size={14} style={{ color: 'var(--text-secondary, #888)', flexShrink: 0 }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={tr('emoji_search')}
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', fontSize: 13, color: 'inherit' }}
            autoFocus
          />
          {search && (
            <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary, #888)', padding: 0, display: 'flex' }}>
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Tab bar */}
      {!search && (
        <div
          ref={tabBarRef}
          className="emoji-tab-bar"
          style={{ display: 'flex', padding: '6px 6px 0', gap: 2, overflowX: 'auto', flexShrink: 0 }}
        >
          {allTabs.map(t => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setShowCreate(false); }}
              title={t.label}
              style={{
                ...BTN,
                fontSize: 16,
                background: tab === t.id ? 'var(--bg-secondary, #222)' : 'none',
                flexShrink: 0,
              }}
            >
              {t.icon}
            </button>
          ))}
        </div>
      )}

      {/* Emoji grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px 8px', scrollbarWidth: 'thin' }}>
        {search ? (
          /* Search results */
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
            {(displayEmojis as any[]).map((item: any, i: number) =>
              item.type === 'custom' ? (
                <button key={`c-${item.emoji.id}`} onClick={() => handleSelect(`:${item.emoji.name}:`)} style={{ ...BTN, fontSize: 0 }} title={`:${item.emoji.name}:`}>
                  <img src={item.emoji.image_url} alt={item.emoji.name} style={{ width: 24, height: 24, objectFit: 'contain' }} />
                </button>
              ) : (
                <button key={i} onClick={() => handleSelect(item.emoji)} style={BTN}>{item.emoji}</button>
              )
            )}
            {displayEmojis.length === 0 && (
              <div style={{ padding: 16, color: 'var(--text-secondary, #888)', fontSize: 13 }}>{tr('emoji_no_results')}</div>
            )}
          </div>
        ) : tab === 'recent' ? (
          recent.length === 0
            ? <div style={{ padding: 16, color: 'var(--text-secondary, #888)', fontSize: 13 }}>{tr('emoji_no_recent')}</div>
            : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                {recent.map((e, i) =>
                  e.startsWith(':') ? (
                    (() => {
                      const name = e.slice(1, -1);
                      const found = customEmojis.find(c => c.name === name);
                      return found ? (
                        <button key={i} onClick={() => handleSelect(e)} style={{ ...BTN, fontSize: 0 }} title={e}>
                          <img src={found.image_url} alt={name} style={{ width: 24, height: 24, objectFit: 'contain' }} />
                        </button>
                      ) : null;
                    })()
                  ) : (
                    <button key={i} onClick={() => handleSelect(e)} style={BTN}>{e}</button>
                  )
                )}
              </div>
        ) : tab === 'custom' ? (
          <div>
            {/* Create button */}
            {!showCreate ? (
              <button
                onClick={() => setShowCreate(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-secondary, #222)', border: '1px dashed var(--border-color, #333)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', color: 'var(--accent-primary, #5865f2)', fontSize: 13, marginBottom: 10, width: '100%' }}
              >
                <Plus size={14} /> {tr('emoji_add_custom')}
              </button>
            ) : (
              <div style={{ background: 'var(--bg-secondary, #222)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{tr('emoji_new')}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                    <div
                      onClick={() => fileRef.current?.click()}
                      title={tr('emoji_pick_image')}
                      style={{ width: 48, height: 48, border: '2px dashed var(--border-color, #333)', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
                    >
                      {createPreview
                        ? <img src={createPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                        : <Plus size={20} style={{ color: 'var(--text-secondary, #888)' }} />
                      }
                    </div>
                    <span style={{ fontSize: 9, color: 'var(--text-secondary, #888)', textAlign: 'center', lineHeight: 1.2 }}>{tr('emoji_format_hint').split('\n').map((l, i) => i === 0 ? l : <><br/>{l}</>)}</span>
                  </div>
                  <div style={{ flex: 1 }}>
                    <input
                      value={createName}
                      onChange={e => setCreateName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                      placeholder={tr('emoji_name_placeholder')}
                      style={{ width: '100%', background: 'var(--bg-primary, #1a1a2e)', border: '1px solid var(--border-color, #333)', borderRadius: 6, padding: '5px 8px', fontSize: 13, color: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                    />
                    <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)', marginTop: 4 }}>Will insert as <b>:{createName || 'name'}:</b></div>
                  </div>
                </div>
                {createError && <div style={{ fontSize: 12, color: '#ff6666', marginBottom: 6 }}>{createError}</div>}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={handleCreateFile} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={handleCreate}
                    disabled={creating}
                    style={{ flex: 1, background: 'var(--accent-primary, #5865f2)', border: 'none', borderRadius: 6, padding: '6px 0', cursor: 'pointer', color: '#fff', fontSize: 13, fontWeight: 600 }}
                  >
                    {creating ? '…' : tr('emoji_create')}
                  </button>
                  <button
                    onClick={() => { setShowCreate(false); setCreateError(''); setCreateName(''); setCreateFile(null); if (createPreview) URL.revokeObjectURL(createPreview); setCreatePreview(null); }}
                    style={{ background: 'var(--bg-primary, #1a1a2e)', border: '1px solid var(--border-color, #333)', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', color: 'inherit', fontSize: 13 }}
                  >
                    {tr('emoji_cancel')}
                  </button>
                </div>
              </div>
            )}

            {/* Custom emoji grid */}
            {customEmojis.length === 0 && !showCreate && (
              <div style={{ color: 'var(--text-secondary, #888)', fontSize: 13, padding: '8px 0' }}>{tr('emoji_no_custom')}</div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {customEmojis.map(e => (
                <div key={e.id} style={{ position: 'relative' }}>
                  <button
                    onClick={() => handleSelect(`:${e.name}:`)}
                    title={`:${e.name}:`}
                    style={{ background: 'var(--bg-secondary, #222)', border: 'none', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}
                  >
                    <img src={e.image_url} alt={e.name} style={{ width: 32, height: 32, objectFit: 'contain' }} />
                    <span style={{ fontSize: 10, color: 'var(--text-secondary, #888)', maxWidth: 50, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                  </button>
                  {e.created_by === currentUser?.username && (
                    <button
                      onClick={() => handleDeleteCustom(e.id)}
                      title={tr('emoji_delete')}
                      style={{ display: 'flex', position: 'absolute', top: 2, right: 2, background: '#ff444488', border: 'none', borderRadius: 4, padding: 2, cursor: 'pointer', color: '#fff', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Standard category */
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
            {(currentCat?.emojis || []).map((e, i) => (
              <button key={i} onClick={() => handleSelect(e)} style={BTN}
                onMouseEnter={ev => (ev.currentTarget.style.background = 'var(--bg-secondary, #222)')}
                onMouseLeave={ev => (ev.currentTarget.style.background = 'none')}
              >{e}</button>
            ))}
          </div>
        )}
      </div>
    </div>
    </>
  );
};

const GIF_URL_RE = /^https?:\/\/(?:media\.tenor\.com|media\d*\.giphy\.com|i\.giphy\.com)\/.+$/i;
const NOTO_STICKER_RE = /^https?:\/\/fonts\.gstatic\.com\/s\/e\/notoemoji\/.+\.gif$/i;
const SINGLE_EMOJI_RE = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic})$/u;
const STICKER_IMG_RE = /^https?:\/\/.+\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i;
const DATA_URL_RE = /^data:image\/(png|jpeg|gif|webp);base64,/;

/** Renders message text with :custom_emoji: shortcodes replaced by images, GIF URLs as inline images, and single emoji as stickers */
export const MessageText: React.FC<{ text: string; customEmojis: CustomEmoji[] }> = ({ text, customEmojis }) => {
  if (!text) return null;

  const trimmed = text.trim();

  // Animated Noto sticker (Google hosted)
  if (NOTO_STICKER_RE.test(trimmed)) {
    return (
      <img
        className="sticker-msg"
        src={trimmed}
        alt="Sticker"
        style={{ width: 140, height: 140, objectFit: 'contain', display: 'block' }}
      />
    );
  }

  // Single emoji → render as large animated sticker
  if (SINGLE_EMOJI_RE.test(trimmed)) {
    return <span className="sticker-emoji-msg" style={{ fontSize: 64, lineHeight: 1.1 }}>{trimmed}</span>;
  }

  // GIF URL from Tenor/Giphy → render as inline GIF
  if (GIF_URL_RE.test(trimmed)) {
    return (
      <img
        className="gif-msg"
        src={trimmed}
        alt="GIF"
        style={{ maxWidth: 280, maxHeight: 240, borderRadius: 8, display: 'block', cursor: 'pointer' }}
        onClick={() => window.open(trimmed, '_blank')}
      />
    );
  }

  // Custom sticker (base64 data URL)
  if (DATA_URL_RE.test(trimmed)) {
    return (
      <img
        className="sticker-msg"
        src={trimmed}
        alt="Sticker"
        style={{ maxWidth: 160, maxHeight: 160, objectFit: 'contain', display: 'block' }}
      />
    );
  }

  // Sticker image URL from server
  if (STICKER_IMG_RE.test(trimmed) && (trimmed.includes('/guild_stickers/') || trimmed.includes('/media/'))) {
    return (
      <img
        className="sticker-msg"
        src={trimmed}
        alt="Sticker"
        style={{ maxWidth: 160, maxHeight: 160, objectFit: 'contain', display: 'block' }}
      />
    );
  }

  if (customEmojis.length === 0 || !text.includes(':')) {
    return <span>{text}</span>;
  }
  const parts: React.ReactNode[] = [];
  const regex = /:([a-z0-9_]+):/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const found = customEmojis.find(e => e.name === m![1]);
    if (found) {
      parts.push(
        <img
          key={m.index}
          src={found.image_url}
          alt={`:${found.name}:`}
          title={`:${found.name}:`}
          style={{ width: 20, height: 20, objectFit: 'contain', verticalAlign: 'middle', display: 'inline' }}
        />
      );
    } else {
      parts.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <span>{parts}</span>;
};
