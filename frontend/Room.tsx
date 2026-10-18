import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  ChevronLeft, ChevronRight, Copy, Hand, LayoutGrid, Link2, Maximize2, MessageSquare, Mic, MicOff, MonitorUp, MonitorX, MoreVertical, PhoneOff,
  Send, Smile, UserCheck, UserX, Users, Video, VideoOff, WifiOff, X,
} from 'lucide-react';
import { reportError, setBusy, isBusy, useCore, useModuleT } from '@sfera/sdk';
import { conferenceLink, type Conn } from './api';
import { RoomClient, type Participant } from './roomClient';
import { Avatar, Button, IconButton, MenuItem, PopMenu, inputStyle, useIsMobile } from './ui';

const REACTIONS = ['👍', '👏', '😂', '🎉', '❤️', '🤔'];

function VideoEl({ track, stream, muted, mirror, fit = 'cover', onVisible }: {
  track?: MediaStreamTrack; stream?: MediaStream | null; muted?: boolean; mirror?: boolean; fit?: 'cover' | 'contain'; onVisible?: (v: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = stream ?? (track ? new MediaStream([track]) : null);
    if (el.srcObject !== next) el.srcObject = next;
    if (next) void el.play().catch(() => {});
  }, [track, stream]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !onVisible) return;
    const io = new IntersectionObserver(([e]) => onVisible(e.isIntersecting), { threshold: 0.01 });
    io.observe(el);
    return () => { io.disconnect(); onVisible(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <video ref={ref} autoPlay playsInline muted={muted}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit, transform: mirror ? 'scaleX(-1)' : undefined, background: '#000', display: 'block' }} />
  );
}

function AudioEl({ track }: { track?: MediaStreamTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = track ? new MediaStream([track]) : null;
      if (track) void ref.current.play().catch(() => {});
    }
  }, [track]);
  return <audio ref={ref} autoPlay style={{ display: 'none' }} />;
}

// ── Pre-join ─────────────────────────────────────────────────────────────────

