import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { Shield, Monitor, Smartphone, Tablet, Trash2, UserX, Camera } from 'lucide-react';
import { useApp } from '../context/AppContext';
import type { ServerUser } from '../types';

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
  auto_input_sensitivity: boolean;
  echo_cancellation: boolean;
  noise_suppression: boolean;
  chat_show_timestamps: boolean;
  chat_emoji_reactions: boolean;
  chat_compact_mode: boolean;
  data_app_improvements: boolean;
  data_personalization: boolean;
  streamer_mode: boolean;
  streamer_hide_info: boolean;
  streamer_disable_notifs: boolean;
  developer_mode: boolean;
  hardware_acceleration: boolean;
  show_current_activity: boolean;
  show_game_status: boolean;
  language: string;
}

const defaultSettings: SettingsData = {
  show_profile_to_everyone: true, display_online_status: true, show_activity_status: false,
  safe_dm_filter: true, scan_messages_everyone: true, scan_messages_non_friends: false, scan_messages_off: false,
  enable_all_notifications: true, notify_direct_messages: true, notify_mentions: true,
  notify_all_server_messages: false, notify_friend_requests: true, sound_message: true, sound_incoming_call: true,
  theme: 'dark', show_timestamps: true, show_avatars: true,
  auto_input_sensitivity: true, echo_cancellation: true, noise_suppression: true,
  chat_show_timestamps: true, chat_emoji_reactions: true, chat_compact_mode: false,
  data_app_improvements: true, data_personalization: true,
  streamer_mode: false, streamer_hide_info: false, streamer_disable_notifs: false,
  developer_mode: false, hardware_acceleration: false,
  show_current_activity: true, show_game_status: true, language: 'en',
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
  const { currentSettingsPage, currentServerIP, authToken } = useApp();
  const [s, setS] = useState<SettingsData>(defaultSettings);
  const [loaded, setLoaded] = useState(false);

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
          setS(prev => ({ ...prev, ...data }));
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
          {currentSettingsPage === 'language' && <LanguageSettings />}
          {currentSettingsPage === 'streamer' && <StreamerSettings />}
          {currentSettingsPage === 'more' && <MoreSettings />}
          {currentSettingsPage === 'privacyOfActivity' && <PrivacyActivitySettings />}
          {currentSettingsPage === 'special' && <SpecialSettings />}
          {currentSettingsPage === 'binds' && <BindsSettings />}
          {currentSettingsPage === 'exportImport' && <ExportImportSettings />}
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

const ProfileSettings: React.FC = () => {
  const { currentUser, currentServerIP, authToken } = useApp();
  const [nickname, setNickname] = useState(currentUser?.nickname || '');
  const [bio, setBio] = useState(currentUser?.bio || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwMsg, setPwMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  useEffect(() => { setNickname(currentUser?.nickname || ''); setBio(currentUser?.bio || ''); }, [currentUser]);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) { setAvatarFile(file); setAvatarPreview(URL.createObjectURL(file)); }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setMsg(null);
    try {
      const fd = new FormData(); fd.append('nickname', nickname); fd.append('bio', bio);
      if (avatarFile) fd.append('avatar', avatarFile);
      const res = await fetch(`${currentServerIP}/api/auth/me/update/`, { method: 'PATCH', headers: { 'Authorization': `Bearer ${authToken}` }, body: fd });
      if (!res.ok) throw new Error('Failed');
      setMsg({ text: 'Profile updated!', type: 'ok' }); setAvatarFile(null);
    } catch { setMsg({ text: 'Failed to save', type: 'err' }); }
    setSaving(false);
  };

  const handleChangePassword = async () => {
    setPwMsg(null);
    if (!oldPw || !newPw) { setPwMsg({ text: 'Fill in both fields', type: 'err' }); return; }
    try {
      const res = await fetch(`${currentServerIP}/api/auth/me/password/`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ old_password: oldPw, new_password: newPw }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setPwMsg({ text: 'Password changed!', type: 'ok' }); setOldPw(''); setNewPw('');
    } catch (e: any) { setPwMsg({ text: e.message, type: 'err' }); }
  };

  const avatarSrc = avatarPreview || currentUser?.avatar || '';

  return (
    <section>
      <h1>My Account</h1>
      <p>Manage your account settings and profile information</p>

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ height: 100, background: 'linear-gradient(135deg, var(--accent-primary), #7c3aed)' }} />
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
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>@{currentUser?.username}</div>
          </div>
        </div>
      </div>

      <form onSubmit={handleSave}>
        <div style={card}>
          <h3 style={sectionH3}>Profile Information</h3>
          <div style={{ marginBottom: 16 }}>
            <div style={fieldLabel}>Display Name</div>
            <input style={fieldInput} value={nickname} onChange={e => setNickname(e.target.value)} placeholder="Display name" />
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={fieldLabel}>Username</div>
            <input style={{ ...fieldInput, opacity: 0.6 }} value={currentUser?.username || ''} disabled />
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={fieldLabel}>About Me</div>
            <textarea value={bio} onChange={e => setBio(e.target.value)} placeholder="Tell us about yourself" rows={3} style={{ ...fieldInput, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          <button type="submit" style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</button>
          {msg && <div style={statusMsg(msg.type)}>{msg.text}</div>}
        </div>
      </form>

      <div style={divider} />

      <div style={card}>
        <h3 style={sectionH3}><Shield size={16} style={{ verticalAlign: 'middle', marginRight: 8 }} />Change Password</h3>
        <div style={{ marginBottom: 12 }}>
          <div style={fieldLabel}>Current Password</div>
          <input type="password" style={fieldInput} value={oldPw} onChange={e => setOldPw(e.target.value)} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={fieldLabel}>New Password</div>
          <input type="password" style={fieldInput} value={newPw} onChange={e => setNewPw(e.target.value)} />
        </div>
        <button type="button" style={btnPrimary} onClick={handleChangePassword}>Change Password</button>
        {pwMsg && <div style={statusMsg(pwMsg.type)}>{pwMsg.text}</div>}
      </div>

      <div style={divider} />

      <h3 style={sectionH3}>Profile Customization</h3>
      <Check label="Show my profile to everyone" field="show_profile_to_everyone" />
      <Check label="Display my online status" field="display_online_status" />
      <Check label="Show my activity status" field="show_activity_status" />
    </section>
  );
};

