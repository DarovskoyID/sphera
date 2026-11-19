import React, { useCallback, useEffect, useState } from 'react';
import { Ban, Check, Flag, Search, ShieldCheck, Trash2, Undo2 } from 'lucide-react';
import { useApp, reportError } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { ListSkeleton } from './Skeleton';

// Superuser-only admin panel: reports on messages and system-wide bans.

interface Brief { id: string; username: string; nickname: string; avatar: string; is_active: boolean }
interface Report {
  id: string;
  created_at: string;
  reporter: Brief;
  author: Brief & { banned: boolean };
  message: { id: string; content: string; created_at: string; attachments: number };
  resolved_at: string | null;
  resolution: string;
  reports_on_author: number;
}
interface BanRow { user: Brief; reason: string; created_at: string; banned_by: Brief | null }
interface FoundUser extends Brief { is_superuser: boolean; banned: boolean; reports: number }

const panel: React.CSSProperties = {
  background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 14, marginBottom: 10,
};
const muted: React.CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)' };
const btn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 500,
  border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const danger: React.CSSProperties = { ...btn, borderColor: '#ef444466', color: '#ef4444' };
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 6, fontSize: 14,
  border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none',
};

const name = (u?: Brief | null) => (u ? u.nickname || u.username : '—');
const when = (iso: string) => new Date(iso).toLocaleString();

function useAdminApi() {
  const { currentServerIP, authToken } = useApp();
  return useCallback(async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${currentServerIP}/api/admin/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }, [currentServerIP, authToken]);
}

const Tab: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    style={{
      ...btn, border: 'none', borderRadius: 0, padding: '8px 2px', marginRight: 18,
      borderBottom: `2px solid ${active ? 'var(--text-primary)' : 'transparent'}`,
      color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
    }}
  >
    {children}
  </button>
);

const ReportsTab: React.FC<{ isRu: boolean; onBanned: () => void }> = ({ isRu, onBanned }) => {
  const api = useAdminApi();
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [rows, setRows] = useState<Report[] | null>(null);

  const load = useCallback(() => {
    setRows(null);
    api(`reports/?status=${status}`).then(d => setRows(d.reports)).catch(e => { reportError(e); setRows([]); });
  }, [api, status]);
  useEffect(load, [load]);

  const resolve = async (r: Report, resolution: 'dismissed' | 'deleted') => {
    if (resolution === 'deleted' && !window.confirm(isRu ? 'Удалить сообщение для всех?' : 'Delete this message for everyone?')) return;
    try {
      await api(`reports/${r.id}/resolve/`, { method: 'POST', body: JSON.stringify({ resolution }) });
      load();
    } catch (e) { reportError(e); }
  };

  const ban = async (r: Report) => {
    const reason = window.prompt(isRu ? `Причина блокировки ${name(r.author)}` : `Reason for banning ${name(r.author)}`, '');
    if (reason === null) return;
    try {
      await api('bans/', { method: 'POST', body: JSON.stringify({ user_id: r.author.id, reason }) });
      load();
      onBanned();
    } catch (e) { reportError(e); }
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        {(['open', 'resolved'] as const).map(s => (
          <button key={s} onClick={() => setStatus(s)} style={{ ...btn, background: status === s ? 'var(--active-bg)' : 'transparent' }}>
            {s === 'open' ? (isRu ? 'Открытые' : 'Open') : (isRu ? 'Закрытые' : 'Resolved')}
          </button>
        ))}
      </div>
      {rows === null ? <ListSkeleton rows={3} /> : rows.length === 0 ? (
        <div style={{ ...muted, padding: '24px 0', textAlign: 'center' }}>{isRu ? 'Жалоб нет' : 'No reports'}</div>
      ) : rows.map(r => (
        <div key={r.id} style={panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 13 }}>
              <b>{name(r.author)}</b> <span style={muted}>@{r.author.username}</span>
              {r.author.banned && <span style={{ ...muted, color: '#ef4444', marginLeft: 6 }}>{isRu ? 'заблокирован' : 'banned'}</span>}
              <span style={{ ...muted, marginLeft: 8 }}>{isRu ? 'жалоб на автора' : 'reports on author'}: {r.reports_on_author}</span>
            </div>
            <span style={muted}>{when(r.created_at)}</span>
          </div>
          <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '8px 10px', borderRadius: 6, background: 'var(--bg-primary)' }}>
            {r.message.content || <span style={muted}>{isRu ? '(без текста)' : '(no text)'}</span>}
            {r.message.attachments > 0 && <div style={{ ...muted, marginTop: 4 }}>📎 {r.message.attachments}</div>}
          </div>
          <div style={{ ...muted, margin: '8px 0' }}>{isRu ? 'Пожаловался' : 'Reported by'}: {name(r.reporter)}</div>
          {r.resolved_at ? (
            <div style={muted}>{r.resolution === 'dismissed' ? (isRu ? 'Отклонено' : 'Dismissed') : r.resolution} · {when(r.resolved_at)}</div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button style={btn} onClick={() => resolve(r, 'dismissed')}><Check size={14} />{isRu ? 'Отклонить' : 'Dismiss'}</button>
              <button style={danger} onClick={() => resolve(r, 'deleted')}><Trash2 size={14} />{isRu ? 'Удалить сообщение' : 'Delete message'}</button>
              {!r.author.banned && <button style={danger} onClick={() => ban(r)}><Ban size={14} />{isRu ? 'Заблокировать автора' : 'Ban author'}</button>}
            </div>
          )}
        </div>
      ))}
    </>
  );
};

