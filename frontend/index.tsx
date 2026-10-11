import { useEffect, useState } from 'react';
import { FileSignature, Scale, X } from 'lucide-react';
import { ToolCard, defineModule, navigate, showDesktopNotification, tmStatic, useCore, useModuleT, type ComposerActionProps, type ModuleContext } from '@sfera/sdk';
import { api, clearVerifyLink, verifyLinkFromLocation } from './api';
import { CreateDialog, LegalView, Logo, ROUTE, SettingsForm, useConn } from './LegalView';
import { VerifyScreen } from './Verify';
import { kitStrings } from './kit';
import { strings } from './i18n';
import * as legal from './store';

let verifySignIn = false;
let moduleCtx: ModuleContext | null = null;
let settingsShown = false;

type Request = { id: number; packageId: string; title: string; from: string };
const listeners = new Set<(r: Request) => void>();
let seq = 0;

function Connector({ children }: { children: React.ReactNode }) {
  const { authToken, currentServerIP, currentUser, setCurrentServer } = useCore();

  useEffect(() => {
    legal.connect(authToken ? { token: authToken, serverIP: currentServerIP } : null);
  }, [authToken, currentServerIP]);

  // Recording and the timestamp service are a server-wide decision: only the superuser gets the page.
  useEffect(() => {
    if (currentUser?.is_superuser && moduleCtx && !settingsShown) {
      settingsShown = true;
      moduleCtx.slot('settings.page', { id: 'legal', label: () => tmStatic('lg_title'), icon: <Scale size={16} />, render: SettingsForm });
    }
  }, [currentUser]);

  // Signed in from a ?verify=… link: show the protocol the link points at.
  useEffect(() => {
    if (!authToken) return;
    const code = verifyLinkFromLocation();
    if (!code) return;
    clearVerifyLink();
    api.list({ token: authToken, serverIP: currentServerIP })
      .then(rows => {
        const hit = rows.find(p => p.code === code);
        setCurrentServer(navigate.moduleRoute(ROUTE, hit ? hit.id : ''));
      })
      .catch(() => setCurrentServer(navigate.moduleRoute(ROUTE, '')));
  }, [authToken, currentServerIP, setCurrentServer]);

  return <>{children}</>;
}

function Rail() {
  const t = useModuleT();
  const { currentServer, setCurrentServer } = useCore();
  const active = currentServer.startsWith(`${ROUTE}:`);
  return (
    <button className={`server-icon ${active ? 'active' : ''}`} title={t('lg_title')} aria-label={t('lg_title')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}>
      <Scale size={20} />
    </button>
  );
}

function Card() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  return (
    <ToolCard
      icon={<Scale size={20} color="#fff" />}
      gradient="linear-gradient(135deg,#7c3aed,#4f46e5)"
      tint="rgba(124,58,237"
      title={t('lg_title')}
      subtitle={t('lg_card_sub')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}
    />
  );
}

/** «Зафиксировать переписку» next to the message box. */
function ComposerButton({ kind, targetId }: ComposerActionProps) {
  const t = useModuleT();
  const conn = useConn();
  const { setCurrentServer } = useCore();
  const [scope, setScope] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (kind !== 'dm') return null;
  return (
    <>
      <button type="button" className="composer-icon-btn" title={t('lg_composer')} aria-label={t('lg_composer')} disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const rows = await api.conversations(conn);
            const hit = rows.find(r => r.participants.some(u => u.id === targetId));
            setScope(hit ? hit.scope : '');
          } finally {
            setBusy(false);
          }
        }}
        style={{ opacity: busy ? 0.5 : 1 }}>
        <Scale size={20} />
      </button>
      {scope !== null && (
        <CreateDialog lockScope={scope || undefined} onClose={() => setScope(null)}
          onCreated={p => { setScope(null); setCurrentServer(navigate.moduleRoute(ROUTE, p.id)); }} />
      )}
    </>
  );
}

/** Someone asked for a signature, or signed a protocol of ours. */
function Toasts() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  const [items, setItems] = useState<Request[]>([]);
  useEffect(() => {
    const on = (r: Request) => {
      setItems(v => [...v.filter(x => x.packageId !== r.packageId), r].slice(-4));
      setTimeout(() => setItems(v => v.filter(x => x.id !== r.id)), 20_000);
    };
    listeners.add(on);
    return () => { listeners.delete(on); };
  }, []);
  if (!items.length) return null;
  return (
    <div aria-live="polite" style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 8500, display: 'flex', flexDirection: 'column', gap: 8, width: 'min(340px, calc(100vw - 32px))' }}>
      {items.map(item => (
        <div key={item.id} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderLeft: '4px solid #7c3aed', borderRadius: 12, padding: 12, boxShadow: 'var(--shadow-lg)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <Logo size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{item.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{item.from}</div>
            </div>
            <button type="button" aria-label={t('lg_cancel')} onClick={() => setItems(v => v.filter(x => x.id !== item.id))}
              style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0 }}><X size={15} /></button>
          </div>
          <button type="button" onClick={() => { setItems(v => v.filter(x => x.id !== item.id)); setCurrentServer(navigate.moduleRoute(ROUTE, item.packageId)); }}
            style={{ width: '100%', marginTop: 10, padding: '6px 0', borderRadius: 8, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <FileSignature size={14} /> {t('lg_open')}
          </button>
        </div>
      ))}
    </div>
  );
}

export default defineModule({
  id: 'legal',
  setup(ctx) {
    moduleCtx = ctx;
    ctx.strings({ ru: { ...kitStrings.ru, ...strings.ru }, en: { ...kitStrings.en, ...strings.en } });

    // A judge or a counterparty opens ?verify=<code> without an account.
    const authRoute = () => ({ id: 'verify', match: () => !!verifyLinkFromLocation() && !verifySignIn, render: VerifyScreen });
    ctx.slot('auth.route', authRoute());
    const onSignIn = () => { verifySignIn = true; ctx.slot('auth.route', authRoute()); };
    window.addEventListener('sfera:legal-signin', onSignIn);
    ctx.onDispose(() => window.removeEventListener('sfera:legal-signin', onSignIn));

    ctx.slot('app.provider', { id: 'connector', render: Connector });
    ctx.slot('nav.rail', { id: 'legal', order: 35, render: Rail });
    ctx.slot('explore.card', { id: 'legal', order: 12, render: Card });
    ctx.slot('main.view', { id: 'legal', match: r => r.currentServer.startsWith(`${ROUTE}:`), render: LegalView });
    ctx.slot('app.overlay', { id: 'legal-toasts', render: Toasts });
    ctx.slot('chat.composerAction', { id: 'legal', render: ComposerButton });

    ctx.onWs('signaling', 'module:legal.sign_request', f => {
      const r: Request = { id: ++seq, packageId: String(f.package_id), title: String(f.title), from: String(f.from) };
      listeners.forEach(l => l(r));
      showDesktopNotification('dm', `⚖ ${r.title}`, r.from);
    });
    ctx.onWs('signaling', 'module:legal.signed', f => {
      listeners.forEach(l => l({ id: ++seq, packageId: String(f.package_id), title: String(f.by), from: String(f.code) }));
    });
    ctx.onDispose(() => { legal.connect(null); moduleCtx = null; settingsShown = false; });
  },
});
