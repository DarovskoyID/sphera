import { useEffect, useState } from 'react';
import { Globe, LogIn, Video } from 'lucide-react';
import { reportError, useCore, useModuleT } from '@sfera/sdk';
import { api, clearLocationSlug, slugFromLocation, type PublicInfo } from './api';
import { Room } from './Room';
import { Button, inputStyle } from './ui';

const NAME_KEY = 'sfera.conference.guestName';

/**
 * Sign-in screen replacement for a conference link. External conferences take
 * a name and let the guest in; the other kinds ask to sign in first (the link
 * stays in the address, so the room opens right after).
 */
export function GuestScreen() {
  const t = useModuleT();
  const { currentServerIP } = useCore();
  const slug = slugFromLocation()!;
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [error, setError] = useState(false);
  const [name, setName] = useState(() => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } });
  const [pass, setPass] = useState<{ guest_pass: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(false);

  useEffect(() => {
    api.publicInfo(currentServerIP, slug).then(setInfo).catch(() => setError(true));
  }, [currentServerIP, slug]);

  const toSignIn = () => {
    // Keep ?conf= so the room opens after signing in; show the regular form now.
    window.dispatchEvent(new CustomEvent('sfera:conference-signin'));
  };

  const enter = async () => {
    const n = name.trim();
    if (n.length < 2 || busy) return;
    setBusy(true);
    try {
      const p = await api.guest(currentServerIP, slug, n);
      try { localStorage.setItem(NAME_KEY, p.name); } catch { /* private mode */ }
      setPass(p);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const shell = (content: React.ReactNode) => (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflow: 'auto' }}>
      <div style={{ width: '100%', maxWidth: 420, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 18, padding: 26, textAlign: 'center', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: 16, background: 'linear-gradient(135deg,#3b82f6,#0ea5e9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Video size={28} color="#fff" />
        </div>
        {content}
      </div>
    </div>
  );

  if (pass && info?.title && !left) {
    return (
      <div style={{ position: 'fixed', inset: 0 }}>
        <Room conn={{ serverIP: currentServerIP, token: '' }} slug={slug} guestPass={pass.guest_pass} title={info.title} displayName={pass.name}
          onLeave={() => { setLeft(true); }} />
      </div>
    );
  }
  if (left) {
    return shell(
      <>
        <h1 style={{ margin: '0 0 8px', fontSize: 20, color: 'var(--text-primary)' }}>{t('cf_guest_left')}</h1>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
          <Button onClick={() => { setLeft(false); setPass(null); }}>{t('cf_rejoin')}</Button>
          <Button kind="plain" onClick={() => { clearLocationSlug(); toSignIn(); }}>{t('cf_to_app')}</Button>
        </div>
      </>,
    );
  }
  if (error) {
    return shell(
      <>
        <h1 style={{ margin: '0 0 8px', fontSize: 20, color: 'var(--text-primary)' }}>{t('cf_error_not_found')}</h1>
        <Button onClick={() => { clearLocationSlug(); toSignIn(); }}>{t('cf_to_app')}</Button>
      </>,
    );
  }
  if (!info) return shell(<div style={{ color: 'var(--text-tertiary)' }}>…</div>);
  if (!info.active) {
    return shell(
      <>
        <h1 style={{ margin: '0 0 8px', fontSize: 20, color: 'var(--text-primary)' }}>{t('cf_ended')}</h1>
        <Button onClick={() => { clearLocationSlug(); toSignIn(); }}>{t('cf_to_app')}</Button>
      </>,
    );
  }
  if (info.login_required) {
    return shell(
      <>
        <h1 style={{ margin: '0 0 8px', fontSize: 20, color: 'var(--text-primary)' }}>{t('cf_login_required')}</h1>
        <p style={{ margin: '0 0 18px', color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5 }}>{t(`cf_login_required_${info.kind}`)}</p>
        <Button kind="primary" onClick={toSignIn}><LogIn size={15} /> {t('cf_sign_in')}</Button>
      </>,
    );
  }
  return shell(
    <>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#10b981', fontWeight: 700, marginBottom: 6 }}><Globe size={13} /> {t('cf_kind_external')}</div>
      <h1 style={{ margin: '0 0 4px', fontSize: 22, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{info.title}</h1>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 18 }}>{t('cf_organizer').replace('{name}', info.owner ?? '')}</div>
      <label style={{ display: 'block', textAlign: 'left', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }} htmlFor="cf-guest-name">{t('cf_your_name')}</label>
      <input id="cf-guest-name" autoFocus value={name} maxLength={64} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void enter(); }}
        placeholder={t('cf_your_name_ph')} style={{ ...inputStyle(), fontSize: 15, padding: '11px 12px' }} autoComplete="name" />
      <Button kind="primary" disabled={name.trim().length < 2 || busy} onClick={() => void enter()} style={{ width: '100%', marginTop: 12, padding: '11px 0' }}>
        {info.guest_lobby ? t('cf_ask_to_join') : t('cf_continue')}
      </Button>
      <div style={{ marginTop: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>
        {t('cf_have_account')} <button type="button" onClick={toSignIn} style={{ border: 'none', background: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: 13, padding: 0 }}>{t('cf_sign_in')}</button>
      </div>
    </>,
  );
}
