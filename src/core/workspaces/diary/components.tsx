import { useCommercial, workspaceEnabled } from '../../commercial/store';
import { useEffect, useState, type CSSProperties } from 'react';
import { NotebookPen, Trash2, X } from 'lucide-react';
import { ToolCard, navigate, useCore, useModuleStore, useModuleT } from '@sfera/sdk';
import * as diary from './store';
import { MAX_DIARIES } from './types';
import { DiaryView } from './DiaryView';

export const ROUTE = 'diary';

/** Keeps the store connected to the signed-in account. */
export function DiaryConnector({ children }: { children: React.ReactNode }) {
  const { authToken, currentServerIP, currentServer } = useCore();
  useCommercial();
  const enabled = workspaceEnabled('diary', currentServerIP, currentServer);
  useEffect(() => {
    diary.connect(enabled && authToken ? { token: authToken, serverIP: currentServerIP } : null);
  }, [authToken, currentServerIP, enabled]);
  useEffect(() => () => diary.connect(null), []);
  return <>{children}</>;
}

export function DiaryRoute({ style }: { style?: CSSProperties }) {
  const { currentServer } = useCore();
  const id = navigate.parseModuleRoute(currentServer, ROUTE);
  return id ? <DiaryView diaryId={id} style={style} /> : null;
}

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};
const sheet: CSSProperties = {
  background: 'var(--bg-secondary)', borderRadius: 12, padding: 22, maxWidth: 380, width: '100%',
  border: '1px solid var(--border-color)',
};
const input = (error = false): CSSProperties => ({
  width: '100%', padding: '9px 11px', borderRadius: 8, fontSize: 14,
  border: `1px solid ${error ? '#ef4444' : 'var(--border-color)'}`,
  background: 'var(--bg-tertiary)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box',
});
const ghost: CSSProperties = {
  padding: '8px 18px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 14, cursor: 'pointer',
};

/** Diaries in the left rail: one icon each, right-click to delete. */
export function DiaryRail() {
  const t = useModuleT();
  const { currentServer, setCurrentServer } = useCore();
  const diaries = useModuleStore(diary.store, s => s.diaries);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => { setConfirm(null); setPwd(''); setErr(''); };
  const target = diaries.find(d => d.id === confirm);

  return (
    <>
      {diaries.map(d => {
        const route = navigate.moduleRoute(ROUTE, d.id);
        return (
          <button
            key={d.id}
            className={`server-icon ${currentServer === route ? 'active' : ''}`}
            title={`${d.name} (${t('pcf_diary')})`}
            onClick={() => setCurrentServer(route)}
            onContextMenu={e => { e.preventDefault(); setMenu({ id: d.id, x: e.clientX, y: e.clientY }); }}
            style={{ position: 'relative', borderRadius: '50%', background: 'linear-gradient(135deg,#a855f7,#7c3aed)', color: '#fff', fontWeight: 700 }}
          >
            {d.name.slice(0, 2).toUpperCase()}
            <span style={{
              position: 'absolute', right: -2, bottom: -2, width: 16, height: 16, borderRadius: '50%',
              background: '#a855f7', border: '2.5px solid var(--bg-secondary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <NotebookPen size={8.5} color="#fff" />
            </span>
          </button>
        );
      })}

      {menu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={() => setMenu(null)} />
          <div className="context-menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1000 }}>
            <button className="context-menu-item" style={{ color: '#ef4444' }} onClick={() => { setConfirm(menu.id); setMenu(null); }}>
              <Trash2 size={14} /> {t('diary_delete')}
            </button>
          </div>
        </>
      )}

      {target && (
        <div style={overlay} onClick={close}>
          <div style={sheet} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 8px', color: 'var(--text-primary)', fontSize: 17, fontWeight: 700 }}>{t('diary_delete')}</h3>
            <p style={{ margin: '0 0 14px', color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.45 }}>{t('diary_delete_hint')}</p>
            <input type="password" autoFocus value={pwd} onChange={e => { setPwd(e.target.value); setErr(''); }} style={input(!!err)} />
            {err && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={close} style={ghost}>{t('diary_cancel')}</button>
              <button
                disabled={busy || !pwd}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await diary.deleteDiary(target.id, pwd);
                    if (currentServer === navigate.moduleRoute(ROUTE, target.id)) setCurrentServer('home');
                    close();
                  } catch {
                    setErr(t('diary_wrong_password'));
                  } finally {
                    setBusy(false);
                  }
                }}
                style={{ ...ghost, background: '#ef4444', color: '#fff', border: 'none', fontWeight: 600, opacity: busy || !pwd ? 0.6 : 1 }}
              >
                {busy ? t('diary_deleting') : t('diary_delete_btn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** «Исследовать сферу» card that creates a diary. */
export function CreateDiaryCard() {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  const count = useModuleStore(diary.store, s => s.diaries.length);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  if (count >= MAX_DIARIES) return null;

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const d = await diary.createDiary(name.trim());
      setOpen(false);
      setName('');
      setCurrentServer(navigate.moduleRoute(ROUTE, d.id));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ToolCard
        icon={<NotebookPen size={20} color="#fff" />}
        gradient="linear-gradient(135deg,#a855f7,#7c3aed)"
        tint="rgba(168,85,247"
        title={t('diary_card_title')}
        subtitle={count === 0
          ? t('diary_card_sub')
          : t('diary_card_more').replace('{left}', String(MAX_DIARIES - count)).replace('{max}', String(MAX_DIARIES))}
        onClick={() => setOpen(true)}
      />
      {open && (
        <div style={overlay} onClick={() => setOpen(false)}>
          <div style={sheet} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)', flex: 1 }}>{t('diary_card_title')}</h3>
              <X size={16} style={{ cursor: 'pointer', color: 'var(--text-tertiary)' }} onClick={() => setOpen(false)} />
            </div>
            <input
              autoFocus
              value={name}
              maxLength={100}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void create(); }}
              placeholder={t('diary_name')}
              style={input()}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
              <button onClick={() => setOpen(false)} style={ghost}>{t('diary_cancel')}</button>
              <button onClick={() => void create()} disabled={busy || !name.trim()}
                style={{ ...ghost, background: '#a855f7', color: '#fff', border: 'none', fontWeight: 600, opacity: busy || !name.trim() ? 0.6 : 1 }}>
                {t('diary_create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
