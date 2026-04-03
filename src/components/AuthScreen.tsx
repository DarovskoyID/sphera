import { useState, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';

export const AuthScreen = () => {
  const { currentServerIP, setAuthToken } = useApp();
  const tr = useTranslation();

  const [login, setLogin] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState('');
  const [error, setError] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isRegister) {
        const formData = new FormData();
        formData.append('username', login);
        formData.append('password', password);
        formData.append('nickname', nickname);
        if (avatarFile) formData.append('avatar', avatarFile);

        const res = await fetch(`${currentServerIP}/api/auth/register/`, {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = typeof data === 'object'
            ? Object.values(data).flat().join(', ')
            : String(data);
          setError(msg);
          return;
        }
        setAuthToken(data.access);
      } else {
        const res = await fetch(`${currentServerIP}/api/auth/login/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: login, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = typeof data === 'object'
            ? Object.values(data).flat().join(', ')
            : String(data);
          setError(msg);
          return;
        }
        setAuthToken(data.access);
      }
    } catch (e: any) {
      setError(e.message || tr('auth_connection_error'));
    } finally {
      setLoading(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: '10px 14px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-color)',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: 14,
    outline: 'none',
  };

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-primary)',
      fontFamily: 'inherit',
    }}>
      <div style={{
        width: 380,
        padding: 32,
        borderRadius: 'var(--radius-lg)',
        background: 'var(--bg-secondary)',
        boxShadow: '0 8px 32px var(--glass-shadow)',
      }}>
        <h2 style={{ margin: '0 0 8px', color: 'var(--text-primary)', fontSize: 24, textAlign: 'center' }}>
          {isRegister ? tr('auth_create_account') : tr('auth_welcome_back')}
        </h2>
        <p style={{ margin: '0 0 24px', color: 'var(--text-secondary)', fontSize: 14, textAlign: 'center' }}>
          {isRegister ? tr('auth_signup_desc') : tr('auth_signin_desc')}
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {isRegister && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <div
                onClick={() => fileInputRef.current?.click()}
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: '50%',
                  background: 'var(--bg-primary)',
                  border: '2px dashed var(--border-color)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  overflow: 'hidden',
                }}
              >
                {avatarPreview
                  ? <img src={avatarPreview} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{tr('auth_photo')}</span>
                }
              </div>
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarChange} />
            </div>
          )}

          <input
            type="text"
            placeholder={tr('auth_login')}
            value={login}
            onChange={e => setLogin(e.target.value)}
            required
            style={inputStyle}
          />

          {isRegister && (
            <input
              type="text"
              placeholder={tr('auth_nickname')}
              value={nickname}
              onChange={e => setNickname(e.target.value)}
              style={inputStyle}
            />
          )}

          <input
            type="password"
            placeholder={tr('auth_password')}
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
            style={inputStyle}
          />

          {error && (
            <div style={{
              color: 'var(--notification-bg)',
              fontSize: 13,
              padding: '6px 10px',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(240, 71, 71, 0.1)',
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '10px 14px',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              background: 'var(--accent-primary)',
              color: '#fff',
              fontSize: 14,
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? '...' : isRegister ? tr('auth_register') : tr('auth_login')}
          </button>
        </form>

        <p style={{ margin: '16px 0 0', color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center' }}>
          {isRegister ? tr('auth_already_have') : tr('auth_dont_have')}{' '}
          <span
            onClick={() => { setIsRegister(!isRegister); setError(''); }}
            style={{ color: 'var(--accent-primary)', cursor: 'pointer', fontWeight: 600 }}
          >
            {isRegister ? tr('auth_signin') : tr('auth_register')}
          </span>
        </p>
      </div>
    </div>
  );
};
