import { openModuleSocket, type ModuleSocket } from '@sfera/sdk';
import { api, type Conn, type JoinInfo } from './api';
import { LiveKitEngine, MeshEngine, type MediaEngine, type RemoteMedia } from './media';

export interface Participant {
  peer_id: string;
  identity: string;
  user_id: string | null;
  name: string;
  avatar: string;
  guest: boolean;
  host: boolean;
  audio: boolean;
  video: boolean;
  screen: boolean;
  hand: boolean;
  joined_at: number;
}

export interface ChatMessage {
  id: string;
  text: string;
  name: string;
  user_id: string | null;
  guest: boolean;
  created_at: string;
}

export type RoomPhase = 'connecting' | 'lobby' | 'joined' | 'ended' | 'kicked' | 'denied' | 'error';

export interface RoomState {
  phase: RoomPhase;
  error?: string;
  me: Participant | null;
  peers: Participant[];
  media: Record<string, RemoteMedia>;
  speaking: Set<string>;
  poor: Set<string>;
  messages: ChatMessage[];
  unread: number;
  lobby: Participant[];
  reactions: { id: number; peer_id: string; emoji: string }[];
  local: { audio: boolean; video: boolean; screen: boolean; hand: boolean };
  localStreams: { camera: MediaStream | null; screen: MediaStream | null };
  notice: string | null;
  mode: 'mesh' | 'livekit' | null;
  socketOpen: boolean;
}

export interface JoinOptions {
  audio: boolean;
  video: boolean;
  audioDevice?: string;
  videoDevice?: string;
}

/** One conference session: room socket, media engine and local devices. */
export class RoomClient {
  state: RoomState = {
    phase: 'connecting', me: null, peers: [], media: {}, speaking: new Set(), poor: new Set(), messages: [], unread: 0, lobby: [],
    reactions: [], local: { audio: false, video: false, screen: false, hand: false }, localStreams: { camera: null, screen: null },
    notice: null, mode: null, socketOpen: false,
  };
  chatOpen = false;
  private listeners = new Set<() => void>();
  private socket: ModuleSocket | null = null;
  private engine: MediaEngine | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private camTrack: MediaStreamTrack | null = null;
  private screenStream: MediaStream | null = null;
  private reactionSeq = 0;
  private closed = false;
  private readonly conn: Conn;
  private readonly slug: string;
  private readonly guestPass?: string;
  private info: JoinInfo | null = null;

  constructor(conn: Conn, slug: string, guestPass?: string) {
    this.conn = conn;
    this.slug = slug;
    this.guestPass = guestPass;
  }

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getState = () => this.state;

  private set(patch: Partial<RoomState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(l => l());
  }

  async join(opts: JoinOptions) {
    try {
      this.info = await api.join(this.conn, this.slug, this.guestPass);
    } catch (e) {
      const status = (e as { status?: number }).status;
      this.set({ phase: 'error', error: status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 401 ? 'login_required' : 'network' });
      return;
    }
    if (this.closed) return;
    this.set({ mode: this.info.media.mode });
    // Devices first: the browser asks for permission once, before the room opens.
    if (opts.audio) await this.enableMic(opts.audioDevice).catch(() => this.set({ notice: 'mic_denied' }));
    if (opts.video) await this.enableCam(opts.videoDevice).catch(() => this.set({ notice: 'cam_denied' }));
    this.openSocket();
  }

  private openSocket() {
    const info = this.info!;
    this.socket = openModuleSocket({
      serverIP: this.conn.serverIP,
      token: this.guestPass ? '' : this.conn.token,
      protocols: this.guestPass ? ['conf.guest', this.guestPass] : [],
      path: info.ws_path,
      onFrame: f => { void this.onFrame(f); },
      onStatus: open => {
        this.set({ socketOpen: open });
        if (open) this.sendState();
      },
    });
    this.ping = setInterval(() => this.socket?.send({ type: 'ping' }), 25_000);
  }

