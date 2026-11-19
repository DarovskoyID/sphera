import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Building2, CalendarClock, Check, Copy, Globe, Lock, MoreHorizontal, Plus, Trash2, UserPlus, Users, Video, X } from 'lucide-react';
import { navigate, reportError, useCore, useModuleT } from '@sfera/sdk';
import { api, conferenceLink, type Conference, type Conn, type Kind } from './api';
import { Room } from './Room';
import { Avatar, Button, Confirm, Empty, Field, MenuItem, Modal, PopMenu, Segmented, UserPicker, displayName, inputStyle, type UserBrief } from './ui';

export const ROUTE = 'conference';

export const KIND_META: Record<Kind, { icon: ReactNode; color: string }> = {
  internal: { icon: <Building2 size={16} />, color: '#3b82f6' },
  private: { icon: <Lock size={16} />, color: '#8b5cf6' },
  external: { icon: <Globe size={16} />, color: '#10b981' },
};

export function useConn(): Conn {
  const { authToken, currentServerIP } = useCore();
  return useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
}

export function KindBadge({ kind }: { kind: Kind }) {
  const t = useModuleT();
  const m = KIND_META[kind];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: m.color, background: `color-mix(in srgb, ${m.color} 14%, transparent)` }}>
      {m.icon} {t(`cf_kind_${kind}`)}
    </span>
  );
}

function CopyLink({ slug, small }: { slug: string; small?: boolean }) {
  const t = useModuleT();
  const [done, setDone] = useState(false);
  return (
    <Button small={small} onClick={() => {
      void navigator.clipboard.writeText(conferenceLink(slug)).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(reportError);
    }}>
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? t('cf_copied') : t('cf_copy_link')}
    </Button>
  );
}

