import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Plus, Trash2 } from 'lucide-react';
import { EMOJI_CATEGORIES } from '../data/emojis';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import {
  useCensorConfig, isFullBlur, fullMask, censorPlain,
  censorToSentinel, sentinelToStars, stripSentinels, MASK_SENTINEL,
} from '../utils/censor';
import { useCensorOff } from './CensorScope';
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

  useEffect(() => {
    if (!isMobile) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }, [isMobile]);

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
            autoFocus={!isMobile}
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
const blurredStyle: React.CSSProperties = {
  filter: 'blur(0.5px)', opacity: 0.6, letterSpacing: 1, userSelect: 'none',
  fontFamily: 'monospace', wordBreak: 'break-word',
};

export const MessageText: React.FC<{
  text: string;
  customEmojis: CustomEmoji[];
  members?: { username: string; nickname: string }[];
  /** Author of the message — decides whether the explicit filter applies. */
  authorId?: string;
}> = ({ text, customEmojis, members, authorId }) => {
  const cfg = useCensorConfig();
  const censorOff = useCensorOff();
  if (!text) return null;

  // Drop any mask sentinels the sender typed, so nobody can forge a mask.
  const clean = stripSentinels(text);

  // Inside a CensorOff scope (the diary) nothing is masked at all.
  if (censorOff) return <span>{renderRichText(clean, customEmojis, members)}</span>;

  // Whole-message masking: appeals to disable the filter are fully hidden and
  // never rich-rendered (so no sticker/GIF/markdown escape hatch survives).
  if (isFullBlur(clean, cfg)) {
    return <span className="blurred-msg" style={blurredStyle}>{fullMask(clean)}</span>;
  }

  // Word masking runs BEFORE markdown parsing — otherwise `с**у**ка` would be
  // split into separate leaves and slip past. Masked spans become sentinel
  // runs (not '*') so the markdown pass cannot reinterpret them as syntax;
  // renderLeaf turns them into asterisks at the very end.
  const censored = censorToSentinel(clean, cfg, authorId);
  const wasCensored = censored !== clean;

  const trimmed = clean.trim();

  // A censored message never takes the sticker/GIF/emoji shortcuts below —
  // those render the raw string as media and would bypass the mask entirely.
  if (wasCensored) return <span>{renderRichText(censored, customEmojis, members)}</span>;

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

  return <span>{renderRichText(text, customEmojis, members)}</span>;
};

