import { useEffect, useState } from 'react';
import { Video, X } from 'lucide-react';
import {
  ToolCard, defineModule, navigate, reportError, showDesktopNotification, tmStatic, useCore, useModuleT,
  type ComposerActionProps, type ModuleContext,
} from '@sfera/sdk';
import { api, clearLocationSlug, conferenceLink, slugFromLocation, type MediaSettings } from './api';
import { ConferenceView, ROUTE, useConn } from './Home';
import { GuestScreen } from './Guest';
import { strings } from './i18n';
import { Button, Field, inputStyle } from './ui';

let guestSignIn = false;
let moduleCtx: ModuleContext | null = null;
let settingsShown = false;

/** Signed in with a conference link in the address: open the room. */
function LinkOpener({ children }: { children: React.ReactNode }) {
  const { authToken, setCurrentServer, currentUser } = useCore();
  // Media server settings concern only the superuser: no empty tab for anyone else.
  useEffect(() => {
    if (currentUser?.is_superuser && moduleCtx && !settingsShown) {
      settingsShown = true;
      moduleCtx.slot('settings.page', { id: 'conference', label: () => tmStatic('cf_title'), icon: <Video size={16} />, render: SettingsPage });
    }
  }, [currentUser?.is_superuser]);
  useEffect(() => {
    const slug = slugFromLocation();
    if (authToken && slug) {
      clearLocationSlug();
      setCurrentServer(navigate.moduleRoute(ROUTE, slug));
    }
  }, [authToken, setCurrentServer]);
  return <>{children}</>;
}

function Rail() {
  const t = useModuleT();
  const { currentServer, setCurrentServer } = useCore();
  return (
    <button className={`server-icon ${currentServer.startsWith(`${ROUTE}:`) ? 'active' : ''}`} title={t('cf_title')} aria-label={t('cf_title')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}>
      <Video size={20} />
    </button>
  );
}

function Card() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  return (
    <ToolCard
      icon={<Video size={20} color="#fff" />}
      gradient="linear-gradient(135deg,#3b82f6,#0ea5e9)"
      tint="rgba(59,130,246"
      title={t('cf_title')}
      subtitle={t('cf_card_sub')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}
    />
  );
}

interface Invite { slug: string; title: string; from: string }
const inviteListeners = new Set<(i: Invite) => void>();

function Invites() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  const [items, setItems] = useState<Invite[]>([]);
  useEffect(() => {
    const on = (i: Invite) => setItems(v => [...v.filter(x => x.slug !== i.slug), i].slice(-3));
    inviteListeners.add(on);
    return () => { inviteListeners.delete(on); };
  }, []);
  if (!items.length) return null;
  return (
    <div style={{ position: 'fixed', right: 16, top: 16, zIndex: 8600, display: 'flex', flexDirection: 'column', gap: 8, width: 'min(340px, calc(100vw - 32px))' }}>
      {items.map(i => (
        <div key={i.slug} role="alert" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderLeft: '4px solid #3b82f6', borderRadius: 12, padding: 12, boxShadow: 'var(--shadow-lg)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <Video size={18} color="#3b82f6" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('cf_invited_by').replace('{name}', i.from)}</div>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{i.title}</div>
            </div>
            <button type="button" aria-label={t('cf_close')} onClick={() => setItems(v => v.filter(x => x.slug !== i.slug))} style={{ border: 'none', background: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}><X size={15} /></button>
          </div>
          <Button kind="primary" small style={{ width: '100%', marginTop: 10 }} onClick={() => { setItems(v => v.filter(x => x.slug !== i.slug)); setCurrentServer(navigate.moduleRoute(ROUTE, i.slug)); }}>
            {t('cf_join')}
          </Button>
        </div>
      ))}
    </div>
  );
}

