import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Upload, Trash2, Plus, Edit2, Crown, Shield, Volume2, Smile,
  Users, Link, Lock, AlertTriangle, FileText, Copy, Play, Pause,
  Check, ChevronRight, ChevronLeft, Zap, Image, Music, Settings, Globe, Bell,
  Eye, Key, RefreshCw, Hash, Ban,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';

function useIsMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = () => setMobile(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return mobile;
}
import type { GuildRole, GuildEmoji, GuildSticker, GuildSound, GuildInviteData, GuildAuditLogEntry } from '../types/index';

// ── Types ─────────────────────────────────────────────────────────────────────
type Section =
  | 'profile' | 'tag' | 'boost'
  | 'emoji' | 'stickers' | 'sounds'
  | 'members' | 'roles' | 'invites' | 'blocked' | 'access' | 'integration'
  | 'security' | 'logs' | 'delete';

// ── Shared styles ─────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px',
  background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 14, outline: 'none',
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)',
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, display: 'block',
};
const sectionTitle: React.CSSProperties = { margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' };
const sectionSubtitle: React.CSSProperties = { margin: '0 0 24px', fontSize: 13, color: 'var(--text-secondary)' };
const saveBtn = (disabled: boolean): React.CSSProperties => ({
  padding: '9px 22px', background: disabled ? 'var(--bg-tertiary)' : 'var(--accent-primary)',
  color: disabled ? 'var(--text-tertiary)' : '#fff', border: 'none',
  borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
});

// ── Server Profile ────────────────────────────────────────────────────────────
function ServerProfileSection() {
  const { currentGuild, updateGuild, currentServerIP } = useApp();
  const tr = useTranslation();
  const iconInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(currentGuild?.name ?? '');
  const [description, setDescription] = useState(currentGuild?.description ?? '');
  const [iconPreview, setIconPreview] = useState<string | null>(
    currentGuild?.icon ? `${currentServerIP}${currentGuild.icon}` : null
  );
  const [bannerPreview, setBannerPreview] = useState<string | null>(
    currentGuild?.banner ? `${currentServerIP}${currentGuild.banner}` : null
  );
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [removeIcon, setRemoveIcon] = useState(false);
  const [removeBanner, setRemoveBanner] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!currentGuild) return null;

  const handleSave = async () => {
    setSaving(true);
    await updateGuild(currentGuild.id, { name, description, icon: iconFile, banner: bannerFile, removeIcon, removeBanner });
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_server_profile')}</h2>
      <p style={sectionSubtitle}>{tr('gs_customize_desc')}</p>

      <div style={{ marginBottom: 20 }}>
        <span style={labelStyle}>{tr('gs_server_banner')}</span>
        <div style={{ position: 'relative', width: '100%', height: 110, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-tertiary)', border: '2px dashed var(--border-color)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => bannerInputRef.current?.click()}>
          {bannerPreview && !removeBanner
            ? <img src={bannerPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: 'var(--text-tertiary)' }}><Upload size={22} /><span style={{ fontSize: 12 }}>{tr('gs_click_upload_banner')}</span></div>}
        </div>
        {bannerPreview && !removeBanner && (
          <button onClick={() => { setRemoveBanner(true); setBannerFile(null); setBannerPreview(null); }} style={{ marginTop: 6, background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 12 }}>{tr('gs_remove_banner')}</button>
        )}
        <input ref={bannerInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => {
          const f = e.target.files?.[0]; if (!f) return;
          if (bannerPreview && bannerPreview.startsWith('blob:')) URL.revokeObjectURL(bannerPreview);
          setBannerFile(f); setRemoveBanner(false); setBannerPreview(URL.createObjectURL(f));
        }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
        <div style={{ width: 80, height: 80, borderRadius: '50%', overflow: 'hidden', background: 'var(--bg-tertiary)', border: '2px dashed var(--border-color)', flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => iconInputRef.current?.click()}>
          {iconPreview && !removeIcon
            ? <img src={iconPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-tertiary)' }}>{currentGuild.name[0]?.toUpperCase()}</span>}
        </div>
        <div>
          <span style={labelStyle}>{tr('gs_server_icon')}</span>
          <button onClick={() => iconInputRef.current?.click()} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '6px 12px', fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
            <Upload size={13} /> {tr('gs_change_icon')}
          </button>
          {iconPreview && !removeIcon && (
            <button onClick={() => { setRemoveIcon(true); setIconFile(null); setIconPreview(null); }} style={{ marginTop: 6, background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 12, display: 'block' }}>{tr('gs_remove_icon')}</button>
          )}
        </div>
        <input ref={iconInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => {
          const f = e.target.files?.[0]; if (!f) return;
          if (iconPreview && iconPreview.startsWith('blob:')) URL.revokeObjectURL(iconPreview);
          setIconFile(f); setRemoveIcon(false); setIconPreview(URL.createObjectURL(f));
        }} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>{tr('gs_server_name')}</label>
        <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} maxLength={100} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>{tr('gs_description')}</label>
        <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 80, fontFamily: 'inherit' }} value={description} onChange={e => setDescription(e.target.value)} maxLength={500} />
      </div>
      <button disabled={saving || !name.trim()} onClick={handleSave} style={saveBtn(saving || !name.trim())}>
        {saved ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Check size={14} /> {tr('gs_saved')}</span> : saving ? tr('gs_saving') : tr('gs_save_changes')}
      </button>
    </div>
  );
}

// ── Server Tag ────────────────────────────────────────────────────────────────
function ServerTagSection() {
  const { currentGuild, updateGuild } = useApp();
  const tr = useTranslation();
  const [tag, setTag] = useState(currentGuild?.tag ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!currentGuild) return null;

  const handleSave = async () => {
    setSaving(true);
    await updateGuild(currentGuild.id, { tag: tag.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) });
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_server_tag')}</h2>
      <p style={sectionSubtitle}>{tr('gs_server_tag_desc')}</p>
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>{tr('gs_tag')}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--text-tertiary)', fontWeight: 700, fontSize: 16 }}>#</span>
          <input style={{ ...inputStyle, flex: 1 }} value={tag} maxLength={8}
            onChange={e => setTag(e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8))}
            placeholder="e.g. IONIK" />
        </div>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>{tag.length}/8 {tr('gs_characters')}</p>
      </div>
      <button disabled={saving} onClick={handleSave} style={saveBtn(saving)}>
        {saved ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Check size={14} /> {tr('gs_saved')}</span> : saving ? tr('gs_saving') : tr('gs_save_changes')}
      </button>
    </div>
  );
}

