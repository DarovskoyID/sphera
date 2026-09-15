import { useEffect, useRef, useState } from 'react';
import { Bell, CalendarCheck, X } from 'lucide-react';
import { ToolCard, defineModule, navigate, showDesktopNotification, useCore, useModuleT } from '@sfera/sdk';
import { api } from './api';
import * as planner from './store';
import { PlannerView, ROUTE } from './PlannerView';
import { formatDue } from './dates';
import { strings } from './i18n';
import type { Task } from './types';

function PlannerConnector({ children }: { children: React.ReactNode }) {
  const { authToken, currentServerIP } = useCore();
  useEffect(() => {
    planner.connect(authToken ? { token: authToken, serverIP: currentServerIP } : null);
  }, [authToken, currentServerIP]);
  return <>{children}</>;
}

function PlannerRail() {
  const t = useModuleT();
  const { currentServer, setCurrentServer } = useCore();
  const active = currentServer.startsWith(`${ROUTE}:`);
  return (
    <button className={`server-icon ${active ? 'active' : ''}`} title={t('pl_title')} aria-label={t('pl_title')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}>
      <CalendarCheck size={20} />
    </button>
  );
}

function PlannerCard() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  return (
    <ToolCard
      icon={<CalendarCheck size={20} color="#fff" />}
      gradient="linear-gradient(135deg,#10b981,#0ea5e9)"
      tint="rgba(16,185,129"
      title={t('pl_title')}
      subtitle={t('pl_card_sub')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}
    />
  );
}

/** Asks the server every minute which reminders came due and shows them. */
function Reminders() {
  const t = useModuleT();
  const { authToken, currentServerIP, language, setCurrentServer } = useCore();
  const [items, setItems] = useState<Task[]>([]);
  const busy = useRef(false);

  useEffect(() => {
    if (!authToken) return;
    const conn = { token: authToken, serverIP: currentServerIP };
    const check = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const due = await api.reminders(conn);
        if (due.length) {
          setItems(prev => [...prev.filter(p => !due.some(d => d.id === p.id)), ...due].slice(-5));
          due.forEach(task => showDesktopNotification('server', `⏰ ${task.title}`, task.project_name ?? t('pl_title')));
        }
      } catch { /* offline or module removed */ } finally {
        busy.current = false;
      }
    };
    void check();
    const timer = setInterval(check, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [authToken, currentServerIP, t]);

  const dismiss = (id: string) => setItems(prev => prev.filter(x => x.id !== id));
  const snooze = (task: Task) => {
    dismiss(task.id);
    setTimeout(() => setItems(prev => [...prev.filter(x => x.id !== task.id), task]), 10 * 60_000);
  };

  if (!items.length) return null;
  return (
    <div aria-live="polite" style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 8500, display: 'flex', flexDirection: 'column', gap: 8, width: 'min(340px, calc(100vw - 32px))' }}>
      {items.map(task => (
        <div key={task.id} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderLeft: '4px solid #f59e0b', borderRadius: 12, padding: 12, boxShadow: 'var(--shadow-lg)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <Bell size={16} color="#f59e0b" style={{ marginTop: 2, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{task.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {task.project_name} {task.due_at && `· ${formatDue(task.due_at, language, task.all_day)}`}
              </div>
            </div>
            <button type="button" aria-label={t('pl_close')} onClick={() => dismiss(task.id)} style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0 }}><X size={15} /></button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={() => { dismiss(task.id); setCurrentServer(navigate.moduleRoute(ROUTE, task.project_id)); }}
              style={{ flex: 1, padding: '6px 0', borderRadius: 8, border: 'none', background: 'var(--accent-primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
              {t('pl_open')}
            </button>
            <button type="button" onClick={() => snooze(task)}
              style={{ flex: 1, padding: '6px 0', borderRadius: 8, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
              {t('pl_snooze')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default defineModule({
  id: 'planner',
  setup(ctx) {
    ctx.strings(strings);
    ctx.slot('app.provider', { id: 'connector', render: PlannerConnector });
    ctx.slot('nav.rail', { id: 'planner', order: 30, render: PlannerRail });
    ctx.slot('explore.card', { id: 'planner', order: 10, render: PlannerCard });
    ctx.slot('app.overlay', { id: 'reminders', render: Reminders });
    ctx.slot('main.view', { id: 'planner', match: route => route.currentServer.startsWith(`${ROUTE}:`), render: PlannerView });
    ctx.onWs('signaling', 'module:planner.changed', f => planner.onRemoteChanged(f as never));
    ctx.onWs('signaling', 'module:planner.comment', f => planner.onRemoteChanged(f as never));
    ctx.onWs('signaling', 'module:planner.removed', f => planner.onRemoteRemoved(f as never));
    ctx.onDispose(() => planner.connect(null));
  },
});