export function CreateDialog({ onClose, onCreated, initialKind = 'internal', startNow = true }: {
  onClose: () => void; onCreated: (c: Conference) => void; initialKind?: Kind; startNow?: boolean;
}) {
  const t = useModuleT();
  const conn = useConn();
  const { currentServerIP } = useCore();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<Kind>(initialKind);
  const [when, setWhen] = useState<'now' | 'later'>(startNow ? 'now' : 'later');
  const [startsAt, setStartsAt] = useState('');
  const [invitees, setInvitees] = useState<UserBrief[]>([]);
  const [lobby, setLobby] = useState(false);
  const [busy, setBusy] = useState(false);
  const search = useCallback((q: string) => api.users(conn, q), [conn]);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const c = await api.create(conn, {
        title: title.trim(), kind, invitee_ids: invitees.map(u => u.id), guest_lobby: kind === 'external' && lobby,
        starts_at: when === 'later' && startsAt ? new Date(startsAt).toISOString() : null,
      });
      onCreated(c);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const kindCard = (k: Kind) => {
    const m = KIND_META[k];
    const active = kind === k;
    return (
      <button key={k} type="button" role="radio" aria-checked={active} onClick={() => setKind(k)} style={{
        flex: '1 1 150px', textAlign: 'left', padding: 12, borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
        border: `2px solid ${active ? m.color : 'var(--border-color)'}`, background: active ? `color-mix(in srgb, ${m.color} 8%, transparent)` : 'transparent',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: m.color, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{m.icon} {t(`cf_kind_${k}`)}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{t(`cf_kind_${k}_hint`)}</div>
      </button>
    );
  };

  return (
    <Modal title={t('cf_new')} onClose={onClose} width={560} footer={
      <>
        <Button onClick={onClose}>{t('cf_cancel')}</Button>
        <Button kind="primary" disabled={!title.trim() || busy || (kind === 'private' && invitees.length === 0)} onClick={() => void submit()}>
          {when === 'now' ? t('cf_create_and_join') : t('cf_schedule')}
        </Button>
      </>
    }>
      <Field label={t('cf_title_label')}>
        <input autoFocus value={title} maxLength={160} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
          placeholder={t('cf_title_ph')} style={inputStyle()} />
      </Field>
      <Field label={t('cf_who_can_join')}>
        <div role="radiogroup" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{(['internal', 'private', 'external'] as Kind[]).map(kindCard)}</div>
      </Field>
      {kind === 'private' && (
        <Field label={t('cf_invitees')} hint={t('cf_invitees_hint')}>
          <UserPicker search={search} serverIP={currentServerIP} exclude={invitees.map(u => u.id)} placeholder={t('cf_find_user')} onPick={u => setInvitees(v => [...v, u])} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {invitees.map(u => (
              <span key={u.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px 3px 3px', borderRadius: 999, background: 'var(--bg-tertiary)', fontSize: 13, color: 'var(--text-primary)' }}>
                <Avatar user={u} size={20} serverIP={currentServerIP} /> {displayName(u)}
                <X size={12} style={{ cursor: 'pointer' }} onClick={() => setInvitees(v => v.filter(x => x.id !== u.id))} />
              </span>
            ))}
          </div>
        </Field>
      )}
      {kind === 'external' && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
          <input type="checkbox" checked={lobby} onChange={e => setLobby(e.target.checked)} style={{ marginTop: 2 }} />
          <span><b style={{ color: 'var(--text-primary)' }}>{t('cf_lobby')}</b><br />{t('cf_lobby_hint')}</span>
        </label>
      )}
      <Field label={t('cf_when')}>
        <Segmented value={when} onChange={setWhen} options={[{ id: 'now', label: t('cf_now') }, { id: 'later', label: t('cf_later') }]} />
        {when === 'later' && <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} style={{ ...inputStyle(), marginTop: 8 }} />}
      </Field>
    </Modal>
  );
}

function ConferenceCard({ c, onOpen, onChanged }: { c: Conference; onOpen: () => void; onChanged: () => void }) {
  const t = useModuleT();
  const conn = useConn();
  const { language, currentServerIP } = useCore();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<'end' | 'delete' | null>(null);
  const live = c.participants > 0;
  const card: CSSProperties = {
    padding: 14, borderRadius: 14, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 10,
  };
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', background: `linear-gradient(135deg, ${KIND_META[c.kind].color}, #0ea5e9)` }}>
          <Video size={20} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <KindBadge kind={c.kind} />
            {live && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: '#ef4444' }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444' }} /> {t('cf_live').replace('{n}', String(c.participants))}</span>}
          </div>
        </div>
        {c.is_host && (
          <button type="button" aria-label={t('cf_more')} onClick={e => setMenu({ x: e.clientX - 180, y: e.clientY })} style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 4 }}>
            <MoreHorizontal size={17} />
          </button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
        <Avatar user={c.owner} size={18} serverIP={currentServerIP} /> {displayName(c.owner)}
        {c.starts_at && <><CalendarClock size={13} style={{ marginLeft: 6 }} /> {new Date(c.starts_at).toLocaleString(language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button kind="primary" onClick={onOpen} style={{ flex: 1 }}><Video size={15} /> {live ? t('cf_join') : t('cf_start')}</Button>
        {c.kind !== 'private' || c.is_host ? <CopyLink slug={c.slug} /> : null}
      </div>
      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem icon={<X size={14} />} label={t('cf_end')} onClick={() => { setMenu(null); setConfirm('end'); }} />
          <MenuItem danger icon={<Trash2 size={14} />} label={t('cf_delete')} onClick={() => { setMenu(null); setConfirm('delete'); }} />
        </PopMenu>
      )}
      {confirm && (
        <Confirm
          title={confirm === 'end' ? t('cf_end') : t('cf_delete')}
          message={confirm === 'end' ? t('cf_end_hint') : t('cf_delete_hint')}
          confirmLabel={confirm === 'end' ? t('cf_end') : t('cf_delete')}
          cancelLabel={t('cf_cancel')}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const what = confirm;
            setConfirm(null);
            try {
              if (what === 'end') await api.end(conn, c.slug); else await api.remove(conn, c.slug);
              onChanged();
            } catch (e) { reportError(e); }
          }}
        />
      )}
    </div>
  );
}