  private async startEngine() {
    if (this.engine || !this.info) return;
    const events = {
      onRemote: (identity: string, media: RemoteMedia) => this.set({ media: { ...this.state.media, [identity]: media } }),
      onRemoteGone: (identity: string) => {
        const media = { ...this.state.media };
        delete media[identity];
        this.set({ media });
      },
      onSpeaking: (speaking: Set<string>) => this.set({ speaking }),
      onQuality: (identity: string, poor: boolean) => {
        const next = new Set(this.state.poor);
        if (poor) next.add(identity); else next.delete(identity);
        this.set({ poor: next });
      },
    };
    const media = this.info.media;
    this.engine = media.mode === 'livekit'
      ? new LiveKitEngine(media.url, media.token, events)
      : new MeshEngine(this.state.me!.peer_id, (to, data) => this.socket?.send({ type: 'signal', to, data }), events);
    try {
      await this.engine.start();
    } catch (e) {
      console.error('[conference] media server', e);
      // Media server unreachable: fall back to direct connections.
      this.engine = new MeshEngine(this.state.me!.peer_id, (to, data) => this.socket?.send({ type: 'signal', to, data }), events);
      this.set({ mode: 'mesh', notice: 'media_fallback' });
    }
    await this.engine.setMicrophone(this.micTrack);
    await this.engine.setCamera(this.camTrack);
    await this.engine.setScreen(this.screenStream);
    for (const p of this.state.peers) this.engine.peerJoined?.(p.peer_id, p.identity);
  }

  private async onFrame(f: { type: string; [k: string]: unknown }) {
    switch (f.type) {
      case 'lobby':
        if (this.state.phase !== 'joined') this.set({ phase: 'lobby' });
        else this.set({ lobby: (f.lobby as Participant[]) ?? [] });
        break;
      case 'welcome': {
        const me = f.me as Participant;
        const peers = (f.peers as Participant[]) ?? [];
        this.set({ phase: 'joined', me, peers, messages: (f.messages as ChatMessage[]) ?? [], lobby: (f.lobby as Participant[]) ?? [] });
        this.sendState();
        if (!this.engine) await this.startEngine();
        else for (const p of peers) this.engine.peerJoined?.(p.peer_id, p.identity);
        break;
      }
      case 'admitted':
        break;
      case 'peer-joined': {
        const p = f.peer as Participant;
        this.set({ peers: [...this.state.peers.filter(x => x.peer_id !== p.peer_id), p] });
        this.engine?.peerJoined?.(p.peer_id, p.identity);
        break;
      }
      case 'peer-left': {
        const gone = this.state.peers.find(x => x.peer_id === f.peer_id);
        this.set({ peers: this.state.peers.filter(x => x.peer_id !== f.peer_id) });
        if (gone) {
          this.engine?.peerLeft?.(gone.peer_id, gone.identity);
          if (!this.state.peers.some(x => x.identity === gone.identity)) {
            const media = { ...this.state.media };
            delete media[gone.identity];
            this.set({ media });
          }
        }
        break;
      }
      case 'peer-updated': {
        const p = f.peer as Participant;
        this.set({ peers: this.state.peers.map(x => (x.peer_id === p.peer_id ? p : x)) });
        break;
      }
      case 'signal':
        this.engine?.signal?.(String(f.from), f.data);
        break;
      case 'chat':
        this.set({ messages: [...this.state.messages, f.message as ChatMessage].slice(-500), unread: this.chatOpen ? 0 : this.state.unread + 1 });
        break;
      case 'reaction': {
        const r = { id: ++this.reactionSeq, peer_id: String(f.peer_id), emoji: String(f.emoji) };
        this.set({ reactions: [...this.state.reactions, r].slice(-30) });
        setTimeout(() => this.set({ reactions: this.state.reactions.filter(x => x.id !== r.id) }), 4000);
        break;
      }
      case 'muted-by-host':
        await this.toggleMic(false);
        this.set({ notice: 'muted_by_host' });
        break;
      case 'hand-lowered':
        this.setHand(false);
        break;
      case 'ended':
        this.set({ phase: 'ended' });
        this.leave();
        break;
      case 'kicked':
        this.set({ phase: 'kicked' });
        this.leave();
        break;
      case 'denied':
        this.set({ phase: 'denied' });
        this.leave();
        break;
    }
  }