// Plain-text (no markdown) render with the privacy content filter applied.
// Used for surfaces that show raw content — channel comments, optimistic
// publishing previews, etc.
export const CensoredPlainText: React.FC<{ text: string; authorId?: string }> = ({ text, authorId }) => {
  const cfg = useCensorConfig();
  const censorOff = useCensorOff();
  if (!text) return null;
  if (censorOff) return <>{text}</>;
  const c = censorPlain(text, cfg, authorId);
  if (c.blurred) return <span className="blurred-msg">{c.text}</span>;
  return <>{c.text}</>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Rich-text formatting
//
// Lightweight markdown-like renderer shared by every place users write text
// (DMs, server channels, channel posts). Supported syntax (see the "Подсказки"
// tab in Settings):
//   **жирный**   *курсив*   __подчёркнутый__   ~~зачёркнутый~~
//   `код`        ```блок кода```   # Большой текст
//   > цитата     - пункт списка     ||спойлер||
// Leaf text still runs through mention + custom-emoji rendering.
// ─────────────────────────────────────────────────────────────────────────────

const mentionStyle: React.CSSProperties = { background: 'rgba(88,101,242,0.3)', color: '#7289da', borderRadius: 3, padding: '0 2px', fontWeight: 600 };
const inlineCodeStyle: React.CSSProperties = { background: 'var(--bg-tertiary, rgba(0,0,0,0.3))', borderRadius: 4, padding: '1px 5px', fontFamily: 'monospace', fontSize: '0.9em' };

/**
 * Text the author chose to hide until the reader asks for it.
 *
 * Blurred rather than blacked out. A solid bar says "something is hidden here"
 * and nothing else; a blur keeps the shape of the sentence — its length, its
 * line breaks, where it sits in the paragraph — so the message still reads as
 * a message with one part withheld. The radius is in `em` so it scales with
 * the text and stays past legibility at any size, and a speckle sits over the
 * top so a very short spoiler cannot simply be squinted at.
 *
 * Reachable from the keyboard: a hidden spoiler is a button in all but name,
 * and a reader who cannot click one should not be locked out of the message.
 */
/**
 * A doubled pipe is the spoiler marker, never a cell boundary.
 *
 * Both syntaxes are made of pipes, and the table rule runs first because it is
 * a block and the spoiler is inline. So a line that is nothing but a hidden
 * sentence — `||the butler did it||`, which is exactly what the composer's hide
 * button produces when the whole message is selected — starts and ends with a
 * pipe and was read as a one-cell table. It came out in a bordered box in bold,
 * with the text on plain display.
 *
 * Judging the line by its single pipes settles it. A hidden sentence has none
 * left once the spoilers are taken out and is not a table; a real row keeps
 * its own, and may now carry a spoiler in a cell.
 */
const SPOILER_SPAN = /\|\|[\s\S]*?\|\|/g;
/** A pipe that is not part of a `||` pair. */
const CELL_PIPE = /(?<!\|)\|(?!\|)/;

function isTableRow(line: string): boolean {
  if (!/^\s*\|.*\|\s*$/.test(line)) return false;
  const withoutSpoilers = line.replace(SPOILER_SPAN, '');
  return (withoutSpoilers.match(/\|/g) || []).length >= 2;
}

function splitTableRow(line: string): string[] {
  return line.trim()
    // Only the outer pipes are the row's own; a `||` at either end belongs to
    // a spoiler that happens to sit at the edge of a cell.
    .replace(/^\|(?!\|)/, '').replace(/(?<!\|)\|$/, '')
    .split(new RegExp(CELL_PIPE.source))
    .map(cell => cell.trim());
}

const Spoiler: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const tr = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const reveal = () => setRevealed(true);

  return (
    <span
      onClick={revealed ? undefined : (e => { e.stopPropagation(); reveal(); })}
      onKeyDown={revealed ? undefined : (e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); reveal(); }
      })}
      role={revealed ? undefined : 'button'}
      tabIndex={revealed ? undefined : 0}
      aria-label={revealed ? undefined : tr('spoiler_reveal')}
      title={revealed ? undefined : tr('spoiler_reveal')}
      style={{
        position: 'relative',
        display: 'inline',
        borderRadius: 4,
        padding: '0 3px',
        cursor: revealed ? 'inherit' : 'pointer',
        background: revealed ? 'rgba(128,128,128,0.18)' : 'rgba(128,128,128,0.10)',
        transition: 'background 0.2s',
      }}
    >
      <span
        style={{
          // The blur is what hides the words; the slight transparency keeps a
          // dark spoiler from reading as a smudge on a light background.
          filter: revealed ? 'none' : 'blur(0.32em)',
          opacity: revealed ? 1 : 0.65,
          userSelect: revealed ? 'auto' : 'none',
          transition: 'filter 0.22s ease, opacity 0.22s ease',
          display: 'inline',
        }}
      >
        {children}
      </span>
      {!revealed && (
        <span
          aria-hidden
          style={{
            position: 'absolute', inset: 0, borderRadius: 4, pointerEvents: 'none',
            backgroundImage: 'radial-gradient(currentColor 0.7px, transparent 0.8px)',
            backgroundSize: '4px 4px',
            opacity: 0.35,
          }}
        />
      )}
    </span>
  );
};

