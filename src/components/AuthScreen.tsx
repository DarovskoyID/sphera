import { useState } from 'react';
import { useApp } from '../context/AppContext';

export const AuthScreen = () => {
  const { currentServerIP, setAuthToken } = useApp();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const url = isRegister
      ? `${currentServerIP}/api/auth/register/`
      : `${currentServerIP}/api/auth/login/`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
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
    } catch (e: any) {
      setError(e.message || 'Connection error');
    } finally {
      setLoading(false);
    }
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
        <h2 style={{
          margin: '0 0 8px',
          color: 'var(--text-primary)',
          fontSize: 24,
          textAlign: 'center',
        }}>
          {isRegister ? 'Create Account' : 'Welcome Back'}
        </h2>
        <p style={{
          margin: '0 0 24px',
          color: 'var(--text-secondary)',
          fontSize: 14,
          textAlign: 'center',
        }}>
          {isRegister ? 'Sign up to get started' : 'Sign in to continue'}
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            required
            style={{
              padding: '10px 14px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-color)',
              background: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontSize: 14,
              outline: 'none',
            }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
            style={{
              padding: '10px 14px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-color)',
              background: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontSize: 14,
              outline: 'none',
            }}
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
            {loading ? '...' : isRegister ? 'Register' : 'Login'}
          </button>
        </form>

        <p style={{
          margin: '16px 0 0',
          color: 'var(--text-secondary)',
          fontSize: 13,
          textAlign: 'center',
        }}>
          {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
          <span
            onClick={() => { setIsRegister(!isRegister); setError(''); }}
            style={{
              color: 'var(--accent-primary)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {isRegister ? 'Sign in' : 'Register'}
          </span>
        </p>
      </div>
    </div>
  );
};
