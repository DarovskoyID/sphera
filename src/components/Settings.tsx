import React, { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { Shield, ShieldCheck, Monitor, Smartphone, Tablet, Trash2, UserX, Camera, Upload, Play, Square, RotateCcw, Server, CheckCircle2, Circle, Clock, Mic, Video, Volume2, Download } from 'lucide-react';
import { ServerSelector } from './ServerSelector';
import { MessageText } from './EmojiPicker';
import { useApp, reportError } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { languages, type LangCode } from '../i18n';
import type { ServerUser } from '../types';
import { saveNotifPrefs, ensureNotificationPermission } from '../utils/notifications';
import { saveA11yPrefs } from '../utils/accessibility';
import { saveDisplayPrefs } from '../utils/displayPrefs';

// ==================== Mobile detection ====================

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

// ==================== Settings context (loads/saves all prefs) ====================

interface SettingsData {
  show_profile_to_everyone: boolean;
  display_online_status: boolean;
  show_activity_status: boolean;
  safe_dm_filter: boolean;
  scan_messages_everyone: boolean;
  scan_messages_non_friends: boolean;
  scan_messages_off: boolean;
  enable_all_notifications: boolean;
  notify_direct_messages: boolean;
  notify_mentions: boolean;
  notify_all_server_messages: boolean;
  notify_friend_requests: boolean;
  sound_message: boolean;
  sound_incoming_call: boolean;
  theme: string;
  show_timestamps: boolean;
  show_avatars: boolean;
  allow_scale: boolean;
  auto_input_sensitivity: boolean;
  echo_cancellation: boolean;
  noise_suppression: boolean;
  chat_show_timestamps: boolean;
  chat_emoji_reactions: boolean;
  chat_compact_mode: boolean;
  chat_message_spacing: number;
  data_app_improvements: boolean;
  data_personalization: boolean;
  streamer_mode: boolean;
  streamer_hide_info: boolean;
  streamer_disable_notifs: boolean;
  developer_mode: boolean;
  hardware_acceleration: boolean;
  show_current_activity: boolean;
  show_game_status: boolean;
  high_contrast: boolean;
  screen_reader: boolean;
  reduce_motion: boolean;
  large_text: boolean;
  keyboard_outlines: boolean;
  language: string;
}

const defaultSettings: SettingsData = {
  show_profile_to_everyone: true, display_online_status: true, show_activity_status: false,
  safe_dm_filter: true, scan_messages_everyone: true, scan_messages_non_friends: false, scan_messages_off: false,
  enable_all_notifications: true, notify_direct_messages: true, notify_mentions: true,
  notify_all_server_messages: false, notify_friend_requests: true, sound_message: true, sound_incoming_call: true,
  theme: 'dark', show_timestamps: true, show_avatars: true, allow_scale: false,
  auto_input_sensitivity: true, echo_cancellation: true, noise_suppression: true,
  chat_show_timestamps: true, chat_emoji_reactions: true, chat_compact_mode: false, chat_message_spacing: 4,
  data_app_improvements: true, data_personalization: true,
  streamer_mode: false, streamer_hide_info: false, streamer_disable_notifs: false,
  developer_mode: false, hardware_acceleration: false,
  show_current_activity: true, show_game_status: true,
  high_contrast: false, screen_reader: false, reduce_motion: false, large_text: false, keyboard_outlines: false,
  language: 'en',
};

interface SettingsCtx {
  s: SettingsData;
  toggle: (key: keyof SettingsData) => void;
  setField: (key: keyof SettingsData, val: any) => void;
}

const SettingsCtx = createContext<SettingsCtx>({ s: defaultSettings, toggle: () => {}, setField: () => {} });

const useSettings = () => useContext(SettingsCtx);

// ==================== Shared styles ====================

const card: React.CSSProperties = { background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border-color)', padding: 20, marginBottom: 16 };
const fieldLabel: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 };
const fieldInput: React.CSSProperties = { width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 14, outline: 'none' };
const btnPrimary: React.CSSProperties = { padding: '10px 24px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const btnSecondary: React.CSSProperties = { padding: '8px 16px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 13, cursor: 'pointer' };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: '#ef4444', borderColor: '#ef444444' };
const divider: React.CSSProperties = { height: 1, background: 'var(--border-color)', margin: '24px 0' };
const statusMsg = (type: 'ok' | 'err'): React.CSSProperties => ({ fontSize: 13, color: type === 'ok' ? '#22c55e' : '#ef4444', marginTop: 8 });
const sectionH3: React.CSSProperties = { margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: 0.5 };

// Checkbox component
const Check: React.FC<{ label: string; field: keyof SettingsData }> = ({ label, field }) => {
  const { s, toggle } = useSettings();
  return (
    <label className="ui-checkbox">
      <input type="checkbox" checked={!!s[field]} onChange={() => toggle(field)} />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">{label}</span>
    </label>
  );
};

// ==================== Main Settings ====================

