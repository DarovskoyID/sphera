import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { ToolCard, defineModule, navigate, tmStatic, useCore, useModuleStore, useModuleT, type ComposerActionProps, type ModuleContext } from '@sfera/sdk';
import { Browser, Logo, OneCView, ROUTE, SettingsForm } from './OneCView';
import { createEventToasts, kitStrings } from './kit';
import * as onec from './store';
import { strings } from './i18n';
import { Modal } from './ui';

const toasts = createEventToasts('#f08c00', <Database size={16} />);
let moduleCtx: ModuleContext | null = null;
let settingsShown = false;

function Connector({ children }: { children: React.ReactNode }) {
  const { authToken, currentServerIP, currentUser } = useCore();
  useEffect(() => {
    onec.connect(authToken ? { token: authToken, serverIP: currentServerIP } : null);
  }, [authToken, currentServerIP]);
  useEffect(() => {
    if (currentUser?.is_superuser && moduleCtx && !settingsShown) {
      settingsShown = true;
      moduleCtx.slot('settings.page', { id: 'onec', label: () => tmStatic('oc_name'), icon: <Database size={16} />, render: SettingsPage });
    }
  }, [currentUser?.is_superuser]);
  return <>{children}</>;
}

function SettingsPage() {
  const t = useModuleT();
  return (
    <section>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Logo size={28} /> {t('oc_name_full')}</h1>
      <p>{t('oc_settings_intro')}</p>
      <SettingsForm />
    </section>
  );
}

function Card() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  return (
    <ToolCard
      icon={<Database size={20} color="#fff" />}
      gradient="linear-gradient(135deg,#ffd43b,#f08c00)"
      tint="rgba(240,140,0"
      title={t('oc_name_full')}
      subtitle={t('oc_card_sub')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}
    />
  );
}

/** Composer button: find a counterparty or document in 1C and put it into the message. */
function ComposerButton({ onPick }: ComposerActionProps) {
  const t = useModuleT();
  const status = useModuleStore(onec.store, s => s.status);
  const [open, setOpen] = useState(false);
  if (!status?.can_act) return null;
  return (
    <>
      <button type="button" className="composer-icon-btn" title={t('oc_composer')} aria-label={t('oc_composer')} onClick={() => setOpen(true)}>
        <Database size={20} />
      </button>
      {open && (
        <Modal width={640} title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Logo size={26} /> {t('oc_composer')}</span>} onClose={() => setOpen(false)}>
          <Browser onInsert={text => { onPick(text); setOpen(false); }} />
        </Modal>
      )}
    </>
  );
}

export default defineModule({
  id: 'onec',
  setup(ctx) {
    moduleCtx = ctx;
    settingsShown = false;
    ctx.onDispose(() => { moduleCtx = null; settingsShown = false; onec.connect(null); });
    ctx.strings({ ru: { ...kitStrings.ru, ...strings.ru }, en: { ...kitStrings.en, ...strings.en } });
    ctx.slot('app.provider', { id: 'connector', render: Connector });
    ctx.slot('explore.card', { id: 'onec', order: 42, render: Card });
    ctx.slot('main.view', { id: 'onec', match: r => r.currentServer.startsWith(`${ROUTE}:`), render: OneCView });
    ctx.slot('chat.composerAction', { id: 'onec-insert', render: ComposerButton });
    ctx.slot('app.overlay', { id: 'onec-events', render: toasts.Toasts });
    ctx.onWs('signaling', 'module:onec.event', f => toasts.push(String(f.summary), f.url ? String(f.url) : undefined));
  },
});
