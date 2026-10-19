import { useCallback, useState } from 'react';
import { Bot, Workflow } from 'lucide-react';
import { defineModule, ToolCard, useCore, useModuleT, type ComposerActionProps } from '@sfera/sdk';
import { BotCommandsButton } from './BotCommandsButton';
import { BotStudio } from './BotStudio';
import { openSferonik } from './botsApi';
import { strings } from './i18n';

/** Сфероник is a tool, not a contact: open its DM from the rail or Explore. */
function useOpenSferonik() {
  const { authToken, currentServerIP, setCurrentServer, setCurrentView, setCurrentChat, setMobileActivePanel } = useCore();
  const [busy, setBusy] = useState(false);
  const open = useCallback(async () => {
    if (busy || !authToken) return;
    setBusy(true);
    try {
      const { bot } = await openSferonik({ token: authToken, serverIP: currentServerIP });
      setCurrentServer('home');
      setCurrentView('home');
      setCurrentChat(bot.user_id);
      setMobileActivePanel('chat-view');
    } catch {
      // Stay where we are; the user can retry.
    } finally {
      setBusy(false);
    }
  }, [busy, authToken, currentServerIP, setCurrentServer, setCurrentView, setCurrentChat, setMobileActivePanel]);
  return { open, busy };
}

// Registering bots is not something a managed (child) account may do.
const useIsChild = () => !!useCore().currentUser?.is_child;

function Workspace() {
  const { setCurrentServer } = useCore();
  return <BotStudio onClose={() => setCurrentServer('explore')} />;
}

function RailButton() {
  const t = useModuleT();
  const { open, busy } = useOpenSferonik();
  if (useIsChild()) return null;
  return (
    <button className="server-icon" onClick={open} title={t('bots_rail_title')} style={{ opacity: busy ? 0.6 : 1 }}>
      <Bot size={20} />
    </button>
  );
}

function SferonikCard() {
  const t = useModuleT();
  const { open, busy } = useOpenSferonik();
  if (useIsChild()) return null;
  return (
    <ToolCard
      icon={<Bot size={20} color="#fff" />}
      gradient="linear-gradient(135deg,#5865f2,#4752c4)"
      tint="rgba(88,101,242"
      title={t('bots_sferonik')}
      subtitle={t('bots_sferonik_sub')}
      busy={busy}
      onClick={open}
    />
  );
}

function StudioCard() {
  const t = useModuleT();
  const [show, setShow] = useState(false);
  if (useIsChild()) return null;
  return (
    <>
      {show && <BotStudio onClose={() => setShow(false)} />}
      <ToolCard
        icon={<Workflow size={20} color="#fff" />}
        gradient="linear-gradient(135deg,#00a8fc,#0d7dc0)"
        tint="rgba(0,168,252"
        title={t('bots_studio')}
        subtitle={t('bots_studio_sub')}
        onClick={() => setShow(true)}
      />
    </>
  );
}

function ComposerCommands({ kind, targetId, token, serverIP, onPick }: ComposerActionProps) {
  return (
    <BotCommandsButton
      token={token}
      serverIP={serverIP}
      userId={kind === 'dm' ? targetId : undefined}
      channelId={kind === 'channel' ? targetId : undefined}
      onPick={onPick}
    />
  );
}

export default defineModule({
  id: 'bots',
  setup(ctx) {
    ctx.slot('main.view', { id: 'bots-workspace', match: route => route.currentServer === 'bots:', render: Workspace });
    ctx.strings(strings);
    ctx.slot('nav.rail', { id: 'sferonik', order: 10, render: RailButton });
    ctx.slot('explore.card', { id: 'sferonik', order: 10, render: SferonikCard });
    ctx.slot('explore.card', { id: 'studio', order: 11, render: StudioCard });
    ctx.slot('chat.composerAction', { id: 'commands', render: ComposerCommands });
  },
});
