import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';
import type { RichMessageType } from '../types';

export interface RichContactCandidate {
  id: string;
  username: string;
  nickname?: string;
  avatar?: string;
}

interface Props {
  type: RichMessageType;
  contacts?: RichContactCandidate[];
  onCancel: () => void;
  /** Resolve to close; reject/throw to keep the dialog open on error. */
  onSubmit: (type: RichMessageType, payload: Record<string, unknown>) => Promise<void> | void;
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};
const sheet: React.CSSProperties = {
  width: '100%', maxWidth: 420, maxHeight: '85vh', overflowY: 'auto',
  background: 'var(--bg-secondary, #2b2d31)', borderRadius: 14, padding: 18,
  border: '1px solid var(--border-color, rgba(255,255,255,.1))',
};
const input: React.CSSProperties = {
  width: '100%', padding: '9px 11px', borderRadius: 8, fontSize: 14,
  border: '1px solid var(--border-color, rgba(255,255,255,.12))',
  background: 'var(--bg-tertiary, #1e1f22)', color: 'var(--text-primary)',
  outline: 'none', boxSizing: 'border-box',
};
const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: .4, textTransform: 'uppercase',
  color: 'var(--text-muted, #949ba4)', marginBottom: 6, display: 'block',
};
const primaryBtn: React.CSSProperties = {
  flex: 1, padding: '9px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--accent-primary)', color: '#fff', fontWeight: 600, fontSize: 14,
};
const ghostBtn: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 14,
  border: '1px solid var(--border-color, rgba(255,255,255,.12))',
  background: 'transparent', color: 'var(--text-primary)',
};

const TITLES: Record<RichMessageType, string> = {
  poll: 'poll_new', todo: 'todo_new', contact: 'contact_new', location: 'location_new',
};