function List() {
  const t = useModuleT();
  const conn = useConn();
  const { setCurrentServer } = useCore();
  const [items, setItems] = useState<Conference[] | null>(null);
  const [creating, setCreating] = useState<Kind | null>(null);
  const [startNow, setStartNow] = useState(true);
  const load = useCallback(() => { api.list(conn).then(setItems).catch(e => { setItems([]); reportError(e); }); }, [conn]);
  useEffect(() => { load(); const i = setInterval(load, 20_000); return () => clearInterval(i); }, [load]);
  const open = (slug: string) => setCurrentServer(navigate.moduleRoute(ROUTE, slug));

  const quick = (k: Kind, icon: ReactNode) => (
    <button type="button" onClick={() => { setStartNow(true); setCreating(k); }} style={{
      flex: '1 1 200px', display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
      border: '1px solid var(--border-color)', background: 'var(--bg-secondary)',
    }}>
      <span style={{ width: 40, height: 40, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', background: KIND_META[k].color }}>{icon}</span>
      <span>
        <span style={{ display: 'block', fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{t(`cf_quick_${k}`)}</span>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)' }}>{t(`cf_kind_${k}_hint`)}</span>
      </span>
    </button>
  );

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '20px 20px 40px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg,#3b82f6,#0ea5e9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Video size={21} color="#fff" />
          </div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', flex: 1 }}>{t('cf_title')}</h1>
          <Button onClick={() => { setStartNow(false); setCreating('internal'); }}><CalendarClock size={15} /> {t('cf_schedule')}</Button>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 26 }}>
          {quick('internal', <Building2 size={19} />)}
          {quick('private', <UserPlus size={19} />)}
          {quick('external', <Globe size={19} />)}
        </div>
        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>{t('cf_available')}</div>
        {items && items.length === 0 ? (
          <Empty icon={<Users size={30} />} title={t('cf_empty')} hint={t('cf_empty_hint')} action={<Button kind="primary" onClick={() => { setStartNow(true); setCreating('internal'); }}><Plus size={15} /> {t('cf_new')}</Button>} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {(items ?? []).map(c => <ConferenceCard key={c.id} c={c} onOpen={() => open(c.slug)} onChanged={load} />)}
          </div>
        )}
      </div>
      {creating && (
        <CreateDialog initialKind={creating} startNow={startNow} onClose={() => setCreating(null)}
          onCreated={c => { setCreating(null); if (startNow) open(c.slug); else load(); }} />
      )}
    </div>
  );
}

function RoomRoute({ slug }: { slug: string }) {
  const t = useModuleT();
  const conn = useConn();
  const { setCurrentServer, currentUser } = useCore();
  const [conf, setConf] = useState<Conference | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get(conn, slug).then(setConf).catch(e => setError((e as { status?: number }).status === 404 ? 'cf_error_not_found' : 'cf_error_network'));
  }, [conn, slug]);
  const back = () => setCurrentServer(navigate.moduleRoute(ROUTE, ''));
  if (error) return <Empty icon={<Video size={30} />} title={t(error)} action={<Button onClick={back}>{t('cf_back')}</Button>} />;
  if (!conf) return <div style={{ flex: 1 }} />;
  if (conf.ended_at) {
    return (
      <Empty icon={<Video size={30} />} title={t('cf_ended')} action={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={back}>{t('cf_back')}</Button>
          {conf.is_host && <Button kind="primary" onClick={() => void api.update(conn, slug, { reopen: true }).then(setConf).catch(reportError)}>{t('cf_reopen')}</Button>}
        </div>
      } />
    );
  }
  return <Room conn={conn} slug={slug} title={conf.title} displayName={currentUser?.nickname || currentUser?.username || ''} onLeave={back} />;
}

export function ConferenceView({ style }: { style?: CSSProperties }) {
  const { currentServer } = useCore();
  const rest = navigate.parseModuleRoute(currentServer, ROUTE) ?? '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg-primary)', overflow: 'hidden', ...style }}>
      {rest ? <RoomRoute key={rest} slug={rest} /> : <List />}
    </div>
  );
}
