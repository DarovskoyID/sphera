import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Check, CheckSquare, MapPin, MessageSquare, Phone, Radio, Square, User as UserIcon } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';
import type {
  ContactPayload,
  LocationPayload,
  PollPayload,
  RichMessageType,
  RichPayload,
  TodoPayload,
} from '../types';

// ── OSM slippy-map maths ─────────────────────────────────────────────────────
// A static preview without any map library: we compute which tiles cover the
// viewport and lay them out so the point sits dead centre.
const TILE = 256;

function lngToTileX(lng: number, z: number) {
  return ((lng + 180) / 360) * 2 ** z;
}
function latToTileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

const MAP_MAX_WIDTH = 320;

function MapPreview({ lat, lng, zoom = 15, height = 160 }: { lat: number; lng: number; zoom?: number; height?: number }) {
  // The tile layout is centred on the point, so it must be computed from the
  // width the box actually gets. Assuming a fixed width would leave the pin
  // (at left:50%) offset from the real coordinates on narrow screens.
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(MAP_MAX_WIDTH);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || MAP_MAX_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tiles = useMemo(() => {
    const n = 2 ** zoom;
    const originX = lngToTileX(lng, zoom) * TILE - width / 2;
    const originY = latToTileY(lat, zoom) * TILE - height / 2;
    const out: Array<{ key: string; url: string; left: number; top: number }> = [];
    for (let x = Math.floor(originX / TILE); x <= Math.floor((originX + width) / TILE); x++) {
      for (let y = Math.floor(originY / TILE); y <= Math.floor((originY + height) / TILE); y++) {
        if (y < 0 || y >= n) continue;
        const tx = ((x % n) + n) % n;
        out.push({
          key: `${x}_${y}`,
          url: `https://tile.openstreetmap.org/${zoom}/${tx}/${y}.png`,
          left: x * TILE - originX,
          top: y * TILE - originY,
        });
      }
    }
    return out;
  }, [lat, lng, zoom, height, width]);

  return (
    <div
      ref={boxRef}
      style={{
        position: 'relative', width: '100%', maxWidth: MAP_MAX_WIDTH, height, overflow: 'hidden',
        borderRadius: 10, background: 'var(--bg-tertiary, #2b2d31)',
      }}
    >
      {tiles.map((t) => (
        <img
          key={t.key}
          src={t.url}
          alt=""
          loading="lazy"
          draggable={false}
          style={{ position: 'absolute', left: t.left, top: t.top, width: TILE, height: TILE, userSelect: 'none' }}
        />
      ))}
      <div
        style={{
          position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -100%)',
          filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.5))', pointerEvents: 'none',
        }}
      >
        <MapPin size={30} color="#ef4444" fill="#ef4444" strokeWidth={1.5} />
      </div>
      <span
        style={{
          position: 'absolute', right: 4, bottom: 2, fontSize: 9, lineHeight: 1.4,
          padding: '1px 4px', borderRadius: 4, background: 'rgba(0,0,0,.55)', color: '#fff',
        }}
      >
        © OpenStreetMap
      </span>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border-color, rgba(255,255,255,.1))',
  background: 'var(--bg-secondary, #2b2d31)',
  borderRadius: 12,
  padding: 12,
  maxWidth: 360,
  marginTop: 4,
};

const headStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
  fontSize: 11, fontWeight: 700, letterSpacing: .4, textTransform: 'uppercase',
  color: 'var(--text-muted, #949ba4)',
};