export function RichComposer({ type, contacts = [], onCancel, onSubmit }: Props) {
  const tr = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // poll
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [duration, setDuration] = useState(0);

  // todo
  const [todoTitle, setTodoTitle] = useState('');
  const [items, setItems] = useState(['', '']);

  // contact
  const [contactMode, setContactMode] = useState<'user' | 'manual'>(contacts.length ? 'user' : 'manual');
  const [pickedUser, setPickedUser] = useState('');
  const [search, setSearch] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');

  // location
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoError, setGeoError] = useState('');
  const [liveMinutes, setLiveMinutes] = useState(0);

  useEffect(() => {
    if (type !== 'location') return;
    if (!navigator.geolocation) { setGeoError(tr('location_unsupported')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => setCoords({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setGeoError(tr('location_denied')),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [type, tr]);

  const editList = (list: string[], set: (v: string[]) => void, i: number, v: string) => {
    const next = [...list];
    next[i] = v;
    set(next);
  };

  const buildPayload = (): Record<string, unknown> | null => {
    if (type === 'poll') {
      const opts = options.map((o) => o.trim()).filter(Boolean);
      if (!question.trim()) { setError(tr('poll_need_question')); return null; }
      if (opts.length < 2) { setError(tr('poll_need_options')); return null; }
      return { question: question.trim(), options: opts, multiple, anonymous, duration_minutes: duration };
    }
    if (type === 'todo') {
      const list = items.map((o) => o.trim()).filter(Boolean);
      if (!list.length) { setError(tr('todo_need_items')); return null; }
      return { title: todoTitle.trim(), items: list };
    }
    if (type === 'contact') {
      if (contactMode === 'user') {
        if (!pickedUser) { setError(tr('contact_need_user')); return null; }
        return { kind: 'user', user_id: pickedUser };
      }
      if (!manualName.trim() || !manualPhone.trim()) { setError(tr('contact_need_fields')); return null; }
      return { kind: 'manual', name: manualName.trim(), phone: manualPhone.trim() };
    }
    if (type === 'location') {
      if (!coords) { setError(geoError || tr('location_waiting')); return null; }
      return { lat: coords.lat, lng: coords.lng, live_minutes: liveMinutes };
    }
    return null;
  };

  const submit = async () => {
    setError('');
    const payload = buildPayload();
    if (!payload) return;
    setBusy(true);
    try {
      await onSubmit(type, payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const filtered = contacts.filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return c.username.toLowerCase().includes(q) || (c.nickname || '').toLowerCase().includes(q);
  });

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={sheet} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)' }}>{tr(TITLES[type] as never)}</h3>
          <button onClick={onCancel} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted, #949ba4)' }}>
            <X size={18} />
          </button>
        </div>

        {type === 'poll' && (
          <>
            <label style={label}>{tr('poll_question')}</label>
            <input style={input} value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} autoFocus />
            <label style={{ ...label, marginTop: 12 }}>{tr('poll_options')}</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {options.map((o, i) => (
                <div key={i} style={{ display: 'flex', gap: 6 }}>
                  <input style={input} value={o} maxLength={100} onChange={(e) => editList(options, setOptions, i, e.target.value)} />
                  {options.length > 2 && (
                    <button onClick={() => setOptions(options.filter((_, j) => j !== i))} style={{ ...ghostBtn, padding: '0 10px' }}><X size={14} /></button>
                  )}
                </div>
              ))}
            </div>
            {options.length < 10 && (
              <button onClick={() => setOptions([...options, ''])} style={{ ...ghostBtn, marginTop: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
                <Plus size={14} /> {tr('poll_add_option')}
              </button>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 14 }}>
                <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} /> {tr('poll_allow_multiple')}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 14 }}>
                <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> {tr('poll_anonymous_votes')}
              </label>
            </div>
            <label style={{ ...label, marginTop: 12 }}>{tr('poll_duration')}</label>
            <select style={input} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              <option value={0}>{tr('poll_no_limit')}</option>
              <option value={60}>1 {tr('unit_hour')}</option>
              <option value={360}>6 {tr('unit_hours')}</option>
              <option value={1440}>1 {tr('unit_day')}</option>
              <option value={10080}>7 {tr('unit_days')}</option>
            </select>
          </>
        )}

        {type === 'todo' && (
          <>
            <label style={label}>{tr('todo_list_title')}</label>
            <input style={input} value={todoTitle} onChange={(e) => setTodoTitle(e.target.value)} maxLength={200} autoFocus />
            <label style={{ ...label, marginTop: 12 }}>{tr('todo_items')}</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {items.map((o, i) => (
                <div key={i} style={{ display: 'flex', gap: 6 }}>
                  <input
                    style={input} value={o} maxLength={200}
                    onChange={(e) => editList(items, setItems, i, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && i === items.length - 1 && items.length < 25) setItems([...items, '']); }}
                  />
                  {items.length > 1 && (
                    <button onClick={() => setItems(items.filter((_, j) => j !== i))} style={{ ...ghostBtn, padding: '0 10px' }}><X size={14} /></button>
                  )}
                </div>
              ))}
            </div>
            {items.length < 25 && (
              <button onClick={() => setItems([...items, ''])} style={{ ...ghostBtn, marginTop: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
                <Plus size={14} /> {tr('todo_add_item')}
              </button>
            )}
          </>
        )}

        {type === 'contact' && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <button
                onClick={() => setContactMode('user')}
                style={{ ...ghostBtn, flex: 1, borderColor: contactMode === 'user' ? 'var(--accent-primary)' : undefined }}
              >
                {tr('contact_from_sfera')}
              </button>
              <button
                onClick={() => setContactMode('manual')}
                style={{ ...ghostBtn, flex: 1, borderColor: contactMode === 'manual' ? 'var(--accent-primary)' : undefined }}
              >
                {tr('contact_manual')}
              </button>
            </div>
            {contactMode === 'user' ? (
              <>
                <input style={input} placeholder={tr('contact_search')} value={search} onChange={(e) => setSearch(e.target.value)} />
                <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {filtered.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setPickedUser(c.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 9, padding: 7, borderRadius: 8, textAlign: 'left',
                        border: `1px solid ${pickedUser === c.id ? 'var(--accent-primary)' : 'transparent'}`,
                        background: pickedUser === c.id ? 'rgba(255,255,255,.05)' : 'transparent',
                        cursor: 'pointer', color: 'var(--text-primary)',
                      }}
                    >
                      {c.avatar
                        ? <img src={c.avatar} alt="" style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover' }} />
                        : <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 700 }}>{(c.nickname || c.username).slice(0, 1).toUpperCase()}</div>}
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14 }}>{c.nickname || c.username}</span>
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted, #949ba4)' }}>@{c.username}</span>
                      </span>
                    </button>
                  ))}
                  {!filtered.length && <div style={{ fontSize: 13, color: 'var(--text-muted, #949ba4)', padding: 8 }}>{tr('contact_none')}</div>}
                </div>
              </>
            ) : (
              <>
                <label style={label}>{tr('contact_name')}</label>
                <input style={input} value={manualName} onChange={(e) => setManualName(e.target.value)} maxLength={100} />
                <label style={{ ...label, marginTop: 12 }}>{tr('contact_phone')}</label>
                <input style={input} value={manualPhone} onChange={(e) => setManualPhone(e.target.value)} maxLength={40} inputMode="tel" />
              </>
            )}
          </>
        )}

        {type === 'location' && (
          <>
            {coords ? (
              <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 12 }}>
                {tr('location_found')}: {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: geoError ? '#ef4444' : 'var(--text-muted, #949ba4)', marginBottom: 12 }}>
                {geoError || tr('location_waiting')}
              </div>
            )}
            <label style={label}>{tr('location_live_share')}</label>
            <select style={input} value={liveMinutes} onChange={(e) => setLiveMinutes(Number(e.target.value))}>
              <option value={0}>{tr('location_static')}</option>
              <option value={15}>15 {tr('unit_minutes')}</option>
              <option value={60}>1 {tr('unit_hour')}</option>
              <option value={480}>8 {tr('unit_hours')}</option>
            </select>
          </>
        )}

        {error && <div style={{ marginTop: 12, color: '#ef4444', fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button onClick={onCancel} style={ghostBtn}>{tr('cancel')}</button>
          <button onClick={submit} disabled={busy} style={{ ...primaryBtn, opacity: busy ? .6 : 1 }}>
            {busy ? tr('common_sending') : tr('common_send')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default RichComposer;
