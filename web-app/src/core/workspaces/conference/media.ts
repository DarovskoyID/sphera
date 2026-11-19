import { getIceServers, getSelectedServerEntry } from '@sfera/sdk';

/**
 * Media of a conference, independent of how it travels. Tiles address remote
 * media by the participant's identity (the same in the room socket and in the
 * media server token).
 */
export interface RemoteMedia {
  audio?: MediaStreamTrack;
  camera?: MediaStreamTrack;
  screen?: MediaStreamTrack;
  screenAudio?: MediaStreamTrack;
}

export interface EngineEvents {
  onRemote: (identity: string, media: RemoteMedia) => void;
  onRemoteGone: (identity: string) => void;
  onSpeaking: (identities: Set<string>) => void;
  onQuality?: (identity: string, poor: boolean) => void;
}

export interface MediaEngine {
  readonly mode: 'mesh' | 'livekit';
  start(): Promise<void>;
  setMicrophone(track: MediaStreamTrack | null): Promise<void>;
  setCamera(track: MediaStreamTrack | null): Promise<void>;
  setScreen(stream: MediaStream | null): Promise<void>;
  /** Peer-to-peer only: socket events that drive signaling. */
  peerJoined?(peerId: string, identity: string): void;
  peerLeft?(peerId: string, identity: string): void;
  signal?(fromPeerId: string, data: unknown): void;
  /** Called when a tile becomes visible or hidden, so large rooms only receive what is on screen. */
  setVisible?(identity: string, visible: boolean): void;
  close(): void;
}

// ── Speaking detection for tracks we hold ourselves ──────────────────────────

export class SpeakingMeter {
  private ctx: AudioContext | null = null;
  private nodes = new Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode; data: Uint8Array<ArrayBuffer> }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onChange: (s: Set<string>) => void;
  private last = '';

  constructor(onChange: (s: Set<string>) => void) {
    this.onChange = onChange;
  }

  track(id: string, track: MediaStreamTrack | undefined) {
    this.untrack(id);
    if (!track) return;
    try {
      this.ctx ??= new AudioContext();
      const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.nodes.set(id, { analyser, source, data: new Uint8Array(analyser.frequencyBinCount) });
      this.timer ??= setInterval(() => this.tick(), 200);
    } catch { /* no audio context (autoplay policy): skip indicators */ }
  }

  untrack(id: string) {
    const n = this.nodes.get(id);
    if (n) { n.source.disconnect(); this.nodes.delete(id); }
  }

  private tick() {
    const speaking = new Set<string>();
    for (const [id, n] of this.nodes) {
      n.analyser.getByteFrequencyData(n.data);
      let sum = 0;
      for (const v of n.data) sum += v;
      if (sum / n.data.length > 18) speaking.add(id);
    }
    const key = [...speaking].sort().join(',');
    if (key !== this.last) { this.last = key; this.onChange(speaking); }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    for (const id of [...this.nodes.keys()]) this.untrack(id);
    void this.ctx?.close().catch(() => {});
  }
}

// ── Peer to peer ─────────────────────────────────────────────────────────────

interface Peer {
  identity: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  senders: { audio?: RTCRtpSender; camera?: RTCRtpSender; screen?: RTCRtpSender; screenAudio?: RTCRtpSender };
  media: RemoteMedia;
  /** Which remote transceiver (mid) carries what, announced with every description. */
  roles: Record<string, keyof RemoteMedia>;
}

type Signal =
  | { kind: 'description'; description: RTCSessionDescriptionInit; roles: Record<string, keyof RemoteMedia> }
  | { kind: 'candidate'; candidate: RTCIceCandidateInit }
  | { kind: 'roles'; roles: Record<string, keyof RemoteMedia> };

/**
 * Every participant connects to every other one. Works without a media server,
 * fine for small meetings; the room itself has no participant cap either way.
 */
export class MeshEngine implements MediaEngine {
  readonly mode = 'mesh' as const;
  private peers = new Map<string, Peer>();
  private local: { audio: MediaStreamTrack | null; camera: MediaStreamTrack | null; screen: MediaStream | null } = { audio: null, camera: null, screen: null };
  private meter: SpeakingMeter;
  private readonly myId: string;
  private readonly send: (to: string, data: Signal) => void;
  private readonly events: EngineEvents;

  constructor(myId: string, send: (to: string, data: Signal) => void, events: EngineEvents) {
    this.myId = myId;
    this.send = send;
    this.events = events;
    this.meter = new SpeakingMeter(s => events.onSpeaking(s));
  }

  async start() { /* peers come from the room socket */ }

  private iceServers(): RTCIceServer[] {
    try { return getIceServers(getSelectedServerEntry()); } catch { return [{ urls: 'stun:stun.l.google.com:19302' }]; }
  }

