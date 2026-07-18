import React, { useState, useEffect, useCallback } from 'react';
import { Search, Users, ArrowRight, Compass, Globe, Gamepad2, Music, Code, BookOpen, Palette, Trophy, MessageCircle, Sparkles, Newspaper, Check, BadgeCheck, NotebookPen, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';

interface ExploreGuild {
  id: string;
  name: string;
  description: string;
  icon: string;
  banner: string;
  member_count: number;
  invite_code: string;
  tags: string[];
  is_personal_channel?: boolean;
  is_member?: boolean;
  is_official?: boolean;
}

const CATEGORIES = [
  { icon: Gamepad2, label: 'Игры', labelEn: 'Gaming', tag: 'gaming', color: '#5865f2', bg: 'rgba(88,101,242,0.12)' },
  { icon: Music, label: 'Музыка', labelEn: 'Music', tag: 'music', color: '#eb459e', bg: 'rgba(235,69,158,0.12)' },
  { icon: Code, label: 'Технологии', labelEn: 'Tech', tag: 'tech', color: '#57f287', bg: 'rgba(87,242,135,0.12)' },
  { icon: BookOpen, label: 'Образование', labelEn: 'Education', tag: 'education', color: '#fee75c', bg: 'rgba(254,231,92,0.12)' },
  { icon: Palette, label: 'Творчество', labelEn: 'Creative', tag: 'creative', color: '#ed4245', bg: 'rgba(237,66,69,0.12)' },
  { icon: Trophy, label: 'Киберспорт', labelEn: 'Esports', tag: 'esports', color: '#f47b67', bg: 'rgba(244,123,103,0.12)' },
  { icon: Newspaper, label: 'Новости', labelEn: 'News', tag: 'news', color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
  { icon: MessageCircle, label: 'Общение', labelEn: 'Social', tag: 'social', color: '#3ba55d', bg: 'rgba(59,165,93,0.12)' },
  { icon: Sparkles, label: 'Другое', labelEn: 'Other', tag: 'other', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
];

interface MessageResult {
  id: string;
  content: string;
  created_at: string;
  channel: { id: string; name: string };
  guild: { id: string; name: string; icon: string; is_personal_channel: boolean; is_member: boolean; invite_code: string };
  author: { username: string; nickname: string };
}

export const ExploreServers: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const { currentServerIP, authToken, joinGuild, previewGuild, selectGuild, guilds, createPersonalNotes } = useApp();
  const [showNotes, setShowNotes] = useState(false);
  const [notesName, setNotesName] = useState('');
  const [notesBusy, setNotesBusy] = useState(false);
  const tr = useTranslation();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ExploreGuild[]>([]);
  const [msgResults, setMsgResults] = useState<MessageResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [hoveredJoin, setHoveredJoin] = useState<string | null>(null);
  const [hoveredCat, setHoveredCat] = useState<number | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);

  const load = useCallback(async (q: string) => {
    if (!authToken) return;
    setLoading(true);
    try {
      const res = await fetch(`${currentServerIP}/api/guilds/explore/?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data: ExploreGuild[] = await res.json();
        // Sort by popularity (member count, descending)
        data.sort((a, b) => b.member_count - a.member_count);
        setResults(data);
      }
    } catch { /* ignore */ }
    setLoading(false);
    setLoaded(true);
  }, [currentServerIP, authToken]);

  const loadMessages = useCallback(async (q: string) => {
    if (!authToken || !q.trim()) { setMsgResults([]); return; }
    try {
      const res = await fetch(`${currentServerIP}/api/search/messages/?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) setMsgResults(await res.json());
    } catch { /* ignore */ }
  }, [currentServerIP, authToken]);

  useEffect(() => {
    const t = setTimeout(() => { load(search); loadMessages(search); }, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [search, load, loadMessages]);

  const openMessageResult = useCallback(async (m: MessageResult) => {
    if (m.guild.is_member) {
      const g = guilds.find(x => String(x.id) === String(m.guild.id));
      if (g) selectGuild(g);
    } else {
      // Open as preview — don't auto-join/subscribe. The channel view shows a
      // "Subscribe" button at the bottom.
      await previewGuild(m.guild.id);
    }
  }, [guilds, selectGuild, previewGuild]);

  const handleJoin = async (e: React.MouseEvent, g: ExploreGuild) => {
    e.stopPropagation();
    // Already a member → just open it instead of joining again.
    if (g.is_member) {
      const existing = guilds.find(x => String(x.id) === String(g.id));
      if (existing) selectGuild(existing);
      return;
    }
    // Channels: open as preview without subscribing (subscribe happens inside).
    if (g.is_personal_channel) {
      await previewGuild(g.id);
      return;
    }
    setJoining(g.id);
    try {
      const joined = await joinGuild(g.invite_code);
      if (joined) selectGuild(joined);
      setResults(prev => prev.filter(r => r.id !== g.id));
    } catch { /* ignore */ }
    setJoining(null);
  };

  const isRu = tr('explore_title') === 'Исследовать Сферу';

  const channelResults = results.filter(g => g.is_personal_channel);
  const serverResults = results.filter(g => !g.is_personal_channel);

  const renderGuildCard = (g: ExploreGuild) => {
    const isHovered = hoveredCard === g.id;
    const isChannel = !!g.is_personal_channel;
    const hue = Math.abs(g.name.charCodeAt(0) * 47 + (g.name.charCodeAt(1) || 0) * 13) % 360;
    return (
      <div
        key={g.id}
        onMouseEnter={() => setHoveredCard(g.id)}
        onMouseLeave={() => setHoveredCard(null)}
        style={{
          borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          cursor: 'pointer',
          transition: 'transform 0.2s, box-shadow 0.2s, border-color 0.2s',
          transform: isHovered ? 'translateY(-3px)' : 'none',
          boxShadow: isHovered ? '0 8px 24px rgba(0,0,0,0.25)' : '0 1px 4px rgba(0,0,0,0.08)',
          borderColor: isHovered ? `hsl(${hue}, 50%, 50%)` : 'var(--border-color)',
        }}
      >
        {/* Banner */}
        <div style={{ position: 'relative', height: 90, overflow: 'hidden' }}>
          {g.banner ? (
            <div style={{
              height: '100%', width: '100%',
              background: `url(${g.banner.startsWith('http') ? g.banner : currentServerIP + g.banner}) center/cover`,
              transition: 'transform 0.3s',
              transform: isHovered ? 'scale(1.05)' : 'scale(1)',
            }} />
          ) : (
            <div style={{
              height: '100%', width: '100%',
              background: `linear-gradient(135deg, hsl(${hue}, 55%, 40%) 0%, hsl(${(hue + 40) % 360}, 45%, 30%) 100%)`,
            }} />
          )}
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, height: 40,
            background: 'linear-gradient(transparent, rgba(0,0,0,0.35))',
          }} />
        </div>

        {/* Icon */}
        <div style={{ padding: '0 14px', marginTop: -22, position: 'relative', zIndex: 1 }}>
          {g.icon ? (
            <img
              src={g.icon.startsWith('http') ? g.icon : currentServerIP + g.icon}
              alt="" style={{
                width: 44, height: 44, borderRadius: isChannel ? 13 : '50%', objectFit: 'cover',
                border: '3px solid var(--bg-secondary)',
                boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
              }}
            />
          ) : (
            <div style={{
              width: 44, height: 44, borderRadius: isChannel ? 13 : '50%',
              background: `linear-gradient(135deg, hsl(${hue}, 55%, 50%), hsl(${(hue + 60) % 360}, 45%, 40%))`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontWeight: 800, fontSize: 18,
              border: '3px solid var(--bg-secondary)',
              boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
            }}>
              {g.name[0]?.toUpperCase()}
            </div>
          )}
        </div>

        {/* Info */}
        <div style={{ padding: '8px 14px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{
              fontWeight: 700, fontSize: 15, color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {g.name}
            </span>
            {g.is_official && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 700, flexShrink: 0, background: 'rgba(88,101,242,0.18)', color: 'var(--accent-primary)' }}>
                <BadgeCheck size={11} /> {isRu ? 'официальный' : 'official'}
              </span>
            )}
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 600, flexShrink: 0, background: isChannel ? 'rgba(88,101,242,0.15)' : 'rgba(59,165,93,0.15)', color: isChannel ? 'var(--accent-primary)' : '#3ba55d' }}>
              {isChannel ? (isRu ? 'канал' : 'channel') : (isRu ? 'сервер' : 'server')}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#3ba55d', flexShrink: 0 }} />
            <Users size={11} />
            <span>{g.member_count} {isRu ? (g.member_count === 1 ? 'участник' : g.member_count < 5 ? 'участника' : 'участников') : (g.member_count === 1 ? 'member' : 'members')}</span>
          </div>

          {g.description ? (
            <p style={{
              margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45,
              overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            }}>
              {g.description}
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
              {isRu ? 'Нет описания' : 'No description'}
            </p>
          )}

          {g.tags && g.tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {g.tags.slice(0, 4).map((t, i) => (
                <span key={i} onClick={e => { e.stopPropagation(); setSearch('#' + t); }} style={{
                  padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 500,
                  background: search === '#' + t ? `hsla(${hue + i * 40}, 40%, 50%, 0.3)` : `hsla(${hue + i * 40}, 40%, 50%, 0.15)`,
                  color: `hsl(${hue + i * 40}, 50%, 65%)`,
                  border: `1px solid hsla(${hue + i * 40}, 40%, 50%, 0.2)`,
                  cursor: 'pointer', transition: 'background 0.15s',
                }}>
                  {t}
                </span>
              ))}
              {g.tags.length > 4 && (
                <span style={{ padding: '2px 6px', fontSize: 10, color: 'var(--text-tertiary)' }}>
                  +{g.tags.length - 4}
                </span>
              )}
            </div>
          )}

          <button
            onClick={e => handleJoin(e, g)}
            disabled={joining === g.id}
            onMouseEnter={() => setHoveredJoin(g.id)}
            onMouseLeave={() => setHoveredJoin(null)}
            style={{
              marginTop: 'auto', padding: '7px 0', borderRadius: 8,
              border: g.is_member ? '1px solid var(--border-color)' : 'none',
              background: g.is_member ? 'transparent' : (hoveredJoin === g.id ? '#4752c4' : 'var(--accent-primary)'),
              color: g.is_member ? 'var(--text-secondary)' : '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              opacity: joining === g.id ? 0.6 : 1,
              transition: 'background 0.15s, transform 0.1s',
              transform: hoveredJoin === g.id && !g.is_member ? 'scale(1.02)' : 'none',
            }}
          >
            {joining === g.id ? (
              <>
                <div style={{
                  width: 13, height: 13, borderRadius: '50%',
                  border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff',
                  animation: 'spin 0.6s linear infinite',
                }} />
                {isRu ? 'Подключение...' : 'Joining...'}
              </>
            ) : g.is_member ? (
              <>
                <Check size={13} /> {isRu ? 'Вы уже здесь' : "You're in"}
              </>
            ) : (
              <>
                {isChannel ? (isRu ? 'Открыть' : 'Open') : tr('explore_join')} <ArrowRight size={13} />
              </>
            )}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)', ...style }}>
      {showNotes && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setShowNotes(false)}>
          <div style={{ width: '100%', maxWidth: 400, background: 'var(--bg-secondary)', borderRadius: 14, padding: 18, border: '1px solid var(--border-color)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <NotebookPen size={18} style={{ color: 'var(--accent-primary)' }} />
              <h3 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)', flex: 1 }}>{isRu ? 'Личный дневник' : 'Personal diary'}</h3>
              <button onClick={() => setShowNotes(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted, #949ba4)' }}><X size={18} /></button>
            </div>
            <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {isRu ? 'Приватное пространство только для вас: текст, медиа, списки задач, код, геопозиции и контакты — как заметки для себя.' : 'A private space just for you: text, media, checklists, code, locations and contacts — notes to self.'}
            </p>
            <input
              className="input-field"
              autoFocus
              placeholder={isRu ? 'Название дневника' : 'Diary name'}
              value={notesName}
              maxLength={100}
              onChange={e => setNotesName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') (document.getElementById('notes-create-btn') as HTMLButtonElement)?.click(); }}
              style={{ width: '100%', padding: '9px 11px', borderRadius: 8, fontSize: 14, border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' }}
            />
            <button
              id="notes-create-btn"
              disabled={notesBusy || !notesName.trim()}
              onClick={async () => {
                setNotesBusy(true);
                const g = await createPersonalNotes(notesName.trim());
                setNotesBusy(false);
                if (g) { setShowNotes(false); setNotesName(''); selectGuild(g); }
              }}
              style={{ width: '100%', marginTop: 12, padding: '10px', borderRadius: 8, border: 'none', background: 'var(--accent-primary)', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', opacity: (notesBusy || !notesName.trim()) ? 0.6 : 1 }}
            >
              {notesBusy ? (isRu ? 'Создание…' : 'Creating…') : (isRu ? 'Создать' : 'Create')}
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes float1 { 0%,100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-12px) rotate(5deg); } }
        @keyframes float2 { 0%,100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-8px) rotate(-3deg); } }
        @keyframes gradientShift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
      `}</style>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {/* Hero banner */}
        <div style={{
          position: 'relative', padding: '48px 24px 40px', overflow: 'hidden',
          background: 'linear-gradient(135deg, #1a1147 0%, #0d1b3e 30%, #0a2540 60%, #0d1f2d 100%)',
          backgroundSize: '200% 200%',
          animation: 'gradientShift 12s ease infinite',
        }}>
          {/* Decorative circles */}
          <div style={{ position: 'absolute', top: -30, right: -30, width: 180, height: 180, borderRadius: '50%', background: 'rgba(88,101,242,0.08)', animation: 'float1 6s ease-in-out infinite' }} />
          <div style={{ position: 'absolute', bottom: -40, left: '20%', width: 120, height: 120, borderRadius: '50%', background: 'rgba(235,69,158,0.06)', animation: 'float2 8s ease-in-out infinite' }} />
          <div style={{ position: 'absolute', top: 20, left: '60%', width: 60, height: 60, borderRadius: '50%', background: 'rgba(87,242,135,0.05)', animation: 'float1 7s ease-in-out infinite' }} />

          <div style={{ position: 'relative', zIndex: 1, maxWidth: 600 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12,
                background: 'linear-gradient(135deg, #5865f2, #7c3aed)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(88,101,242,0.3)',
              }}>
                <Compass size={22} color="#fff" />
              </div>
              <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: '#fff', letterSpacing: '-0.5px' }}>
                {tr('explore_title')}
              </h1>
            </div>
            <p style={{ margin: '0 0 16px', fontSize: 14, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>
              {tr('explore_subtitle')}
            </p>
            {!guilds.some(g => g.is_private) && (
            <button
              onClick={() => setShowNotes(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 20,
                padding: '9px 16px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)',
                background: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(10px)',
                color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              <NotebookPen size={16} /> {isRu ? 'Создать личный дневник' : 'Create personal diary'}
            </button>
            )}
            <div style={{ position: 'relative', maxWidth: 420 }}>
              <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.7)', zIndex: 1 }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder={tr('explore_search_placeholder')}
                style={{
                  width: '100%', padding: '11px 16px 11px 40px', borderRadius: 12,
                  border: `1.5px solid ${searchFocused ? 'rgba(88,101,242,0.6)' : 'rgba(255,255,255,0.1)'}`,
                  background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(10px)',
                  color: '#fff', fontSize: 14, outline: 'none', boxSizing: 'border-box',
                  transition: 'border-color 0.2s, box-shadow 0.2s',
                  boxShadow: searchFocused ? '0 0 0 3px rgba(88,101,242,0.15)' : 'none',
                }}
              />
            </div>
          </div>
        </div>

        {/* Categories */}
        <div style={{ padding: '20px 24px 8px' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            {isRu ? 'Категории' : 'Categories'}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
            {CATEGORIES.map((cat, i) => {
              const Icon = cat.icon;
              const isHov = hoveredCat === i;
              return (
                <div
                  key={i}
                  onMouseEnter={() => setHoveredCat(i)}
                  onMouseLeave={() => setHoveredCat(null)}
                  onClick={() => setSearch(prev => prev === '#' + cat.tag ? '' : '#' + cat.tag)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                    padding: '14px 8px', borderRadius: 10, cursor: 'pointer',
                    background: search === '#' + cat.tag ? cat.bg : isHov ? cat.bg : 'var(--bg-secondary)',
                    border: `1px solid ${search === '#' + cat.tag ? cat.color : isHov ? cat.color + '40' : 'var(--border-color)'}`,
                    transition: 'all 0.2s',
                    transform: isHov ? 'translateY(-2px)' : 'none',
                  }}
                >
                  <Icon size={22} style={{ color: cat.color, transition: 'transform 0.2s', transform: isHov ? 'scale(1.15)' : 'none' }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: isHov ? cat.color : 'var(--text-secondary)', transition: 'color 0.2s', textAlign: 'center' }}>
                    {isRu ? cat.label : cat.labelEn}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Divider */}
        <div style={{ margin: '16px 24px 0', borderTop: '1px solid var(--border-color)' }} />

        {/* Messages & posts section (only while searching) */}
        {search && msgResults.length > 0 && (
          <div style={{ padding: '16px 24px 0' }}>
            <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {isRu ? 'Посты и сообщения' : 'Posts & messages'}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {msgResults.map(m => {
                const icon = m.guild.icon ? (m.guild.icon.startsWith('http') ? m.guild.icon : currentServerIP + m.guild.icon) : '';
                return (
                  <div
                    key={m.id}
                    onClick={() => openMessageResult(m)}
                    style={{
                      display: 'flex', gap: 12, padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                      background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                      transition: 'border-color 0.15s, transform 0.1s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-primary)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}
                  >
                    {icon ? (
                      <img src={icon} alt="" style={{ width: 38, height: 38, borderRadius: m.guild.is_personal_channel ? 10 : '50%', objectFit: 'cover', flexShrink: 0 }} />
                    ) : (
                      <div style={{ width: 38, height: 38, borderRadius: m.guild.is_personal_channel ? 10 : '50%', flexShrink: 0, background: 'var(--accent-primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
                        {m.guild.name[0]?.toUpperCase()}
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.guild.name}</span>
                        {!m.guild.is_personal_channel && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-tertiary)' }}>#{m.channel.name}</span>}
                        {m.guild.is_personal_channel
                          ? <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(88,101,242,0.15)', color: 'var(--accent-primary)', fontWeight: 600 }}>{isRu ? 'канал' : 'channel'}</span>
                          : <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(59,165,93,0.15)', color: '#3ba55d', fontWeight: 600 }}>{isRu ? 'сервер' : 'server'}</span>}
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                        {m.content || (isRu ? '[вложение]' : '[attachment]')}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Channels section — only when browsing (not searching); while searching
            everything is merged into a single "Search results" list below. */}
        {loaded && !loading && !search && channelResults.length > 0 && (
          <div style={{ padding: '16px 24px 0' }}>
            <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {isRu ? 'Каналы' : 'Channels'}
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
              {channelResults.map(renderGuildCard)}
            </div>
          </div>
        )}

        {/* Results / popular section */}
        <div style={{ padding: '16px 24px 32px' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            {search
              ? (isRu ? 'Результаты поиска' : 'Search results')
              : (isRu ? 'Популярные серверы' : 'Popular servers')}
          </h3>

          {!loaded || loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 40, gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                border: '3px solid var(--border-color)', borderTopColor: 'var(--accent-primary)',
                animation: 'spin 0.8s linear infinite',
              }} />
              <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{tr('explore_loading')}</p>
            </div>
          ) : (search ? results.length === 0 : serverResults.length === 0) ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
              background: 'var(--bg-secondary)', borderRadius: 12,
              padding: '40px 20px',
              border: '1px dashed var(--border-color)',
            }}>
              <Globe size={40} style={{ color: 'var(--text-tertiary)', opacity: 0.4 }} />
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, fontWeight: 500, margin: 0 }}>
                {search ? (isRu ? 'Ничего не найдено' : 'Nothing found') : tr('explore_empty')}
              </p>
              <p style={{ color: 'var(--text-tertiary)', fontSize: 12, margin: 0, textAlign: 'center' }}>
                {search
                  ? (isRu ? 'Попробуйте другой запрос' : 'Try a different search')
                  : (isRu ? 'Серверы с включённой видимостью появятся здесь' : 'Discoverable servers will appear here')}
              </p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
              {(search ? results : serverResults).map(renderGuildCard)}
            </div>
          )}
        </div>


        {/* Footer */}
        <div style={{
          padding: '20px 24px 24px', textAlign: 'center',
          borderTop: '1px solid var(--border-color)',
          color: 'var(--text-tertiary)', fontSize: 12,
        }}>
          <Compass size={16} style={{ verticalAlign: 'middle', marginRight: 6, opacity: 0.5 }} />
          {isRu
            ? 'Сделайте свой сервер видимым в настройках, чтобы он появился здесь'
            : 'Make your server discoverable in settings to appear here'}
        </div>
      </div>
    </div>
  );
};