export const Settings: React.FC = () => {
  const { currentSettingsPage, currentServerIP, authToken, language } = useApp();
  const [s, setS] = useState<SettingsData>(() => ({ ...defaultSettings, language }));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { setS(prev => prev.language === language ? prev : { ...prev, language }); }, [language]);

  // Load settings from API
  useEffect(() => {
    if (!authToken) return;
    (async () => {
      try {
        const res = await fetch(`${currentServerIP}/api/auth/settings/`, {
          headers: { 'Authorization': `Bearer ${authToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          setS(prev => ({ ...prev, ...data, language: prev.language }));
        }
      } catch { /* use defaults */ }
      setLoaded(true);
    })();
  }, [authToken, currentServerIP]);

  // Save to API on change (debounced)
  const saveTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveToApi = useCallback((newS: SettingsData) => {
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(async () => {
      try {
        await fetch(`${currentServerIP}/api/auth/settings/update/`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(newS),
        });
      } catch { /* ignore */ }
    }, 500);
  }, [currentServerIP, authToken]);

  const toggle = useCallback((key: keyof SettingsData) => {
    setS(prev => {
      const newS = { ...prev, [key]: !prev[key] };
      saveToApi(newS);
      return newS;
    });
  }, [saveToApi]);

  const setField = useCallback((key: keyof SettingsData, val: any) => {
    setS(prev => {
      const newS = { ...prev, [key]: val };
      saveToApi(newS);
      return newS;
    });
  }, [saveToApi]);

  // Apply chat_message_spacing as CSS variable whenever it changes
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-message-gap', `${s.chat_message_spacing}px`);
  }, [s.chat_message_spacing]);

  // Mirror notification prefs to localStorage so the WS handlers respect them live.
  useEffect(() => {
    saveNotifPrefs({
      enable_all_notifications: s.enable_all_notifications,
      notify_direct_messages: s.notify_direct_messages,
      notify_mentions: s.notify_mentions,
      notify_all_server_messages: s.notify_all_server_messages,
      notify_friend_requests: s.notify_friend_requests,
      sound_message: s.sound_message,
      sound_incoming_call: s.sound_incoming_call,
      streamer_disable_notifs: s.streamer_mode && s.streamer_disable_notifs,
    });
    if (s.enable_all_notifications) ensureNotificationPermission();
  }, [s.enable_all_notifications, s.notify_direct_messages, s.notify_mentions,
      s.notify_all_server_messages, s.notify_friend_requests, s.sound_message, s.sound_incoming_call,
      s.streamer_mode, s.streamer_disable_notifs]);

  // Apply chat display + streamer-mode preferences globally via root classes.
  useEffect(() => {
    saveDisplayPrefs({
      chat_show_timestamps: s.chat_show_timestamps,
      chat_emoji_reactions: s.chat_emoji_reactions,
      chat_compact_mode: s.chat_compact_mode,
      streamer_mode: s.streamer_mode,
      streamer_hide_info: s.streamer_hide_info,
    });
  }, [s.chat_show_timestamps, s.chat_emoji_reactions, s.chat_compact_mode, s.streamer_mode, s.streamer_hide_info]);

  // Mirror + apply accessibility prefs live.
  useEffect(() => {
    saveA11yPrefs({
      high_contrast: s.high_contrast,
      screen_reader: s.screen_reader,
      reduce_motion: s.reduce_motion,
      large_text: s.large_text,
      keyboard_outlines: s.keyboard_outlines,
    });
  }, [s.high_contrast, s.screen_reader, s.reduce_motion, s.large_text, s.keyboard_outlines]);

  if (!currentSettingsPage || !loaded) return null;

  return (
    <SettingsCtx.Provider value={{ s, toggle, setField }}>
      <div className="settings-container">
        <div className="settings-list">
          {currentSettingsPage === 'profile' && <ProfileSettings />}
          {currentSettingsPage === 'content' && <PrivacySettings />}
          {currentSettingsPage === 'data' && <DataSettings />}
          {currentSettingsPage === 'devices' && <DevicesSettings />}
          {currentSettingsPage === 'notifications' && <NotificationSettings />}
          {currentSettingsPage === 'view' && <AppearanceSettings />}
          {currentSettingsPage === 'voiceAndVideo' && <VoiceVideoSettings />}
          {currentSettingsPage === 'chat' && <ChatSettings />}
          {currentSettingsPage === 'formatting' && <FormattingSettings />}
          {currentSettingsPage === 'language' && <LanguageSettings />}
          {currentSettingsPage === 'streamer' && <StreamerSettings />}
          {currentSettingsPage === 'more' && <MoreSettings />}
          {currentSettingsPage === 'privacyOfActivity' && <PrivacyActivitySettings />}
          {currentSettingsPage === 'special' && <SpecialSettings />}
          {currentSettingsPage === 'binds' && <BindsSettings />}
          {currentSettingsPage === 'exportImport' && <ExportImportSettings />}
          {currentSettingsPage === 'servers' && <ServersSettings />}
          {currentSettingsPage === 'family' && <Placeholder title="Family Center" />}
          {currentSettingsPage === 'integration' && <Placeholder title="Integrations" />}
          {currentSettingsPage === 'apps' && <Placeholder title="Connected Apps" />}
          {currentSettingsPage === 'nitro' && <Placeholder title="Nitro" />}
          {currentSettingsPage === 'subscribes' && <Placeholder title="Subscriptions" />}
          {currentSettingsPage === 'gifts' && <Placeholder title="Gifts" />}
          {currentSettingsPage === 'payments' && <Placeholder title="Payments" />}
          {currentSettingsPage === 'games' && <Placeholder title="Registered Games" />}
        </div>
      </div>
    </SettingsCtx.Provider>
  );
};

// ==================== Profile Settings ====================

const VerificationCard: React.FC<{ user: ServerUser | null; isRu: boolean }> = ({ user, isRu }) => {
  const v = user?.verification;
  const level = v?.level ?? user?.verification_level ?? 0;

  const criteria = [
    {
      lvl: 1,
      done: v?.has_email ?? false,
      label: isRu ? 'Указана почта в профиле' : 'Email set in profile',
    },
    {
      lvl: 2,
      done: v?.has_phone ?? false,
      label: isRu ? 'Добавлен номер телефона' : 'Phone number added',
    },
    {
      lvl: 3,
      done: v?.clean_3_months ?? false,
      label: isRu
        ? 'Нет жалоб 3 месяца и регистрация более 3 месяцев назад'
        : 'No complaints for 3 months and registered over 3 months ago',
    },
    {
      lvl: 4,
      done: v?.clean_1_year ?? false,
      label: isRu
        ? 'Нет жалоб более года и регистрация более года назад'
        : 'No complaints for over a year and registered over a year ago',
    },
  ];

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <ShieldCheck size={18} style={{ color: level > 0 ? 'var(--accent-primary)' : 'var(--text-secondary)' }} />
        <h3 style={{ ...sectionH3, margin: 0 }}>{isRu ? 'Уровень доверия' : 'Trust level'}</h3>
        <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: 'var(--accent-primary)' }}>
          {(isRu ? 'Уровень ' : 'Level ') + level} / 4
        </span>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
        {isRu
          ? 'Уровень доверия повышается автоматически по мере выполнения условий.'
          : 'Your trust level increases automatically as you meet the criteria below.'}
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {[1, 2, 3, 4].map(n => (
          <div key={n} style={{ flex: 1, height: 6, borderRadius: 3, background: n <= level ? 'var(--accent-primary)' : 'var(--bg-tertiary)' }} />
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {criteria.map(c => (
          <div key={c.lvl} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {c.done
              ? <CheckCircle2 size={18} style={{ color: '#22c55e', flexShrink: 0 }} />
              : <Circle size={18} style={{ color: 'var(--text-secondary)', opacity: 0.5, flexShrink: 0 }} />}
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', minWidth: 56 }}>
              {(isRu ? 'Ур. ' : 'Lv. ') + c.lvl}
            </span>
            <span style={{ fontSize: 13, color: c.done ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{c.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const ProfileSettings: React.FC = () => {
  const tr = useTranslation();
  const isRu = tr('settings_formatting') === 'Подсказки';
  const { currentUser, currentServerIP, authToken, setCurrentUser } = useApp();
  const [nickname, setNickname] = useState(currentUser?.nickname || '');
  const [bio, setBio] = useState(currentUser?.bio || '');
  const [email, setEmail] = useState(currentUser?.email || '');
  const [phone, setPhone] = useState(currentUser?.phone || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwMsg, setPwMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  useEffect(() => {
    setNickname(currentUser?.nickname || '');
    setBio(currentUser?.bio || '');
    setEmail(currentUser?.email || '');
    setPhone(currentUser?.phone || '');
  }, [currentUser]);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) { setAvatarFile(file); setAvatarPreview(URL.createObjectURL(file)); }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setMsg(null);
    try {
      const fd = new FormData(); fd.append('nickname', nickname); fd.append('bio', bio);
      fd.append('email', email); fd.append('phone', phone);
      if (avatarFile) fd.append('avatar', avatarFile);
      const res = await fetch(`${currentServerIP}/api/auth/me/update/`, { method: 'PATCH', headers: { 'Authorization': `Bearer ${authToken}` }, body: fd });
      if (!res.ok) throw new Error('Failed');
      const updatedUser = await res.json();
      const avatarUrl = updatedUser.avatar ? `${currentServerIP}${updatedUser.avatar}` : (currentUser?.avatar || '');
      setCurrentUser({ ...updatedUser, avatar: avatarUrl });
      setMsg({ text: tr('sp_saved'), type: 'ok' }); setAvatarFile(null);
    } catch { setMsg({ text: tr('sp_save_fail'), type: 'err' }); }
    setSaving(false);
  };

  const handleChangePassword = async () => {
    setPwMsg(null);
    if (!oldPw || !newPw) { setPwMsg({ text: tr('sp_fill_both'), type: 'err' }); return; }
    try {
      const res = await fetch(`${currentServerIP}/api/auth/me/password/`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ old_password: oldPw, new_password: newPw }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setPwMsg({ text: tr('sp_password_changed'), type: 'ok' }); setOldPw(''); setNewPw('');
    } catch (e: any) { setPwMsg({ text: e.message, type: 'err' }); }
  };

  const avatarSrc = avatarPreview || currentUser?.avatar || '';

  return (
    <section>
      <h1>{tr('sp_title')}</h1>
      <p>{tr('sp_desc')}</p>

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ height: 88, background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border-color)' }} />
        <div style={{ padding: '0 20px 20px', marginTop: -40 }}>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            {avatarSrc ? (
              <img src={avatarSrc} alt="Avatar" style={{ width: 80, height: 80, borderRadius: '50%', border: '4px solid var(--bg-secondary)', objectFit: 'cover' }} />
            ) : (
              <div style={{ width: 80, height: 80, borderRadius: '50%', border: '4px solid var(--bg-secondary)', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 28, fontWeight: 700 }}>
                {(currentUser?.nickname || currentUser?.username || '?')[0].toUpperCase()}
              </div>
            )}
            <label style={{ position: 'absolute', bottom: 0, right: 0, width: 28, height: 28, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: '2px solid var(--bg-secondary)' }}>
              <Camera size={14} color="#fff" />
              <input type="file" accept="image/*" onChange={handleAvatarChange} style={{ display: 'none' }} />
            </label>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{currentUser?.nickname || currentUser?.username}</div>
            <div className="streamer-sensitive" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>@{currentUser?.username}</div>
          </div>
        </div>
      </div>

      <VerificationCard user={currentUser} isRu={isRu} />

      <form onSubmit={handleSave}>
        <div style={card}>
          <h3 style={sectionH3}>{tr('sp_profile_info')}</h3>
          <div style={{ marginBottom: 16 }}>
            <div style={fieldLabel}>{tr('sp_display_name')}</div>
            <input style={fieldInput} value={nickname} onChange={e => setNickname(e.target.value)} placeholder="Display name" />
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={fieldLabel}>{tr('sp_username')}</div>
            <input style={{ ...fieldInput, opacity: 0.6 }} value={currentUser?.username || ''} disabled />
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={fieldLabel}>{tr('sp_about')}</div>
            <textarea value={bio} onChange={e => setBio(e.target.value)} placeholder={tr('sp_about_placeholder')} rows={3} style={{ ...fieldInput, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          <div className="streamer-sensitive" style={{ marginBottom: 16 }}>
            <div style={fieldLabel}>{isRu ? 'Электронная почта' : 'Email'}</div>
            <input type="email" style={fieldInput} value={email} onChange={e => setEmail(e.target.value)} placeholder={isRu ? 'you@example.com' : 'you@example.com'} />
          </div>
          <div className="streamer-sensitive" style={{ marginBottom: 16 }}>
            <div style={fieldLabel}>{isRu ? 'Номер телефона' : 'Phone number'}</div>
            <input type="tel" style={fieldInput} value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1 555 123 4567" />
          </div>
          <button type="submit" style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} disabled={saving}>{saving ? tr('sp_saving') : tr('sp_save')}</button>
          {msg && <div style={statusMsg(msg.type)}>{msg.text}</div>}
        </div>
      </form>

      <div style={divider} />

      <div style={card}>
        <h3 style={sectionH3}><Shield size={16} style={{ verticalAlign: 'middle', marginRight: 8 }} />{tr('sp_change_password')}</h3>
        <div style={{ marginBottom: 12 }}>
          <div style={fieldLabel}>{tr('sp_current_password')}</div>
          <input type="password" style={fieldInput} value={oldPw} onChange={e => setOldPw(e.target.value)} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={fieldLabel}>{tr('sp_new_password')}</div>
          <input type="password" style={fieldInput} value={newPw} onChange={e => setNewPw(e.target.value)} />
        </div>
        <button type="button" style={btnPrimary} onClick={handleChangePassword}>{tr('sp_change_password')}</button>
        {pwMsg && <div style={statusMsg(pwMsg.type)}>{pwMsg.text}</div>}
      </div>

      <div style={divider} />

      <h3 style={sectionH3}>{tr('sp_profile_custom')}</h3>
      <Check label={tr('sp_show_profile')} field="show_profile_to_everyone" />
      <Check label={tr('sp_show_online')} field="display_online_status" />
      <Check label={tr('sp_show_activity')} field="show_activity_status" />

      <div style={divider} />

      <DeleteAccount />
    </section>
  );
};

// ==================== Delete Account ====================

const DeleteAccount: React.FC = () => {
  const tr = useTranslation();
  const { currentServerIP, authToken, setAuthToken } = useApp();
  const [show, setShow] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleDelete = async () => {
    if (!username || !password) { setError(tr('sp_fill_both')); return; }
    try {
      const res = await fetch(`${currentServerIP}/api/auth/me/delete/`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to delete'); return; }
      setShow(false);
      setAuthToken('');
    } catch { setError('Network error'); }
  };

  return (
    <>
      <div style={{ ...card, borderColor: '#ef444444' }}>
        <h3 style={{ ...sectionH3, color: '#ef4444' }}>
          <Trash2 size={16} style={{ verticalAlign: 'middle', marginRight: 8 }} />
          {tr('sd_title')}
        </h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
          {tr('sd_desc')}
        </p>
        <button type="button" onClick={() => setShow(true)} style={{ padding: '10px 24px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          {tr('sd_title')}
        </button>
      </div>

      {show && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 24, maxWidth: 400, width: '90%', border: '1px solid var(--border-color)' }}>
            <h3 style={{ margin: '0 0 8px', color: '#ef4444', fontSize: 18, fontWeight: 700 }}>{tr('sd_title')}</h3>
            <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 14 }}>
              {tr('sd_confirm')}
            </p>
            <div style={{ marginBottom: 12 }}>
              <div style={fieldLabel}>{tr('sd_username')}</div>
              <input type="text" value={username} onChange={e => { setUsername(e.target.value); setError(''); }} placeholder={tr('sd_username_placeholder')} style={{ ...fieldInput, boxSizing: 'border-box' as const }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={fieldLabel}>{tr('sd_password')}</div>
              <input type="password" value={password} onChange={e => { setPassword(e.target.value); setError(''); }} placeholder={tr('sd_password_placeholder')} style={{ ...fieldInput, boxSizing: 'border-box' as const }} />
            </div>
            {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShow(false); setUsername(''); setPassword(''); setError(''); }} style={{ ...btnSecondary }}>{tr('cancel')}</button>
              <button onClick={handleDelete} style={{ padding: '8px 20px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>{tr('sd_title')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// ==================== Privacy Settings ====================

interface BlockedEntry { id: number; blocked: ServerUser; created_at: string; }

const PrivacySettings: React.FC = () => {
  const tr = useTranslation();
  const { currentServerIP, authToken, searchUsers, unblockUser, blockedContacts } = useApp();
  const [blocked, setBlocked] = useState<BlockedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [blockQuery, setBlockQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ServerUser[]>([]);
  const [error, setError] = useState('');

  const loadBlocked = useCallback(async () => {
    try {
      const res = await fetch(`${currentServerIP}/api/auth/blocked/`, { headers: { 'Authorization': `Bearer ${authToken}` } });
      if (res.ok) setBlocked(await res.json());
    } catch (e) { reportError(e); }
    setLoading(false);
  }, [currentServerIP, authToken]);

  useEffect(() => { loadBlocked(); }, [loadBlocked]);

  const handleSearch = async () => {
    if (!blockQuery.trim()) return; setError('');
    try {
      const results = await searchUsers(blockQuery);
      const blockedIds = blockedContacts.map(u => String(u.id));
      setSearchResults(results.filter(u => !blockedIds.includes(String(u.id))));
      if (results.length === 0) setError('No users found');
    } catch (e) { reportError(e); }
  };

  const handleBlock = async (userId: string) => {
    try {
      const res = await fetch(`${currentServerIP}/api/auth/block/`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId }) });
      if (res.ok) { setSearchResults([]); setBlockQuery(''); await loadBlocked(); }
    } catch (e) { reportError(e); }
  };

  const handleUnblock = async (userId: string) => {
    try {
      await unblockUser(userId);
      setBlocked(prev => prev.filter(b => String(b.blocked.id) !== userId));
    } catch (e) { reportError(e); }
  };

  return (
    <section>
      <h1>{tr('sprv_title')}</h1>
      <p>{tr('sprv_desc')}</p>

      <h3 style={sectionH3}>{tr('sprv_safe_dm')}</h3>
      <p>{tr('sprv_safe_dm_desc')}</p>
      <Check label={tr('sprv_keep_safe')} field="safe_dm_filter" />

      <div style={divider} />

      <h3 style={sectionH3}>{tr('sprv_explicit')}</h3>
      <p>{tr('sprv_explicit_desc')}</p>
      <Check label={tr('sprv_scan_all')} field="scan_messages_everyone" />
      <Check label={tr('sprv_scan_non_friends')} field="scan_messages_non_friends" />
      <Check label={tr('sprv_scan_off')} field="scan_messages_off" />

      <div style={divider} />

      <h3 style={sectionH3}>{tr('sprv_blocked')} ({blockedContacts.length})</h3>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input style={{ ...fieldInput, flex: 1 }} placeholder={tr('sprv_search_block')} value={blockQuery} onChange={e => setBlockQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} />
        <button type="button" style={btnSecondary} onClick={handleSearch}>{tr('chat_search')}</button>
      </div>
      {error && <div style={{ ...statusMsg('err'), marginBottom: 12 }}>{error}</div>}

      {searchResults.map(u => (
        <div key={u.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, padding: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
            {(u.nickname || u.username)[0].toUpperCase()}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>{u.nickname || u.username}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>@{u.username}</div>
          </div>
          <button type="button" style={btnDanger} onClick={() => handleBlock(u.id)}><UserX size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />{tr('sprv_block')}</button>
        </div>
      ))}

      {loading ? <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{tr('loading')}</div> : blocked.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16, textAlign: 'center' }}>{tr('sprv_no_blocked')}</div>
      ) : blocked.map(entry => {
        const u = entry.blocked; const name = u.nickname || u.username;
        return (
          <div key={entry.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, padding: 12 }}>
            {u.avatar ? <img src={u.avatar} alt={name} style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} /> : (
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#ef444433', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444', fontWeight: 700, fontSize: 16, flexShrink: 0 }}>{name[0].toUpperCase()}</div>
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>{name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{tr('sprv_blocked_on')} {new Date(entry.created_at).toLocaleDateString()}</div>
            </div>
            <button type="button" style={btnSecondary} onClick={() => handleUnblock(String(u.id))}>{tr('sprv_unblock')}</button>
          </div>
        );
      })}
    </section>
  );
};

// ==================== Devices Settings ====================

interface DeviceEntry { id: number; device_name: string; device_type: string; ip_address: string; last_login: string; created_at: string; }

const DeviceIcon = ({ type }: { type: string }) => {
  if (type === 'mobile') return <Smartphone size={20} />;
  if (type === 'tablet') return <Tablet size={20} />;
  return <Monitor size={20} />;
};

const DevicesSettings: React.FC = () => {
  const tr = useTranslation();
  const { currentServerIP, authToken } = useApp();
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDevices = useCallback(async () => {
    try { const res = await fetch(`${currentServerIP}/api/auth/devices/`, { headers: { 'Authorization': `Bearer ${authToken}` } }); if (res.ok) setDevices(await res.json()); } catch (e) { reportError(e); }
    setLoading(false);
  }, [currentServerIP, authToken]);

  useEffect(() => { loadDevices(); }, [loadDevices]);

  const handleRemove = async (id: number) => {
    try { await fetch(`${currentServerIP}/api/auth/devices/${id}/remove/`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } }); setDevices(prev => prev.filter(d => d.id !== id)); } catch (e) { reportError(e); }
  };

  const parseBrowser = (ua: string) => { if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome'; if (ua.includes('Firefox')) return 'Firefox'; if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari'; if (ua.includes('Edg')) return 'Edge'; return 'Browser'; };
  const parseOS = (ua: string) => { if (ua.includes('Windows')) return 'Windows'; if (ua.includes('Mac OS')) return 'macOS'; if (ua.includes('Linux')) return 'Linux'; if (ua.includes('Android')) return 'Android'; if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS'; return 'Unknown OS'; };

  return (
    <section>
      <h1>{tr('sdev_title')}</h1>
      <p>{tr('sdev_desc')}</p>

      {loading ? <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 20 }}>{tr('sdev_loading')}</div> : devices.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 20, textAlign: 'center' }}>{tr('sdev_none')}</div>
      ) : devices.map((device, i) => {
        const browser = parseBrowser(device.device_name);
        const os = parseOS(device.device_name);
        const lastSeen = new Date(device.last_login);
        const isRecent = Date.now() - lastSeen.getTime() < 5 * 60 * 1000;
        return (
          <div key={device.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: i === 0 ? 'var(--accent-primary)' : 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: i === 0 ? '#fff' : 'var(--text-secondary)', flexShrink: 0 }}>
              <DeviceIcon type={device.device_type} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                {browser} on {os}
                {isRecent && <span style={{ fontSize: 11, background: '#22c55e22', color: '#22c55e', padding: '2px 8px', borderRadius: 99, fontWeight: 500 }}>{tr('sdev_active')}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{tr('sdev_ip')} {device.ip_address}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{tr('sdev_last_active')} {lastSeen.toLocaleString()}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', opacity: 0.7 }}>{tr('sdev_first_login')} {new Date(device.created_at).toLocaleString()}</div>
            </div>
            {i > 0 && <button type="button" style={{ ...btnDanger, display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px' }} onClick={() => handleRemove(device.id)}><Trash2 size={14} /></button>}
          </div>
        );
      })}
    </section>
  );
};

// ==================== Notifications ====================

const NotificationSettings: React.FC = () => {
  const tr = useTranslation();
  const isMobile = useIsMobile();
  const [hasCustomRingtone, setHasCustomRingtone] = useState(!!localStorage.getItem('customRingtone'));
  const [customRingtoneName, setCustomRingtoneName] = useState(localStorage.getItem('customRingtoneName') || '');
  const [isPlaying, setIsPlaying] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleRingtoneUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('audio/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      localStorage.setItem('customRingtone', dataUrl);
      localStorage.setItem('customRingtoneName', file.name);
      setHasCustomRingtone(true);
      setCustomRingtoneName(file.name);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const resetRingtone = () => {
    localStorage.removeItem('customRingtone');
    localStorage.removeItem('customRingtoneName');
    setHasCustomRingtone(false);
    setCustomRingtoneName('');
    stopPreview();
  };

  const togglePreview = () => {
    if (isPlaying) {
      stopPreview();
    } else {
      const src = localStorage.getItem('customRingtone') || '/rington.mp3';
      const audio = new Audio(src);
      audio.onended = () => setIsPlaying(false);
      audio.play().catch(() => {});
      previewAudioRef.current = audio;
      setIsPlaying(true);
    }
  };

  const stopPreview = () => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
      previewAudioRef.current = null;
    }
    setIsPlaying(false);
  };

  useEffect(() => () => stopPreview(), []);

  return (
  <section>
    <h1>{tr('sn_title')}</h1>
    <p>{tr('sn_desc')}</p>
    {!isMobile && (
      <>
        <h3 style={sectionH3}>{tr('sn_desktop')}</h3>
        <Check label={tr('sn_enable_all')} field="enable_all_notifications" />
        <div style={divider} />
      </>
    )}
    <h3 style={sectionH3}>{tr('sn_push')}</h3>
    <Check label={tr('sn_dm')} field="notify_direct_messages" />
    <Check label={tr('sn_mentions')} field="notify_mentions" />
    <Check label={tr('sn_all_server')} field="notify_all_server_messages" />
    <Check label={tr('sn_friend_req')} field="notify_friend_requests" />
    <div style={divider} />
    <h3 style={sectionH3}>{tr('sn_sounds')}</h3>
    <Check label={tr('sn_sound_msg')} field="sound_message" />
    <Check label={tr('sn_sound_call')} field="sound_incoming_call" />
    <div style={divider} />
    <h3 style={sectionH3}>{tr('sn_ringtone')}</h3>
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            {hasCustomRingtone ? tr('sn_ringtone_custom') : tr('sn_ringtone_default')}
          </div>
          {hasCustomRingtone && customRingtoneName && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{customRingtoneName}</div>
          )}
        </div>
        <button type="button" onClick={togglePreview} style={{ ...btnSecondary, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px' }}>
          {isPlaying ? <Square size={14} /> : <Play size={14} />}
          {tr('sn_ringtone_preview')}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => fileInputRef.current?.click()} style={{ ...btnPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Upload size={14} />
          {tr('sn_ringtone_upload')}
        </button>
        {hasCustomRingtone && (
          <button type="button" onClick={resetRingtone} style={{ ...btnSecondary, display: 'flex', alignItems: 'center', gap: 6 }}>
            <RotateCcw size={14} />
            {tr('sn_ringtone_reset')}
          </button>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleRingtoneUpload} style={{ display: 'none' }} />
    </div>
  </section>
  );
};

// ==================== Appearance ====================

const ACCENT_PRESETS = [
  '#0070F3', '#6366f1', '#8b5cf6', '#ec4899',
  '#10b981', '#f59e0b', '#ef4444', '#06b6d4',
];

const AppearanceSettings: React.FC = () => {
  const tr = useTranslation();
  const { s, setField } = useSettings();
  const { setAccentColor, theme, toggleTheme } = useApp();
  const [accent, setAccent] = useState(localStorage.getItem('accentColor') || '#0070F3');
  const isMobile = useIsMobile();
  const isRu = tr('settings_formatting') === 'Подсказки';

  const pick = (c: string) => { setAccent(c); setAccentColor(c); };

  return (
    <section>
      <h1>{tr('sa_title')}</h1>
      <p>{tr('sa_desc')}</p>
      <h3 style={sectionH3}>{tr('sa_theme')}</h3>
      <label style={fieldLabel}>{tr('sa_app_theme')}
        <select
          value={theme}
          onChange={e => {
            setField('theme', e.target.value);
            if (e.target.value !== theme) toggleTheme();
          }}
          style={{ ...fieldInput, marginTop: 6 }}
        >
          <option value="dark">{tr('sa_dark')}</option>
          <option value="light">{tr('sa_light')}</option>
        </select>
      </label>
      <div style={divider} />
      <h3 style={sectionH3}>Accent colour</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        {ACCENT_PRESETS.map(c => (
          <button key={c} onClick={() => pick(c)} style={{
            width: 28, height: 28, borderRadius: '50%', background: c, padding: 0,
            border: accent === c ? '3px solid var(--text-primary)' : '2px solid transparent',
            cursor: 'pointer',
          }} />
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input type="color" value={accent}
          onChange={e => pick(e.target.value)}
          style={{ width: 36, height: 36, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 0, background: 'none' }}
        />
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Custom colour</span>
      </div>
      <div style={divider} />
      <h3 style={sectionH3}>{tr('sa_msg_display')}</h3>
      <Check label={tr('sa_timestamps')} field="show_timestamps" />
      <Check label={tr('sa_avatars')} field="show_avatars" />
      {isMobile && (
        <>
          <div style={divider} />
          <h3 style={sectionH3}>{isRu ? 'Мобильное' : 'Mobile'}</h3>
          <Check label={isRu ? 'Разрешить масштабирование' : 'Allow zoom & scaling'} field="allow_scale" />
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            {isRu
              ? 'Позволяет масштабировать интерфейс в мобильном приложении. Масштабирование выполняется самим приложением (WebView).'
              : 'Lets you pinch-to-zoom and scale the interface in the mobile app. Scaling is handled by the app shell (WebView).'}
          </p>
        </>
      )}
    </section>
  );
};

// ==================== Voice & Video ====================

const VoiceVideoSettings: React.FC = () => {
  const tr = useTranslation();
  const isRu = tr('settings_formatting') === 'Подсказки';
  const isMobile = useIsMobile();

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState(localStorage.getItem('voiceMicId') || '');
  const [spkId, setSpkId] = useState(localStorage.getItem('voiceSpeakerId') || '');
  const [camId, setCamId] = useState(localStorage.getItem('voiceCameraId') || '');

  // Mic test
  const [micTesting, setMicTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  // Camera test
  const [camTesting, setCamTesting] = useState(false);
  const camStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [spkTesting, setSpkTesting] = useState(false);
  const spkAudioRef = useRef<HTMLAudioElement | null>(null);

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (isMobile) return;
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [isMobile, refreshDevices]);

  const stopMicTest = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;
    setMicLevel(0); setMicTesting(false);
  }, []);

  const stopCamTest = useCallback(() => {
    camStreamRef.current?.getTracks().forEach(t => t.stop());
    camStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamTesting(false);
  }, []);

  const stopSpkTest = useCallback(() => {
    if (spkAudioRef.current) { spkAudioRef.current.pause(); spkAudioRef.current.currentTime = 0; spkAudioRef.current = null; }
    setSpkTesting(false);
  }, []);

  useEffect(() => () => { stopMicTest(); stopCamTest(); stopSpkTest(); }, [stopMicTest, stopCamTest, stopSpkTest]);

  const startMicTest = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micId ? { deviceId: { exact: micId } } : true,
      });
      micStreamRef.current = stream;
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
        setMicLevel(Math.min(100, Math.round((peak / 128) * 140)));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      setMicTesting(true);
      refreshDevices(); // labels become available after permission
    } catch { /* permission denied */ }
  }, [micId, refreshDevices]);

  const startCamTest = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: camId ? { deviceId: { exact: camId } } : true,
      });
      camStreamRef.current = stream;
      setCamTesting(true);
      // assign after render so the <video> exists
      setTimeout(() => { if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); } }, 0);
      refreshDevices();
    } catch { /* permission denied */ }
  }, [camId, refreshDevices]);

  const startSpkTest = useCallback(async () => {
    try {
      const audio = new Audio('/rington.mp3');
      audio.volume = 0.6;
      if (spkId && (audio as any).setSinkId) {
        try { await (audio as any).setSinkId(spkId); } catch { /* unsupported */ }
      }
      audio.onended = () => setSpkTesting(false);
      spkAudioRef.current = audio;
      await audio.play();
      setSpkTesting(true);
    } catch { /* ignore */ }
  }, [spkId]);

  const mics = devices.filter(d => d.kind === 'audioinput');
  const spks = devices.filter(d => d.kind === 'audiooutput');
  const cams = devices.filter(d => d.kind === 'videoinput');
  const sinkSupported = typeof (HTMLAudioElement as any) !== 'undefined' && 'setSinkId' in HTMLAudioElement.prototype;

  const defaultLabel = isRu ? 'По умолчанию' : 'Default';

  const renderSelect = (
    icon: React.ReactNode, label: string, value: string,
    onChange: (v: string) => void, list: MediaDeviceInfo[], lsKey: string,
  ) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ ...fieldLabel, display: 'flex', alignItems: 'center', gap: 6 }}>{icon}{label}</div>
      <select
        style={{ ...fieldInput, marginTop: 0, opacity: isMobile ? 0.6 : 1, cursor: isMobile ? 'not-allowed' : 'pointer' }}
        value={isMobile ? '__default__' : value}
        disabled={isMobile}
        onChange={e => { onChange(e.target.value); localStorage.setItem(lsKey, e.target.value); }}
      >
        {isMobile ? (
          <option value="__default__">{defaultLabel}</option>
        ) : (
          <>
            <option value="">{defaultLabel}</option>
            {list.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `${label} ${i + 1}`}
              </option>
            ))}
          </>
        )}
      </select>
    </div>
  );

  return (
  <section>
    <h1>{tr('sv_title')}</h1>
    <p>{tr('sv_desc')}</p>

    {isMobile && (
      <div style={{ ...card, fontSize: 13, color: 'var(--text-secondary)' }}>
        {isRu
          ? 'В мобильной версии используется устройство по умолчанию — выбор задаётся системой телефона.'
          : 'On mobile the default device is used — selection is managed by your phone’s system.'}
      </div>
    )}

    {/* Microphone */}
    <div style={card}>
      <h3 style={sectionH3}>{isRu ? 'Микрофон' : 'Microphone'}</h3>
      {renderSelect(<Mic size={13} />, isRu ? 'Устройство ввода' : 'Input device', micId, setMicId, mics, 'voiceMicId')}
      {!isMobile && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" style={btnSecondary} onClick={micTesting ? stopMicTest : startMicTest}>
              {micTesting ? (isRu ? 'Остановить' : 'Stop') : (isRu ? 'Проверить микрофон' : 'Test microphone')}
            </button>
            <div style={{ flex: 1, height: 10, background: 'var(--bg-tertiary)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ width: `${micLevel}%`, height: '100%', background: micLevel > 70 ? '#ef4444' : 'var(--accent-primary)', transition: 'width 0.06s linear' }} />
            </div>
          </div>
          {micTesting && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>{isRu ? 'Говорите — полоса должна двигаться.' : 'Speak — the bar should move.'}</div>}
        </>
      )}
    </div>

    {/* Speaker */}
    <div style={card}>
      <h3 style={sectionH3}>{isRu ? 'Динамики' : 'Speakers'}</h3>
      {renderSelect(<Volume2 size={13} />, isRu ? 'Устройство вывода' : 'Output device', spkId, setSpkId, spks, 'voiceSpeakerId')}
      {!isMobile && (
        <>
          <button type="button" style={btnSecondary} onClick={spkTesting ? stopSpkTest : startSpkTest}>
            <Play size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            {spkTesting ? (isRu ? 'Остановить' : 'Stop') : (isRu ? 'Проверить динамик' : 'Test speaker')}
          </button>
          {!sinkSupported && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
              {isRu ? 'Выбор устройства вывода не поддерживается этим браузером — звук пойдёт на системное устройство.' : 'Output device selection isn’t supported by this browser — audio uses the system default.'}
            </div>
          )}
        </>
      )}
    </div>

    {/* Camera */}
    <div style={card}>
      <h3 style={sectionH3}>{isRu ? 'Камера' : 'Camera'}</h3>
      {renderSelect(<Video size={13} />, isRu ? 'Видеоустройство' : 'Video device', camId, setCamId, cams, 'voiceCameraId')}
      {!isMobile && (
        <>
          <button type="button" style={btnSecondary} onClick={camTesting ? stopCamTest : startCamTest}>
            {camTesting ? (isRu ? 'Остановить' : 'Stop') : (isRu ? 'Проверить камеру' : 'Test camera')}
          </button>
          {camTesting && (
            <div style={{ marginTop: 12 }}>
              <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', maxWidth: 360, borderRadius: 10, background: '#000', aspectRatio: '16 / 9', objectFit: 'cover' }} />
            </div>
          )}
        </>
      )}
    </div>

    <h3 style={sectionH3}>{tr('sv_processing')}</h3>
    <Check label={tr('sv_auto_sensitivity')} field="auto_input_sensitivity" />
    <Check label={tr('sv_echo')} field="echo_cancellation" />
    <Check label={tr('sv_noise')} field="noise_suppression" />
  </section>
  );
};

// ==================== Chat ====================

const ChatSettings: React.FC = () => {
  const tr = useTranslation();
  const { s, setField } = useSettings();
  const [spacingRaw, setSpacingRaw] = useState(String(s.chat_message_spacing));
  const [spacingErr, setSpacingErr] = useState('');

  const handleSpacingChange = (val: string) => {
    setSpacingRaw(val);
    const n = parseInt(val, 10);
    if (val.trim() === '' || isNaN(n)) {
      setSpacingErr('Enter a number between 0 and 50');
      return;
    }
    if (n < 0 || n > 50) {
      setSpacingErr('Value must be between 0 and 50');
      return;
    }
    setSpacingErr('');
    setField('chat_message_spacing', n);
  };

  return (
  <section>
    <h1>{tr('sc_title')}</h1>
    <Check label={tr('sc_timestamps')} field="chat_show_timestamps" />
    <Check label={tr('sc_emoji')} field="chat_emoji_reactions" />
    <Check label={tr('sc_compact')} field="chat_compact_mode" />
    <div style={{ ...card, marginTop: 16 }}>
      <h3 style={sectionH3}>{tr('sc_message_spacing')}</h3>
      <div style={fieldLabel as React.CSSProperties}>{tr('sc_gap_between')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <input
          type="number"
          min={0}
          max={50}
          step={1}
          value={spacingRaw}
          onChange={e => handleSpacingChange(e.target.value)}
          style={{ ...fieldInput, width: 100 }}
        />
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          px (0 – 50)
        </span>
      </div>
      {spacingErr && <div style={statusMsg('err')}>{spacingErr}</div>}
    </div>
  </section>
  );
};

// ==================== Formatting hints (read-only reference) ====================

const FormattingSettings: React.FC = () => {
  const tr = useTranslation();
  const { customEmojis } = useApp();
  const isRu = tr('settings_formatting') === 'Подсказки';

  const rows: { syntax: string; example: string }[] = [
    { syntax: '**текст**', example: '**Глава 1**' },
    { syntax: '*текст*', example: '*курсив*' },
    { syntax: '__текст__', example: '__подчёркнутый__' },
    { syntax: '~~текст~~', example: '~~зачёркнутый~~' },
    { syntax: '`код`', example: '`const x = 1`' },
    { syntax: '```\\nблок кода\\n```', example: '```\nfunction hi() {\n  return 42;\n}\n```' },
    { syntax: '# Заголовок', example: '# Большой текст' },
    { syntax: '> цитата', example: '> Это цитата' },
    { syntax: '- пункт', example: '- Первый\n- Второй\n- Третий' },
    { syntax: '||спойлер||', example: '||скрытый текст||' },
  ];
  const labels: Record<string, string> = {
    '**текст**': isRu ? 'Жирный' : 'Bold',
    '*текст*': isRu ? 'Курсив' : 'Italic',
    '__текст__': isRu ? 'Подчёркнутый' : 'Underline',
    '~~текст~~': isRu ? 'Зачёркнутый' : 'Strikethrough',
    '`код`': isRu ? 'Код в строке' : 'Inline code',
    '```\\nблок кода\\n```': isRu ? 'Блок кода (с кнопкой «Копировать»)' : 'Code block (with copy button)',
    '# Заголовок': isRu ? 'Крупный текст' : 'Large text',
    '> цитата': isRu ? 'Цитата' : 'Quote',
    '- пункт': isRu ? 'Маркированный список' : 'Bulleted list',
    '||спойлер||': isRu ? 'Скрытый текст (спойлер)' : 'Spoiler',
  };

  return (
    <section>
      <h1>{isRu ? 'Подсказки по оформлению' : 'Formatting'}</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: -4 }}>
        {isRu
          ? 'Используйте специальные символы, чтобы оформить текст в личных сообщениях, серверах и постах. Эти правила нельзя изменить — это просто справка.'
          : 'Use these special characters to format your text in DMs, servers and posts. These rules are fixed — this is just a reference.'}
      </p>
      <div style={{ ...card, marginTop: 16, padding: 0, overflow: 'hidden' }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, padding: '12px 16px', borderTop: i ? '1px solid var(--border-color)' : 'none', alignItems: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{labels[r.syntax]}</div>
            <code style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-secondary)', background: 'var(--bg-tertiary, rgba(0,0,0,0.25))', padding: '4px 8px', borderRadius: 6, whiteSpace: 'pre-wrap' }}>
              {r.syntax.replace(/\\n/g, '\n')}
            </code>
            <div style={{ fontSize: 14, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              <MessageText text={r.example} customEmojis={customEmojis} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

// ==================== Language ====================

const LanguageSettings: React.FC = () => {
  const tr = useTranslation();
  const { s, setField } = useSettings();
  const { setLanguage } = useApp();
  return (
    <section>
      <h1>{tr('sl_title')}</h1>
      <p>{tr('sl_desc')}</p>
      <label style={fieldLabel}>{tr('sl_select')}
        <select value={s.language} onChange={e => { setField('language', e.target.value); setLanguage(e.target.value); }} style={{ ...fieldInput, marginTop: 6 }}>
          {(Object.entries(languages) as [LangCode, string][]).map(([code, name]) => (
            <option key={code} value={code}>{name}</option>
          ))}
        </select>
      </label>
    </section>
  );
};

// ==================== Data & Privacy ====================

interface DataExportState {
  id: string;
  status: 'pending' | 'ready' | 'failed';
  item_count?: number;
  download_url?: string;
  error?: string;
}

const DataSettings: React.FC = () => {
  const tr = useTranslation();
  const isRu = tr('settings_formatting') === 'Подсказки';
  const { currentServerIP, authToken } = useApp();
  const [exp, setExp] = useState<DataExportState | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const poll = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${currentServerIP}/api/auth/data-export/${id}/`, {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      if (!res.ok) return;
      const data: DataExportState = await res.json();
      setExp(data);
      if (data.status !== 'pending') stopPolling();
    } catch { /* keep polling */ }
  }, [currentServerIP, authToken, stopPolling]);

  const startExport = async () => {
    setErr(''); setRequesting(true); stopPolling();
    try {
      const res = await fetch(`${currentServerIP}/api/auth/data-export/`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error('Failed');
      const data: DataExportState = await res.json();
      setExp(data);
      if (data.status === 'pending') {
        pollRef.current = setInterval(() => poll(data.id), 4000);
      }
    } catch {
      setErr(isRu ? 'Не удалось запустить экспорт' : 'Could not start export');
    }
    setRequesting(false);
  };

  const downloadFile = async () => {
    if (!exp?.download_url) return;
    setDownloading(true);
    try {
      const res = await fetch(exp.download_url, {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error('Failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ionik-data-export.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setErr(isRu ? 'Не удалось скачать файл' : 'Could not download file');
    }
    setDownloading(false);
  };

  const isBuilding = requesting || exp?.status === 'pending';

  return (
  <section>
    <h1>{tr('sdata_title')}</h1>
    <Check label={tr('sdata_improvements')} field="data_app_improvements" />
    <Check label={tr('sdata_personal')} field="data_personalization" />
    <div style={divider} />

    <h3 style={sectionH3}>{isRu ? 'Скачать мои данные' : 'Download my data'}</h3>
    <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
      {isRu
        ? 'Соберём всё, что вы написали на платформе — личные сообщения, посты и сообщения на серверах, комментарии — в один JSON-файл. Сбор может занять несколько минут.'
        : 'We will collect everything you have written on the platform — direct messages, server posts and messages, and comments — into a single JSON file. This may take a few minutes.'}
    </p>

    <button type="button" style={{ ...btnSecondary, opacity: isBuilding || requesting ? 0.6 : 1 }} onClick={startExport} disabled={isBuilding || requesting}>
      {isBuilding
        ? (isRu ? 'Собираем данные…' : 'Collecting data…')
        : (isRu ? 'Выгрузить мои данные' : 'Export my data')}
    </button>

    {err && <div style={statusMsg('err')}>{err}</div>}

    {isBuilding && (
      <div style={{ ...card, marginTop: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          {isRu
            ? 'Готовим ваш архив. Можно закрыть эту страницу и вернуться позже — кнопка скачивания появится здесь, когда всё будет готово.'
            : 'Preparing your archive. You can leave this page and come back later — the download will appear here once it is ready.'}
        </div>
        <div className="data-export-skeleton-line" style={{ width: '90%' }} />
        <div className="data-export-skeleton-line" style={{ width: '75%' }} />
        <div className="data-export-skeleton-line" style={{ width: '82%' }} />
        <div className="data-export-skeleton-line" style={{ width: '60%', marginBottom: 0 }} />
      </div>
    )}

    {exp?.status === 'ready' && (
      <div style={{ ...card, marginTop: 16, borderColor: '#22c55e44' }}>
        <h3 style={{ ...sectionH3, color: '#22c55e' }}>{isRu ? 'Архив готов' : 'Your archive is ready'}</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px' }}>
          {isRu
            ? `Собрано записей: ${exp.item_count ?? 0}. Файл в формате JSON.`
            : `Collected ${exp.item_count ?? 0} entries. The file is in JSON format.`}
        </p>
        <button type="button" style={{ ...btnPrimary, opacity: downloading ? 0.6 : 1 }} onClick={downloadFile} disabled={downloading}>
          {downloading
            ? (isRu ? 'Скачивание…' : 'Downloading…')
            : (isRu ? 'Скачать JSON' : 'Download JSON')}
        </button>
      </div>
    )}

    {exp?.status === 'failed' && (
      <div style={statusMsg('err')}>
        {isRu ? 'Не удалось собрать данные. Попробуйте ещё раз.' : 'Failed to collect data. Please try again.'}
      </div>
    )}
  </section>
  );
};

// ==================== Streamer ====================

const StreamerSettings: React.FC = () => {
  const tr = useTranslation();
  const { s } = useSettings();
  const isRu = tr('settings_formatting') === 'Подсказки';
  const help: React.CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 14px 30px' };
  return (
  <section>
    <h1>{tr('sstr_title')}</h1>
    <Check label={tr('sstr_enable')} field="streamer_mode" />
    <p style={help}>{isRu ? 'Скрывает чувствительные данные и приглушает уведомления, пока вы в эфире.' : 'Hides sensitive data and quiets notifications while you are live.'}</p>
    <div style={divider} />
    <h3 style={sectionH3}>{tr('sstr_privacy')}</h3>
    <Check label={tr('sstr_hide')} field="streamer_hide_info" />
    <p style={help}>{isRu ? 'Размывает email, телефон и тег пользователя — наведите курсор, чтобы посмотреть.' : 'Blurs your email, phone and user tag — hover to reveal.'}</p>
    <Check label={tr('sstr_disable_notifs')} field="streamer_disable_notifs" />
    <p style={help}>{isRu ? 'Отключает всплывающие уведомления и звуки сообщений.' : 'Suppresses notification pop-ups and message sounds.'}</p>
    {!s.streamer_mode && (
      <div style={{ ...card, marginTop: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
        {isRu ? 'Параметры приватности применяются только при включённом режиме стримера.' : 'Privacy options apply only while streamer mode is on.'}
      </div>
    )}
  </section>
  );
};

// ==================== Advanced ====================

const MoreSettings: React.FC = () => {
  const tr = useTranslation();
  return (
  <section>
    <h1>{tr('sadv_title')}</h1>
    <Check label={tr('sadv_dev')} field="developer_mode" />
    <Check label={tr('sadv_hw')} field="hardware_acceleration" />
  </section>
  );
};

// ==================== Activity Privacy ====================

const PrivacyActivitySettings: React.FC = () => {
  const tr = useTranslation();
  const isRu = tr('settings_formatting') === 'Подсказки';
  return (
  <section>
    <h1>{tr('sact_title')}</h1>
    <div style={{ ...card, marginTop: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '40px 24px', gap: 12 }}>
      <Clock size={40} style={{ color: 'var(--text-secondary)', opacity: 0.6 }} />
      <h3 style={{ ...sectionH3, margin: 0 }}>{isRu ? 'Скоро' : 'Coming soon'}</h3>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: 0, maxWidth: 360 }}>
        {isRu
          ? 'Управление приватностью активности появится в одном из следующих обновлений.'
          : 'Activity privacy controls are on the way in an upcoming update.'}
      </p>
    </div>
  </section>
  );
};

// ==================== Accessibility ====================

const SpecialSettings: React.FC = () => {
  const tr = useTranslation();
  const isRu = tr('settings_formatting') === 'Подсказки';
  const help: React.CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 14px 30px' };
  return (
  <section>
    <h1>{tr('sacc_title')}</h1>
    <p>{tr('sacc_desc')}</p>

    <h3 style={sectionH3}>{isRu ? 'Зрение' : 'Vision'}</h3>
    <Check label={tr('sacc_contrast')} field="high_contrast" />
    <p style={help}>{isRu ? 'Усиливает контраст текста и границ для слабовидящих.' : 'Boosts text and border contrast for low vision.'}</p>
    <Check label={isRu ? 'Крупный текст' : 'Larger text'} field="large_text" />
    <p style={help}>{isRu ? 'Увеличивает размер шрифта во всём приложении.' : 'Increases the font size across the whole app.'}</p>

    <div style={divider} />

    <h3 style={sectionH3}>{isRu ? 'Движение и навигация' : 'Motion & navigation'}</h3>
    <Check label={isRu ? 'Уменьшить анимацию' : 'Reduce motion'} field="reduce_motion" />
    <p style={help}>{isRu ? 'Отключает анимации и плавную прокрутку (помогает при вестибулярных нарушениях).' : 'Disables animations and smooth scrolling (helps with vestibular disorders).'}</p>
    <Check label={isRu ? 'Видимая обводка фокуса' : 'Visible focus outlines'} field="keyboard_outlines" />
    <p style={help}>{isRu ? 'Подсвечивает активный элемент — удобно при навигации с клавиатуры и на сенсорных экранах.' : 'Highlights the focused element — useful for keyboard and touch navigation.'}</p>

    <div style={divider} />

    <h3 style={sectionH3}>{isRu ? 'Экранный диктор' : 'Screen reader'}</h3>
    <Check label={tr('sacc_reader')} field="screen_reader" />
    <p style={help}>{isRu ? 'Озвучивает новые сообщения и упоминания через программу экранного доступа.' : 'Announces new messages and mentions through your screen reader.'}</p>
  </section>
  );
};

// ==================== Keybindings ====================

const BindsSettings: React.FC = () => {
  const tr = useTranslation();
  return (
  <section>
    <h1>{tr('sbind_title')}</h1>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {[[tr('sbind_mute'), 'Ctrl + Shift + M'], [tr('sbind_deafen'), 'Ctrl + Shift + D'], [tr('sbind_ptt'), 'Ctrl + Space']].map(([action, key]) => (
        <div key={action} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 12, marginBottom: 0 }}>
          <span style={{ color: 'var(--text-primary)', fontSize: 14 }}>{action}</span>
          <kbd style={{ padding: '4px 10px', background: 'var(--bg-primary)', borderRadius: 4, fontSize: 12, color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }}>{key}</kbd>
        </div>
      ))}
    </div>
  </section>
  );
};

// ==================== Export & Import ====================

// localStorage keys worth carrying along with the backend settings.
const LOCAL_PREF_KEYS = ['accentColor', 'notifPrefs', 'a11yPrefs', 'displayPrefs', 'messengerTheme', 'customRingtoneName', 'voiceMicId', 'voiceSpeakerId', 'voiceCameraId'];

const ExportImportSettings: React.FC = () => {
  const tr = useTranslation();
  const isRu = tr('settings_formatting') === 'Подсказки';
  const { s } = useSettings();
  const { currentServerIP, authToken } = useApp();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [msg, setMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null);
  const [importing, setImporting] = useState(false);

  const handleExport = () => {
    setMsg(null);
    const local: Record<string, string> = {};
    LOCAL_PREF_KEYS.forEach(k => { const v = localStorage.getItem(k); if (v !== null) local[k] = v; });
    const bundle = {
      app: 'ionik',
      kind: 'settings-backup',
      version: 1,
      exported_at: new Date().toISOString(),
      settings: s,
      local_prefs: local,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ionik-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setMsg({ text: isRu ? 'Настройки экспортированы' : 'Settings exported', type: 'ok' });
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMsg(null); setImporting(true);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      if (bundle?.kind !== 'settings-backup' || !bundle.settings) {
        throw new Error('bad-file');
      }
      // Restore local prefs first so they apply on reload.
      if (bundle.local_prefs && typeof bundle.local_prefs === 'object') {
        Object.entries(bundle.local_prefs).forEach(([k, v]) => {
          if (LOCAL_PREF_KEYS.includes(k) && typeof v === 'string') localStorage.setItem(k, v);
        });
      }
      // Push settings to the backend.
      const { language, ...rest } = bundle.settings;
      const res = await fetch(`${currentServerIP}/api/auth/settings/update/`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...rest, language }),
      });
      if (!res.ok) throw new Error('save-failed');
      setMsg({ text: isRu ? 'Настройки импортированы. Перезагрузка…' : 'Settings imported. Reloading…', type: 'ok' });
      setTimeout(() => window.location.reload(), 900);
    } catch (err: any) {
      setMsg({
        text: err?.message === 'bad-file'
          ? (isRu ? 'Неверный файл настроек' : 'Invalid settings file')
          : (isRu ? 'Не удалось импортировать настройки' : 'Could not import settings'),
        type: 'err',
      });
      setImporting(false);
    }
  };

  return (
  <section>
    <h1>{tr('sexp_title')}</h1>
    <p>{tr('sexp_desc')}</p>
    <h3 style={sectionH3}>{tr('sexp_export')}</h3>
    <p>{tr('sexp_export_desc')}</p>
    <button type="button" style={{ ...btnSecondary, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={handleExport}>
      <Download size={14} />{tr('sexp_export')}
    </button>
    <div style={divider} />
    <h3 style={sectionH3}>{tr('sexp_import')}</h3>
    <p>{tr('sexp_import_desc')}</p>
    <button type="button" style={{ ...btnSecondary, display: 'inline-flex', alignItems: 'center', gap: 6, opacity: importing ? 0.6 : 1 }} onClick={() => fileRef.current?.click()} disabled={importing}>
      <Upload size={14} />{importing ? (isRu ? 'Импорт…' : 'Importing…') : tr('sexp_import')}
    </button>
    <input ref={fileRef} type="file" accept="application/json,.json" onChange={handleImport} style={{ display: 'none' }} />
    {msg && <div style={statusMsg(msg.type)}>{msg.text}</div>}
  </section>
  );
};

// ==================== Servers ====================

const ServersSettings: React.FC = () => {
  const tr = useTranslation();
  return (
    <section>
      <h1><Server size={20} style={{ verticalAlign: 'middle', marginRight: 8 }} />{tr('srv_title')}</h1>
      <p>{tr('srv_desc')}</p>
      <ServerSelector />
    </section>
  );
};

// ==================== Placeholder ====================

const Placeholder: React.FC<{ title: string }> = ({ title }) => {
  const tr = useTranslation();
  return (
  <section><h1>{title}</h1><p style={{ color: 'var(--text-secondary)' }}>{tr('settings_coming_soon')}</p></section>
  );
};