// ── Boost Bonus ───────────────────────────────────────────────────────────────
const BOOST_PERK_KEYS: Record<number, string[]> = {
  0: ['gs_perk_basic', 'gs_perk_50_emoji', 'gs_perk_standard_audio'],
  1: ['gs_perk_128_audio', 'gs_perk_100_emoji', 'gs_perk_animated_icon', 'gs_perk_custom_invite_bg'],
  2: ['gs_perk_256_audio', 'gs_perk_150_emoji', 'gs_perk_server_banner', 'gs_perk_50mb_upload', 'gs_perk_custom_role_icons'],
  3: ['gs_perk_384_audio', 'gs_perk_250_emoji', 'gs_perk_animated_banner', 'gs_perk_100mb_upload', 'gs_perk_vanity_url'],
};

function BoostBonusSection() {
  const { currentGuild, updateGuild } = useApp();
  const tr = useTranslation();
  const [saving, setSaving] = useState(false);
  if (!currentGuild) return null;
  const isOwner = currentGuild.my_role === 'owner';
  const level = currentGuild.boost_level ?? 0;

  const handleSetLevel = async (l: number) => {
    if (!isOwner) return;
    setSaving(true);
    await updateGuild(currentGuild.id, { boost_level: l });
    setSaving(false);
  };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_boost_bonus')}</h2>
      <p style={sectionSubtitle}>{tr('gs_boost_desc')}</p>
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        {[0, 1, 2, 3].map(l => (
          <div key={l} onClick={() => isOwner && !saving && handleSetLevel(l)} style={{
            flex: 1, minWidth: 150, padding: 16, borderRadius: 10, cursor: isOwner ? 'pointer' : 'default',
            border: `2px solid ${l === level ? 'var(--accent-primary)' : 'var(--border-color)'}`,
            background: l === level ? 'rgba(var(--accent-primary-rgb, 88,101,242),0.08)' : 'var(--bg-tertiary)',
            transition: 'border 0.15s, background 0.15s',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Zap size={16} style={{ color: l === level ? 'var(--accent-primary)' : '#faa81a' }} />
              <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{tr('gs_level')} {l}</span>
              {l === level && <span style={{ marginLeft: 'auto', fontSize: 10, background: 'var(--accent-primary)', color: '#fff', padding: '2px 6px', borderRadius: 4 }}>{tr('gs_active')}</span>}
            </div>
            <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              {BOOST_PERK_KEYS[l].map(p => <li key={p}>{tr(p as any)}</li>)}
            </ul>
          </div>
        ))}
      </div>
      {!isOwner && <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{tr('gs_owner_only_boost')}</p>}
    </div>
  );
}

// ── Emoji ─────────────────────────────────────────────────────────────────────
function EmojiSection() {
  const { currentGuild, loadGuildEmojis, uploadGuildEmoji, deleteGuildEmoji } = useApp();
  const tr = useTranslation();
  const [emojis, setEmojis] = useState<GuildEmoji[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isAdmin = currentGuild?.my_role === 'owner' || currentGuild?.my_role === 'admin';

  useEffect(() => {
    if (!currentGuild) return;
    loadGuildEmojis(currentGuild.id).then(data => { setEmojis(data); setLoading(false); });
  }, [currentGuild?.id]);

  const handleUpload = async () => {
    if (!currentGuild || !name.trim() || !file) return;
    const emoji = await uploadGuildEmoji(currentGuild.id, name.trim(), file);
    if (emoji) { setEmojis(prev => [...prev, emoji]); setName(''); setFile(null); setFilePreview(null); }
  };

  const handleDelete = async (emojiId: string) => {
    if (!currentGuild) return;
    await deleteGuildEmoji(currentGuild.id, emojiId);
    setEmojis(prev => prev.filter(e => e.id !== emojiId));
  };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_emoji')}</h2>
      <p style={sectionSubtitle}>{tr('gs_emoji_desc').replace('{n}', String(emojis.length))}</p>

      {isAdmin && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 24, background: 'var(--bg-tertiary)', padding: 16, borderRadius: 10, border: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 48, height: 48, borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
              onClick={() => inputRef.current?.click()}>
              {filePreview ? <img src={filePreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Upload size={16} style={{ color: 'var(--text-tertiary)' }} />}
            </div>
            <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => {
              const f = e.target.files?.[0]; if (!f) return; if (filePreview) URL.revokeObjectURL(filePreview); setFile(f); setFilePreview(URL.createObjectURL(f));
            }} />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ ...labelStyle, marginBottom: 4 }}>{tr('gs_emoji_name')}</label>
            <input style={inputStyle} placeholder="e.g. smile" value={name} onChange={e => setName(e.target.value.replace(/\s/g, '_').slice(0, 32))} />
          </div>
          <button disabled={!name.trim() || !file} onClick={handleUpload}
            style={{ padding: '9px 18px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: !name.trim() || !file ? 'not-allowed' : 'pointer', opacity: !name.trim() || !file ? 0.5 : 1 }}>
            <Plus size={14} style={{ display: 'inline', marginRight: 4 }} /> {tr('gs_upload')}
          </button>
        </div>
      )}

      {loading ? <p style={{ color: 'var(--text-secondary)' }}>{tr('gs_loading')}</p> : emojis.length === 0
        ? <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{tr('gs_no_custom_emoji')}</p>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 12 }}>
            {emojis.map(e => (
              <div key={e.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: 10, borderRadius: 8, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', position: 'relative' }}>
                <img src={e.image} alt={e.name} style={{ width: 40, height: 40, objectFit: 'contain' }} />
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', wordBreak: 'break-all', textAlign: 'center' }}>:{e.name}:</span>
                {isAdmin && (
                  <button onClick={() => handleDelete(e.id)} style={{ position: 'absolute', top: 4, right: 4, background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 2 }}>
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Stickers ──────────────────────────────────────────────────────────────────
function StickersSection() {
  const { currentGuild, loadGuildStickers, uploadGuildSticker, deleteGuildSticker } = useApp();
  const tr = useTranslation();
  const [stickers, setStickers] = useState<GuildSticker[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isAdmin = currentGuild?.my_role === 'owner' || currentGuild?.my_role === 'admin';

  useEffect(() => {
    if (!currentGuild) return;
    loadGuildStickers(currentGuild.id).then(data => { setStickers(data); setLoading(false); });
  }, [currentGuild?.id]);

  const handleUpload = async () => {
    if (!currentGuild || !name.trim() || !file) return;
    const sticker = await uploadGuildSticker(currentGuild.id, name.trim(), desc.trim(), file);
    if (sticker) { setStickers(prev => [...prev, sticker]); setName(''); setDesc(''); setFile(null); setFilePreview(null); }
  };

  const handleDelete = async (id: string) => {
    if (!currentGuild) return;
    await deleteGuildSticker(currentGuild.id, id);
    setStickers(prev => prev.filter(s => s.id !== id));
  };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_stickers')}</h2>
      <p style={sectionSubtitle}>{tr('gs_stickers_desc').replace('{n}', String(stickers.length))}</p>

      {isAdmin && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24, background: 'var(--bg-tertiary)', padding: 16, borderRadius: 10, border: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ width: 64, height: 64, borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}
              onClick={() => inputRef.current?.click()}>
              {filePreview ? <img src={filePreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Upload size={18} style={{ color: 'var(--text-tertiary)' }} />}
            </div>
            <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => {
              const f = e.target.files?.[0]; if (!f) return; if (filePreview) URL.revokeObjectURL(filePreview); setFile(f); setFilePreview(URL.createObjectURL(f));
            }} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input style={inputStyle} placeholder={tr('gs_sticker_name')} value={name} onChange={e => setName(e.target.value.slice(0, 50))} />
              <input style={inputStyle} placeholder={tr('gs_sticker_desc_optional')} value={desc} onChange={e => setDesc(e.target.value.slice(0, 200))} />
            </div>
          </div>
          <button disabled={!name.trim() || !file} onClick={handleUpload}
            style={{ alignSelf: 'flex-end', padding: '8px 18px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: !name.trim() || !file ? 'not-allowed' : 'pointer', opacity: !name.trim() || !file ? 0.5 : 1 }}>
            <Plus size={14} style={{ display: 'inline', marginRight: 4 }} /> {tr('gs_upload_sticker')}
          </button>
        </div>
      )}

      {loading ? <p style={{ color: 'var(--text-secondary)' }}>{tr('gs_loading')}</p> : stickers.length === 0
        ? <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{tr('gs_no_stickers')}</p>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
            {stickers.map(s => (
              <div key={s.id} style={{ borderRadius: 8, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', padding: 10, position: 'relative' }}>
                <img src={s.image} alt={s.name} style={{ width: '100%', aspectRatio: '1', objectFit: 'contain', borderRadius: 4 }} />
                <p style={{ margin: '6px 0 0', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</p>
                {s.description && <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</p>}
                {isAdmin && (
                  <button onClick={() => handleDelete(s.id)} style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.5)', border: 'none', borderRadius: 4, cursor: 'pointer', color: '#fff', padding: '2px 4px' }}>
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Sound Panel ───────────────────────────────────────────────────────────────
function SoundsSection() {
  const { currentGuild, loadGuildSounds, uploadGuildSound, deleteGuildSound } = useApp();
  const tr = useTranslation();
  const [sounds, setSounds] = useState<GuildSound[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isAdmin = currentGuild?.my_role === 'owner' || currentGuild?.my_role === 'admin';

  useEffect(() => {
    if (!currentGuild) return;
    loadGuildSounds(currentGuild.id).then(data => { setSounds(data); setLoading(false); });
  }, [currentGuild?.id]);

  const handlePlay = (sound: GuildSound) => {
    if (playing === sound.id) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(sound.url);
    audio.onended = () => setPlaying(null);
    audio.play();
    audioRef.current = audio;
    setPlaying(sound.id);
  };

  const handleUpload = async () => {
    if (!currentGuild || !name.trim() || !file) return;
    const sound = await uploadGuildSound(currentGuild.id, name.trim(), file);
    if (sound) { setSounds(prev => [...prev, sound]); setName(''); setFile(null); }
  };

  const handleDelete = async (id: string) => {
    if (!currentGuild) return;
    if (playing === id) { audioRef.current?.pause(); audioRef.current = null; setPlaying(null); }
    await deleteGuildSound(currentGuild.id, id);
    setSounds(prev => prev.filter(s => s.id !== id));
  };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_sound_panel')}</h2>
      <p style={sectionSubtitle}>{tr('gs_sounds_desc').replace('{n}', String(sounds.length))}</p>

      {isAdmin && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 24, background: 'var(--bg-tertiary)', padding: 16, borderRadius: 10, border: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ ...labelStyle, marginBottom: 4 }}>{tr('gs_sound_name')}</label>
            <input style={inputStyle} placeholder="e.g. drumroll" value={name} onChange={e => setName(e.target.value.slice(0, 50))} />
          </div>
          <div>
            <label style={{ ...labelStyle, marginBottom: 4 }}>{tr('gs_audio_file')}</label>
            <button onClick={() => inputRef.current?.click()} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: file ? 'var(--accent-primary)' : 'var(--text-secondary)', cursor: 'pointer' }}>
              <Music size={13} /> {file ? file.name.slice(0, 20) : tr('gs_choose_file')}
            </button>
            <input ref={inputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f); }} />
          </div>
          <button disabled={!name.trim() || !file} onClick={handleUpload}
            style={{ padding: '9px 18px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: !name.trim() || !file ? 'not-allowed' : 'pointer', opacity: !name.trim() || !file ? 0.5 : 1 }}>
            <Plus size={14} style={{ display: 'inline', marginRight: 4 }} /> {tr('gs_upload')}
          </button>
        </div>
      )}

      {loading ? <p style={{ color: 'var(--text-secondary)' }}>{tr('gs_loading')}</p> : sounds.length === 0
        ? <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{tr('gs_no_sounds')}</p>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sounds.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 8, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)' }}>
                <button onClick={() => handlePlay(s)} style={{ width: 36, height: 36, borderRadius: '50%', background: playing === s.id ? 'var(--accent-primary)' : 'var(--bg-secondary)', border: '1px solid var(--border-color)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: playing === s.id ? '#fff' : 'var(--text-primary)', flexShrink: 0 }}>
                  {playing === s.id ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <Music size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 14, color: 'var(--text-primary)', fontWeight: 500 }}>{s.name}</span>
                {isAdmin && (
                  <button onClick={() => handleDelete(s.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Members ───────────────────────────────────────────────────────────────────
function MembersSection() {
  const { currentGuild, kickMember, setMemberRole, loadGuildRoles, assignMemberRole, removeMemberRole } = useApp();
  const tr = useTranslation();
  const [roles, setRoles] = useState<GuildRole[]>([]);
  const [search, setSearch] = useState('');
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  const [memberRoles, setMemberRoles] = useState<Record<string, string[]>>({});
  if (!currentGuild) return null;
  const isOwner = currentGuild.my_role === 'owner';
  const isAdmin = isOwner || currentGuild.my_role === 'admin';

  useEffect(() => {
    loadGuildRoles(currentGuild.id).then(setRoles);
    const map: Record<string, string[]> = {};
    currentGuild.members.forEach(m => { map[m.id] = m.custom_roles ?? []; });
    setMemberRoles(map);
  }, [currentGuild.id]);

  const filtered = currentGuild.members.filter(m =>
    (m.nickname || m.username).toLowerCase().includes(search.toLowerCase())
  );

  const handleToggleRole = async (userId: string, roleId: string) => {
    const current = memberRoles[userId] ?? [];
    if (current.includes(roleId)) {
      await removeMemberRole(currentGuild.id, userId, roleId);
      setMemberRoles(prev => ({ ...prev, [userId]: prev[userId].filter(r => r !== roleId) }));
    } else {
      await assignMemberRole(currentGuild.id, userId, roleId);
      setMemberRoles(prev => ({ ...prev, [userId]: [...(prev[userId] ?? []), roleId] }));
    }
  };

  const roleColors: Record<string, string> = { owner: '#faa81a', admin: '#5865f2', member: '#99aab5' };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_members')}</h2>
      <p style={sectionSubtitle}>{tr('gs_members_count').replace('{n}', String(currentGuild.members.length))}</p>
      <input style={{ ...inputStyle, marginBottom: 16 }} placeholder={tr('gs_search_members')} value={search} onChange={e => setSearch(e.target.value)} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {filtered.map(m => {
          const isExpanded = expandedMember === m.id;
          const isSelf = m.id === currentGuild.owner_id;
          return (
            <div key={m.id} style={{ borderRadius: 8, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'pointer', flexWrap: 'wrap' }}
                onClick={() => setExpandedMember(isExpanded ? null : m.id)}>
                {m.avatar
                  ? <img src={m.avatar} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                  : <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#fff', fontWeight: 700, flexShrink: 0 }}>{(m.nickname || m.username)[0]?.toUpperCase()}</div>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{m.nickname || m.username}</span>
                  {m.nickname && <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginLeft: 6 }}>@{m.username}</span>}
                </div>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'var(--bg-secondary)', color: roleColors[m.role] ?? '#99aab5', fontWeight: 700, flexShrink: 0 }}>
                  {m.role}
                </span>
                <ChevronRight size={14} style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: '0.15s', color: 'var(--text-tertiary)', flexShrink: 0 }} />
                {(memberRoles[m.id] ?? []).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, width: '100%', paddingTop: 4 }}>
                    {(memberRoles[m.id] ?? []).map(rId => {
                      const r = roles.find(x => x.id === rId);
                      return r ? <span key={rId} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: r.color + '22', color: r.color, fontWeight: 700, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span> : null;
                    })}
                  </div>
                )}
              </div>
              {isExpanded && (
                <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border-color)' }}>
                  {roles.length > 0 && (
                    <div style={{ marginTop: 10, marginBottom: 10 }}>
                      <span style={labelStyle}>{tr('gs_custom_roles')}</span>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {roles.map(r => {
                          const has = (memberRoles[m.id] ?? []).includes(r.id);
                          return (
                            <button key={r.id} onClick={() => isAdmin && handleToggleRole(m.id, r.id)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, border: `1.5px solid ${r.color}`, background: has ? r.color + '33' : 'transparent', color: r.color, fontSize: 12, fontWeight: 600, cursor: isAdmin ? 'pointer' : 'default' }}>
                              {has && <Check size={10} />} {r.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {isAdmin && m.role !== 'owner' && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                      {isOwner && m.role === 'member' && (
                        <button onClick={() => setMemberRole(currentGuild.id, m.id, 'admin')} style={{ padding: '6px 12px', background: '#5865f2', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                          <Shield size={11} style={{ display: 'inline', marginRight: 4 }} /> {tr('gs_make_admin')}
                        </button>
                      )}
                      {isOwner && m.role === 'admin' && (
                        <button onClick={() => setMemberRole(currentGuild.id, m.id, 'member')} style={{ padding: '6px 12px', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                          {tr('gs_remove_admin')}
                        </button>
                      )}
                      {!(currentGuild.my_role === 'admin' && m.role === 'admin') && (
                        <button onClick={() => kickMember(currentGuild.id, m.id)} style={{ padding: '6px 12px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                          <Trash2 size={11} style={{ display: 'inline', marginRight: 4 }} /> {tr('gs_kick')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}

// ── Roles ─────────────────────────────────────────────────────────────────────
const PERMISSIONS = [
  { key: 'ADMINISTRATOR', labelKey: 'gs_perm_administrator', descKey: 'gs_perm_administrator_desc' },
  { key: 'MANAGE_CHANNELS', labelKey: 'gs_perm_manage_channels', descKey: 'gs_perm_manage_channels_desc' },
  { key: 'MANAGE_ROLES', labelKey: 'gs_perm_manage_roles', descKey: 'gs_perm_manage_roles_desc' },
  { key: 'KICK_MEMBERS', labelKey: 'gs_perm_kick_members', descKey: 'gs_perm_kick_members_desc' },
  { key: 'INVITE_MEMBERS', labelKey: 'gs_perm_create_invites', descKey: 'gs_perm_create_invites_desc' },
  { key: 'MANAGE_MESSAGES', labelKey: 'gs_perm_manage_messages', descKey: 'gs_perm_manage_messages_desc' },
  { key: 'SEND_MESSAGES', labelKey: 'gs_perm_send_messages', descKey: 'gs_perm_send_messages_desc' },
  { key: 'READ_MESSAGES', labelKey: 'gs_perm_read_messages', descKey: 'gs_perm_read_messages_desc' },
];

function RolesSection() {
  const { currentGuild, loadGuildRoles, createGuildRole, updateGuildRole, deleteGuildRole } = useApp();
  const tr = useTranslation();
  const [roles, setRoles] = useState<GuildRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<GuildRole | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', color: '#5865f2', permissions: [] as string[] });
  const isAdmin = currentGuild?.my_role === 'owner' || currentGuild?.my_role === 'admin';

  useEffect(() => {
    if (!currentGuild) return;
    loadGuildRoles(currentGuild.id).then(data => { setRoles(data); setLoading(false); });
  }, [currentGuild?.id]);

  const startCreate = () => { setForm({ name: '', color: '#5865f2', permissions: [] }); setCreating(true); setEditing(null); };
  const startEdit = (r: GuildRole) => { setForm({ name: r.name, color: r.color, permissions: r.permissions }); setEditing(r); setCreating(false); };

  const handleSave = async () => {
    if (!currentGuild || !form.name.trim()) return;
    if (editing) {
      const updated = await updateGuildRole(currentGuild.id, editing.id, form);
      if (updated) setRoles(prev => prev.map(r => r.id === editing.id ? updated : r));
    } else {
      const created = await createGuildRole(currentGuild.id, form);
      if (created) setRoles(prev => [...prev, created]);
    }
    setEditing(null); setCreating(false);
  };

  const handleDelete = async (roleId: string) => {
    if (!currentGuild) return;
    await deleteGuildRole(currentGuild.id, roleId);
    setRoles(prev => prev.filter(r => r.id !== roleId));
    if (editing?.id === roleId) setEditing(null);
  };

  const togglePerm = (key: string) => {
    setForm(prev => ({
      ...prev,
      permissions: prev.permissions.includes(key)
        ? prev.permissions.filter(p => p !== key)
        : [...prev.permissions, key],
    }));
  };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_roles')}</h2>
      <p style={sectionSubtitle}>{tr('gs_roles_desc')}</p>

      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: '0 0 200px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {isAdmin && (
            <button onClick={startCreate} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: 4 }}>
              <Plus size={14} /> {tr('gs_create_role')}
            </button>
          )}
          {loading ? <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{tr('gs_loading')}</p>
            : roles.map(r => (
              <div key={r.id} onClick={() => startEdit(r)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: editing?.id === r.id ? 'var(--bg-tertiary)' : 'transparent', border: editing?.id === r.id ? '1px solid var(--border-color)' : '1px solid transparent' }}>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: r.color, flexShrink: 0, display: 'inline-block' }} />
                <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              </div>
            ))}
          {roles.length === 0 && !loading && <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{tr('gs_no_roles')}</p>}
        </div>

        {(editing || creating) && (
          <div style={{ flex: 1, background: 'var(--bg-tertiary)', borderRadius: 10, border: '1px solid var(--border-color)', padding: 20 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{creating ? tr('gs_new_role') : `${tr('gs_edit_role')}: ${editing?.name}`}</h3>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>{tr('gs_role_name')}</label>
              <input style={inputStyle} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value.slice(0, 50) }))} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>{tr('gs_color')}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="color" value={form.color} onChange={e => setForm(p => ({ ...p, color: e.target.value }))} style={{ width: 40, height: 36, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                <input style={{ ...inputStyle, flex: 1 }} value={form.color} onChange={e => setForm(p => ({ ...p, color: e.target.value }))} maxLength={7} />
              </div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>{tr('gs_permissions')}</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {PERMISSIONS.map(p => (
                  <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.permissions.includes(p.key)} onChange={() => togglePerm(p.key)} style={{ width: 15, height: 15, accentColor: form.color }} />
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{tr(p.labelKey as any)}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 6 }}>{tr(p.descKey as any)}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { setEditing(null); setCreating(false); }} style={{ padding: '8px 16px', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>{tr('gs_cancel')}</button>
                <button disabled={!form.name.trim()} onClick={handleSave} style={saveBtn(!form.name.trim())}>{tr('gs_save')}</button>
              </div>
              {editing && isAdmin && (
                <button onClick={() => handleDelete(editing.id)} style={{ padding: '8px 16px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
                  <Trash2 size={13} style={{ display: 'inline', marginRight: 4 }} /> {tr('gs_delete_role')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Invites ───────────────────────────────────────────────────────────────────
function InvitesSection() {
  const { currentGuild, loadGuildInvites, createGuildInvite, revokeGuildInvite } = useApp();
  const tr = useTranslation();
  const [invites, setInvites] = useState<GuildInviteData[]>([]);
  const [loading, setLoading] = useState(true);
  const [maxUses, setMaxUses] = useState('');
  const [expiresHours, setExpiresHours] = useState('');
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  if (!currentGuild) return null;

  useEffect(() => {
    loadGuildInvites(currentGuild.id).then(data => { setInvites(data); setLoading(false); });
  }, [currentGuild.id]);

  const handleCreate = async () => {
    setCreating(true);
    const invite = await createGuildInvite(currentGuild.id, {
      max_uses: maxUses ? parseInt(maxUses) : undefined,
      expires_hours: expiresHours ? parseInt(expiresHours) : undefined,
    });
    if (invite) { setInvites(prev => [invite, ...prev]); setMaxUses(''); setExpiresHours(''); }
    setCreating(false);
  };

  const handleRevoke = async (id: string) => {
    await revokeGuildInvite(currentGuild.id, id);
    setInvites(prev => prev.filter(i => i.id !== id));
  };

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_invites')}</h2>
      <p style={sectionSubtitle}>{tr('gs_invites_desc')}</p>

      <div style={{ background: 'var(--bg-tertiary)', padding: 16, borderRadius: 10, border: '1px solid var(--border-color)', marginBottom: 24 }}>
        <span style={labelStyle}>{tr('gs_permanent_invite')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <code style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 6, fontSize: 14, color: 'var(--accent-primary)', border: '1px solid var(--border-color)', fontFamily: 'monospace' }}>{currentGuild.invite_code}</code>
          <button onClick={() => handleCopy(currentGuild.invite_code)} style={{ padding: '8px 12px', background: copied === currentGuild.invite_code ? '#3ba55c' : 'var(--bg-secondary)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, fontSize: 13 }}>
            {copied === currentGuild.invite_code ? <Check size={13} /> : <Copy size={13} />} {tr('gs_copy')}
          </button>
        </div>
      </div>

      <div style={{ background: 'var(--bg-tertiary)', padding: 16, borderRadius: 10, border: '1px solid var(--border-color)', marginBottom: 24 }}>
        <span style={labelStyle}>{tr('gs_create_custom_invite')}</span>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ flex: 1, minWidth: 120 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>{tr('gs_max_uses')}</label>
            <input style={inputStyle} type="number" min="1" placeholder="e.g. 10" value={maxUses} onChange={e => setMaxUses(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 120 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>{tr('gs_expires_after')}</label>
            <input style={inputStyle} type="number" min="1" placeholder="e.g. 24" value={expiresHours} onChange={e => setExpiresHours(e.target.value)} />
          </div>
        </div>
        <button disabled={creating} onClick={handleCreate} style={saveBtn(creating)}>
          <Plus size={13} style={{ display: 'inline', marginRight: 4 }} /> {creating ? tr('gs_creating') : tr('gs_create_invite')}
        </button>
      </div>

      {loading ? <p style={{ color: 'var(--text-secondary)' }}>{tr('gs_loading')}</p> : invites.length === 0
        ? <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{tr('gs_no_custom_invites')}</p>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {invites.map(inv => (
              <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
                <code style={{ fontSize: 14, color: 'var(--accent-primary)', fontFamily: 'monospace', fontWeight: 700 }}>{inv.code}</code>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{inv.uses}{inv.max_uses ? `/${inv.max_uses}` : ''} {tr('gs_uses')}</span>
                {inv.expires_at && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{tr('gs_expires')} {new Date(inv.expires_at).toLocaleString()}</span>}
                {inv.creator && <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{tr('gs_by')} {inv.creator.username}</span>}
                <button onClick={() => handleCopy(inv.code)} style={{ padding: '5px 10px', background: copied === inv.code ? '#3ba55c' : 'var(--bg-secondary)', color: copied === inv.code ? '#fff' : 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 6, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {copied === inv.code ? <Check size={11} /> : <Copy size={11} />} {tr('gs_copy')}
                </button>
                <button onClick={() => handleRevoke(inv.id)} style={{ padding: '5px 10px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>{tr('gs_revoke')}</button>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Blocked ──────────────────────────────────────────────────────────────────
function BlockedSection() {
  const { blockedContacts, unblockUser } = useApp();
  const tr = useTranslation();

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_blocked_users')}</h2>
      <p style={sectionSubtitle}>{tr('gs_blocked_users_desc')}</p>
      {blockedContacts.length === 0 ? (
        <p style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>{tr('gs_no_blocked')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {blockedContacts.map(u => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
              {u.avatar
                ? <img src={u.avatar} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                : <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#f97316', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: '#fff', fontWeight: 700, flexShrink: 0 }}>
                    {(u.nickname || u.username)[0]?.toUpperCase()}
                  </div>
              }
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{u.nickname || u.username}</div>
                {u.nickname && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>@{u.username}</div>}
              </div>
              <button
                onClick={() => unblockUser(u.id)}
                style={{ padding: '6px 14px', background: 'rgba(59,165,92,0.15)', color: '#3ba55c', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                {tr('gs_unblock')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Access ────────────────────────────────────────────────────────────────────
function AccessSection() {
  const { currentGuild, updateGuild } = useApp();
  const tr = useTranslation();
  const [vLevel, setVLevel] = useState(currentGuild?.verification_level ?? 'none');
  const [defNotif, setDefNotif] = useState(currentGuild?.default_notifications ?? 'all');
  const [explicitFilter, setExplicitFilter] = useState(currentGuild?.explicit_content_filter ?? 'disabled');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!currentGuild) return null;

  const handleSave = async () => {
    setSaving(true);
    await updateGuild(currentGuild.id, { verification_level: vLevel, default_notifications: defNotif, explicit_content_filter: explicitFilter });
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_access')}</h2>
      <p style={sectionSubtitle}>{tr('gs_access_desc')}</p>

      <div style={{ marginBottom: 20 }}>
        <label style={labelStyle}>{tr('gs_verification_level')}</label>
        <select style={selectStyle} value={vLevel} onChange={e => setVLevel(e.target.value)}>
          <option value="none">{tr('gs_verify_none')}</option>
          <option value="low">{tr('gs_verify_low')}</option>
          <option value="medium">{tr('gs_verify_medium')}</option>
          <option value="high">{tr('gs_verify_high')}</option>
        </select>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>{tr('gs_verification_hint')}</p>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={labelStyle}>{tr('gs_default_notifications')}</label>
        <select style={selectStyle} value={defNotif} onChange={e => setDefNotif(e.target.value)}>
          <option value="all">{tr('gs_notif_all')}</option>
          <option value="mentions">{tr('gs_notif_mentions')}</option>
        </select>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>{tr('gs_default_notif_hint')}</p>
      </div>

      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>{tr('gs_explicit_filter')}</label>
        <select style={selectStyle} value={explicitFilter} onChange={e => setExplicitFilter(e.target.value)}>
          <option value="disabled">{tr('gs_filter_disabled')}</option>
          <option value="no_role">{tr('gs_filter_no_role')}</option>
          <option value="all">{tr('gs_filter_all')}</option>
        </select>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>{tr('gs_explicit_filter_hint')}</p>
      </div>

      <button disabled={saving} onClick={handleSave} style={saveBtn(saving)}>
        {saved ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Check size={14} /> {tr('gs_saved')}</span> : saving ? tr('gs_saving') : tr('gs_save_changes')}
      </button>
    </div>
  );
}

// ── Integration ───────────────────────────────────────────────────────────────
function IntegrationSection() {
  const tr = useTranslation();
  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_integration')}</h2>
      <p style={sectionSubtitle}>{tr('gs_integration_desc')}</p>
      <div style={{ padding: 32, borderRadius: 12, background: 'var(--bg-tertiary)', border: '2px dashed var(--border-color)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <Zap size={36} style={{ color: 'var(--text-tertiary)' }} />
        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-secondary)' }}>{tr('gs_coming_soon')}</span>
        <span style={{ fontSize: 13, color: 'var(--text-tertiary)', textAlign: 'center', maxWidth: 320 }}>
          {tr('gs_integration_coming_soon')}
        </span>
      </div>
    </div>
  );
}

// ── Security ──────────────────────────────────────────────────────────────────
function SecuritySection() {
  const { currentGuild, updateGuild } = useApp();
  const tr = useTranslation();
  const [require2fa, setRequire2fa] = useState(currentGuild?.require_2fa ?? false);
  const [discoverable, setDiscoverable] = useState(currentGuild?.is_discoverable ?? true);
  const [tags, setTags] = useState<string[]>(currentGuild?.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!currentGuild) return null;
  const isOwner = currentGuild.my_role === 'owner';
  const isAdmin = isOwner || currentGuild.my_role === 'admin';

  const handleSave = async () => {
    setSaving(true);
    await updateGuild(currentGuild.id, { require_2fa: require2fa, is_discoverable: discoverable, tags: JSON.stringify(tags) });
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_security_settings')}</h2>
      <p style={sectionSubtitle}>{tr('gs_security_desc')}</p>

      <div style={{ padding: 16, background: 'var(--bg-tertiary)', borderRadius: 10, border: '1px solid var(--border-color)', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{tr('gs_require_2fa')}</p>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>{tr('gs_require_2fa_desc')}</p>
          </div>
          <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24, flexShrink: 0 }}>
            <input type="checkbox" checked={require2fa} onChange={e => isOwner && setRequire2fa(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} disabled={!isOwner} />
            <span style={{
              position: 'absolute', cursor: isOwner ? 'pointer' : 'not-allowed', inset: 0, borderRadius: 12,
              background: require2fa ? 'var(--accent-primary)' : 'var(--bg-secondary)',
              border: '1px solid var(--border-color)', transition: '0.2s',
            }}>
              <span style={{ position: 'absolute', content: '', height: 18, width: 18, left: require2fa ? 22 : 2, bottom: 2, background: '#fff', borderRadius: '50%', transition: '0.2s' }} />
            </span>
          </label>
        </div>
      </div>

      <div style={{ padding: 16, background: 'var(--bg-tertiary)', borderRadius: 10, border: '1px solid var(--border-color)', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{tr('gs_discoverable')}</p>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>{tr('gs_discoverable_desc')}</p>
          </div>
          <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24, flexShrink: 0 }}>
            <input type="checkbox" checked={discoverable} onChange={e => isAdmin && setDiscoverable(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} disabled={!isAdmin} />
            <span style={{
              position: 'absolute', cursor: isAdmin ? 'pointer' : 'not-allowed', inset: 0, borderRadius: 12,
              background: discoverable ? 'var(--accent-primary)' : 'var(--bg-secondary)',
              border: '1px solid var(--border-color)', transition: '0.2s',
            }}>
              <span style={{ position: 'absolute', content: '', height: 18, width: 18, left: discoverable ? 22 : 2, bottom: 2, background: '#fff', borderRadius: '50%', transition: '0.2s' }} />
            </span>
          </label>
        </div>
      </div>

      <div style={{ padding: 16, background: 'var(--bg-tertiary)', borderRadius: 10, border: '1px solid var(--border-color)', marginBottom: 24 }}>
        <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{tr('gs_tags')}</p>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-secondary)' }}>{tr('gs_tags_desc')}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: tags.length ? 10 : 0 }}>
          {tags.map((t, i) => (
            <span key={i} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 16, fontSize: 12, fontWeight: 500,
              background: 'var(--accent-primary)', color: '#fff',
            }}>
              {t}
              {isAdmin && (
                <span onClick={() => setTags(prev => prev.filter((_, j) => j !== i))} style={{ cursor: 'pointer', fontSize: 14, lineHeight: 1, opacity: 0.8 }}>&times;</span>
              )}
            </span>
          ))}
        </div>
        {isAdmin && tags.length < 10 && (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={tagInput}
              onChange={e => setTagInput(e.target.value.slice(0, 24))}
              onKeyDown={e => {
                if (e.key === 'Enter' && tagInput.trim() && !tags.includes(tagInput.trim())) {
                  setTags(prev => [...prev, tagInput.trim()]);
                  setTagInput('');
                }
              }}
              placeholder={tr('gs_tags_placeholder')}
              style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, outline: 'none' }}
            />
            <button
              onClick={() => {
                if (tagInput.trim() && !tags.includes(tagInput.trim())) {
                  setTags(prev => [...prev, tagInput.trim()]);
                  setTagInput('');
                }
              }}
              disabled={!tagInput.trim() || tags.includes(tagInput.trim())}
              style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--accent-primary)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: !tagInput.trim() ? 0.5 : 1 }}
            >
              +
            </button>
          </div>
        )}
      </div>

      {!isOwner && <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>{tr('gs_owner_only_security')}</p>}

      <button disabled={saving || !isAdmin} onClick={handleSave} style={saveBtn(saving || !isAdmin)}>
        {saved ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Check size={14} /> {tr('gs_saved')}</span> : saving ? tr('gs_saving') : tr('gs_save_changes')}
      </button>
    </div>
  );
}

// ── Logs ──────────────────────────────────────────────────────────────────────
const ACTION_LABEL_KEYS: Record<string, string> = {
  guild_update: 'gs_log_server_updated', member_kick: 'gs_log_member_kicked', member_role_set: 'gs_log_role_changed',
  member_role_assign: 'gs_log_role_assigned', member_role_remove: 'gs_log_role_removed',
  emoji_create: 'gs_log_emoji_added', emoji_delete: 'gs_log_emoji_deleted',
  sticker_create: 'gs_log_sticker_added', sticker_delete: 'gs_log_sticker_deleted',
  sound_create: 'gs_log_sound_added', sound_delete: 'gs_log_sound_deleted',
  role_create: 'gs_log_role_created', role_update: 'gs_log_role_updated', role_delete: 'gs_log_role_deleted',
  invite_create: 'gs_log_invite_created', invite_revoke: 'gs_log_invite_revoked',
  channel_create: 'gs_log_channel_created', channel_delete: 'gs_log_channel_deleted',
  category_create: 'gs_log_category_created', category_delete: 'gs_log_category_deleted',
  member_block: 'gs_log_member_blocked', member_unblock: 'gs_log_member_unblocked',
};

function LogsSection() {
  const { currentGuild, loadGuildAuditLog } = useApp();
  const tr = useTranslation();
  const [logs, setLogs] = useState<GuildAuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentGuild) return;
    loadGuildAuditLog(currentGuild.id).then(data => { setLogs(data); setLoading(false); });
  }, [currentGuild?.id]);

  const reload = () => {
    if (!currentGuild) return;
    setLoading(true);
    loadGuildAuditLog(currentGuild.id).then(data => { setLogs(data); setLoading(false); });
  };

  return (
    <div>
      <h2 style={sectionTitle}>{tr('gs_audit_log')}</h2>
      <p style={sectionSubtitle}>{tr('gs_audit_log_desc')}</p>
      <button onClick={reload} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, padding: '7px 14px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>
        <RefreshCw size={13} /> {tr('gs_refresh')}
      </button>
      {loading ? <p style={{ color: 'var(--text-secondary)' }}>{tr('gs_loading')}</p> : logs.length === 0
        ? <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{tr('gs_no_log_entries')}</p>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {logs.map(lg => (
              <div key={lg.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 14px', borderRadius: 8, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)' }}>
                <FileText size={14} style={{ color: 'var(--accent-primary)', flexShrink: 0, marginTop: 1 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: '0 0 2px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {ACTION_LABEL_KEYS[lg.action] ? tr(ACTION_LABEL_KEYS[lg.action] as any) : lg.action}
                    {lg.target && <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}> — {lg.target.username}</span>}
                  </p>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
                    {tr('gs_by')} <strong>{lg.actor.username}</strong>
                    {Object.keys(lg.details).length > 0 && <span style={{ color: 'var(--text-tertiary)', marginLeft: 6 }}>
                      {Object.entries(lg.details).map(([k, v]) => `${tr(('gs_detail_' + k) as any) || k}: ${v}`).join(', ')}
                    </span>}
                  </p>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0, whiteSpace: 'nowrap' }}>{new Date(lg.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Delete Server ─────────────────────────────────────────────────────────────
function DeleteSection({ onClose }: { onClose: () => void }) {
  const { currentGuild, deleteGuild } = useApp();
  const tr = useTranslation();
  const [input, setInput] = useState('');
  if (!currentGuild) return null;
  const isOwner = currentGuild.my_role === 'owner';

  return (
    <div>
      <h2 style={{ ...sectionTitle, color: '#ef4444' }}>{tr('gs_delete_server')}</h2>
      <p style={sectionSubtitle}>{tr('gs_delete_server_desc')}</p>

      {!isOwner ? (
        <div style={{ padding: 20, borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
          <p style={{ margin: 0, color: '#ef4444', fontSize: 14 }}>{tr('gs_owner_only_delete')}</p>
        </div>
      ) : (
        <div style={{ padding: 20, borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
          <AlertTriangle size={20} style={{ color: '#ef4444', marginBottom: 10 }} />
          <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 }}>
            {tr('gs_type_to_confirm')} <strong style={{ color: 'var(--text-primary)' }}>{currentGuild.name}</strong>:
          </p>
          <input style={{ ...inputStyle, marginBottom: 16 }} value={input} onChange={e => setInput(e.target.value)} placeholder={currentGuild.name} autoFocus />
          <button disabled={input !== currentGuild.name} onClick={() => { deleteGuild(currentGuild.id); onClose(); }}
            style={{ padding: '10px 24px', background: input === currentGuild.name ? '#ef4444' : 'var(--bg-tertiary)', color: input === currentGuild.name ? '#fff' : 'var(--text-tertiary)', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: input === currentGuild.name ? 'pointer' : 'not-allowed', transition: 'background 0.15s' }}>
            {tr('gs_delete_server')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Nav item ──────────────────────────────────────────────────────────────────
function NavItem({ icon, label, active, danger, onClick, disabled }: { icon: React.ReactNode; label: string; active: boolean; danger?: boolean; onClick: () => void; disabled?: boolean }) {
  const tr = useTranslation();
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px',
      background: active ? 'var(--bg-tertiary)' : 'transparent',
      color: disabled ? 'var(--text-tertiary)' : danger ? '#ef4444' : active ? 'var(--text-primary)' : 'var(--text-secondary)',
      border: 'none', borderRadius: 6, cursor: disabled ? 'default' : 'pointer', textAlign: 'left',
      fontSize: 13, fontWeight: active ? 600 : 400, transition: 'background 0.1s',
    }}>
      {icon} {label}
      {disabled && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 4 }}>{tr('gs_soon')}</span>}
    </button>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────
export function GuildSettingsModal({ onClose }: { onClose: () => void }) {
  const { currentGuild } = useApp();
  const tr = useTranslation();
  const [section, setSection] = useState<Section>('profile');
  const isMobile = useIsMobile();
  // On mobile we show the nav list OR the section content (not both side by side).
  const [showContent, setShowContent] = useState(false);
  const pickSection = (key: Section) => { setSection(key); if (isMobile) setShowContent(true); };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!currentGuild) return null;
  const isAdmin = currentGuild.my_role === 'owner' || currentGuild.my_role === 'admin';
  const isOwner = currentGuild.my_role === 'owner';

  const nav: Array<{ key: Section; icon: React.ReactNode; label: string; danger?: boolean; disabled?: boolean; ownerOnly?: boolean }> = [
    { key: 'profile', icon: <Settings size={14} />, label: tr('gs_server_profile') },
    { key: 'tag', icon: <Hash size={14} />, label: tr('gs_server_tag') },
    { key: 'boost', icon: <Zap size={14} />, label: tr('gs_boost_bonus') },
    { key: 'emoji', icon: <Smile size={14} />, label: tr('gs_emoji') },
    { key: 'stickers', icon: <Image size={14} />, label: tr('gs_stickers') },
    { key: 'sounds', icon: <Music size={14} />, label: tr('gs_sound_panel') },
    { key: 'members', icon: <Users size={14} />, label: tr('gs_members') },
    { key: 'roles', icon: <Shield size={14} />, label: tr('gs_roles') },
    { key: 'invites', icon: <Link size={14} />, label: tr('gs_invites') },
    { key: 'blocked', icon: <Ban size={14} />, label: tr('gs_blocked_users') },
    { key: 'access', icon: <Globe size={14} />, label: tr('gs_access') },
    { key: 'integration', icon: <Zap size={14} />, label: tr('gs_integration'), disabled: true },
    { key: 'security', icon: <Lock size={14} />, label: tr('gs_security_settings'), ownerOnly: true },
    { key: 'logs', icon: <FileText size={14} />, label: tr('gs_logs') },
    { key: 'delete', icon: <AlertTriangle size={14} />, label: tr('gs_delete_server'), danger: true, ownerOnly: true },
  ];

  const categories = [
    { label: tr('gs_cat_general'), items: ['profile', 'tag', 'boost'] },
    { label: tr('gs_cat_content'), items: ['emoji', 'stickers', 'sounds'] },
    { label: tr('gs_cat_community'), items: ['members', 'roles', 'invites', 'blocked', 'access', 'integration'] },
    { label: tr('gs_cat_safety'), items: ['security', 'logs'] },
    { label: tr('gs_cat_danger'), items: ['delete'] },
  ];

  const renderSection = () => {
    switch (section) {
      case 'profile': return <ServerProfileSection />;
      case 'tag': return <ServerTagSection />;
      case 'boost': return <BoostBonusSection />;
      case 'emoji': return <EmojiSection />;
      case 'stickers': return <StickersSection />;
      case 'sounds': return <SoundsSection />;
      case 'members': return <MembersSection />;
      case 'roles': return <RolesSection />;
      case 'invites': return <InvitesSection />;
      case 'blocked': return <BlockedSection />;
      case 'access': return <AccessSection />;
      case 'integration': return <IntegrationSection />;
      case 'security': return <SecuritySection />;
      case 'logs': return <LogsSection />;
      case 'delete': return <DeleteSection onClose={onClose} />;
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9500 }}
      onClick={e => { if (!isMobile && e.target === e.currentTarget) onClose(); }}>
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', width: isMobile ? '100%' : '92vw', maxWidth: isMobile ? 'none' : 880, height: isMobile ? '100%' : '88vh', background: 'var(--bg-primary)', borderRadius: isMobile ? 0 : 14, overflow: 'hidden', border: isMobile ? 'none' : '1px solid var(--border-color)' }}>

        {/* Sidebar — full width on mobile, hidden when a section is open */}
        {(!isMobile || !showContent) && (
        <aside style={{ width: isMobile ? '100%' : 220, flex: isMobile ? 1 : undefined, flexShrink: 0, minHeight: 0, background: 'var(--bg-secondary)', borderRight: isMobile ? 'none' : '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '16px 14px 8px', borderBottom: '1px solid var(--border-color)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{tr('gs_server_settings')}</p>
              <p style={{ margin: '2px 0 0', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentGuild.name}</p>
            </div>
            {isMobile && (
              <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4, flexShrink: 0 }}><X size={20} /></button>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 16px' }}>
            {categories.map(cat => {
              const catItems = nav.filter(n => cat.items.includes(n.key));
              const visible = catItems.filter(n => !n.ownerOnly || isOwner);
              if (visible.length === 0) return null;
              return (
                <div key={cat.label} style={{ marginBottom: 8 }}>
                  <p style={{ margin: '8px 10px 4px', fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{cat.label}</p>
                  {visible.map(item => (
                    <NavItem key={item.key} icon={item.icon} label={item.label} active={!isMobile && section === item.key}
                      danger={item.danger} disabled={item.disabled}
                      onClick={() => !item.disabled && pickSection(item.key)} />
                  ))}
                  <div style={{ height: 1, background: 'var(--border-color)', margin: '6px 0' }} />
                </div>
              );
            })}
          </div>
          {!isMobile && (
            <div style={{ padding: '10px 8px', borderTop: '1px solid var(--border-color)', flexShrink: 0 }}>
              <button onClick={onClose} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '7px 10px', background: 'transparent', color: 'var(--text-secondary)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                <X size={14} /> {tr('gs_close_settings')}
              </button>
            </div>
          )}
        </aside>
        )}

        {/* Content */}
        {(!isMobile || showContent) && (
        <main style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: isMobile ? '0 0 24px' : '28px 32px', display: 'flex', flexDirection: 'column' }}>
          {isMobile && (
            <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-color)' }}>
              <button onClick={() => setShowContent(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', padding: 4, display: 'flex', alignItems: 'center', gap: 4, fontSize: 14, fontWeight: 600 }}>
                <ChevronLeft size={20} /> {nav.find(n => n.key === section)?.label}
              </button>
            </div>
          )}
          <div style={{ flex: 1, padding: isMobile ? '16px 16px 0' : 0 }}>
            {renderSection()}
          </div>
        </main>
        )}
      </div>
    </div>
  );
}