// ==================== Privacy Settings ====================

interface BlockedEntry { id: number; blocked: ServerUser; created_at: string; }

const PrivacySettings: React.FC = () => {
  const { currentServerIP, authToken, searchUsers } = useApp();
  const [blocked, setBlocked] = useState<BlockedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [blockQuery, setBlockQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ServerUser[]>([]);
  const [error, setError] = useState('');

  const loadBlocked = useCallback(async () => {
    try {
      const res = await fetch(`${currentServerIP}/api/auth/blocked/`, { headers: { 'Authorization': `Bearer ${authToken}` } });
      if (res.ok) setBlocked(await res.json());
    } catch { /* */ }
    setLoading(false);
  }, [currentServerIP, authToken]);

  useEffect(() => { loadBlocked(); }, [loadBlocked]);

  const handleSearch = async () => {
    if (!blockQuery.trim()) return; setError('');
    try {
      const results = await searchUsers(blockQuery);
      const blockedIds = blocked.map(b => String(b.blocked.id));
      setSearchResults(results.filter(u => !blockedIds.includes(String(u.id))));
      if (results.length === 0) setError('No users found');
    } catch { setError('Search failed'); }
  };

  const handleBlock = async (userId: string) => {
    try {
      const res = await fetch(`${currentServerIP}/api/auth/block/`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId }) });
      if (res.ok) { setSearchResults([]); setBlockQuery(''); await loadBlocked(); }
    } catch { /* */ }
  };

  const handleUnblock = async (userId: string) => {
    try { await fetch(`${currentServerIP}/api/auth/unblock/${userId}/`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } }); setBlocked(prev => prev.filter(b => String(b.blocked.id) !== userId)); } catch { /* */ }
  };

  return (
    <section>
      <h1>Privacy & Safety</h1>
      <p>Manage your content filtering and privacy preferences</p>

      <h3 style={sectionH3}>Safe Direct Messaging</h3>
      <p>Filter direct messages from server members who are not friends</p>
      <Check label="Keep me safe" field="safe_dm_filter" />

      <div style={divider} />

      <h3 style={sectionH3}>Explicit Content Filter</h3>
      <p>Automatically scan and delete direct messages containing explicit media</p>
      <Check label="Scan messages from everyone" field="scan_messages_everyone" />
      <Check label="Scan messages from non-friends only" field="scan_messages_non_friends" />
      <Check label="Don't scan any messages" field="scan_messages_off" />

      <div style={divider} />

      <h3 style={sectionH3}>Blocked Users ({blocked.length})</h3>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input style={{ ...fieldInput, flex: 1 }} placeholder="Search user to block..." value={blockQuery} onChange={e => setBlockQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} />
        <button type="button" style={btnSecondary} onClick={handleSearch}>Search</button>
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
          <button type="button" style={btnDanger} onClick={() => handleBlock(u.id)}><UserX size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />Block</button>
        </div>
      ))}

      {loading ? <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading...</div> : blocked.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16, textAlign: 'center' }}>No blocked users</div>
      ) : blocked.map(entry => {
        const u = entry.blocked; const name = u.nickname || u.username;
        return (
          <div key={entry.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, padding: 12 }}>
            {u.avatar ? <img src={u.avatar} alt={name} style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} /> : (
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#ef444433', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444', fontWeight: 700, fontSize: 16, flexShrink: 0 }}>{name[0].toUpperCase()}</div>
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>{name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Blocked {new Date(entry.created_at).toLocaleDateString()}</div>
            </div>
            <button type="button" style={btnSecondary} onClick={() => handleUnblock(String(u.id))}>Unblock</button>
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
  const { currentServerIP, authToken } = useApp();
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDevices = useCallback(async () => {
    try { const res = await fetch(`${currentServerIP}/api/auth/devices/`, { headers: { 'Authorization': `Bearer ${authToken}` } }); if (res.ok) setDevices(await res.json()); } catch { /* */ }
    setLoading(false);
  }, [currentServerIP, authToken]);

  useEffect(() => { loadDevices(); }, [loadDevices]);

  const handleRemove = async (id: number) => {
    try { await fetch(`${currentServerIP}/api/auth/devices/${id}/remove/`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } }); setDevices(prev => prev.filter(d => d.id !== id)); } catch { /* */ }
  };

  const parseBrowser = (ua: string) => { if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome'; if (ua.includes('Firefox')) return 'Firefox'; if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari'; if (ua.includes('Edg')) return 'Edge'; return 'Browser'; };
  const parseOS = (ua: string) => { if (ua.includes('Windows')) return 'Windows'; if (ua.includes('Mac OS')) return 'macOS'; if (ua.includes('Linux')) return 'Linux'; if (ua.includes('Android')) return 'Android'; if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS'; return 'Unknown OS'; };

  return (
    <section>
      <h1>Devices</h1>
      <p>Manage devices that have logged into your account</p>

      {loading ? <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 20 }}>Loading...</div> : devices.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 20, textAlign: 'center' }}>No devices found</div>
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
                {isRecent && <span style={{ fontSize: 11, background: '#22c55e22', color: '#22c55e', padding: '2px 8px', borderRadius: 99, fontWeight: 500 }}>Active now</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>IP: {device.ip_address}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Last active: {lastSeen.toLocaleString()}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', opacity: 0.7 }}>First login: {new Date(device.created_at).toLocaleString()}</div>
            </div>
            {i > 0 && <button type="button" style={{ ...btnDanger, display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px' }} onClick={() => handleRemove(device.id)}><Trash2 size={14} /></button>}
          </div>
        );
      })}
    </section>
  );
};