// Lightweight, language-agnostic syntax highlighter. Tokenizes comments,
// strings, numbers, keywords and punctuation — good enough for a chat code block.
const CODE_KEYWORDS = new Set([
  'function', 'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'new', 'class', 'extends', 'super', 'this', 'import', 'export', 'from', 'default', 'async', 'await',
  'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'null', 'undefined', 'true', 'false',
  'def', 'elif', 'lambda', 'pass', 'with', 'as', 'not', 'and', 'or', 'None', 'True', 'False', 'self', 'print',
  'public', 'private', 'protected', 'static', 'void', 'int', 'float', 'double', 'string', 'bool', 'char',
]);
const CODE_TOKEN_RE = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:]+)/g;

function highlightCode(code: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  CODE_TOKEN_RE.lastIndex = 0;
  while ((m = CODE_TOKEN_RE.exec(code)) !== null) {
    if (m.index > last) out.push(code.slice(last, m.index));
    let color: string | undefined;
    if (m[1]) color = '#6a9955';          // comment
    else if (m[2]) color = '#ce9178';      // string
    else if (m[3]) color = '#b5cea8';      // number
    else if (m[4]) color = CODE_KEYWORDS.has(m[4]) ? '#569cd6' : undefined; // keyword
    else if (m[5]) color = '#808a99';      // punctuation
    out.push(color ? <span key={key++} style={{ color }}>{m[0]}</span> : m[0]);
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

const CodeBlock: React.FC<{ code: string }> = ({ code }) => {
  const tr = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <div style={{ background: '#1e1f22', border: '1px solid var(--border-color, rgba(255,255,255,0.08))', borderRadius: 8, margin: '6px 0', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 8px 5px 12px', background: 'rgba(0,0,0,0.25)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.4)', letterSpacing: 0.4 }}>code</span>
        <button
          onClick={copy}
          style={{
            fontSize: 11, padding: '3px 8px', borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)',
            color: copied ? '#3ba55d' : 'rgba(255,255,255,0.7)', cursor: 'pointer', fontWeight: 600, flexShrink: 0,
          }}
        >
          {copied ? tr('code_copied') : tr('code_copy')}
        </button>
      </div>
      <pre style={{ margin: 0, padding: '12px 14px', overflowX: 'auto', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.5, color: '#e3e5e8', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {/* Code blocks skip renderLeaf, so masks are materialised here. */}
        {highlightCode(sentinelToStars(code))}
      </pre>
    </div>
  );
};

// Turn mask-sentinel runs (written by the content filter before markdown
// parsing) into visible asterisks. Runs are emitted as styled spans; plain
// segments pass through untouched.
function withMaskSpans(nodes: React.ReactNode[], keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  nodes.forEach((node, ni) => {
    if (typeof node !== 'string' || !node.includes(MASK_SENTINEL)) { out.push(node); return; }
    const re = new RegExp(MASK_SENTINEL + '+', 'g');
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(node)) !== null) {
      if (m.index > last) out.push(node.slice(last, m.index));
      out.push(
        <span key={`${keyBase}-mask${ni}-${m.index}`} className="blurred-msg">
          {'*'.repeat(m[0].length)}
        </span>
      );
      last = m.index + m[0].length;
    }
    if (last < node.length) out.push(node.slice(last));
  });
  return out;
}

// Render plain leaf text: custom emojis + mentions.
function renderLeaf(str: string, customEmojis: CustomEmoji[], members: { username: string; nickname: string }[] | undefined, keyBase: string): React.ReactNode[] {
  const renderMentions = (s: string, kb: string): React.ReactNode[] => {
    if (!members?.length && !s.includes('@everyone') && !s.includes('@role:')) return [s];
    const mentionRe = /@(everyone|role:[^\s]+|[^\s@]+)/g;
    const out: React.ReactNode[] = [];
    let prev = 0;
    let mm: RegExpExecArray | null;
    while ((mm = mentionRe.exec(s)) !== null) {
      if (mm.index > prev) out.push(s.slice(prev, mm.index));
      const raw = mm[1];
      if (raw === 'everyone') {
        out.push(<span key={`${kb}-m${mm.index}`} style={mentionStyle}>@everyone</span>);
      } else if (raw.startsWith('role:')) {
        out.push(<span key={`${kb}-m${mm.index}`} style={mentionStyle}>@{raw.slice(5)}</span>);
      } else {
        const member = members?.find(u => u.username === raw);
        if (member) out.push(<span key={`${kb}-m${mm.index}`} style={mentionStyle}>@{member.nickname || member.username}</span>);
        else out.push(mm[0]);
      }
      prev = mm.index + mm[0].length;
    }
    if (prev < s.length) out.push(s.slice(prev));
    return out;
  };

  if (customEmojis.length === 0 || !str.includes(':')) return withMaskSpans(renderMentions(str, keyBase), keyBase);

  const parts: React.ReactNode[] = [];
  const regex = /:([a-z0-9_]+):/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(str)) !== null) {
    if (m.index > last) parts.push(...renderMentions(str.slice(last, m.index), `${keyBase}-${m.index}`));
    const found = customEmojis.find(e => e.name === m![1]);
    if (found) {
      parts.push(<img key={`${keyBase}-e${m.index}`} src={found.image_url} alt={`:${found.name}:`} title={`:${found.name}:`} style={{ width: 20, height: 20, objectFit: 'contain', verticalAlign: 'middle', display: 'inline' }} />);
    } else {
      parts.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < str.length) parts.push(...renderMentions(str.slice(last), `${keyBase}-end`));
  return withMaskSpans(parts, keyBase);
}

