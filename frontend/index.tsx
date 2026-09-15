import { useEffect } from 'react';
import { PenTool } from 'lucide-react';
import { ToolCard, defineModule, navigate, useCore, useModuleT } from '@sfera/sdk';
import * as boards from './store';
import { ROUTE, WhiteboardView } from './BoardsView';
import { strings } from './i18n';

function Connector({ children }: { children: React.ReactNode }) {
  const { authToken, currentServerIP } = useCore();
  useEffect(() => {
    boards.connect(authToken ? { token: authToken, serverIP: currentServerIP } : null);
  }, [authToken, currentServerIP]);
  return <>{children}</>;
}

function Rail() {
  const t = useModuleT();
  const { currentServer, setCurrentServer } = useCore();
  return (
    <button className={`server-icon ${currentServer.startsWith(`${ROUTE}:`) ? 'active' : ''}`} title={t('wb_title')} aria-label={t('wb_title')}
      onClick={() => { void boards.refresh(); setCurrentServer(navigate.moduleRoute(ROUTE, '')); }}>
      <PenTool size={20} />
    </button>
  );
}

function Card() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  return (
    <ToolCard
      icon={<PenTool size={20} color="#fff" />}
      gradient="linear-gradient(135deg,#f97316,#ec4899)"
      tint="rgba(249,115,22"
      title={t('wb_title')}
      subtitle={t('wb_card_sub')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}
    />
  );
}

export default defineModule({
  id: 'whiteboard',
  setup(ctx) {
    ctx.strings(strings);
    ctx.slot('app.provider', { id: 'connector', render: Connector });
    ctx.slot('nav.rail', { id: 'whiteboard', order: 35, render: Rail });
    ctx.slot('explore.card', { id: 'whiteboard', order: 20, render: Card });
    ctx.slot('main.view', { id: 'whiteboard', match: r => r.currentServer.startsWith(`${ROUTE}:`), render: WhiteboardView });
    ctx.onDispose(() => boards.connect(null));
  },
});