// ==================== Notifications ====================

const NotificationSettings: React.FC = () => (
  <section>
    <h1>Notifications</h1>
    <p>Control how you receive notifications</p>
    <h3 style={sectionH3}>Enable Desktop Notifications</h3>
    <Check label="Enable all notifications" field="enable_all_notifications" />
    <div style={divider} />
    <h3 style={sectionH3}>Push Notifications</h3>
    <Check label="Direct messages" field="notify_direct_messages" />
    <Check label="Mentions" field="notify_mentions" />
    <Check label="All server messages" field="notify_all_server_messages" />
    <Check label="Friend requests" field="notify_friend_requests" />
    <div style={divider} />
    <h3 style={sectionH3}>Sounds</h3>
    <Check label="Message notification sound" field="sound_message" />
    <Check label="Incoming call sound" field="sound_incoming_call" />
  </section>
);

// ==================== Appearance ====================

const AppearanceSettings: React.FC = () => {
  const { s, setField } = useSettings();
  return (
    <section>
      <h1>Appearance</h1>
      <p>Customize how your app looks and feels</p>
      <h3 style={sectionH3}>Theme</h3>
      <label style={fieldLabel}>App Theme
        <select value={s.theme} onChange={e => setField('theme', e.target.value)} style={{ ...fieldInput, marginTop: 6 }}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <div style={divider} />
      <h3 style={sectionH3}>Message Display</h3>
      <Check label="Show message timestamps" field="show_timestamps" />
      <Check label="Show avatars" field="show_avatars" />
    </section>
  );
};

// ==================== Voice & Video ====================

