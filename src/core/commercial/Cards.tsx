import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Bot, Briefcase, Building2, CalendarCheck, Check, Database, Download, FileText, Globe, Home, KeyRound, NotebookPen, PenTool, Puzzle, Rss, Scale, ShieldCheck, Users, Video, X, Trash2, type LucideIcon } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useCommercial, refreshCommercial, setCommercialInstallation } from './store';
import { openWorkspace } from './navigation';
import { MODULE_CATALOG } from './catalog';
import { formatSubscriptionExpiry } from './subscription';
import { ActivationForm } from './ActivationForm';

const icons: Record<string, LucideIcon> = { bot: Bot, rss: Rss, 'notebook-pen': NotebookPen, home: Home, users: Users, globe: Globe, video: Video, 'pen-tool': PenTool, 'calendar-check': CalendarCheck, briefcase: Briefcase, building: Building2, database: Database, 'file-text': FileText, 'shield-check': ShieldCheck, scale: Scale };
const colors = ['#5865f2', '#8b5cf6', '#0891b2', '#3b82f6', '#d97706', '#db2777'];
type Module = typeof MODULE_CATALOG[number];
const nameOf = (module: Module, ru: boolean) => module.name[ru ? 'ru' : 'en'];

function InstallDialog({ module, close }: { module: Module; close: () => void }) {
  const { language } = useApp();
  const ru = language === 'ru';
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { dialog.current?.showModal(); dialog.current?.querySelector('input')?.focus(); }, []);
  return createPortal(<dialog className="commercial-surface" ref={dialog} aria-labelledby="module-install-title" onCancel={event => { event.preventDefault(); if (!pending) close(); }} style={{ position: 'fixed', inset: 0, margin: 'auto', width: 'min(460px, calc(100vw - 32px))', height: 'fit-content', boxSizing: 'border-box', padding: 24, borderRadius: 20, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', boxShadow: '0 24px 80px #0008', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto' }}>
    <style>{'dialog::backdrop { background: rgba(0,0,0,.65); backdrop-filter: blur(4px); }'}</style>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <KeyRound size={24} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
      <h2 id="module-install-title" style={{ margin: 0, fontSize: 20, flex: 1 }}>{nameOf(module, ru)}</h2>
      <button aria-label={ru ? 'Закрыть' : 'Close'} disabled={pending} onClick={close} style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', padding: 6 }}><X size={20} /></button>
    </div>
    <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{ru ? 'Введите ключ, чтобы установить модуль для всех пользователей этого сервера.' : 'Enter an access key to install this module for everyone on this server.'}</p>
    <ActivationForm moduleId={module.id} onActivated={close} onPendingChange={setPending} autoFocus />
  </dialog>, document.body);
}

function RemoveDialog({ module, pending, error, close, confirm }: { module: Module; pending: boolean; error: string; close: () => void; confirm: () => void }) {
  const { language } = useApp();
  const ru = language === 'ru';
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className="commercial-surface" aria-labelledby="module-remove-title" onCancel={event => { event.preventDefault(); if (!pending) close(); }} style={{ position: 'fixed', inset: 0, margin: 'auto', width: 'min(460px, calc(100vw - 32px))', height: 'fit-content', boxSizing: 'border-box', padding: 24, borderRadius: 20, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto' }}>
    <style>{'dialog::backdrop { background: rgba(0,0,0,.65); backdrop-filter: blur(4px); }'}</style>
    <h2 id="module-remove-title" style={{ margin: '0 0 12px', fontSize: 20 }}>{ru ? 'Удалить модуль?' : 'Remove module?'}</h2>
    <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>{nameOf(module, ru)}. {ru ? 'Инструменты модуля будут отключены для всех пользователей сервера. Данные и подписка сохранятся — модуль можно установить снова.' : 'This module will be disabled for everyone on the server. Data and the subscription are kept, so you can reinstall it.'}</p>
    {error && <p role="alert" style={{ color: '#ef4444', marginTop: 12 }}>{error}</p>}
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
      <button disabled={pending} onClick={close}>{ru ? 'Отмена' : 'Cancel'}</button>
      <button disabled={pending} onClick={confirm} style={{ background: '#dc2626', border: 0, color: '#fff' }}>{pending ? (ru ? 'Удаление…' : 'Removing…') : (ru ? 'Удалить' : 'Remove')}</button>
    </div>
  </dialog>, document.body);
}

export function CommercialCards() {
  const { language, currentUser, setCurrentServer, setCurrentSettingsPage, currentServerIP } = useApp();
  const { services, status, server } = useCommercial();
  const [install, setInstall] = useState<Module | null>(null);
  const [remove, setRemove] = useState<Module | null>(null);
  const [mutation, setMutation] = useState<string | null>(null);
  const [error, setError] = useState('');
  const ru = language === 'ru';
  const canManage = !!currentUser?.is_superuser;
  // A node/user change closes the key form instead of submitting it elsewhere.
  useEffect(() => { setInstall(null); setRemove(null); setError(''); }, [currentServerIP, currentUser?.id]);
  const changeInstallation = async (module: Module, enabled: boolean) => {
    if (mutation) return;
    setMutation(module.id); setError('');
    try { await setCommercialInstallation(module.id, enabled); setRemove(null); }
    catch { setError(ru ? 'Не удалось изменить установку модуля. Проверьте подключение и повторите.' : 'Could not change module installation. Check the connection and retry.'); }
    finally { setMutation(null); }
  };
  const current = server === currentServerIP && status === 'ready';
  return <section className="commercial-surface" style={{ padding: '20px 24px 0' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{ru ? 'Модули' : 'Modules'}</h3>
      <button onClick={() => { setCurrentServer('settings'); setCurrentSettingsPage('subscriptions'); }} style={{ border: 0, background: 'transparent', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>{ru ? 'Ключи и подписки' : 'Keys and subscriptions'} <ArrowUpRight size={13} style={{ verticalAlign: 'middle' }} /></button>
    </div>
    {status !== 'loading' && !current && <p role="status" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{ru ? 'Не удалось проверить доступ к модулям.' : 'Could not check module access.'} <button onClick={() => void refreshCommercial(true)}>{ru ? 'Повторить' : 'Retry'}</button></p>}
    {error && !remove && <p role="alert" style={{ color: '#ef4444' }}>{error}</p>}
    {!canManage && <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{ru ? 'Модули устанавливает администратор сервера.' : 'The server administrator installs modules.'}</p>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 230px), 1fr))', gap: 12 }}>
      {MODULE_CATALOG.map((module, index) => {
        const grant = current ? services.find(service => service.id === module.id) : undefined;
        const installed = grant?.available === true && grant.installed !== false;
        const expires = formatSubscriptionExpiry(grant?.subscription.expires_at, language);
        const renewal = grant && ['expired', 'revoked', 'paused'].includes(grant.subscription.status);
        const Icon = icons[module.icon] || Puzzle;
        const color = colors[index % colors.length];
        return <article key={module.id} data-module-id={module.id} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, borderRadius: 14, background: 'var(--bg-secondary)', border: `1px solid ${installed ? 'var(--accent-primary)' : 'var(--border-color)'}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 13, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `linear-gradient(135deg, ${color}, ${colors[(index + 1) % colors.length]})`, boxShadow: `0 4px 14px ${color}25` }}><Icon size={22} color="#fff" /></div>
            <div style={{ minWidth: 0, flex: 1 }}><div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{nameOf(module, ru)}</div><div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>{ru ? 'Для всего сервера' : 'For the whole server'}</div></div>
            {installed && <Check size={17} aria-label={ru ? 'Установлен' : 'Installed'} style={{ color: 'var(--accent-primary)' }} />}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, flex: 1 }}>{module.description[ru ? 'ru' : 'en']}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: installed ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}>{installed ? <Check size={13} /> : <KeyRound size={13} />}{installed ? (ru ? 'Установлен' : 'Installed') : grant?.available && grant.installed === false ? (ru ? 'Удалён с сервера' : 'Removed from server') : renewal ? (ru ? 'Требуется продление ключа' : 'Key renewal required') : (ru ? 'Доступ по ключу' : 'Access with a key')}</div>
          {expires && <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{ru ? 'До ' : 'Until '}<time dateTime={grant?.subscription.expires_at || undefined}>{expires}</time></div>}
          <div style={{ display: 'flex', gap: 8 }}>
          <button disabled={mutation === module.id || (!installed && !canManage)} onClick={() => installed ? openWorkspace(module.id, setCurrentServer, setCurrentSettingsPage) : grant?.available && grant.installed === false ? void changeInstallation(module, true) : setInstall(module)} style={{ flex: 1, padding: '10px 12px', borderRadius: 9, fontWeight: 600, fontSize: 13, border: 0, background: installed ? 'var(--bg-tertiary)' : 'var(--accent-primary)', color: installed ? 'var(--text-primary)' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, cursor: installed || canManage ? 'pointer' : 'default', opacity: installed || canManage ? 1 : .5 }}>
            {installed ? <ArrowUpRight size={15} /> : <Download size={15} />}{installed ? (ru ? 'Открыть' : 'Open') : (ru ? 'Установить' : 'Install')}
          </button>
          {installed && canManage && <button aria-label={ru ? `Удалить модуль ${nameOf(module, ru)}` : `Remove ${nameOf(module, ru)}`} disabled={mutation === module.id} onClick={() => { setError(''); setRemove(module); }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 8px', fontSize: 13, color: 'var(--text-secondary)' }}><Trash2 size={14} />{ru ? 'Удалить' : 'Remove'}</button>}
          </div>
        </article>;
      })}
    </div>
    {remove && <RemoveDialog module={remove} pending={mutation === remove.id} error={error} close={() => { setRemove(null); setError(''); }} confirm={() => void changeInstallation(remove, false)} />}
    {install && <InstallDialog key={`${currentServerIP}:${install.id}`} module={install} close={() => setInstall(null)} />}
  </section>;
}