export function PreJoin({ title, name, onJoin, onCancel }: {
  title: string; name: string; onJoin: (o: { audio: boolean; video: boolean; audioDevice?: string; videoDevice?: string }) => void; onCancel?: () => void;
}) {
  const t = useModuleT();
  const [audio, setAudio] = useState(true);
  const [video, setVideo] = useState(true);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevice, setAudioDevice] = useState('');
  const [videoDevice, setVideoDevice] = useState('');
  const [denied, setDenied] = useState(false);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    let dead = false;
    let stream: MediaStream | null = null;
    let raf = 0;
    let ctx: AudioContext | null = null;
    (async () => {
      if (!audio && !video) { setPreview(null); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audio ? { deviceId: audioDevice ? { exact: audioDevice } : undefined } : false,
          video: video ? { deviceId: videoDevice ? { exact: videoDevice } : undefined, width: { ideal: 1280 } } : false,
        });
        if (dead) { stream.getTracks().forEach(tr => tr.stop()); return; }
        setDenied(false);
        setPreview(stream);
        setDevices(await navigator.mediaDevices.enumerateDevices());
        if (audio && stream.getAudioTracks()[0]) {
          ctx = new AudioContext();
          const an = ctx.createAnalyser();
          an.fftSize = 256;
          ctx.createMediaStreamSource(stream).connect(an);
          const data = new Uint8Array(an.frequencyBinCount);
          const loop = () => { an.getByteFrequencyData(data); setLevel(Math.min(1, data.reduce((a, b) => a + b, 0) / data.length / 60)); raf = requestAnimationFrame(loop); };
          loop();
        }
      } catch {
        if (!dead) setDenied(true);
      }
    })();
    return () => { dead = true; cancelAnimationFrame(raf); void ctx?.close().catch(() => {}); stream?.getTracks().forEach(tr => tr.stop()); };
  }, [audio, video, audioDevice, videoDevice]);

  const mics = devices.filter(d => d.kind === 'audioinput');
  const cams = devices.filter(d => d.kind === 'videoinput');
  const toggle = (on: boolean, color = 'var(--bg-tertiary)'): CSSProperties => ({
    width: 48, height: 48, borderRadius: '50%', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: on ? color : '#ef4444', color: on ? 'var(--text-primary)' : '#fff',
  });

  return (
    <div style={{ height: '100%', overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box', background: 'var(--bg-primary)' }}>
      <div style={{ display: 'flex', gap: 28, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center', maxWidth: 980, width: '100%' }}>
        <div style={{ flex: '1 1 440px', maxWidth: 620 }}>
          <div style={{ position: 'relative', aspectRatio: '16 / 10', borderRadius: 18, overflow: 'hidden', background: '#111', boxShadow: 'var(--shadow-lg)' }}>
            {video && preview?.getVideoTracks()[0] ? <VideoEl stream={preview} muted mirror /> : (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,.6)', flexDirection: 'column', gap: 8 }}>
                <VideoOff size={34} />
                <span style={{ fontSize: 13 }}>{denied ? t('cf_devices_denied') : t('cf_camera_off')}</span>
              </div>
            )}
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 14, display: 'flex', justifyContent: 'center', gap: 12 }}>
              <button type="button" aria-label={audio ? t('cf_mic_off') : t('cf_mic_on')} title={audio ? t('cf_mic_off') : t('cf_mic_on')} onClick={() => setAudio(v => !v)} style={{ ...toggle(audio, 'rgba(255,255,255,.18)'), color: '#fff', position: 'relative' }}>
                {audio ? <Mic size={20} /> : <MicOff size={20} />}
                {audio && <span style={{ position: 'absolute', inset: -3, borderRadius: '50%', border: `3px solid rgba(34,197,94,${level})`, pointerEvents: 'none' }} />}
              </button>
              <button type="button" aria-label={video ? t('cf_cam_off') : t('cf_cam_on')} title={video ? t('cf_cam_off') : t('cf_cam_on')} onClick={() => setVideo(v => !v)} style={{ ...toggle(video, 'rgba(255,255,255,.18)'), color: '#fff' }}>
                {video ? <Video size={20} /> : <VideoOff size={20} />}
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {mics.length > 1 && (
              <select aria-label={t('cf_microphone')} value={audioDevice} onChange={e => setAudioDevice(e.target.value)} style={{ ...inputStyle(), flex: 1, minWidth: 180 }}>
                <option value="">{t('cf_default_mic')}</option>
                {mics.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
              </select>
            )}
            {cams.length > 1 && (
              <select aria-label={t('cf_camera')} value={videoDevice} onChange={e => setVideoDevice(e.target.value)} style={{ ...inputStyle(), flex: 1, minWidth: 180 }}>
                <option value="">{t('cf_default_cam')}</option>
                {cams.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
              </select>
            )}
          </div>
        </div>
        <div style={{ flex: '0 1 320px', textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 6 }}>{t('cf_ready_to_join')}</div>
          <h1 style={{ margin: '0 0 6px', fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{title}</h1>
          <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: 20 }}>{t('cf_joining_as').replace('{name}', name)}</div>
          <Button kind="primary" onClick={() => { preview?.getTracks().forEach(tr => tr.stop()); onJoin({ audio, video, audioDevice: audioDevice || undefined, videoDevice: videoDevice || undefined }); }}
            style={{ padding: '12px 36px', fontSize: 15, borderRadius: 999 }}>
            {t('cf_join_now')}
          </Button>
          {onCancel && <div><Button kind="plain" onClick={onCancel} style={{ marginTop: 10 }}>{t('cf_back')}</Button></div>}
        </div>
      </div>
    </div>
  );
}

// ── Tiles ────────────────────────────────────────────────────────────────────

interface TileInfo {
  key: string;
  participant: Participant;
  self: boolean;
  kind: 'camera' | 'screen';
}

function Tile({ tile, client, compact, onPin, pinned }: { tile: TileInfo; client: RoomClient; compact?: boolean; onPin?: () => void; pinned?: boolean }) {
  const t = useModuleT();
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const p = tile.participant;
  const media = state.media[p.identity] ?? {};
  const speaking = state.speaking.has(p.identity);
  const track = tile.kind === 'screen' ? (tile.self ? undefined : media.screen) : tile.self ? undefined : media.camera;
  const localStream = tile.self ? (tile.kind === 'screen' ? state.localStreams.screen : state.localStreams.camera) : null;
  const hasVideo = !!track || !!localStream;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const reaction = state.reactions.filter(r => r.peer_id === p.peer_id).slice(-1)[0];
  const isHost = !!state.me?.host && !tile.self;

  return (
    <div
      onDoubleClick={onPin}
      style={{
        position: 'relative', borderRadius: compact ? 10 : 14, overflow: 'hidden', background: '#1c1d21', minHeight: 0, minWidth: 0,
        boxShadow: speaking && tile.kind === 'camera' ? '0 0 0 3px #22c55e inset, 0 0 0 1px #22c55e' : '0 0 0 1px rgba(255,255,255,.06)',
        transition: 'box-shadow .15s',
      }}
    >
      {hasVideo ? (
        <VideoEl track={track} stream={localStream} muted mirror={tile.self && tile.kind === 'camera'} fit={tile.kind === 'screen' ? 'contain' : 'cover'}
          onVisible={tile.self || tile.kind === 'screen' ? undefined : v => client.setVisible(p.identity, v)} />
      ) : (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Avatar user={{ id: p.identity, username: p.name, avatar: p.avatar }} size={compact ? 40 : 72} />
        </div>
      )}
      <div style={{ position: 'absolute', left: 8, bottom: 8, right: 8, display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'none' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%', padding: '3px 8px', borderRadius: 8,
          background: 'rgba(0,0,0,.55)', color: '#fff', fontSize: compact ? 11 : 12.5, fontWeight: 600, backdropFilter: 'blur(4px)',
        }}>
          {tile.kind === 'screen' && <MonitorUp size={12} />}
          {tile.kind === 'camera' && !p.audio && <MicOff size={12} color="#f87171" />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tile.kind === 'screen' ? t('cf_screen_of').replace('{name}', tile.self ? t('cf_you') : p.name) : tile.self ? `${p.name} (${t('cf_you')})` : p.name}
          </span>
          {p.guest && tile.kind === 'camera' && <span style={{ fontSize: 10, opacity: 0.75 }}>· {t('cf_guest')}</span>}
          {p.host && tile.kind === 'camera' && <span style={{ fontSize: 10, opacity: 0.75 }}>· {t('cf_host')}</span>}
        </span>
        {state.poor.has(p.identity) && <WifiOff size={13} color="#fbbf24" />}
      </div>
      {p.hand && tile.kind === 'camera' && (
        <span style={{ position: 'absolute', left: 8, top: 8, width: 30, height: 30, borderRadius: '50%', background: '#f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }} title={t('cf_hand_raised')}>
          <Hand size={16} />
        </span>
      )}
      {reaction && tile.kind === 'camera' && (
        <span key={reaction.id} style={{ position: 'absolute', right: 12, bottom: 38, fontSize: compact ? 26 : 38, animation: 'cf-float 4s ease-out forwards', pointerEvents: 'none' }}>{reaction.emoji}</span>
      )}
      {!compact && (onPin || isHost) && (
        <div className="cf-tile-actions" style={{ position: 'absolute', right: 6, top: 6, display: 'flex', gap: 4 }}>
          {onPin && (
            <button type="button" title={pinned ? t('cf_unpin') : t('cf_pin')} aria-label={pinned ? t('cf_unpin') : t('cf_pin')} onClick={onPin}
              style={{ width: 28, height: 28, borderRadius: 8, border: 'none', background: 'rgba(0,0,0,.5)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {pinned ? <LayoutGrid size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          {isHost && tile.kind === 'camera' && (
            <button type="button" title={t('cf_manage')} aria-label={t('cf_manage')} onClick={e => setMenu({ x: e.clientX, y: e.clientY })}
              style={{ width: 28, height: 28, borderRadius: 8, border: 'none', background: 'rgba(0,0,0,.5)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <MoreVertical size={14} />
            </button>
          )}
        </div>
      )}
      {menu && (
        <PopMenu x={menu.x - 190} y={menu.y} onClose={() => setMenu(null)}>
          {p.audio && <MenuItem icon={<MicOff size={14} />} label={t('cf_ask_mute')} onClick={() => { client.host('mute', p.peer_id); setMenu(null); }} />}
          {p.hand && <MenuItem icon={<Hand size={14} />} label={t('cf_lower_hand')} onClick={() => { client.host('lower-hand', p.peer_id); setMenu(null); }} />}
          <MenuItem danger icon={<UserX size={14} />} label={t('cf_remove')} onClick={() => { client.host('kick', p.peer_id); setMenu(null); }} />
        </PopMenu>
      )}
    </div>
  );
}

/** Columns × rows that give tiles the largest 16:9 area in the given box. */
function bestGrid(count: number, width: number, height: number) {
  let best = { cols: 1, rows: 1, size: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const w = width / cols;
    const h = height / rows;
    const size = Math.min(w, (h * 16) / 9);
    if (size > best.size) best = { cols, rows, size };
  }
  return best;
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 800, h: 500 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function Stage({ client, mobile }: { client: RoomClient; mobile: boolean }) {
  const t = useModuleT();
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const box = useRef<HTMLDivElement>(null);
  const size = useSize(box);
  const [page, setPage] = useState(0);
  const [pinned, setPinned] = useState<string | null>(null);

  const tiles = useMemo(() => {
    if (!state.me) return [];
    const me: TileInfo = { key: `self:camera`, participant: { ...state.me, ...state.local }, self: true, kind: 'camera' };
    const people = [...state.peers].sort((a, b) => Number(b.hand) - Number(a.hand) || Number(state.speaking.has(b.identity)) - Number(state.speaking.has(a.identity)) || a.joined_at - b.joined_at);
    const cams = people.map<TileInfo>(p => ({ key: `${p.peer_id}:camera`, participant: p, self: false, kind: 'camera' }));
    const screens = [
      ...(state.local.screen ? [{ key: 'self:screen', participant: { ...state.me, ...state.local }, self: true, kind: 'screen' as const }] : []),
      ...people.filter(p => p.screen && state.media[p.identity]?.screen).map<TileInfo>(p => ({ key: `${p.peer_id}:screen`, participant: p, self: false, kind: 'screen' })),
    ];
    return [...screens, me, ...cams];
    // `speaking` reorders the grid; ignore it to avoid tiles jumping around every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.me, state.peers, state.local, state.media]);

  const focus = tiles.find(x => x.key === pinned) ?? tiles.find(x => x.kind === 'screen' && !x.self) ?? null;
  const perPage = mobile ? 6 : size.w > 1400 ? 30 : 20;
  const rest = focus ? tiles.filter(x => x.key !== focus.key) : tiles;
  const pages = Math.max(1, Math.ceil(rest.length / perPage));
  const current = Math.min(page, pages - 1);
  const visible = rest.slice(current * perPage, current * perPage + perPage);

  // Every remote audio plays, whether or not the tile is on the current page.
  const audio = state.peers.map(p => {
    const m = state.media[p.identity];
    return (
      <span key={p.peer_id}>
        <AudioEl track={m?.audio} />
        {m?.screenAudio && <AudioEl track={m.screenAudio} />}
      </span>
    );
  });

  const pager = pages > 1 && (
    <div style={{ position: 'absolute', left: '50%', bottom: 6, transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(0,0,0,.55)', borderRadius: 999, padding: '2px 6px', color: '#fff', fontSize: 12, zIndex: 2 }}>
      <IconButton title={t('cf_prev_page')} onClick={() => setPage(Math.max(0, current - 1))} style={{ color: '#fff', width: 26, height: 26 }}><ChevronLeft size={15} /></IconButton>
      {current + 1} / {pages}
      <IconButton title={t('cf_next_page')} onClick={() => setPage(Math.min(pages - 1, current + 1))} style={{ color: '#fff', width: 26, height: 26 }}><ChevronRight size={15} /></IconButton>
    </div>
  );

  if (focus) {
    const stripVertical = size.w > size.h;
    return (
      <div ref={box} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: stripVertical ? 'row' : 'column', gap: 8, padding: 8, position: 'relative' }}>
        {audio}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'grid', gridTemplateRows: 'minmax(0, 1fr)', gridTemplateColumns: 'minmax(0, 1fr)' }}>
            <Tile tile={focus} client={client} pinned={pinned === focus.key} onPin={() => setPinned(pinned === focus.key ? null : focus.key)} />
          </div>
        </div>
        {visible.length > 0 && (
          <div style={{
            display: 'grid', gap: 8, overflow: 'auto', position: 'relative', flexShrink: 0,
            ...(stripVertical ? { width: mobile ? 120 : 220, gridAutoRows: mobile ? 76 : 124 } : { height: 110, gridAutoFlow: 'column', gridAutoColumns: 160 }),
          }}>
            {visible.map(tile => <Tile key={tile.key} tile={tile} client={client} compact onPin={() => setPinned(tile.key)} />)}
            {pager}
          </div>
        )}
      </div>
    );
  }

  const g = bestGrid(Math.max(visible.length, 1), Math.max(size.w - 16, 100), Math.max(size.h - 16 - (pages > 1 ? 30 : 0), 100));
  return (
    <div ref={box} style={{ flex: 1, minHeight: 0, padding: 8, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {audio}
      <div style={{
        display: 'grid', gap: 8, width: '100%', height: '100%',
        gridTemplateColumns: `repeat(${g.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${g.rows}, minmax(0, 1fr))`,
        maxWidth: g.cols * ((Math.min((size.h - 16) / g.rows, 9999) * 16) / 9) + (g.cols - 1) * 8,
      }}>
        {visible.map(tile => <Tile key={tile.key} tile={tile} client={client} compact={g.size < 260} onPin={() => setPinned(tile.key)} />)}
      </div>
      {pager}
    </div>
  );
}

// ── Side panels ──────────────────────────────────────────────────────────────

function ChatPanel({ client, onClose }: { client: RoomClient; onClose: () => void }) {
  const t = useModuleT();
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { client.setChatOpen(true); return () => client.setChatOpen(false); }, [client]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [state.messages.length]);
  const send = () => { if (text.trim()) { client.chat(text.trim()); setText(''); } };
  return (
    <>
      <PanelHeader title={t('cf_chat')} onClose={onClose} />
      <div ref={list} style={{ flex: 1, overflow: 'auto', padding: '4px 14px' }}>
        {state.messages.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center', marginTop: 24 }}>{t('cf_chat_empty')}</div>}
        {state.messages.map(m => (
          <div key={m.id} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12 }}>
              <b style={{ color: 'var(--text-primary)' }}>{m.name}</b>
              {m.guest && <span style={{ color: 'var(--text-tertiary)' }}> · {t('cf_guest')}</span>}
              <span style={{ color: 'var(--text-tertiary)', marginLeft: 6 }}>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, padding: 10, borderTop: '1px solid var(--border-color)' }}>
        <textarea value={text} rows={1} onChange={e => setText(e.target.value)} placeholder={t('cf_chat_ph')}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          style={{ ...inputStyle(), resize: 'none' }} />
        <IconButton title={t('cf_send')} active={!!text.trim()} onClick={send}><Send size={16} /></IconButton>
      </div>
    </>
  );
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const t = useModuleT();
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '12px 10px 8px 14px' }}>
      <span style={{ flex: 1, fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{title}</span>
      <IconButton title={t('cf_close')} onClick={onClose}><X size={16} /></IconButton>
    </div>
  );
}

function PeopleRow({ p, client, self }: { p: Participant; client: RoomClient; self?: boolean }) {
  const t = useModuleT();
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const host = !!state.me?.host && !self;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
      <Avatar user={{ id: p.identity, username: p.name, avatar: p.avatar }} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.name}{self && ` (${t('cf_you')})`}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{p.host ? t('cf_host') : p.guest ? t('cf_guest') : t('cf_member')}</div>
      </div>
      {p.hand && <Hand size={15} color="#f59e0b" />}
      {p.screen && <MonitorUp size={15} color="var(--accent-primary)" />}
      {p.video ? <Video size={15} color="var(--text-tertiary)" /> : <VideoOff size={15} color="var(--text-tertiary)" />}
      {p.audio ? <Mic size={15} color="var(--text-tertiary)" /> : <MicOff size={15} color="#ef4444" />}
      {host && p.audio && <IconButton title={t('cf_ask_mute')} onClick={() => client.host('mute', p.peer_id)} style={{ width: 26, height: 26 }}><MicOff size={13} /></IconButton>}
      {host && <IconButton title={t('cf_remove')} onClick={() => client.host('kick', p.peer_id)} style={{ width: 26, height: 26, color: '#ef4444' }}><UserX size={13} /></IconButton>}
    </div>
  );
}

function PeoplePanel({ client, slug, onClose }: { client: RoomClient; slug: string; onClose: () => void }) {
  const t = useModuleT();
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const q = query.trim().toLowerCase();
  const list = state.peers.filter(p => !q || p.name.toLowerCase().includes(q));
  const copy = async () => {
    try { await navigator.clipboard.writeText(conferenceLink(slug)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) { reportError(e); }
  };
  return (
    <>
      <PanelHeader title={`${t('cf_people')} · ${state.peers.length + 1}`} onClose={onClose} />
      <div style={{ padding: '0 14px 8px' }}>
        <Button small onClick={() => void copy()} style={{ width: '100%' }}>{copied ? <UserCheck size={14} /> : <Link2 size={14} />} {copied ? t('cf_copied') : t('cf_copy_link')}</Button>
      </div>
      {state.me?.host && state.lobby.length > 0 && (
        <div style={{ margin: '0 14px 10px', padding: 10, borderRadius: 10, background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.35)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b', marginBottom: 6 }}>{t('cf_waiting').replace('{n}', String(state.lobby.length))}</div>
          {state.lobby.map(g => (
            <div key={g.peer_id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
              <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text-primary)' }}>{g.name}</span>
              <Button small kind="primary" onClick={() => client.host('admit', g.peer_id)}>{t('cf_admit')}</Button>
              <IconButton title={t('cf_deny')} onClick={() => client.host('deny', g.peer_id)} style={{ width: 28, height: 28 }}><X size={14} /></IconButton>
            </div>
          ))}
        </div>
      )}
      {state.peers.length > 8 && (
        <div style={{ padding: '0 14px 6px' }}>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('cf_find_people')} style={{ ...inputStyle(), padding: '6px 10px', fontSize: 13 }} />
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 14px' }}>
        {state.me && <PeopleRow p={{ ...state.me, ...state.local }} client={client} self />}
        {list.map(p => <PeopleRow key={p.peer_id} p={p} client={client} />)}
      </div>
    </>
  );
}

// ── Room ─────────────────────────────────────────────────────────────────────

export function Room({ conn, slug, guestPass, title, displayName, onLeave }: {
  conn: Conn; slug: string; guestPass?: string; title: string; displayName: string; onLeave: () => void;
}) {
  const mobile = useIsMobile();
  const { isCallActive } = useCore();
  const [client, setClient] = useState<RoomClient | null>(null);
  const [panel, setPanel] = useState<'chat' | 'people' | null>(null);
  const [reactions, setReactions] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [joinOpts, setJoinOpts] = useState<Parameters<RoomClient['join']>[0] | null>(null);

  useEffect(() => {
    if (!joinOpts) return;
    if (isBusy()) {
      reportError(new Error('Сначала завершите текущий звонок или конференцию'));
      setJoinOpts(null);
      return;
    }
    const c = new RoomClient(conn, slug, guestPass);
    setClient(c);
    setBusy('conference', true);
    void c.join(joinOpts);
    const beforeUnload = () => c.leave();
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('beforeunload', beforeUnload); c.leave(); setBusy('conference', false); };
  }, [conn, slug, guestPass, joinOpts]);

  if (isCallActive) return <div role="status" style={{ padding: 24 }}>Сначала завершите текущий звонок.</div>;
  if (!joinOpts) return <PreJoin title={title} name={displayName} onJoin={setJoinOpts} onCancel={onLeave} />;
  if (!client) return null;
  return <RoomView client={client} slug={slug} title={title} mobile={mobile} panel={panel} setPanel={setPanel}
    reactions={reactions} setReactions={setReactions} confirmLeave={confirmLeave} setConfirmLeave={setConfirmLeave} onLeave={onLeave} />;
}

function RoomView({ client, slug, title, mobile, panel, setPanel, reactions, setReactions, confirmLeave, setConfirmLeave, onLeave }: {
  client: RoomClient; slug: string; title: string; mobile: boolean;
  panel: 'chat' | 'people' | null; setPanel: (p: 'chat' | 'people' | null) => void;
  reactions: boolean; setReactions: (v: boolean) => void; confirmLeave: boolean; setConfirmLeave: (v: boolean) => void; onLeave: () => void;
}) {
  const t = useModuleT();
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { const s = Date.now(); const i = setInterval(() => setElapsed(Math.floor((Date.now() - s) / 1000)), 1000); return () => clearInterval(i); }, []);

  useEffect(() => {
    if (!state.notice) return;
    const timer = setTimeout(() => client.clearNotice(), 5000);
    return () => clearTimeout(timer);
  }, [state.notice, client]);

  // Keyboard: Ctrl+D mic, Ctrl+E camera (as in common meeting apps).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); void client.toggleMic(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); void client.toggleCam(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [client]);

  const final = ({ ended: 'cf_ended', kicked: 'cf_kicked', denied: 'cf_denied', error: `cf_error_${state.error}` } as Record<string, string>)[state.phase];
  if (final) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, background: 'var(--bg-primary)', padding: 16, textAlign: 'center' }}>
        <PhoneOff size={36} color="var(--text-tertiary)" />
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{t(final)}</div>
        <Button kind="primary" onClick={onLeave}>{t('cf_back')}</Button>
      </div>
    );
  }
  if (state.phase === 'lobby' || state.phase === 'connecting') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: 'var(--bg-primary)', padding: 16, textAlign: 'center' }}>
        <div className="cf-spinner" style={{ width: 36, height: 36, borderRadius: '50%', border: '3px solid var(--border-color)', borderTopColor: 'var(--accent-primary)', animation: 'spin 1s linear infinite' }} />
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{state.phase === 'lobby' ? t('cf_in_lobby') : t('cf_connecting')}</div>
        {state.phase === 'lobby' && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('cf_in_lobby_hint')}</div>}
        <Button onClick={() => { client.leave(); onLeave(); }}>{t('cf_cancel')}</Button>
      </div>
    );
  }

  const ctrl = (on: boolean, danger = false): CSSProperties => ({
    height: 46, minWidth: 46, padding: '0 12px', borderRadius: 999, border: 'none', cursor: 'pointer', position: 'relative',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontWeight: 600, fontSize: 13,
    background: danger ? '#ef4444' : on ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.9)',
    color: danger ? '#fff' : on ? '#fff' : '#111',
  });
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const leave = () => { client.leave(); onLeave(); };

  return (
    <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', background: '#0e0f12', color: '#fff', overflow: 'hidden' }}>
      <style>{'@keyframes cf-float{0%{opacity:0;transform:translateY(10px) scale(.6)}15%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(-80px)}}.cf-tile-actions{opacity:0;transition:opacity .15s}div:hover>.cf-tile-actions{opacity:1}'}</style>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
        <span style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <span style={{ fontSize: 12, opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>{mm}:{ss}</span>
        {!state.socketOpen && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#fbbf24' }}><WifiOff size={13} /> {t('cf_reconnecting')}</span>}
        <div style={{ flex: 1 }} />
        {state.me?.host && state.lobby.length > 0 && (
          <Button small kind="primary" onClick={() => setPanel('people')}><Users size={14} /> {t('cf_waiting').replace('{n}', String(state.lobby.length))}</Button>
        )}
        <span title={state.mode === 'livekit' ? t('cf_mode_sfu') : t('cf_mode_mesh')} style={{ fontSize: 11, opacity: 0.55 }}>{state.mode === 'livekit' ? 'SFU' : 'P2P'}</span>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Stage client={client} mobile={mobile} />
        {panel && (
          <aside style={{
            width: mobile ? '100%' : 340, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', color: 'var(--text-primary)',
            borderRadius: mobile ? 0 : 14, margin: mobile ? 0 : '0 8px 8px 0', overflow: 'hidden',
            ...(mobile ? { position: 'absolute', inset: 0, zIndex: 20 } : {}),
          }}>
            {panel === 'chat' ? <ChatPanel client={client} onClose={() => setPanel(null)} /> : <PeoplePanel client={client} slug={slug} onClose={() => setPanel(null)} />}
          </aside>
        )}
      </div>

      {state.notice && (
        <div role="status" style={{ position: 'absolute', left: '50%', top: 56, transform: 'translateX(-50%)', background: 'rgba(0,0,0,.8)', padding: '8px 14px', borderRadius: 10, fontSize: 13, zIndex: 30 }}>
          {t(`cf_notice_${state.notice}`)}
        </div>
      )}

      <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: mobile ? 6 : 10, padding: '10px 12px 14px', flexWrap: 'wrap' }}>
        <button type="button" style={ctrl(state.local.audio)} onClick={() => void client.toggleMic()} title={`${state.local.audio ? t('cf_mic_off') : t('cf_mic_on')} (Ctrl+D)`} aria-label={state.local.audio ? t('cf_mic_off') : t('cf_mic_on')}>
          {state.local.audio ? <Mic size={19} /> : <MicOff size={19} />}
        </button>
        <button type="button" style={ctrl(state.local.video)} onClick={() => void client.toggleCam()} title={`${state.local.video ? t('cf_cam_off') : t('cf_cam_on')} (Ctrl+E)`} aria-label={state.local.video ? t('cf_cam_off') : t('cf_cam_on')}>
          {state.local.video ? <Video size={19} /> : <VideoOff size={19} />}
        </button>
        {!mobile && typeof navigator.mediaDevices?.getDisplayMedia === 'function' && (
          <button type="button" style={{ ...ctrl(true), background: state.local.screen ? 'var(--accent-primary)' : 'rgba(255,255,255,.14)' }} onClick={() => void client.toggleScreen()}
            title={state.local.screen ? t('cf_stop_share') : t('cf_share_screen')} aria-label={state.local.screen ? t('cf_stop_share') : t('cf_share_screen')}>
            {state.local.screen ? <MonitorX size={19} /> : <MonitorUp size={19} />}
          </button>
        )}
        <button type="button" style={{ ...ctrl(true), background: state.local.hand ? '#f59e0b' : 'rgba(255,255,255,.14)' }} onClick={() => client.setHand()} title={t('cf_raise_hand')} aria-label={t('cf_raise_hand')}>
          <Hand size={19} />
        </button>
        <div style={{ position: 'relative' }}>
          <button type="button" style={ctrl(true)} onClick={() => setReactions(!reactions)} title={t('cf_react')} aria-label={t('cf_react')}><Smile size={19} /></button>
          {reactions && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setReactions(false)} />
              <div style={{ position: 'absolute', bottom: 54, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 4, background: 'rgba(30,31,36,.95)', padding: 6, borderRadius: 999, zIndex: 41 }}>
                {REACTIONS.map(e => (
                  <button key={e} type="button" onClick={() => { client.react(e); setReactions(false); }} style={{ fontSize: 22, width: 40, height: 40, border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: '50%' }}>{e}</button>
                ))}
              </div>
            </>
          )}
        </div>
        <button type="button" style={{ ...ctrl(true), background: panel === 'chat' ? 'var(--accent-primary)' : 'rgba(255,255,255,.14)' }} onClick={() => setPanel(panel === 'chat' ? null : 'chat')} title={t('cf_chat')} aria-label={t('cf_chat')}>
          <MessageSquare size={19} />
          {state.unread > 0 && panel !== 'chat' && <span style={{ position: 'absolute', top: 4, right: 4, minWidth: 16, height: 16, borderRadius: 8, background: '#ef4444', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>{state.unread > 99 ? '99+' : state.unread}</span>}
        </button>
        <button type="button" style={{ ...ctrl(true), background: panel === 'people' ? 'var(--accent-primary)' : 'rgba(255,255,255,.14)' }} onClick={() => setPanel(panel === 'people' ? null : 'people')} title={t('cf_people')} aria-label={t('cf_people')}>
          <Users size={19} /> {!mobile && <span>{state.peers.length + 1}</span>}
        </button>
        {!mobile && (
          <button type="button" style={ctrl(true)} title={t('cf_copy_link')} aria-label={t('cf_copy_link')}
            onClick={() => { void navigator.clipboard.writeText(conferenceLink(slug)).then(() => client.notify('link_copied')).catch(reportError); }}>
            <Copy size={18} />
          </button>
        )}
        <button type="button" style={{ ...ctrl(true, true), padding: '0 18px' }} onClick={() => (state.me?.host ? setConfirmLeave(true) : leave())} title={t('cf_leave')} aria-label={t('cf_leave')}>
          <PhoneOff size={19} /> {!mobile && t('cf_leave')}
        </button>
      </footer>

      {confirmLeave && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }} onClick={() => setConfirmLeave(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', borderRadius: 14, padding: 20, maxWidth: 360, width: '100%' }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{t('cf_leave_title')}</div>
            <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: 16 }}>{t('cf_leave_hint')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Button onClick={leave}>{t('cf_just_leave')}</Button>
              <Button kind="danger" onClick={() => { client.host('end'); setTimeout(leave, 300); }}>{t('cf_end_for_all')}</Button>
              <Button kind="plain" onClick={() => setConfirmLeave(false)}>{t('cf_cancel')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
