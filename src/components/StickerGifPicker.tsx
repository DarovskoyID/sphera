import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Image, Film, Plus, Trash2, Smile, Clock } from 'lucide-react';
import { EMOJI_CATEGORIES } from '../data/emojis';
import { useApp } from '../context/AppContext';
import type { GuildSticker, CustomEmoji } from '../types';

const TENOR_KEY = 'LIVDSRZULELA';

interface GifItem { id: string; title: string; url: string; preview: string }

// ── Custom stickers (localStorage) ───────────────────────────────────────────

interface CustomSticker { id: string; name: string; imageData: string; createdAt: number }

const CS_KEY = 'ionik_custom_stickers';
function loadCS(): CustomSticker[] { try { return JSON.parse(localStorage.getItem(CS_KEY) || '[]'); } catch { return []; } }
function saveCS(s: CustomSticker[]) { localStorage.setItem(CS_KEY, JSON.stringify(s)); }

// ── Recent emoji (localStorage) ──────────────────────────────────────────────

const RECENT_KEY = 'recentEmojis';
const MAX_RECENT = 32;
function getRecent(): string[] { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function addRecent(e: string) { const l = [e, ...getRecent().filter(x => x !== e)].slice(0, MAX_RECENT); localStorage.setItem(RECENT_KEY, JSON.stringify(l)); }

// ── Built-in animated sticker packs ──────────────────────────────────────────

const noto = (cp: string) => `https://fonts.gstatic.com/s/e/notoemoji/latest/${cp}/512.gif`;
interface BuiltinSticker { url: string; label: string }

const STICKER_PACKS: { name: string; stickers: BuiltinSticker[] }[] = [
  {
    name: 'Reactions',
    stickers: [
      { url: noto('1f44d'), label: 'thumbs up' }, { url: noto('1f44e'), label: 'thumbs down' },
      { url: noto('2764_fe0f'), label: 'heart' }, { url: noto('1f602'), label: 'laughing' },
      { url: noto('1f62d'), label: 'crying' }, { url: noto('1f525'), label: 'fire' },
      { url: noto('1f480'), label: 'skull' }, { url: noto('1f921'), label: 'clown' },
      { url: noto('1f60d'), label: 'heart eyes' }, { url: noto('1f97a'), label: 'pleading' },
      { url: noto('1f60e'), label: 'cool' }, { url: noto('1f92e'), label: 'vomit' },
      { url: noto('1f4a9'), label: 'poop' }, { url: noto('1fae1'), label: 'salute' },
      { url: noto('1f91d'), label: 'handshake' }, { url: noto('2728'), label: 'sparkles' },
    ],
  },
  {
    name: 'Animals',
    stickers: [
      { url: noto('1f431'), label: 'cat' }, { url: noto('1f415'), label: 'dog' },
      { url: noto('1f438'), label: 'frog' }, { url: noto('1f98a'), label: 'fox' },
      { url: noto('1f43b'), label: 'bear' }, { url: noto('1f427'), label: 'penguin' },
      { url: noto('1f984'), label: 'unicorn' }, { url: noto('1f419'), label: 'octopus' },
      { url: noto('1f98b'), label: 'butterfly' }, { url: noto('1f41d'), label: 'bee' },
      { url: noto('1f422'), label: 'turtle' }, { url: noto('1f988'), label: 'shark' },
    ],
  },
  {
    name: 'Vibes',
    stickers: [
      { url: noto('1f389'), label: 'party' }, { url: noto('1f47e'), label: 'gaming' },
      { url: noto('1f3b6'), label: 'music' }, { url: noto('2615'), label: 'coffee' },
      { url: noto('1f355'), label: 'pizza' }, { url: noto('1f31d'), label: 'moon' },
      { url: noto('26a1'), label: 'lightning' }, { url: noto('1f308'), label: 'rainbow' },
      { url: noto('1f634'), label: 'sleep' }, { url: noto('1f4aa'), label: 'strong' },
      { url: noto('1f3af'), label: 'bullseye' }, { url: noto('1f680'), label: 'rocket' },
    ],
  },
];

// ── Delay options ────────────────────────────────────────────────────────────

const DELAY_OPTIONS = [
  { label: '5 sec', ms: 5000 },
  { label: '30 sec', ms: 30000 },
  { label: '1 min', ms: 60000 },
  { label: '5 min', ms: 300000 },
];

// ── Props ────────────────────────────────────────────────────────────────────

type Tab = 'emoji' | 'stickers' | 'gif' | 'timer';

interface Props {
  onSelectEmoji: (emoji: string) => void;
  onSelectGif: (url: string) => void;
  onSelectSticker: (url: string, name: string) => void;
  onDelayedSend: (delayMs: number) => void;
  canSchedule: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

// ── Main unified picker ──────────────────────────────────────────────────────

export const UnifiedPicker: React.FC<Props> = ({ onSelectEmoji, onSelectGif, onSelectSticker, onDelayedSend, canSchedule, onClose, anchorRef }) => {
  const { currentGuild, loadGuildStickers, currentServerIP, authToken, currentUser, customEmojis, loadCustomEmojis } = useApp();
  const [tab, setTab] = useState<Tab>('emoji');
  const [search, setSearch] = useState('');

  // Emoji state
  const [emojiCat, setEmojiCat] = useState('recent');
  const [recent, setRecent] = useState<string[]>(getRecent);
  const [showCreateEmoji, setShowCreateEmoji] = useState(false);
  const [createEmojiName, setCreateEmojiName] = useState('');
  const [createEmojiFile, setCreateEmojiFile] = useState<File | null>(null);
  const [createEmojiPreview, setCreateEmojiPreview] = useState<string | null>(null);
  const [creatingEmoji, setCreatingEmoji] = useState(false);
  const [createEmojiError, setCreateEmojiError] = useState('');
  const emojiFileRef = useRef<HTMLInputElement>(null);

  // GIF state
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [gifLoading, setGifLoading] = useState(false);
  const [gifError, setGifError] = useState('');

  // Sticker state
  const [guildStickers, setGuildStickers] = useState<GuildSticker[]>([]);
  const [customStickers, setCustomStickers] = useState<CustomSticker[]>(loadCS);
  const [stickerPack, setStickerPack] = useState(0);
  const [showCreateSticker, setShowCreateSticker] = useState(false);

  const pickerRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const tabBarRef = useRef<HTMLDivElement>(null);

  const PICKER_W = 360;
  const PICKER_H = 440;
  const MARGIN = 8;

  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 540);
  type Pos = { top?: number; bottom?: number; right: number };
  const [pos, setPos] = useState<Pos>({ bottom: 0, right: MARGIN });

  const calcPos = useCallback(() => {
    const mobile = window.innerWidth < 540;
    setIsMobile(mobile);
    if (mobile || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const right = Math.max(MARGIN, vw - r.right);
    if (r.top - MARGIN >= PICKER_H) setPos({ bottom: vh - r.top + MARGIN, right });
    else setPos({ top: r.bottom + MARGIN, right });
  }, [anchorRef]);

  useEffect(() => { calcPos(); window.addEventListener('resize', calcPos); return () => window.removeEventListener('resize', calcPos); }, [calcPos]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose, anchorRef]);

  // Tab bar horizontal scroll
  useEffect(() => {
    const el = tabBarRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => { if (e.deltaY !== 0) { e.preventDefault(); el.scrollLeft += e.deltaY; } };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);

  useEffect(() => { if (currentGuild) loadGuildStickers(currentGuild.id).then(setGuildStickers).catch(() => {}); }, [currentGuild?.id]);
  useEffect(() => { if (tab === 'gif' && gifs.length === 0 && !search) fetchGifs(''); }, [tab]);

  // ── GIF fetch ──────────────────────────────────────────────────────────────

  const fetchGifs = useCallback(async (q: string) => {
    setGifLoading(true); setGifError('');
    try {
      const ep = q
        ? `/tenor-api/search?key=${TENOR_KEY}&q=${encodeURIComponent(q)}&limit=30&media_filter=minimal&locale=en_US`
        : `/tenor-api/trending?key=${TENOR_KEY}&limit=30&media_filter=minimal&locale=en_US`;
      const res = await fetch(ep);
      if (!res.ok) { setGifError('Failed to load GIFs'); setGifs([]); return; }
      const data = await res.json();
      setGifs((data.results || []).map((r: any) => {
        const m = r.media?.[0] || {};
        return { id: r.id, title: r.title || r.content_description || '', url: m.gif?.url || '', preview: m.tinygif?.url || m.nanogif?.url || '' };
      }));
    } catch { setGifError('Network error'); setGifs([]); }
    finally { setGifLoading(false); }
  }, []);

  const handleSearch = useCallback((val: string) => {
    setSearch(val);
    if (tab === 'gif') {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => fetchGifs(val), 400);
    }
  }, [tab, fetchGifs]);

  useEffect(() => () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); }, []);

  // ── Emoji handlers ─────────────────────────────────────────────────────────

  const handleEmojiSelect = useCallback((emoji: string) => {
    addRecent(emoji); setRecent(getRecent()); onSelectEmoji(emoji);
  }, [onSelectEmoji]);

  const handleCreateEmojiFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type)) { setCreateEmojiError('Only PNG/JPG/GIF/WebP'); return; }
    if (f.size > 2 * 1024 * 1024) { setCreateEmojiError('Max 2 MB'); return; }
    setCreateEmojiError(''); setCreateEmojiFile(f);
    if (createEmojiPreview) URL.revokeObjectURL(createEmojiPreview);
    setCreateEmojiPreview(URL.createObjectURL(f));
  };

  const handleCreateEmoji = async () => {
    if (!createEmojiName.trim() || !createEmojiFile) { setCreateEmojiError('Name and image required'); return; }
    if (!/^[a-z0-9_]+$/.test(createEmojiName)) { setCreateEmojiError('Only lowercase, numbers, _'); return; }
    setCreatingEmoji(true); setCreateEmojiError('');
    try {
      const form = new FormData(); form.append('name', createEmojiName); form.append('image', createEmojiFile);
      const res = await fetch(`${currentServerIP}/api/auth/emojis/create/`, { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: form });
      if (res.ok) { await loadCustomEmojis(); setCreateEmojiName(''); setCreateEmojiFile(null); if (createEmojiPreview) URL.revokeObjectURL(createEmojiPreview); setCreateEmojiPreview(null); setShowCreateEmoji(false); setEmojiCat('custom'); }
      else { const d = await res.json(); setCreateEmojiError(d.error || 'Failed'); }
    } catch { setCreateEmojiError('Network error'); }
    finally { setCreatingEmoji(false); }
  };

  const handleDeleteEmoji = async (id: string) => {
    await fetch(`${currentServerIP}/api/auth/emojis/${id}/`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
    loadCustomEmojis();
  };

  // ── Sticker handlers ───────────────────────────────────────────────────────

  const handleCreateSticker = useCallback((name: string, imgData: string) => {
    const s: CustomSticker = { id: `cs-${Date.now()}`, name, imageData: imgData, createdAt: Date.now() };
    const u = [s, ...customStickers]; setCustomStickers(u); saveCS(u); setShowCreateSticker(false); setStickerPack(-2);
  }, [customStickers]);

  const handleDeleteSticker = useCallback((id: string) => {
    const u = customStickers.filter(s => s.id !== id); setCustomStickers(u); saveCS(u);
  }, [customStickers]);

  // ── Filter ─────────────────────────────────────────────────────────────────

  const sl = search.toLowerCase();
  const filteredBuiltin = search ? STICKER_PACKS.flatMap(p => p.stickers).filter(s => s.label.toLowerCase().includes(sl)) : STICKER_PACKS[stickerPack]?.stickers || [];
  const filteredGuild = search ? guildStickers.filter(s => s.name.toLowerCase().includes(sl)) : guildStickers;
  const filteredCustomS = search ? customStickers.filter(s => s.name.toLowerCase().includes(sl)) : customStickers;

  // ── Styles ─────────────────────────────────────────────────────────────────

  const BASE: React.CSSProperties = { background: 'var(--bg-primary, #1a1a2e)', border: '1px solid var(--border-color, #2a2a3e)', color: 'var(--text-primary, #fff)' };
  const containerStyle: React.CSSProperties = isMobile
    ? { position: 'fixed', bottom: 0, left: 0, right: 0, width: '100%', height: '60vh', minHeight: 300, maxHeight: 520, ...BASE, borderRadius: '16px 16px 0 0', boxShadow: '0 -8px 40px rgba(0,0,0,0.7)', display: 'flex', flexDirection: 'column', zIndex: 8000, overflow: 'hidden' }
    : { position: 'fixed', top: pos.top, bottom: pos.bottom, right: pos.right, width: PICKER_W, height: PICKER_H, ...BASE, borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', zIndex: 8000, overflow: 'hidden' };

  const tabBtn = (t: Tab, icon: React.ReactNode, label: string) => (
    <button
      key={t}
      onClick={() => { setTab(t); setSearch(''); setShowCreateSticker(false); setShowCreateEmoji(false); }}
      style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        padding: '7px 0', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
        background: tab === t ? 'var(--bg-secondary, #222)' : 'none',
        color: tab === t ? 'var(--accent-primary, #5865f2)' : 'var(--text-secondary, #888)',
        borderRadius: '6px 6px 0 0',
      }}
    >
      {icon} {label}
    </button>
  );

  const showSearch = tab !== 'timer';

  return (
    <>
      {isMobile && <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 7999 }} />}
      <div ref={pickerRef} style={containerStyle}>
        {isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 12px 0', flexShrink: 0, position: 'relative' }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-color, #444)' }} />
            <button onClick={onClose} style={{ position: 'absolute', right: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', padding: 4 }}><X size={18} /></button>
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', padding: '6px 8px 0', gap: 2, flexShrink: 0 }}>
          {tabBtn('emoji', <Smile size={14} />, 'Emoji')}
          {tabBtn('stickers', <Image size={14} />, 'Stickers')}
          {tabBtn('gif', <Film size={14} />, 'GIF')}
          {tabBtn('timer', <Clock size={14} />, 'Timer')}
        </div>

        {/* Search (not for timer) */}
        {showSearch && (
          <div style={{ padding: '6px 10px 0', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-secondary, #222)', borderRadius: 8, padding: '5px 10px' }}>
              <Search size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
              <input
                value={search}
                onChange={e => handleSearch(e.target.value)}
                placeholder={tab === 'emoji' ? 'Search emoji…' : tab === 'gif' ? 'Search GIFs…' : 'Search stickers…'}
                style={{ flex: 1, background: 'none', border: 'none', outline: 'none', fontSize: 13, color: 'inherit' }}
                autoFocus
              />
              {search && <button onClick={() => handleSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 0, display: 'flex' }}><X size={13} /></button>}
            </div>
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px 8px', scrollbarWidth: 'thin' }}>
          {tab === 'emoji' && (
            <EmojiTab
              search={search} emojiCat={emojiCat} setEmojiCat={setEmojiCat}
              recent={recent} customEmojis={customEmojis}
              onSelect={handleEmojiSelect}
              showCreate={showCreateEmoji} setShowCreate={setShowCreateEmoji}
              createName={createEmojiName} setCreateName={setCreateEmojiName}
              createPreview={createEmojiPreview} fileRef={emojiFileRef}
              onFileChange={handleCreateEmojiFile} onCreate={handleCreateEmoji}
              creating={creatingEmoji} createError={createEmojiError}
              setCreateError={setCreateEmojiError}
              onDelete={handleDeleteEmoji} currentUser={currentUser?.username || ''}
              tabBarRef={tabBarRef}
            />
          )}
          {tab === 'stickers' && (
            showCreateSticker ? (
              <CreateStickerForm onCreate={handleCreateSticker} onCancel={() => setShowCreateSticker(false)} />
            ) : (
              <StickerTab
                builtin={filteredBuiltin} guild={filteredGuild} custom={filteredCustomS}
                packs={STICKER_PACKS} activePack={stickerPack} onPackChange={setStickerPack}
                searching={!!search} hasGuild={guildStickers.length > 0}
                onSelectBuiltin={s => onSelectSticker(s.url, s.label)}
                onSelectGuild={s => onSelectSticker(`${currentServerIP}${s.image}`, s.name)}
                onSelectCustom={s => onSelectSticker(s.imageData, s.name)}
                onDeleteCustom={handleDeleteSticker}
                onCreateNew={() => setShowCreateSticker(true)}
              />
            )
          )}
          {tab === 'gif' && <GifGrid gifs={gifs} loading={gifLoading} error={gifError} onSelect={onSelectGif} />}
          {tab === 'timer' && <TimerTab canSchedule={canSchedule} onDelay={onDelayedSend} />}
        </div>

        {tab === 'gif' && (
          <div style={{ padding: '3px 10px 5px', fontSize: 10, color: 'var(--text-tertiary, #666)', textAlign: 'right', flexShrink: 0 }}>Powered by Tenor</div>
        )}
      </div>
    </>
  );
};

// ── Emoji Tab ────────────────────────────────────────────────────────────────

const BTN: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', padding: '5px 7px', borderRadius: 6, fontSize: 20, lineHeight: 1 };

const EmojiTab: React.FC<{
  search: string; emojiCat: string; setEmojiCat: (c: string) => void;
  recent: string[]; customEmojis: CustomEmoji[];
  onSelect: (e: string) => void;
  showCreate: boolean; setShowCreate: (v: boolean) => void;
  createName: string; setCreateName: (v: string) => void;
  createPreview: string | null; fileRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onCreate: () => void; creating: boolean; createError: string; setCreateError: (v: string) => void;
  onDelete: (id: string) => void; currentUser: string;
  tabBarRef: React.RefObject<HTMLDivElement | null>;
}> = ({ search, emojiCat, setEmojiCat, recent, customEmojis, onSelect, showCreate, setShowCreate, createName, setCreateName, createPreview, fileRef, onFileChange, onCreate, creating, createError, setCreateError, onDelete, currentUser, tabBarRef }) => {

  const MERGED: { id: string; icon: string; label: string; sources: string[] }[] = [
    { id: 'smileys_people', icon: '😀', label: 'Smileys', sources: ['smileys', 'people'] },
    { id: 'nature', icon: '🐾', label: 'Nature', sources: ['animals', 'food'] },
    { id: 'activities', icon: '⚽', label: 'Activities', sources: ['activities', 'travel'] },
    { id: 'objects', icon: '💡', label: 'Objects', sources: ['objects', 'symbols'] },
  ];
  const allTabs = [
    { id: 'recent', icon: '🕐', label: 'Recent' },
    ...MERGED.map(m => ({ id: m.id, icon: m.icon, label: m.label })),
    { id: 'custom', icon: '⭐', label: 'Custom' },
  ];
  const mergedCat = MERGED.find(m => m.id === emojiCat);
  const mergedEmojis = mergedCat ? EMOJI_CATEGORIES.filter(c => mergedCat.sources.includes(c.id)).flatMap(c => c.emojis) : [];

  if (search) {
    const sl = search.toLowerCase();
    const matched = EMOJI_CATEGORIES.flatMap(c => c.emojis).slice(0, 100);
    const customMatched = customEmojis.filter(e => e.name.includes(sl));
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
        {customMatched.map(e => (
          <button key={e.id} onClick={() => onSelect(`:${e.name}:`)} style={{ ...BTN, fontSize: 0 }} title={`:${e.name}:`}>
            <img src={e.image_url} alt={e.name} style={{ width: 24, height: 24, objectFit: 'contain' }} />
          </button>
        ))}
        {matched.map((e, i) => <button key={i} onClick={() => onSelect(e)} style={BTN}>{e}</button>)}
        {matched.length === 0 && customMatched.length === 0 && <div style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 13 }}>No results</div>}
      </div>
    );
  }

  return (
    <>
      {/* Category bar */}
      <div ref={tabBarRef} className="emoji-tab-bar" style={{ display: 'flex', gap: 2, overflowX: 'auto', flexShrink: 0, marginBottom: 6 }}>
        {allTabs.map(t => (
          <button key={t.id} onClick={() => { setEmojiCat(t.id); setShowCreate(false); }} title={t.label}
            style={{ ...BTN, fontSize: 16, background: emojiCat === t.id ? 'var(--bg-secondary, #222)' : 'none', flexShrink: 0 }}>
            {t.icon}
          </button>
        ))}
      </div>

      {emojiCat === 'recent' ? (
        recent.length === 0
          ? <div style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 13 }}>No recent emojis</div>
          : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
              {recent.map((e, i) => e.startsWith(':') ? (() => {
                const name = e.slice(1, -1); const f = customEmojis.find(c => c.name === name);
                return f ? <button key={i} onClick={() => onSelect(e)} style={{ ...BTN, fontSize: 0 }} title={e}><img src={f.image_url} alt={name} style={{ width: 24, height: 24, objectFit: 'contain' }} /></button> : null;
              })() : <button key={i} onClick={() => onSelect(e)} style={BTN}>{e}</button>)}
            </div>
      ) : emojiCat === 'custom' ? (
        <div>
          {!showCreate ? (
            <button onClick={() => setShowCreate(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-secondary)', border: '1px dashed var(--border-color)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', color: 'var(--accent-primary)', fontSize: 13, marginBottom: 10, width: '100%' }}>
              <Plus size={14} /> Add custom emoji
            </button>
          ) : (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>New emoji</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
                <div onClick={() => fileRef.current?.click()} style={{ width: 48, height: 48, border: '2px dashed var(--border-color)', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                  {createPreview ? <img src={createPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <Plus size={20} style={{ color: 'var(--text-secondary)' }} />}
                </div>
                <input value={createName} onChange={e => setCreateName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="name" style={{ flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '5px 8px', fontSize: 13, color: 'inherit', outline: 'none' }} />
              </div>
              {createError && <div style={{ fontSize: 12, color: '#ff6666', marginBottom: 6 }}>{createError}</div>}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={onFileChange} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={onCreate} disabled={creating} style={{ flex: 1, background: 'var(--accent-primary)', border: 'none', borderRadius: 6, padding: '6px 0', cursor: 'pointer', color: '#fff', fontSize: 13, fontWeight: 600 }}>{creating ? '…' : 'Create'}</button>
                <button onClick={() => { setShowCreate(false); setCreateError(''); }} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', color: 'inherit', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}
          {customEmojis.length === 0 && !showCreate && <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No custom emojis yet</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {customEmojis.map(e => (
              <div key={e.id} style={{ position: 'relative' }}>
                <button onClick={() => onSelect(`:${e.name}:`)} title={`:${e.name}:`} style={{ background: 'var(--bg-secondary)', border: 'none', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                  <img src={e.image_url} alt={e.name} style={{ width: 32, height: 32, objectFit: 'contain' }} />
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)', maxWidth: 50, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                </button>
                {e.created_by === currentUser && (
                  <button onClick={() => onDelete(e.id)} title="Delete" style={{ position: 'absolute', top: 2, right: 2, background: '#ff444488', border: 'none', borderRadius: 4, padding: 2, cursor: 'pointer', color: '#fff', display: 'flex' }}><Trash2 size={10} /></button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {mergedEmojis.map((e, i) => (
            <button key={i} onClick={() => onSelect(e)} style={BTN}
              onMouseEnter={ev => (ev.currentTarget.style.background = 'var(--bg-secondary)')}
              onMouseLeave={ev => (ev.currentTarget.style.background = 'none')}
            >{e}</button>
          ))}
        </div>
      )}
    </>
  );
};

// ── GIF Grid ─────────────────────────────────────────────────────────────────

const GifGrid: React.FC<{ gifs: GifItem[]; loading: boolean; error: string; onSelect: (url: string) => void }> = ({ gifs, loading, error, onSelect }) => {
  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120 }}><div style={{ width: 24, height: 24, border: '2px solid var(--accent-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /></div>;
  if (error) return <div style={{ padding: 20, textAlign: 'center', color: '#ff6666', fontSize: 13 }}>{error}</div>;
  if (gifs.length === 0) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>No GIFs found</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
      {gifs.map(g => (
        <button key={g.id} onClick={() => onSelect(g.url)} style={{ background: '#000', border: 'none', padding: 0, cursor: 'pointer', borderRadius: 8, overflow: 'hidden', aspectRatio: '1' }} title={g.title}>
          <img src={g.preview} alt={g.title} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8, display: 'block' }} />
        </button>
      ))}
    </div>
  );
};

// ── Timer Tab ────────────────────────────────────────────────────────────────

const TimerTab: React.FC<{ canSchedule: boolean; onDelay: (ms: number) => void }> = ({ canSchedule, onDelay }) => {
  if (!canSchedule) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>Type a message first to schedule it</div>;
  }
  return (
    <div style={{ padding: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Schedule message</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {DELAY_OPTIONS.map(opt => (
          <button
            key={opt.label}
            onClick={() => onDelay(opt.ms)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
              background: 'var(--bg-secondary, #222)', border: '1px solid var(--border-color, #333)',
              borderRadius: 10, cursor: 'pointer', color: 'var(--text-primary)', fontSize: 14,
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent-primary)')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-color, #333)')}
          >
            <Clock size={16} style={{ color: 'var(--accent-primary)' }} />
            Send in {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
};

// ── Sticker Tab ──────────────────────────────────────────────────────────────

const StickerTab: React.FC<{
  builtin: BuiltinSticker[]; guild: GuildSticker[]; custom: CustomSticker[];
  packs: typeof STICKER_PACKS; activePack: number; onPackChange: (i: number) => void;
  searching: boolean; hasGuild: boolean;
  onSelectBuiltin: (s: BuiltinSticker) => void;
  onSelectGuild: (s: GuildSticker) => void;
  onSelectCustom: (s: CustomSticker) => void;
  onDeleteCustom: (id: string) => void;
  onCreateNew: () => void;
}> = ({ builtin, guild, custom, packs, activePack, onPackChange, searching, hasGuild, onSelectBuiltin, onSelectGuild, onSelectCustom, onDeleteCustom, onCreateNew }) => (
  <div>
    {!searching && (
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, overflowX: 'auto', scrollbarWidth: 'thin' }}>
        {packs.map((p, i) => <PkBtn key={i} label={p.name} active={activePack === i} onClick={() => onPackChange(i)} />)}
        <PkBtn label="My Stickers" active={activePack === -2} onClick={() => onPackChange(-2)} />
        {hasGuild && <PkBtn label="Server" active={activePack === -1} onClick={() => onPackChange(-1)} />}
      </div>
    )}

    {(searching || activePack === -2) && (
      <div style={{ marginBottom: searching ? 12 : 0 }}>
        {searching && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>My Stickers</div>}
        {!searching && (
          <button onClick={onCreateNew} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'var(--bg-secondary)', border: '1px dashed var(--border-color)', borderRadius: 8, padding: '10px 12px', cursor: 'pointer', color: 'var(--accent-primary)', fontSize: 13, marginBottom: 10 }}>
            <Plus size={14} /> Create new sticker
          </button>
        )}
        {custom.length === 0 && !searching && <div style={{ color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center', padding: 12 }}>No custom stickers yet</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {custom.map(s => (
            <div key={s.id} style={{ position: 'relative' }}>
              <button onClick={() => onSelectCustom(s)} title={s.name} style={{ background: 'var(--bg-secondary)', border: 'none', borderRadius: 10, padding: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: '100%' }}>
                <img src={s.imageData} alt={s.name} style={{ width: 52, height: 52, objectFit: 'contain', borderRadius: 4 }} />
                <span style={{ fontSize: 9, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{s.name}</span>
              </button>
              <button onClick={e => { e.stopPropagation(); onDeleteCustom(s.id); }} title="Delete" style={{ position: 'absolute', top: 2, right: 2, background: '#ff444488', border: 'none', borderRadius: 4, padding: 2, cursor: 'pointer', color: '#fff', display: 'flex' }}><Trash2 size={10} /></button>
            </div>
          ))}
        </div>
      </div>
    )}

    {(searching || activePack === -1) && guild.length > 0 && (
      <>
        {searching && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>Server Stickers</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: searching ? 12 : 0 }}>
          {guild.map(s => (
            <button key={s.id} onClick={() => onSelectGuild(s)} title={s.name} style={{ background: 'var(--bg-secondary)', border: 'none', borderRadius: 10, padding: 8, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <img src={s.image} alt={s.name} style={{ width: 52, height: 52, objectFit: 'contain' }} />
              <span style={{ fontSize: 10, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{s.name}</span>
            </button>
          ))}
        </div>
      </>
    )}

    {(searching || activePack >= 0) && (
      <>
        {searching && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>Stickers</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {builtin.map((s, i) => (
            <button key={i} onClick={() => onSelectBuiltin(s)} title={s.label} style={{ background: 'var(--bg-secondary)', border: 'none', borderRadius: 10, padding: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <img src={s.url} alt={s.label} loading="lazy" style={{ width: 56, height: 56, objectFit: 'contain' }} />
              <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>{s.label}</span>
            </button>
          ))}
        </div>
        {builtin.length === 0 && <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>No stickers found</div>}
      </>
    )}
  </div>
);

// ── Create Sticker Form ──────────────────────────────────────────────────────

const CreateStickerForm: React.FC<{ onCreate: (name: string, img: string) => void; onCancel: () => void }> = ({ onCreate, onCancel }) => {
  const [name, setName] = useState('');
  const [img, setImg] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type)) { setErr('Only PNG/JPG/GIF/WebP'); return; }
    if (f.size > 2 * 1024 * 1024) { setErr('Max 2 MB'); return; }
    setErr(''); const r = new FileReader(); r.onload = () => setImg(r.result as string); r.readAsDataURL(f);
  };

  return (
    <div style={{ padding: 4 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Create Sticker</div>
      <div onClick={() => ref.current?.click()} style={{ width: '100%', height: 120, borderRadius: 10, border: '2px dashed var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', overflow: 'hidden', marginBottom: 10, background: 'var(--bg-secondary)' }}>
        {img ? <img src={img} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}><Plus size={28} style={{ marginBottom: 4 }} /><div style={{ fontSize: 12 }}>Click to pick image</div><div style={{ fontSize: 10, marginTop: 2 }}>PNG/JPG/GIF/WebP, max 2 MB</div></div>}
      </div>
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={handleFile} />
      <input value={name} onChange={e => setName(e.target.value.slice(0, 30))} placeholder="Sticker name" style={{ width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: 'inherit', outline: 'none', boxSizing: 'border-box', marginBottom: 8 }} />
      {err && <div style={{ fontSize: 12, color: '#ff6666', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => { if (!name.trim()) { setErr('Enter a name'); return; } if (!img) { setErr('Pick an image'); return; } onCreate(name.trim(), img); }} style={{ flex: 1, background: 'var(--accent-primary)', border: 'none', borderRadius: 8, padding: '8px 0', cursor: 'pointer', color: '#fff', fontSize: 13, fontWeight: 600 }}>Create</button>
        <button onClick={onCancel} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', color: 'inherit', fontSize: 13 }}>Cancel</button>
      </div>
    </div>
  );
};

const PkBtn: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
  <button onClick={onClick} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, background: active ? 'var(--accent-primary)' : 'var(--bg-secondary)', color: active ? '#fff' : 'var(--text-secondary)' }}>{label}</button>
);