interface InlineRule { re: RegExp; render: (inner: string, key: string, parse: (s: string, kb: string) => React.ReactNode[]) => React.ReactNode; literal?: boolean; }
const INLINE_RULES: InlineRule[] = [
  // `literal` rules bypass renderLeaf, so masks are materialised inline.
  { re: /`([^`]+)`/, literal: true, render: (inner, key) => <code key={key} style={inlineCodeStyle}>{sentinelToStars(inner)}</code> },
  { re: /\*\*([\s\S]+?)\*\*/, render: (inner, key, parse) => <strong key={key}>{parse(inner, key)}</strong> },
  { re: /__([\s\S]+?)__/, render: (inner, key, parse) => <u key={key}>{parse(inner, key)}</u> },
  { re: /~~([\s\S]+?)~~/, render: (inner, key, parse) => <s key={key}>{parse(inner, key)}</s> },
  { re: /\|\|([\s\S]+?)\|\|/, render: (inner, key, parse) => <Spoiler key={key}>{parse(inner, key)}</Spoiler> },
  { re: /\*([\s\S]+?)\*/, render: (inner, key, parse) => <em key={key}>{parse(inner, key)}</em> },
];

function parseInline(str: string, customEmojis: CustomEmoji[], members: { username: string; nickname: string }[] | undefined, keyBase: string): React.ReactNode[] {
  if (!str) return [];
  // Find the earliest-matching inline rule.
  let best: { rule: InlineRule; match: RegExpExecArray } | null = null;
  for (const rule of INLINE_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    re.lastIndex = 0;
    const match = re.exec(str);
    if (match && (!best || match.index < best.match.index)) best = { rule, match };
  }
  if (!best) return renderLeaf(str, customEmojis, members, keyBase);

  const { rule, match } = best;
  const out: React.ReactNode[] = [];
  if (match.index > 0) out.push(...renderLeaf(str.slice(0, match.index), customEmojis, members, `${keyBase}-pre`));
  const key = `${keyBase}-f${match.index}`;
  const recur = (s: string, kb: string) => parseInline(s, customEmojis, members, kb);
  out.push(rule.literal ? rule.render(match[1], key, recur) : rule.render(match[1], key, recur));
  const rest = str.slice(match.index + match[0].length);
  if (rest) out.push(...parseInline(rest, customEmojis, members, `${keyBase}-rest`));
  return out;
}

export function renderRichText(text: string, customEmojis: CustomEmoji[], members?: { username: string; nickname: string }[]): React.ReactNode {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  const inline = (s: string, kb: string) => parseInline(s, customEmojis, members, kb);
  while (i < lines.length) {
    const line = lines[i];
    const start = i; // stable, unique per-block key (i mutates while consuming)
    // Code fence
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith('```')) { codeLines.push(lines[j]); j++; }
      blocks.push(<CodeBlock key={`b${start}`} code={codeLines.join('\n')} />);
      i = j + 1;
      continue;
    }
    // Heading (bigger text)
    if (/^#\s+/.test(line)) {
      blocks.push(<div key={`b${start}`} style={{ fontSize: '1.4em', fontWeight: 700, lineHeight: 1.3, margin: '2px 0' }}>{inline(line.replace(/^#\s+/, ''), `b${i}`)}</div>);
      i++;
      continue;
    }
    // Quote (group consecutive)
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push(
        <blockquote key={`b${start}`} style={{ margin: '3px 0', padding: '2px 0 2px 10px', borderLeft: '3px solid var(--accent-primary)', color: 'var(--text-secondary)' }}>
          {q.map((l, k) => <div key={k}>{inline(l, `b${start}-${k}`)}</div>)}
        </blockquote>
      );
      continue;
    }
    // Bullet list (group consecutive)
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, '')); i++; }
      blocks.push(
        <ul key={`b${start}`} style={{ margin: '3px 0', paddingLeft: 22 }}>
          {items.map((l, k) => <li key={k}>{inline(l, `b${start}-${k}`)}</li>)}
        </ul>
      );
      continue;
    }
    // Table: consecutive pipe-wrapped rows.  | Name | Age |
    // The first row is the header; a separator row (| --- | --- |) is ignored.
    if (isTableRow(line)) {
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = splitTableRow(lines[i]);
        // Skip a markdown separator row like | --- | :---: |
        if (!cells.every(c => c === '' || /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length) {
        const cols = Math.max(...rows.map(r => r.length));
        blocks.push(
          <div key={`b${start}`} style={{ overflowX: 'auto', margin: '4px 0', maxWidth: '100%' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: '0.95em' }}>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri}>
                    {Array.from({ length: cols }).map((_, ci) => {
                      const isHead = ri === 0;
                      const Cell = isHead ? 'th' : 'td';
                      return (
                        <Cell
                          key={ci}
                          style={{
                            border: '1px solid var(--border-color)', padding: '5px 10px',
                            textAlign: 'left', fontWeight: isHead ? 700 : 400,
                            background: isHead ? 'var(--bg-tertiary)' : 'transparent',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {inline(r[ci] ?? '', `b${start}-${ri}-${ci}`)}
                        </Cell>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }
    // Normal text (group consecutive non-special lines; render each newline as a
    // <br> — a bare "\n" in a <span> collapses to a space otherwise).
    const norm: string[] = [];
    // Must agree with the branches above, all of them. A line this calls
    // special that none of them actually consumes is never stepped over, and
    // the outer loop reads it again forever.
    const isSpecial = (l: string) => l.trim().startsWith('```') || /^#\s+/.test(l) || /^>\s?/.test(l) || /^[-*]\s+/.test(l) || isTableRow(l);
    while (i < lines.length && !isSpecial(lines[i])) { norm.push(lines[i]); i++; }
    blocks.push(
      <React.Fragment key={`b${start}`}>
        {norm.map((l, k) => (
          <React.Fragment key={k}>
            {k > 0 && <br />}
            {inline(l, `b${start}-${k}`)}
          </React.Fragment>
        ))}
      </React.Fragment>
    );
  }
  return blocks;
}