const VoiceVideoSettings: React.FC = () => (
  <section>
    <h1>Voice & Video</h1>
    <p>Configure your audio and video settings</p>
    <h3 style={sectionH3}>Voice Processing</h3>
    <Check label="Automatically determine input sensitivity" field="auto_input_sensitivity" />
    <Check label="Echo cancellation" field="echo_cancellation" />
    <Check label="Noise suppression" field="noise_suppression" />
  </section>
);

// ==================== Chat ====================

const ChatSettings: React.FC = () => (
  <section>
    <h1>Chat Settings</h1>
    <Check label="Show timestamps" field="chat_show_timestamps" />
    <Check label="Enable emoji reactions" field="chat_emoji_reactions" />
    <Check label="Compact mode" field="chat_compact_mode" />
  </section>
);

// ==================== Language ====================

const LanguageSettings: React.FC = () => {
  const { s, setField } = useSettings();
  return (
    <section>
      <h1>Language</h1>
      <p>Choose your preferred language</p>
      <label style={fieldLabel}>Select Language
        <select value={s.language} onChange={e => setField('language', e.target.value)} style={{ ...fieldInput, marginTop: 6 }}>
          <option value="en">English</option>
          <option value="ru">Russian</option>
        </select>
      </label>
    </section>
  );
};

// ==================== Data & Privacy ====================

const DataSettings: React.FC = () => (
  <section>
    <h1>Data and Privacy</h1>
    <Check label="Use my data for app improvements" field="data_app_improvements" />
    <Check label="Use my data for personalization" field="data_personalization" />
    <div style={divider} />
    <button type="button" style={btnSecondary}>Download my data</button>
  </section>
);

// ==================== Streamer ====================

const StreamerSettings: React.FC = () => (
  <section>
    <h1>Streamer Mode</h1>
    <Check label="Enable streamer mode" field="streamer_mode" />
    <div style={divider} />
    <h3 style={sectionH3}>Privacy Options</h3>
    <Check label="Hide personal information" field="streamer_hide_info" />
    <Check label="Disable notifications" field="streamer_disable_notifs" />
  </section>
);

// ==================== Advanced ====================

const MoreSettings: React.FC = () => (
  <section>
    <h1>Advanced Settings</h1>
    <Check label="Developer mode" field="developer_mode" />
    <Check label="Hardware acceleration" field="hardware_acceleration" />
  </section>
);

// ==================== Activity Privacy ====================

const PrivacyActivitySettings: React.FC = () => (
  <section>
    <h1>Activity Privacy</h1>
    <Check label="Show current activity" field="show_current_activity" />
    <Check label="Show game status" field="show_game_status" />
  </section>
);

// ==================== Accessibility ====================

const SpecialSettings: React.FC = () => (
  <section>
    <h1>Accessibility</h1>
    <p>Configure accessibility features for better usability.</p>
    <label className="ui-checkbox"><input type="checkbox" /><span className="ui-checkbox-box"></span><span className="ui-checkbox-text">High contrast mode</span></label>
    <label className="ui-checkbox"><input type="checkbox" /><span className="ui-checkbox-box"></span><span className="ui-checkbox-text">Screen reader support</span></label>
  </section>
);

// ==================== Keybindings ====================

const BindsSettings: React.FC = () => (
  <section>
    <h1>Keybindings</h1>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {[['Mute/Unmute', 'Ctrl + Shift + M'], ['Deafen/Undeafen', 'Ctrl + Shift + D'], ['Push to Talk', 'Ctrl + Space']].map(([action, key]) => (
        <div key={action} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 12, marginBottom: 0 }}>
          <span style={{ color: 'var(--text-primary)', fontSize: 14 }}>{action}</span>
          <kbd style={{ padding: '4px 10px', background: 'var(--bg-primary)', borderRadius: 4, fontSize: 12, color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }}>{key}</kbd>
        </div>
      ))}
    </div>
  </section>
);

// ==================== Export & Import ====================

const ExportImportSettings: React.FC = () => (
  <section>
    <h1>Export & Import</h1>
    <p>Backup and restore your settings</p>
    <h3 style={sectionH3}>Export Settings</h3>
    <p>Download all your settings as a JSON file</p>
    <button type="button" style={btnSecondary}>Export Settings</button>
    <div style={divider} />
    <h3 style={sectionH3}>Import Settings</h3>
    <p>Upload a previously exported settings file</p>
    <button type="button" style={btnSecondary}>Import Settings</button>
  </section>
);

// ==================== Placeholder ====================

const Placeholder: React.FC<{ title: string }> = ({ title }) => (
  <section><h1>{title}</h1><p style={{ color: 'var(--text-secondary)' }}>Coming soon</p></section>
);
