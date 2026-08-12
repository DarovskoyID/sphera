import { useState, useRef } from 'react';
import { Lock, MessagesSquare, Server, ShieldCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { languages, type LangCode } from '../i18n';
import { ServerSelector } from './ServerSelector';
import { CodeInput, CODE_LENGTH } from './CodeInput';
import { AuthBackdrop } from './AuthBackdrop';
import { readResponse, toUserMessage } from '../utils/errorManager';

export const AuthScreen = () => {
  const { currentServerIP, setAuthToken, setLanguage, language } = useApp();
  const tr = useTranslation();

  const [login, setLogin] = useState('');
  const [email, setEmail] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  // Sign-up is two steps: fill the form, then confirm the email code.
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showServers, setShowServers] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setAvatarPreview(URL.createObjectURL(file));
  };

  const handleLogin = async () => {
    const res = await fetch(`${currentServerIP}/api/auth/login/`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: login, password }),
    });
    const data = await readResponse(res, {
      serverIP: currentServerIP,
      unauthorizedKey: 'error_invalid_credentials',
    });
    setAuthToken(data.access);
  };

  // Step 1 of sign-up: ask the server to email a confirmation code.
  const handleSendCode = async () => {
    const res = await fetch(`${currentServerIP}/api/auth/register/send-code/`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: login, email }),
    });
    await readResponse(res, { serverIP: currentServerIP });
    setCodeSent(true);
    setCode('');
    setInfo(tr('auth_code_sent'));
  };

  // Step 2 of sign-up: send the code together with the full registration data.
  const handleVerifyAndRegister = async () => {
    const formData = new FormData();
    formData.append('username', login);
    formData.append('email', email);
    formData.append('password', password);
    formData.append('nickname', nickname);
    formData.append('code', code.trim());
    if (avatarFile) formData.append('avatar', avatarFile);

    const res = await fetch(`${currentServerIP}/api/auth/register/`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    const data = await readResponse(res, { serverIP: currentServerIP });
    setAuthToken(data.access);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);

    try {
      if (!isRegister) {
        await handleLogin();
      } else if (!codeSent) {
        await handleSendCode();
      } else {
        await handleVerifyAndRegister();
      }
    } catch (e: unknown) {
      setError(toUserMessage(e, { serverIP: currentServerIP }));
    } finally {
      setLoading(false);
    }
  };

  // "Resend code" link — same call as step 1, with its own loading/error guard.
  const handleResend = async () => {
    if (loading) return;
    setError('');
    setInfo('');
    setLoading(true);
    try {
      await handleSendCode();
    } catch (e: unknown) {
      setError(toUserMessage(e, { serverIP: currentServerIP }));
    } finally {
      setLoading(false);
    }
  };

  // Reset back to the sign-up form (e.g. wrong email, or to change details).
  const handleEditDetails = () => {
    setCodeSent(false);
    setCode('');
    setError('');
    setInfo('');
  };

  const switchMode = (register: boolean) => {
    if (register === isRegister) return;
    setIsRegister(register);
    setCodeSent(false);
    setCode('');
    setError('');
    setInfo('');
  };

  const submitDisabled = loading || (codeSent && code.trim().length < CODE_LENGTH);

  return (
    <div className="auth-root">
      <AuthBackdrop />

      <div className="auth-stage">
        <section className="auth-hero">
          <div className="auth-hero-mark">
            <span className="auth-hero-logo">
              <img src="/logo.svg" alt="" width={30} height={30} />
            </span>
            <span className="auth-hero-name">{tr('auth_brand')}</span>
          </div>
          <h1>{tr('auth_hero_title_lead')} <em>{tr('auth_hero_title_accent')}</em></h1>
          <p>{tr('auth_hero_text')}</p>
          <ul className="auth-points">
            <li><ShieldCheck size={17} /> {tr('auth_point_privacy')}</li>
            <li><MessagesSquare size={17} /> {tr('auth_point_chat')}</li>
            <li><Server size={17} /> {tr('auth_point_servers')}</li>
          </ul>
        </section>

        <div className="auth-card">
          {!codeSent && (
            <div className="auth-tabs" role="tablist">
              <span className="auth-tab-thumb" data-at={isRegister ? 'register' : 'login'} />
              <button
                type="button" role="tab" aria-selected={!isRegister}
                onClick={() => switchMode(false)}
              >
                {tr('auth_signin')}
              </button>
              <button
                type="button" role="tab" aria-selected={isRegister}
                onClick={() => switchMode(true)}
              >
                {tr('auth_register')}
              </button>
            </div>
          )}

          <h2>
            {codeSent ? tr('auth_verify_title') : isRegister ? tr('auth_create_account') : tr('auth_welcome_back')}
          </h2>
          <p className="auth-card-sub">
            {codeSent ? `${tr('auth_verify_desc')} ${email}` : isRegister ? tr('auth_signup_desc') : tr('auth_signin_desc')}
          </p>

          <form onSubmit={handleSubmit} className="auth-form">
            {!codeSent && (
              <>
                {isRegister && (
                  <>
                    <div
                      className="auth-avatar"
                      onClick={() => fileInputRef.current?.click()}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
                      aria-label={tr('auth_photo')}
                    >
                      {avatarPreview
                        ? <img src={avatarPreview} alt="" />
                        : <span>{tr('auth_photo')}</span>}
                    </div>
                    <input
                      ref={fileInputRef} type="file" accept="image/*"
                      style={{ display: 'none' }} onChange={handleAvatarChange}
                    />
                  </>
                )}

                {/* placeholder=" " is load-bearing: :placeholder-shown is what
                    tells the floating label whether the field is empty. */}
                <div className="auth-field">
                  <input
                    id="auth-login" type="text" placeholder=" " required
                    autoComplete={isRegister ? 'username' : 'username'}
                    value={login} onChange={e => setLogin(e.target.value)}
                  />
                  <label htmlFor="auth-login">{tr('auth_login')}</label>
                </div>

                {isRegister && (
                  <div className="auth-field">
                    <input
                      id="auth-email" type="email" placeholder=" " required
                      autoComplete="email"
                      value={email} onChange={e => setEmail(e.target.value)}
                    />
                    <label htmlFor="auth-email">{tr('auth_email')}</label>
                  </div>
                )}

                {isRegister && (
                  <div className="auth-field">
                    <input
                      id="auth-nickname" type="text" placeholder=" "
                      autoComplete="nickname"
                      value={nickname} onChange={e => setNickname(e.target.value)}
                    />
                    <label htmlFor="auth-nickname">{tr('auth_nickname')}</label>
                  </div>
                )}

                <div className="auth-field">
                  <input
                    id="auth-password" type="password" placeholder=" " required minLength={6}
                    autoComplete={isRegister ? 'new-password' : 'current-password'}
                    value={password} onChange={e => setPassword(e.target.value)}
                  />
                  <label htmlFor="auth-password">{tr('auth_password')}</label>
                </div>
              </>
            )}

            {codeSent && (
              <CodeInput value={code} onChange={setCode} length={CODE_LENGTH} disabled={loading} />
            )}

            {info && <div className="auth-note auth-note-info">{info}</div>}
            {error && <div className="auth-note auth-note-error" role="alert">{error}</div>}

            <button type="submit" className="auth-submit" disabled={submitDisabled}>
              {loading
                ? <span className="auth-spinner" />
                : codeSent ? tr('auth_confirm') : isRegister ? tr('auth_register') : tr('auth_signin')}
            </button>
          </form>

          {codeSent && (
            <p className="auth-links">
              <button type="button" className="auth-link" onClick={handleResend} disabled={loading}>
                {tr('auth_resend_code')}
              </button>
              {'  ·  '}
              <button type="button" className="auth-link" onClick={handleEditDetails}>
                {tr('auth_change_email')}
              </button>
            </p>
          )}

          <div className="auth-foot">
            <div className="auth-foot-row">
              <select value={language} onChange={e => setLanguage(e.target.value)} aria-label={tr('auth_language')}>
                {(Object.entries(languages) as [LangCode, string][]).map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
              <button type="button" onClick={() => setShowServers(!showServers)}>
                <Lock size={13} />
                {tr('srv_title')}
              </button>
            </div>
            {showServers && (
              <div style={{ marginTop: 12 }}>
                <ServerSelector compact maxListHeight={200} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
