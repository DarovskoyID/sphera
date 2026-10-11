import { useState, useRef } from 'react';
import { MessagesSquare, Server, ShieldCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { languages, type LangCode } from '../i18n';
import { SlotList } from '../core/modules/Slots';
import { useSlot } from '../sdk/slots';
import { API_BASE_URL, saveSelectedServer } from '../config/network';
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
  // Forgotten password: ask for the address, then the emailed code + a new password.
  const [resetStage, setResetStage] = useState<'' | 'email' | 'code'>('');
  // Set when a module interrupts the sign-in for a second factor.
  const [challenge, setChallenge] = useState('');
  const [hasBackupCodes, setHasBackupCodes] = useState(false);
  // Sign-up is two steps: fill the form, then confirm the email code.
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  // Choosing another server is the multiserver module (auth.footer slot).
  const serverPickers = useSlot('auth.footer');
  const { setCurrentServerIP } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setAvatarPreview(URL.createObjectURL(file));
  };

  // Step 1 of a forgotten password: the server mails a one-time code. Its answer
  // is the same for an unknown address, so this never reveals who is registered.
  const handleResetSendCode = async () => {
    const res = await fetch(`${currentServerIP}/api/auth/password-reset/send-code/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    await readResponse(res, { serverIP: currentServerIP });
    setResetStage('code');
    setCode('');
    setInfo(tr('auth_reset_sent'));
  };

  // Step 2: the code plus the new password. Every session is signed out server-side.
  const handleResetConfirm = async () => {
    const res = await fetch(`${currentServerIP}/api/auth/password-reset/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: code.trim(), password }),
    });
    await readResponse(res, { serverIP: currentServerIP });
    setResetStage('');
    setIsRegister(false);
    setPassword('');
    setCode('');
    setInfo(tr('auth_reset_done'));
  };

  const handleLogin = async () => {
    const res = await fetch(`${currentServerIP}/api/auth/login/`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: login, password }),
    });
    // A module (two-factor, say) can stop a sign-in halfway: the password was
    // right, but no token is issued until the second step is passed.
    if (res.status === 409) {
      const body = await res.json().catch(() => null);
      if (body?.error === 'second_factor_required' && body.challenge) {
        setChallenge(body.challenge);
        setHasBackupCodes(!!body.backup_codes);
        setCode('');
        return;
      }
    }
    const data = await readResponse(res, {
      serverIP: currentServerIP,
      unauthorizedKey: 'error_invalid_credentials',
    });
    setAuthToken(data.access);
  };

  // The second step itself: the challenge from the server plus the code the
  // person reads out of their authenticator (or one of their backup codes).
  const handleSecondFactor = async () => {
    const res = await fetch(`${currentServerIP}/api/auth/login/2fa/`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge, code: code.trim() }),
    });
    const data = await readResponse(res, {
      serverIP: currentServerIP,
      unauthorizedKey: 'auth_2fa_bad',
    });
    setChallenge('');
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
      if (challenge) {
        await handleSecondFactor();
      } else if (resetStage === 'email') {
        await handleResetSendCode();
      } else if (resetStage === 'code') {
        await handleResetConfirm();
      } else if (!isRegister) {
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
      await (resetStage ? handleResetSendCode() : handleSendCode());
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

  const startReset = () => {
    setResetStage('email');
    setCodeSent(false);
    setCode('');
    setPassword('');
    setError('');
    setInfo('');
  };

  const leaveReset = () => {
    setResetStage('');
    setCode('');
    setPassword('');
    setError('');
    setInfo('');
  };

  const switchMode = (register: boolean) => {
    if (register === isRegister) return;
    setResetStage('');
    setIsRegister(register);
    setCodeSent(false);
    setCode('');
    setError('');
    setInfo('');
  };

  const awaitingCode = codeSent || resetStage === 'code';
  const submitDisabled = loading
    || (awaitingCode && code.trim().length < CODE_LENGTH)
    || (!!challenge && code.trim().length < CODE_LENGTH);
  const submitLabel = challenge ? tr('auth_2fa_confirm')
    : resetStage === 'email' ? tr('auth_reset_send')
      : resetStage === 'code' ? tr('auth_reset_save')
        : codeSent ? tr('auth_confirm') : isRegister ? tr('auth_register') : tr('auth_signin');

  return (
    <div className="auth-root">
      <AuthBackdrop />

      <div className="auth-stage">
        <div className="auth-inner">
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
          {!codeSent && !resetStage && !challenge && (
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
            {challenge ? tr('auth_2fa_title')
              : resetStage ? tr('auth_reset_title')
              : codeSent ? tr('auth_verify_title') : isRegister ? tr('auth_create_account') : tr('auth_welcome_back')}
          </h2>
          <p className="auth-card-sub">
            {challenge ? tr('auth_2fa_desc')
              : resetStage === 'email' ? tr('auth_reset_desc')
              : resetStage === 'code' ? `${tr('auth_verify_desc')} ${email}`
                : codeSent ? `${tr('auth_verify_desc')} ${email}`
                  : isRegister ? tr('auth_signup_desc') : tr('auth_signin_desc')}
          </p>

          <form onSubmit={handleSubmit} className="auth-form">
            {challenge && (
              <>
                {/* Six digits from the app, or a backup code like ABCD-EFGH —
                    so a free-form field rather than the digit boxes. */}
                <div className="auth-field">
                  <input
                    id="auth-2fa" type="text" placeholder=" " required autoFocus
                    inputMode="text" autoComplete="one-time-code" maxLength={9}
                    style={{ letterSpacing: '4px', fontFamily: 'ui-monospace, Consolas, monospace' }}
                    value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^0-9A-Z-]/g, ''))}
                  />
                  <label htmlFor="auth-2fa">{tr('auth_2fa_code')}</label>
                </div>
                {hasBackupCodes && <div className="auth-note auth-note-info">{tr('auth_2fa_backup_hint')}</div>}
              </>
            )}

            {resetStage === 'email' && (
              <div className="auth-field">
                <input
                  id="auth-reset-email" type="email" placeholder=" " required autoFocus
                  autoComplete="email"
                  value={email} onChange={e => setEmail(e.target.value)}
                />
                <label htmlFor="auth-reset-email">{tr('auth_email')}</label>
              </div>
            )}

            {resetStage === 'code' && (
              <>
                <CodeInput value={code} onChange={setCode} length={CODE_LENGTH} disabled={loading} />
                <div className="auth-field">
                  <input
                    id="auth-new-password" type="password" placeholder=" " required minLength={6}
                    autoComplete="new-password"
                    value={password} onChange={e => setPassword(e.target.value)}
                  />
                  <label htmlFor="auth-new-password">{tr('auth_reset_new_password')}</label>
                </div>
              </>
            )}

            {!codeSent && !resetStage && !challenge && (
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

            {codeSent && !resetStage && (
              <CodeInput value={code} onChange={setCode} length={CODE_LENGTH} disabled={loading} />
            )}

            {info && <div className="auth-note auth-note-info">{info}</div>}
            {error && <div className="auth-note auth-note-error" role="alert">{error}</div>}

            <button type="submit" className="auth-submit" disabled={submitDisabled}>
              {loading ? <span className="auth-spinner" /> : submitLabel}
            </button>
          </form>

          {challenge && (
            <p className="auth-links">
              <button type="button" className="auth-link" onClick={() => { setChallenge(''); setCode(''); setError(''); }}>
                {tr('auth_2fa_back')}
              </button>
            </p>
          )}

          {!codeSent && !resetStage && !challenge && !isRegister && (
            <p className="auth-links">
              <button type="button" className="auth-link" onClick={startReset}>
                {tr('auth_forgot')}
              </button>
            </p>
          )}

          {resetStage === 'code' && (
            <p className="auth-links">
              <button type="button" className="auth-link" onClick={handleResend} disabled={loading}>
                {tr('auth_resend_code')}
              </button>
              {'  ·  '}
              <button type="button" className="auth-link" onClick={() => setResetStage('email')}>
                {tr('auth_change_email')}
              </button>
            </p>
          )}

          {resetStage && (
            <p className="auth-links">
              <button type="button" className="auth-link" onClick={leaveReset}>
                {tr('auth_reset_back')}
              </button>
            </p>
          )}

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
              {serverPickers.length === 0 && currentServerIP !== API_BASE_URL && (
                // Without the module there is no way back from another server — offer one.
                <button type="button" onClick={() => { saveSelectedServer(API_BASE_URL); setCurrentServerIP(API_BASE_URL); }}>
                  {language === 'ru' ? 'Основной сервер' : 'Main server'}
                </button>
              )}
            </div>
            <SlotList slot="auth.footer" />
          </div>
        </div>
        </div>
      </div>
    </div>
  );
};