function SettingsPage() {
  const t = useModuleT();
  const conn = useConn();
  const { currentUser } = useCore();
  const [s, setS] = useState<MediaSettings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (currentUser?.is_superuser) api.settings(conn).then(setS).catch(reportError); }, [conn, currentUser?.is_superuser]);

  return (
    <section>
      <h1><Video size={20} style={{ verticalAlign: 'middle', marginRight: 8 }} />{t('cf_title')}</h1>
      <p>{t('cf_settings_intro')}</p>
      {!currentUser?.is_superuser ? null : !s ? <p>…</p> : (
        <div style={{ maxWidth: 520 }}>
          <div style={{ padding: 12, borderRadius: 10, marginBottom: 14, background: s.mode === 'livekit' ? 'rgba(16,185,129,.1)' : 'rgba(245,158,11,.1)', color: s.mode === 'livekit' ? '#10b981' : '#f59e0b', fontSize: 13.5, lineHeight: 1.5 }}>
            {s.mode === 'livekit' ? t('cf_settings_sfu_on') : t('cf_settings_sfu_off')}
            {s.from_env && <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{t('cf_settings_env')}</div>}
          </div>
          <Field label="LiveKit URL" hint="wss://livekit.example.com">
            <input value={s.livekit_url} onChange={e => setS({ ...s, livekit_url: e.target.value })} style={inputStyle()} />
          </Field>
          <Field label="API key">
            <input value={s.livekit_api_key} onChange={e => setS({ ...s, livekit_api_key: e.target.value })} style={inputStyle()} autoComplete="off" />
          </Field>
          <Field label="API secret">
            <input type="password" value={s.livekit_api_secret} onChange={e => setS({ ...s, livekit_api_secret: e.target.value })} style={inputStyle()} autoComplete="new-password" />
          </Field>
          <Button kind="primary" onClick={() => void api.saveSettings(conn, s).then(r => { setS(r); setSaved(true); setTimeout(() => setSaved(false), 2000); }).catch(reportError)}>
            {saved ? t('cf_saved') : t('cf_save')}
          </Button>
        </div>
      )}
    </section>
  );
}

/** Next to a message composer: create a meeting and put its link into the message. */
function ComposerButton({ kind, targetId, onPick }: ComposerActionProps) {
  const t = useModuleT();
  const conn = useConn();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="composer-icon-btn" title={t('cf_composer')} aria-label={t('cf_composer')} disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const c = kind === 'dm'
            ? await api.create(conn, { title: t('cf_call_title'), kind: 'private', invitee_ids: [targetId] })
            : await api.create(conn, { title: t('cf_call_title'), kind: 'internal' });
          onPick(`${t('cf_join_link')} ${conferenceLink(c.slug)}`);
        } catch (e) { reportError(e); } finally { setBusy(false); }
      }}
      style={{ opacity: busy ? 0.5 : 1 }}>
      <Video size={20} />
    </button>
  );
}

export default defineModule({
  id: 'conference',
  setup(ctx: ModuleContext) {
    moduleCtx = ctx;
    settingsShown = false;
    ctx.onDispose(() => { moduleCtx = null; settingsShown = false; });
    ctx.strings(strings);
    const authRoute = () => ({ id: 'guest', match: () => !!slugFromLocation() && !guestSignIn, render: GuestScreen });
    ctx.slot('auth.route', authRoute());
    const onSignIn = () => { guestSignIn = true; ctx.slot('auth.route', authRoute()); };
    window.addEventListener('sfera:conference-signin', onSignIn);
    ctx.onDispose(() => window.removeEventListener('sfera:conference-signin', onSignIn));

    ctx.slot('app.provider', { id: 'link', render: LinkOpener });
    ctx.slot('nav.rail', { id: 'conference', order: 25, render: Rail });
    ctx.slot('explore.card', { id: 'conference', order: 5, render: Card });
    ctx.slot('main.view', { id: 'conference', match: r => r.currentServer.startsWith(`${ROUTE}:`), render: ConferenceView });
    ctx.slot('app.overlay', { id: 'invites', render: Invites });
    ctx.slot('chat.composerAction', { id: 'conference', render: ComposerButton });
    ctx.onWs('signaling', 'module:conference.invited', f => {
      const invite = { slug: String(f.slug), title: String(f.title), from: String(f.from) };
      inviteListeners.forEach(l => l(invite));
      showDesktopNotification('dm', `📹 ${invite.title}`, invite.from);
    });
  },
});