// ── Poll ─────────────────────────────────────────────────────────────────────
function PollCard({ poll, canManage, onVote, onClose }: {
  poll: PollPayload;
  canManage: boolean;
  onVote?: (ids: string[]) => void;
  onClose?: () => void;
}) {
  const tr = useTranslation();
  const total = poll.options.reduce((s, o) => s + o.count, 0);
  const showResults = poll.closed || poll.voted;

  const pick = (id: string) => {
    if (poll.closed || !onVote) return;
    if (poll.multiple) {
      const next = poll.options.filter((o) => (o.id === id ? !o.me : o.me)).map((o) => o.id);
      onVote(next);
    } else {
      onVote(poll.options.find((o) => o.id === id)?.me ? [] : [id]);
    }
  };

  return (
    <div style={cardStyle}>
      <div style={headStyle}>
        <BarChart3 size={13} />
        {poll.closed ? tr('poll_closed') : poll.multiple ? tr('poll_multiple') : tr('poll_single')}
        {poll.anonymous && <span>· {tr('poll_anonymous')}</span>}
      </div>
      <div style={{ fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)' }}>{poll.question}</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {poll.options.map((o) => {
          const pct = total ? Math.round((o.count / total) * 100) : 0;
          return (
            <button
              key={o.id}
              onClick={() => pick(o.id)}
              disabled={poll.closed}
              title={!poll.anonymous && o.voters.length ? o.voters.map((v) => v.nickname || v.username).join(', ') : undefined}
              style={{
                position: 'relative', textAlign: 'left', padding: '8px 10px', borderRadius: 8,
                border: `1px solid ${o.me ? 'var(--accent-primary)' : 'var(--border-color, rgba(255,255,255,.1))'}`,
                background: 'var(--bg-tertiary, #1e1f22)', color: 'var(--text-primary)',
                cursor: poll.closed ? 'default' : 'pointer', overflow: 'hidden',
              }}
            >
              {showResults && (
                <span
                  style={{
                    position: 'absolute', inset: 0, width: `${pct}%`,
                    background: 'var(--accent-primary)', opacity: o.me ? 0.28 : 0.14,
                    transition: 'width .3s ease',
                  }}
                />
              )}
              <span style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    width: 15, height: 15, flexShrink: 0,
                    borderRadius: poll.multiple ? 4 : '50%',
                    border: `2px solid ${o.me ? 'var(--accent-primary)' : 'var(--text-muted, #949ba4)'}`,
                    background: o.me ? 'var(--accent-primary)' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {o.me && <Check size={10} color="#fff" strokeWidth={4} />}
                </span>
                <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{o.text}</span>
                {showResults && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted, #949ba4)', flexShrink: 0 }}>
                    {pct}% · {o.count}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, fontSize: 12, color: 'var(--text-muted, #949ba4)' }}>
        <span>{tr('poll_votes_count')}: {poll.total_voters}</span>
        {canManage && !poll.closed && onClose && (
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-primary)', fontSize: 12, padding: 0 }}
          >
            {tr('poll_close')}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Todo ─────────────────────────────────────────────────────────────────────
function TodoCard({ todo, onToggle }: { todo: TodoPayload; onToggle?: (id: string) => void }) {
  const tr = useTranslation();
  const pct = todo.total ? Math.round((todo.done_count / todo.total) * 100) : 0;
  return (
    <div style={cardStyle}>
      <div style={headStyle}>
        <CheckSquare size={13} />
        {tr('todo_title')}
        <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}>
          {todo.done_count}/{todo.total}
        </span>
      </div>
      {todo.title && <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--text-primary)' }}>{todo.title}</div>}

      <div style={{ height: 3, borderRadius: 3, background: 'var(--bg-tertiary, #1e1f22)', marginBottom: 10, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent-primary)', transition: 'width .3s ease' }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {todo.items.map((it) => (
          <button
            key={it.id}
            onClick={() => onToggle?.(it.id)}
            title={it.done && it.done_by ? `${tr('todo_done_by')}: ${it.done_by.nickname || it.done_by.username}` : undefined}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 6px', borderRadius: 6,
              border: 'none', background: 'none', cursor: onToggle ? 'pointer' : 'default',
              textAlign: 'left', color: 'var(--text-primary)',
            }}
          >
            {it.done
              ? <Check size={15} style={{ flexShrink: 0, marginTop: 2, color: 'var(--accent-primary)' }} />
              : <Square size={15} style={{ flexShrink: 0, marginTop: 2, color: 'var(--text-muted, #949ba4)' }} />}
            <span
              style={{
                flex: 1, minWidth: 0, wordBreak: 'break-word',
                textDecoration: it.done ? 'line-through' : 'none',
                opacity: it.done ? 0.55 : 1,
              }}
            >
              {it.text}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Contact ──────────────────────────────────────────────────────────────────
function ContactCard({ contact, onMessage }: { contact: ContactPayload; onMessage?: (userId: string) => void }) {
  const tr = useTranslation();
  const isUser = contact.kind === 'user';
  const name = isUser ? (contact.nickname || contact.username) : contact.name;
  const sub = isUser ? `@${contact.username}` : contact.phone;

  return (
    <div style={{ ...cardStyle, maxWidth: 300 }}>
      <div style={headStyle}><UserIcon size={13} />{tr('contact_title')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {isUser && contact.avatar
          ? <img src={contact.avatar} alt="" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
          : (
            <div style={{
              width: 40, height: 40, borderRadius: '50%', flexShrink: 0, background: 'var(--accent-primary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700,
            }}>
              {name.slice(0, 1).toUpperCase()}
            </div>
          )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted, #949ba4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        {isUser ? (
          <button
            onClick={() => onMessage?.(contact.user_id)}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '7px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
              background: 'var(--accent-primary)', color: '#fff', fontSize: 13, fontWeight: 600,
            }}
          >
            <MessageSquare size={14} /> {tr('contact_message')}
          </button>
        ) : (
          <a
            href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '7px 10px', borderRadius: 7, textDecoration: 'none',
              background: 'var(--accent-primary)', color: '#fff', fontSize: 13, fontWeight: 600,
            }}
          >
            <Phone size={14} /> {tr('contact_call')}
          </a>
        )}
      </div>
    </div>
  );
}