  private roleMap(peer: Peer): Record<string, keyof RemoteMedia> {
    const roles: Record<string, keyof RemoteMedia> = {};
    for (const t of peer.pc.getTransceivers()) {
      const role = (Object.entries(peer.senders) as [keyof RemoteMedia, RTCRtpSender][]).find(([, s]) => s === t.sender)?.[0];
      if (role && t.mid) roles[t.mid] = role;
    }
    return roles;
  }

  private ensure(peerId: string, identity: string): Peer {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers() });
    const peer: Peer = { identity, pc, polite: this.myId > peerId, makingOffer: false, ignoreOffer: false, senders: {}, media: {}, roles: {} };
    this.peers.set(peerId, peer);

    pc.onicecandidate = e => { if (e.candidate) this.send(peerId, { kind: 'candidate', candidate: e.candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.send(peerId, { kind: 'description', description: pc.localDescription!.toJSON(), roles: this.roleMap(peer) });
      } catch { /* closed meanwhile */ } finally {
        peer.makingOffer = false;
      }
    };
    pc.ontrack = e => {
      const role = peer.roles[e.transceiver.mid ?? ''] ?? (e.track.kind === 'audio' ? 'audio' : 'camera');
      peer.media = { ...peer.media, [role]: e.track };
      if (role === 'audio') this.meter.track(peer.identity, e.track);
      const clear = () => {
        if (peer.media[role] !== e.track) return;
        peer.media = { ...peer.media, [role]: undefined };
        this.events.onRemote(peer.identity, peer.media);
      };
      e.track.onmute = clear;
      e.track.onended = clear;
      e.track.onunmute = () => { peer.media = { ...peer.media, [role]: e.track }; this.events.onRemote(peer.identity, peer.media); };
      this.events.onRemote(peer.identity, peer.media);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      this.events.onQuality?.(identity, pc.connectionState === 'failed' || pc.connectionState === 'disconnected');
    };

    // Our current media goes to the newcomer as well.
    void this.attachAll(peer);
    return peer;
  }

  private async attachAll(peer: Peer) {
    if (this.local.audio) await this.put(peer, 'audio', this.local.audio);
    if (this.local.camera) await this.put(peer, 'camera', this.local.camera);
    const screen = this.local.screen;
    if (screen) {
      await this.put(peer, 'screen', screen.getVideoTracks()[0] ?? null);
      const sa = screen.getAudioTracks()[0];
      if (sa) await this.put(peer, 'screenAudio', sa);
    }
  }

  private async put(peer: Peer, role: keyof RemoteMedia, track: MediaStreamTrack | null) {
    const sender = peer.senders[role];
    if (sender) {
      await sender.replaceTrack(track).catch(() => {});
      // Receivers only learn roles from descriptions; keep them current.
      this.send([...this.peers.entries()].find(([, p]) => p === peer)![0], { kind: 'roles', roles: this.roleMap(peer) });
      return;
    }
    if (!track) return;
    const t = peer.pc.addTransceiver(track, { direction: 'sendrecv', streams: [new MediaStream([track])] });
    peer.senders[role] = t.sender;
  }

  private async setAll(role: keyof RemoteMedia, track: MediaStreamTrack | null) {
    await Promise.all([...this.peers.values()].map(p => this.put(p, role, track)));
  }

  async setMicrophone(track: MediaStreamTrack | null) { this.local.audio = track; await this.setAll('audio', track); }
  async setCamera(track: MediaStreamTrack | null) { this.local.camera = track; await this.setAll('camera', track); }
  async setScreen(stream: MediaStream | null) {
    this.local.screen = stream;
    await this.setAll('screen', stream?.getVideoTracks()[0] ?? null);
    await this.setAll('screenAudio', stream?.getAudioTracks()[0] ?? null);
  }

  peerJoined(peerId: string, identity: string) { this.ensure(peerId, identity); }

  peerLeft(peerId: string, identity: string) {
    const p = this.peers.get(peerId);
    if (!p) return;
    p.pc.close();
    this.peers.delete(peerId);
    this.meter.untrack(identity);
    this.events.onRemoteGone(identity);
  }

  async signal(from: string, raw: unknown) {
    const data = raw as Signal;
    const peer = this.peers.get(from);
    if (!peer) return;
    const { pc } = peer;
    try {
      if (data.kind === 'roles') {
        peer.roles = { ...peer.roles, ...data.roles };
        this.reclassify(peer);
      } else if (data.kind === 'description') {
        peer.roles = { ...peer.roles, ...data.roles };
        const collision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          this.send(from, { kind: 'description', description: pc.localDescription!.toJSON(), roles: this.roleMap(peer) });
        }
        this.reclassify(peer);
      } else if (data.kind === 'candidate') {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignoreOffer) throw e; }
      }
    } catch (e) {
      console.warn('[conference] signaling', e);
    }
  }

  /** Tracks may arrive before their role is known; sort them once it is. */
  private reclassify(peer: Peer) {
    const media: RemoteMedia = {};
    for (const t of peer.pc.getTransceivers()) {
      const track = t.receiver.track;
      if (!track || track.readyState === 'ended' || track.muted) continue;
      const role = peer.roles[t.mid ?? ''];
      if (role) media[role] = track;
    }
    peer.media = media;
    this.events.onRemote(peer.identity, media);
  }

  close() {
    for (const p of this.peers.values()) p.pc.close();
    this.peers.clear();
    this.meter.close();
  }
}