const BansTab: React.FC<{ isRu: boolean; version: number }> = ({ isRu, version }) => {
  const api = useAdminApi();
  const [rows, setRows] = useState<BanRow[] | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<FoundUser[]>([]);

  const load = useCallback(() => {
    api('bans/').then(d => setRows(d.bans)).catch(e => { reportError(e); setRows([]); });
  }, [api]);
  useEffect(load, [load, version]);

  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => {
      api(`users/?q=${encodeURIComponent(q.trim())}`).then(d => setFound(d.users)).catch(reportError);
    }, 300);
    return () => clearTimeout(t);
  }, [q, api]);

  const ban = async (u: FoundUser) => {
    const reason = window.prompt(isRu ? `Причина блокировки ${name(u)}` : `Reason for banning ${name(u)}`, '');
    if (reason === null) return;
    try {
      await api('bans/', { method: 'POST', body: JSON.stringify({ user_id: u.id, reason }) });
      setFound(prev => prev.map(x => (x.id === u.id ? { ...x, banned: true } : x)));
      load();
    } catch (e) { reportError(e); }
  };

  const unban = async (id: string) => {
    try {
      await api(`bans/${id}/`, { method: 'DELETE' });
      setFound(prev => prev.map(x => (x.id === id ? { ...x, banned: false } : x)));
      load();
    } catch (e) { reportError(e); }
  };

  return (
    <>
      <div style={{ position: 'relative', margin: '12px 0' }}>
        <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
        <input value={q} onChange={e => setQ(e.target.value)} style={{ ...input, paddingLeft: 32 }}
          placeholder={isRu ? 'Найти пользователя, чтобы заблокировать' : 'Find a user to ban'} />
      </div>
      {found.map(u => (
        <div key={u.id} style={{ ...panel, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 14 }}>
            <b>{name(u)}</b> <span style={muted}>@{u.username} · {isRu ? 'жалоб' : 'reports'}: {u.reports}</span>
          </div>
          {u.is_superuser ? <ShieldCheck size={16} style={{ color: 'var(--text-tertiary)' }} />
            : u.banned ? <button style={btn} onClick={() => unban(u.id)}><Undo2 size={14} />{isRu ? 'Разблокировать' : 'Unban'}</button>
              : <button style={danger} onClick={() => ban(u)}><Ban size={14} />{isRu ? 'Заблокировать' : 'Ban'}</button>}
        </div>
      ))}

      <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.4px', margin: '20px 0 10px' }}>
        {isRu ? 'Заблокированы в системе' : 'Banned system-wide'}
      </h3>
      {rows === null ? <ListSkeleton rows={3} /> : rows.length === 0 ? (
        <div style={{ ...muted, padding: '16px 0' }}>{isRu ? 'Никто не заблокирован' : 'Nobody is banned'}</div>
      ) : rows.map(b => (
        <div key={b.user.id} style={{ ...panel, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14 }}><b>{name(b.user)}</b> <span style={muted}>@{b.user.username}</span></div>
            <div style={muted}>{b.reason || (isRu ? 'Без причины' : 'No reason')} · {when(b.created_at)}</div>
          </div>
          <button style={btn} onClick={() => unban(b.user.id)}><Undo2 size={14} />{isRu ? 'Разблокировать' : 'Unban'}</button>
        </div>
      ))}
    </>
  );
};

export const AdminPanel: React.FC = () => {
  const { currentUser } = useApp();
  const tr = useTranslation();
  const isRu = tr('settings_formatting') === 'Подсказки';
  const [tab, setTab] = useState<'reports' | 'bans'>('reports');
  const [bansVersion, setBansVersion] = useState(0);

  if (!currentUser?.is_superuser) return null;
  return (
    <section>
      <h1>{isRu ? 'Админ-панель' : 'Admin panel'}</h1>
      <p>{isRu
        ? 'Жалобы на сообщения и блокировки во всей системе. Заблокированный пользователь не может войти в Сферу, пока вы не снимете блокировку.'
        : 'Message reports and system-wide bans. A banned user cannot sign in to Sfera until you lift the ban.'}</p>
      <div style={{ borderBottom: '1px solid var(--border-color)' }}>
        <Tab active={tab === 'reports'} onClick={() => setTab('reports')}><Flag size={14} />{isRu ? 'Жалобы' : 'Reports'}</Tab>
        <Tab active={tab === 'bans'} onClick={() => setTab('bans')}><Ban size={14} />{isRu ? 'Блокировки' : 'Bans'}</Tab>
      </div>
      {tab === 'reports'
        ? <ReportsTab isRu={isRu} onBanned={() => setBansVersion(v => v + 1)} />
        : <BansTab isRu={isRu} version={bansVersion} />}
    </section>
  );
};
