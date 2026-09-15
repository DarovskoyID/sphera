import { useEffect, useState } from 'react';
import { Briefcase } from 'lucide-react';
import { ToolCard, defineModule, navigate, tmStatic, useCore, useModuleStore, useModuleT, type ComposerActionProps, type ModuleContext } from '@sfera/sdk';
import { AmoView, LeadDialog, Logo, ROUTE, SettingsForm } from './AmoView';
import { createEventToasts, kitStrings } from './kit';
import * as amo from './store';
import { strings } from './i18n';

const toasts = createEventToasts('#339dc7', <Briefcase size={16} />);
let moduleCtx: ModuleContext | null = null;
let settingsShown = false;

function Connector({ children }: { children: React.ReactNode }) {
  const { authToken, currentServerIP, currentUser } = useCore();
  useEffect(() => {
    amo.connect(authToken ? { token: authToken, serverIP: currentServerIP } : null);
  }, [authToken, currentServerIP]);
  useEffect(() => {
    // Connection settings are for the superuser only: no empty tab for others.
    if (currentUser?.is_superuser && moduleCtx && !settingsShown) {
      settingsShown = true;
      moduleCtx.slot('settings.page', { id: 'amocrm', label: () => 'amoCRM', icon: <Briefcase size={16} />, render: SettingsPage });
    }
  }, [currentUser?.is_superuser]);
  return <>{children}</>;
}

function SettingsPage() {
  const t = useModuleT();
  return (
    <section>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Logo size={28} /> amoCRM</h1>
      <p>{t('am_settings_intro')}</p>
      <SettingsForm />
    </section>
  );
}

function Card() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  return (
    <ToolCard
      icon={<Briefcase size={20} color="#fff" />}
      gradient="linear-gradient(135deg,#339dc7,#1b5f8c)"
      tint="rgba(51,157,199"
      title="amoCRM"
      subtitle={t('am_card_sub')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}
    />
  );
}

/** Composer button: a lead from this conversation, with the contact filled in. */
function ComposerButton({ kind, targetId }: ComposerActionProps) {
  const t = useModuleT();
  const { friends } = useCore();
  const status = useModuleStore(amo.store, s => s.status);
  const [open, setOpen] = useState(false);
  if (!status?.can_act) return null;
  const peer = kind === 'dm' ? friends.find(f => f.id === targetId) : undefined;
  const name = peer ? peer.nickname || peer.username : '';
  return (
    <>
      <button type="button" className="composer-icon-btn" title={t('am_composer')} aria-label={t('am_composer')} onClick={() => setOpen(true)}>
        <Briefcase size={20} />
      </button>
      {open && (
        <LeadDialog onClose={() => setOpen(false)} initial={{
          name: name ? tmStatic('am_lead_from').replace('{name}', name) : '',
          contact_name: name, email: peer?.email ?? '', phone: peer?.phone ?? '',
        }} />
      )}
    </>
  );
}

export default defineModule({
  id: 'amocrm',
  setup(ctx) {
    moduleCtx = ctx;
    settingsShown = false;
    ctx.onDispose(() => { moduleCtx = null; settingsShown = false; amo.connect(null); });
    ctx.strings({ ru: { ...kitStrings.ru, ...strings.ru }, en: { ...kitStrings.en, ...strings.en } });
    ctx.slot('app.provider', { id: 'connector', render: Connector });
    ctx.slot('explore.card', { id: 'amocrm', order: 40, render: Card });
    ctx.slot('main.view', { id: 'amocrm', match: r => r.currentServer.startsWith(`${ROUTE}:`), render: AmoView });
    ctx.slot('chat.composerAction', { id: 'amocrm-lead', render: ComposerButton });
    ctx.slot('app.overlay', { id: 'amocrm-events', render: toasts.Toasts });
    ctx.onWs('signaling', 'module:amocrm.event', f => toasts.push(String(f.summary), f.url ? String(f.url) : undefined));
  },
});