// ── Location ─────────────────────────────────────────────────────────────────
function useCountdown(until: string | null) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!until) { setLeft(0); return; }
    const tick = () => setLeft(Math.max(0, Math.floor((new Date(until).getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [until]);
  return left;
}

function LocationCard({ loc, isOwn, onStopLive }: { loc: LocationPayload; isOwn: boolean; onStopLive?: () => void }) {
  const tr = useTranslation();
  const left = useCountdown(loc.live ? loc.live_until : null);
  const liveActive = loc.live && left > 0;
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div style={{ ...cardStyle, maxWidth: 340 }}>
      <div style={headStyle}>
        {liveActive ? <Radio size={13} color="#ef4444" /> : <MapPin size={13} />}
        {liveActive ? tr('location_live') : tr('location_title')}
        {liveActive && (
          <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
            {mm}:{ss}
          </span>
        )}
      </div>

      <a
        href={`https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=16/${loc.lat}/${loc.lng}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: 'block', textDecoration: 'none' }}
      >
        <MapPreview lat={loc.lat} lng={loc.lng} />
      </a>

      {loc.label && <div style={{ marginTop: 8, color: 'var(--text-primary)', fontSize: 13 }}>{loc.label}</div>}
      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted, #949ba4)', fontVariantNumeric: 'tabular-nums' }}>
        {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}
      </div>

      {liveActive && isOwn && onStopLive && (
        <button
          onClick={onStopLive}
          style={{
            marginTop: 8, width: '100%', padding: '6px 10px', borderRadius: 7, cursor: 'pointer',
            border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: 12, fontWeight: 600,
          }}
        >
          {tr('location_stop')}
        </button>
      )}
    </div>
  );
}

// ── Entry point ──────────────────────────────────────────────────────────────
export interface RichMessageProps {
  type: RichMessageType;
  payload: RichPayload;
  isOwn: boolean;
  canManage?: boolean;
  onVote?: (optionIds: string[]) => void;
  onClosePoll?: () => void;
  onToggleTodo?: (itemId: string) => void;
  onStopLive?: () => void;
  onMessageContact?: (userId: string) => void;
}

export function RichMessage(props: RichMessageProps) {
  const { type, payload, isOwn, canManage = false } = props;
  if (!payload) return null;
  switch (type) {
    case 'poll':
      return <PollCard poll={payload as PollPayload} canManage={canManage || isOwn} onVote={props.onVote} onClose={props.onClosePoll} />;
    case 'todo':
      return <TodoCard todo={payload as TodoPayload} onToggle={props.onToggleTodo} />;
    case 'contact':
      return <ContactCard contact={payload as ContactPayload} onMessage={props.onMessageContact} />;
    case 'location':
      return <LocationCard loc={payload as LocationPayload} isOwn={isOwn} onStopLive={props.onStopLive} />;
    default:
      return null;
  }
}

export default RichMessage;
