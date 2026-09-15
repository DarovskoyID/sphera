import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { ToolCard, defineModule, navigate, tmStatic, useCore, useModuleStore, useModuleT, type ComposerActionProps, type ModuleContext } from '@sfera/sdk';
import { BitrixView, CreateDialog, Logo, ROUTE, SettingsForm } from './BitrixView';
import { createEventToasts, kitStrings } from './kit';
import * as bx from './store';
import { strings } from './i18n';

const toasts = createEventToasts('#2fc6f6', <Building2 size={16} />);
let moduleCtx: ModuleContext | null = null;
let settingsShown = false;

function Connector({ children }: { children: React.ReactNode }) {
  const { authToken, currentServerIP, currentUser } = useCore();
  useEffect(() => {
    bx.connect(authToken ? { token: authToken, serverIP: currentServerIP } : null);
  }, [authToken, currentServerIP]);
  useEffect(() => {
    if (currentUser?.is_superuser && moduleCtx && !settingsShown) {
      settingsShown = true;
      moduleCtx.slot('settings.page', { id: 'bitrix', label: () => tmStatic('bx_name'), icon: <Building2 size={16} />, render: SettingsPage });
    }
  }, [currentUser?.is_superuser]);
  return <>{children}</>;
}

function SettingsPage() {
  const t = useModuleT();
  return (
    <section>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Logo size={28} /> {t('bx_name')}</h1>
      <p>{t('bx_settings_intro')}</p>
      <SettingsForm />
    </section>
  );
}

function Card() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  return (
    <ToolCard
      icon={<Building2 size={20} color="#fff" />}
      gradient="linear-gradient(135deg,#2fc6f6,#0b66c3)"
      tint="rgba(47,198,246"
      title={t('bx_name')}
      subtitle={t('bx_card_sub')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}
    />
  );
}

function ComposerButton({ kind, targetId }: ComposerActionProps) {
  const t = useModuleT();
  const { friends } = useCore();
  const status = useModuleStore(bx.store, s => s.status);
  const [open, setOpen] = useState(false);
  if (!status?.can_act) return null;
  const peer = kind === 'dm' ? friends.find(f => f.id === targetId) : undefined;
  const name = peer ? peer.nickname || peer.username : '';
  return (
    <>
      <button type="button" className="composer-icon-btn" title={t('bx_composer')} aria-label={t('bx_composer')} onClick={() => setOpen(true)}>
        <Building2 size={20} />
      </button>
      {open && (
        <CreateDialog onClose={() => setOpen(false)} initial={{
          title: name ? tmStatic('bx_from').replace('{name}', name) : '', name, email: peer?.email ?? '', phone: peer?.phone ?? '',
        }} />
      )}
    </>
  );
}

export default defineModule({
  id: 'bitrix',
  setup(ctx) {
    moduleCtx = ctx;
    settingsShown = false;
    ctx.onDispose(() => { moduleCtx = null; settingsShown = false; bx.connect(null); });
    ctx.strings({ ru: { ...kitStrings.ru, ...strings.ru }, en: { ...kitStrings.en, ...strings.en } });
    ctx.slot('app.provider', { id: 'connector', render: Connector });
    ctx.slot('explore.card', { id: 'bitrix', order: 41, render: Card });
    ctx.slot('main.view', { id: 'bitrix', match: r => r.currentServer.startsWith(`${ROUTE}:`), render: BitrixView });
    ctx.slot('chat.composerAction', { id: 'bitrix-create', render: ComposerButton });
    ctx.slot('app.overlay', { id: 'bitrix-events', render: toasts.Toasts });
    ctx.onWs('signaling', 'module:bitrix.event', f => toasts.push(String(f.summary), f.url ? String(f.url) : undefined));
  },
});