// ── LiveKit (selective forwarding server) ────────────────────────────────────

/**
 * Media through a LiveKit server: each participant sends one stream to the
 * server whatever the room size, and receives only what is shown on screen.
 */
export class LiveKitEngine implements MediaEngine {
  readonly mode = 'livekit' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private room: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private lk: any = null;
  private readonly url: string;
  private readonly token: string;
  private readonly events: EngineEvents;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private published = new Map<string, any>();

  constructor(url: string, token: string, events: EngineEvents) {
    this.url = url;
    this.token = token;
    this.events = events;
  }

  async start() {
    this.lk = await import('livekit-client');
    const { Room, RoomEvent } = this.lk;
    const room = new Room({ adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: false });
    this.room = room;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refresh = (p: any) => this.events.onRemote(p.identity, this.mediaOf(p));
    room
      .on(RoomEvent.TrackSubscribed, (_t: unknown, _pub: unknown, p: unknown) => refresh(p))
      .on(RoomEvent.TrackUnsubscribed, (_t: unknown, _pub: unknown, p: unknown) => refresh(p))
      .on(RoomEvent.TrackMuted, (_pub: unknown, p: { isLocal?: boolean }) => { if (!p.isLocal) refresh(p); })
      .on(RoomEvent.TrackUnmuted, (_pub: unknown, p: { isLocal?: boolean }) => { if (!p.isLocal) refresh(p); })
      .on(RoomEvent.ParticipantDisconnected, (p: { identity: string }) => this.events.onRemoteGone(p.identity))
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: { identity: string }[]) => this.events.onSpeaking(new Set(speakers.map(s => s.identity))))
      .on(RoomEvent.ConnectionQualityChanged, (q: string, p: { identity: string; isLocal?: boolean }) => {
        if (!p.isLocal) this.events.onQuality?.(p.identity, q === 'poor' || q === 'lost');
      });
    await room.connect(this.url, this.token, { autoSubscribe: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    room.remoteParticipants.forEach((p: any) => refresh(p));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mediaOf(p: any): RemoteMedia {
    const { Track } = this.lk;
    const track = (source: string) => {
      const pub = p.getTrackPublication(source);
      return pub && pub.isSubscribed && !pub.isMuted ? pub.track?.mediaStreamTrack : undefined;
    };
    return {
      audio: track(Track.Source.Microphone),
      camera: track(Track.Source.Camera),
      screen: track(Track.Source.ScreenShare),
      screenAudio: track(Track.Source.ScreenShareAudio),
    };
  }

  private async publish(key: string, track: MediaStreamTrack | null, source: string) {
    const lp = this.room?.localParticipant;
    if (!lp) return;
    const current = this.published.get(key);
    if (current) {
      await lp.unpublishTrack(current, false).catch(() => {});
      this.published.delete(key);
    }
    if (!track) return;
    const pub = await lp.publishTrack(track, { source, simulcast: source === this.lk.Track.Source.Camera });
    this.published.set(key, pub.track ?? track);
  }

  async setMicrophone(track: MediaStreamTrack | null) { await this.publish('mic', track, this.lk.Track.Source.Microphone); }
  async setCamera(track: MediaStreamTrack | null) { await this.publish('cam', track, this.lk.Track.Source.Camera); }
  async setScreen(stream: MediaStream | null) {
    await this.publish('screen', stream?.getVideoTracks()[0] ?? null, this.lk.Track.Source.ScreenShare);
    await this.publish('screenAudio', stream?.getAudioTracks()[0] ?? null, this.lk.Track.Source.ScreenShareAudio);
  }

  setVisible(identity: string, visible: boolean) {
    const p = this.room?.remoteParticipants.get(identity);
    const { Track } = this.lk ?? {};
    if (!p || !Track) return;
    const pub = p.getTrackPublication(Track.Source.Camera);
    // Off-screen tiles stop receiving camera video; audio always flows.
    pub?.setSubscribed?.(visible);
  }

  close() {
    void this.room?.disconnect();
    this.room = null;
  }
}
