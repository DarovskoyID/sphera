import { useEffect, useState } from 'react';
import { FileText, X } from 'lucide-react';
import {
  ToolCard, defineModule, navigate, showDesktopNotification, useCore, useModuleT, type ComposerActionProps,
} from '@sfera/sdk';
import { CreateDialog, KIND_ICON, OfficeView, ROUTE } from './OfficeView';
import { strings } from './i18n';
import * as office from './store';
import type { Kind } from './types';

type Shared = { id: number; docId: string; title: string; from: string; kind: Kind };
const listeners = new Set<(s: Shared) => void>();
let seq = 0;

function Connector({ children }: { children: React.ReactNode }) {
  const { authToken, currentServerIP } = useCore();
  useEffect(() => {
    office.connect(authToken ? { token: authToken, serverIP: currentServerIP } : null);
  }, [authToken, currentServerIP]);
  return <>{children}</>;
}

function Rail() {
  const t = useModuleT();
  const { currentServer, setCurrentServer } = useCore();
  const active = currentServer.startsWith(`${ROUTE}:`);
  return (
    <button className={`server-icon ${active ? 'active' : ''}`} title={t('of_title')} aria-label={t('of_title')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}>
      <FileText size={20} />
    </button>
  );
}

function Card() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  return (
    <ToolCard
      icon={<FileText size={20} color="#fff" />}
      gradient="linear-gradient(135deg,#4f46e5,#0ea5e9)"
      tint="rgba(79,70,229"
      title={t('of_title')}
      subtitle={t('of_card_sub')}
      onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}
    />
  );
}

/** Start a document from a conversation and drop its link into the message box. */
function ComposerButton({ onPick }: ComposerActionProps) {
  const t = useModuleT();
  const [open, setOpen] = useState(false);
  const { setCurrentServer } = useCore();
  return (
    <>
      <button type="button" className="composer-icon-btn" title={t('of_composer')} aria-label={t('of_composer')}
        onClick={() => setOpen(true)}>
        <FileText size={20} />
      </button>
      {open && (
        <CreateDialog onClose={() => setOpen(false)} onCreated={doc => {
          setOpen(false);
          void office.refresh();
          onPick(`${t('of_title')}: ${doc.title}`);
          setCurrentServer(navigate.moduleRoute(ROUTE, doc.id));
        }} />
      )}
    </>
  );
}

/** Someone shared a document: a toast that opens it. */
function Toasts() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  const [items, setItems] = useState<Shared[]>([]);
  useEffect(() => {
    const on = (s: Shared) => {
      setItems(v => [...v.filter(x => x.docId !== s.docId), s].slice(-4));
      setTimeout(() => setItems(v => v.filter(x => x.id !== s.id)), 15_000);
    };
    listeners.add(on);
    return () => { listeners.delete(on); };
  }, []);
  if (!items.length) return null;
  return (
    <div aria-live="polite" style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 8500, display: 'flex', flexDirection: 'column', gap: 8, width: 'min(330px, calc(100vw - 32px))' }}>
      {items.map(item => (
        <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderLeft: '4px solid #4f46e5', borderRadius: 12, padding: '10px 12px', boxShadow: 'var(--shadow-lg)' }}>
          <span style={{ color: '#4f46e5', display: 'flex' }}>{KIND_ICON[item.kind] ?? KIND_ICON.doc}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('of_shared_toast')} · {item.from}</div>
          </div>
          <button type="button" onClick={() => { setItems(v => v.filter(x => x.id !== item.id)); setCurrentServer(navigate.moduleRoute(ROUTE, item.docId)); }}
            style={{ border: 'none', background: '#4f46e5', color: '#fff', borderRadius: 8, padding: '5px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
            {t('of_open')}
          </button>
          <button type="button" aria-label={t('of_close')} onClick={() => setItems(v => v.filter(x => x.id !== item.id))}
            style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export default defineModule({
  id: 'office',
  setup(ctx) {
    ctx.strings(strings);
    ctx.slot('app.provider', { id: 'connector', render: Connector });
    ctx.slot('nav.rail', { id: 'office', order: 28, render: Rail });
    ctx.slot('explore.card', { id: 'office', order: 8, render: Card });
    ctx.slot('main.view', { id: 'office', match: r => r.currentServer.startsWith(`${ROUTE}:`), render: OfficeView });
    ctx.slot('app.overlay', { id: 'office-toasts', render: Toasts });
    ctx.slot('chat.composerAction', { id: 'office', render: ComposerButton });
    ctx.onWs('signaling', 'module:office.shared', f => {
      const shared: Shared = {
        id: ++seq, docId: String(f.doc_id), title: String(f.title),
        from: String(f.from), kind: String(f.kind) as Kind,
      };
      listeners.forEach(l => l(shared));
      showDesktopNotification('dm', `📄 ${shared.title}`, shared.from);
      void office.refresh();
    });
    ctx.onDispose(() => office.connect(null));
  },
});