  private sendState() {
    this.socket?.send({ type: 'state', ...this.state.local });
  }

  private setLocal(patch: Partial<RoomState['local']>) {
    this.set({ local: { ...this.state.local, ...patch } });
    this.sendState();
  }

  // ── Devices ──────────────────────────────────────────────────────────────

  private async enableMic(deviceId?: string) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.micTrack?.stop();
    this.micTrack = stream.getAudioTracks()[0];
    await this.engine?.setMicrophone(this.micTrack);
    this.setLocal({ audio: true });
  }

  private async enableCam(deviceId?: string) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    this.camTrack?.stop();
    this.camTrack = stream.getVideoTracks()[0];
    this.set({ localStreams: { ...this.state.localStreams, camera: new MediaStream([this.camTrack]) } });
    await this.engine?.setCamera(this.camTrack);
    this.setLocal({ video: true });
  }

  async toggleMic(on = !this.state.local.audio, deviceId?: string) {
    if (on) {
      try { await this.enableMic(deviceId); } catch { this.set({ notice: 'mic_denied' }); }
      return;
    }
    this.micTrack?.stop();
    this.micTrack = null;
    await this.engine?.setMicrophone(null);
    this.setLocal({ audio: false });
  }

  async toggleCam(on = !this.state.local.video, deviceId?: string) {
    if (on) {
      try { await this.enableCam(deviceId); } catch { this.set({ notice: 'cam_denied' }); }
      return;
    }
    this.camTrack?.stop();
    this.camTrack = null;
    this.set({ localStreams: { ...this.state.localStreams, camera: null } });
    await this.engine?.setCamera(null);
    this.setLocal({ video: false });
  }

  async toggleScreen(on = !this.state.local.screen) {
    if (on) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: true });
        stream.getVideoTracks()[0]?.addEventListener('ended', () => { void this.toggleScreen(false); });
        this.screenStream = stream;
        this.set({ localStreams: { ...this.state.localStreams, screen: stream } });
        await this.engine?.setScreen(stream);
        this.setLocal({ screen: true });
      } catch { /* picker dismissed */ }
      return;
    }
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream = null;
    this.set({ localStreams: { ...this.state.localStreams, screen: null } });
    await this.engine?.setScreen(null);
    this.setLocal({ screen: false });
  }

  setHand(on = !this.state.local.hand) { this.setLocal({ hand: on }); }

  chat(text: string) { this.socket?.send({ type: 'chat', text }); }
  react(emoji: string) {
    this.socket?.send({ type: 'reaction', emoji });
    void this.onFrame({ type: 'reaction', peer_id: this.state.me?.peer_id ?? '', emoji });
  }
  host(action: 'mute' | 'kick' | 'admit' | 'deny' | 'end' | 'lower-hand', peerId = '') { this.socket?.send({ type: action, peer_id: peerId }); }
  setChatOpen(open: boolean) { this.chatOpen = open; if (open) this.set({ unread: 0 }); }
  clearNotice() { this.set({ notice: null }); }
  notify(notice: string) { this.set({ notice }); }
  setVisible(identity: string, visible: boolean) { this.engine?.setVisible?.(identity, visible); }

  leave() {
    if (this.closed) return;
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    this.socket?.close();
    this.engine?.close();
    this.micTrack?.stop();
    this.camTrack?.stop();
    this.screenStream?.getTracks().forEach(t => t.stop());
  }
}
