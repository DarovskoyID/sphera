import React, { useEffect, useRef, useCallback, useState, createContext, useContext } from 'react';
import {
  useModuleT as useTranslation, getIceServers, getSelectedServerEntry, fetchPoolIceServers,
} from '@sfera/sdk';
import { Monitor, MonitorOff, Video, VideoOff, PhoneOff, Mic, MicOff, ChevronLeft } from 'lucide-react';
import { useApp } from './ServersContext';

const SPEAKING_THRESHOLD = 15; // 0–255 RMS

function AudioEl({ stream, muted }: { stream: MediaStream; muted?: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  useEffect(() => { if (ref.current) ref.current.muted = !!muted; }, [muted]);
  return <audio ref={ref} autoPlay muted={muted} style={{ display: 'none' }} />;
}

interface PeerEntry {
  pc: RTCPeerConnection;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

interface VoiceRoomValue {
  remoteStreams: Map<string, MediaStream>;
  localVideo: MediaStream | null;
  videoKind: 'screen' | 'camera' | null;
  startVideo: (kind: 'screen' | 'camera') => void;
  stopVideo: () => void;
}

const Ctx = createContext<VoiceRoomValue | null>(null);
export const useVoiceRoom = () => useContext(Ctx);

/**
 * The always-mounted WebRTC engine for guild voice. Kept above the view tree so
 * the call keeps running while the user browses other channels; the visible
 * card grid ({@link GuildVoiceStage}) reads its media through context.
 */
export const VoiceRoomProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    currentVoiceChannel,
    voiceParticipants,
    sendVoiceSignal,
    voiceSignalHandler,
    voiceLocalStream,
    userIDonServer,
    setSpeakersActive,
    authToken,
    currentServerIP,
    isHeadphonesActive,
  } = useApp();

  const peers = useRef<Map<string, PeerEntry>>(new Map());
  const iceServersRef = useRef<RTCIceServer[]>(getIceServers(getSelectedServerEntry()));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pool = await fetchPoolIceServers(currentServerIP, authToken);
      if (!cancelled && pool) iceServersRef.current = pool;
    })();
    return () => { cancelled = true; };
  }, [currentServerIP, authToken]);

  const remoteStreams = useRef<Map<string, MediaStream>>(new Map());
  const [, forceUpdate] = useState(0);
  const rerender = useCallback(() => forceUpdate(n => n + 1), []);

  const localVideo = useRef<MediaStream | null>(null);
  const [videoKind, setVideoKind] = useState<'screen' | 'camera' | null>(null);

  const addVideoToPeer = useCallback((pc: RTCPeerConnection) => {
    const stream = localVideo.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    if (!pc.getSenders().some(s => s.track === track)) pc.addTrack(track, stream);
  }, []);

  const stopVideo = useCallback(() => {
    const stream = localVideo.current;
    if (stream) {
      const tracks = stream.getTracks();
      peers.current.forEach(({ pc }) => {
        pc.getSenders().forEach(s => {
          if (s.track && tracks.includes(s.track)) {
            try { pc.removeTrack(s); } catch { /* peer closing */ }
          }
        });
      });
      tracks.forEach(t => t.stop());
    }
    localVideo.current = null;
    setVideoKind(null);
    rerender();
  }, [rerender]);

  const startVideo = useCallback(async (kind: 'screen' | 'camera') => {
    try {
      const stream = kind === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        : await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
      if (localVideo.current) stopVideo();
      localVideo.current = stream;
      setVideoKind(kind);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopVideo());
      peers.current.forEach(({ pc }) => addVideoToPeer(pc));
      rerender();
    } catch {
      // permission denied or picker dismissed
    }
  }, [addVideoToPeer, stopVideo, rerender]);

  // ── Audio analysis (speaking indicator) ─────────────────────────────────────
  const audioCtx = useRef<AudioContext | null>(null);
  const analysers = useRef<Map<string, { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }>>(new Map());

  const getAudioCtx = useCallback((): AudioContext => {
    if (!audioCtx.current) audioCtx.current = new AudioContext();
    return audioCtx.current;
  }, []);

  const setupAnalyser = useCallback((userId: string, stream: MediaStream) => {
    if (analysers.current.has(userId)) return;
    if (stream.getAudioTracks().length === 0) return;
    try {
      const ctx = getAudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      analysers.current.set(userId, { analyser, data: new Uint8Array(analyser.frequencyBinCount) });
    } catch { /* denied or inactive */ }
  }, [getAudioCtx]);

  useEffect(() => {
    const id = setInterval(() => {
      const speaking: string[] = [];
      analysers.current.forEach(({ analyser, data }, userId) => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        if (avg > SPEAKING_THRESHOLD) speaking.push(userId);
      });
      setSpeakersActive(speaking);
    }, 80);
    return () => clearInterval(id);
  }, [setSpeakersActive]);

  useEffect(() => {
    return () => {
      analysers.current.clear();
      audioCtx.current?.close();
      audioCtx.current = null;
      setSpeakersActive([]);
    };
  }, [setSpeakersActive]);

  // ── Local mic ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!currentVoiceChannel) return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        voiceLocalStream.current = stream;
        setupAnalyser(userIDonServer, stream);
        peers.current.forEach(({ pc }) => {
          if (pc.getSenders().filter(s => s.track).length === 0) {
            stream.getTracks().forEach(t => pc.addTrack(t, stream));
          }
        });
      } catch {
        // mic denied — join without audio
      }
    })();
    return () => {
      cancelled = true;
      voiceLocalStream.current?.getTracks().forEach(t => t.stop());
      voiceLocalStream.current = null;
      analysers.current.delete(userIDonServer);
    };
  }, [currentVoiceChannel, voiceLocalStream, setupAnalyser, userIDonServer]);

  // Leaving the channel stops any share and tears down peers.
  useEffect(() => {
    if (currentVoiceChannel) return;
    localVideo.current?.getTracks().forEach(t => t.stop());
    localVideo.current = null;
    setVideoKind(null);
    peers.current.forEach(({ pc }) => pc.close());
    peers.current.clear();
    remoteStreams.current.clear();
    connectedRef.current.clear();
    rerender();
  }, [currentVoiceChannel, rerender]);

  useEffect(() => {
    return () => {
      localVideo.current?.getTracks().forEach(t => t.stop());
      peers.current.forEach(({ pc }) => pc.close());
      peers.current.clear();
      remoteStreams.current.clear();
    };
  }, []);

  const getOrCreatePeer = useCallback((remoteId: string): PeerEntry => {
    if (peers.current.has(remoteId)) return peers.current.get(remoteId)!;

    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    const entry: PeerEntry = { pc, makingOffer: false, ignoreOffer: false };
    peers.current.set(remoteId, entry);

    if (voiceLocalStream.current) {
      voiceLocalStream.current.getTracks().forEach(t => pc.addTrack(t, voiceLocalStream.current!));
    }
    addVideoToPeer(pc);

    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      remoteStreams.current.set(remoteId, stream);
      setupAnalyser(remoteId, stream);
      e.track.addEventListener('ended', rerender);
      e.track.addEventListener('mute', rerender);
      e.track.addEventListener('unmute', rerender);
      rerender();
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) sendVoiceSignal(remoteId, { type: 'candidate', candidate: e.candidate.toJSON() });
    };

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        sendVoiceSignal(remoteId, { type: 'offer', sdp: pc.localDescription });
      } catch { /* renegotiation race */ } finally {
        entry.makingOffer = false;
      }
    };

    return entry;
  }, [sendVoiceSignal, rerender, voiceLocalStream, setupAnalyser, addVideoToPeer]);

  useEffect(() => {
    voiceSignalHandler.current = async (data: unknown) => {
      const msg = data as { from: string; payload: { type: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } };
      const { from, payload } = msg;
      if (!from || !payload) return;

      const polite = userIDonServer > from;
      const entry = getOrCreatePeer(from);
      const { pc } = entry;

      try {
        if (payload.type === 'offer') {
          const offerCollision = entry.makingOffer || pc.signalingState !== 'stable';
          entry.ignoreOffer = !polite && offerCollision;
          if (entry.ignoreOffer) return;
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp!));
          await pc.setLocalDescription();
          sendVoiceSignal(from, { type: 'answer', sdp: pc.localDescription });
        } else if (payload.type === 'answer') {
          if (pc.signalingState === 'stable') return;
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp!));
        } else if (payload.type === 'candidate') {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(payload.candidate!));
          } catch (e) {
            if (!entry.ignoreOffer) throw e;
          }
        }
      } catch { /* ignore */ }
    };
    return () => { voiceSignalHandler.current = null; };
  }, [getOrCreatePeer, sendVoiceSignal, voiceSignalHandler, userIDonServer]);

  const connectedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    voiceParticipants.forEach(p => {
      if (p.id === userIDonServer) return;
      if (connectedRef.current.has(p.id)) return;
      connectedRef.current.add(p.id);
      if (userIDonServer < p.id) {
        const entry = getOrCreatePeer(p.id);
        if (voiceLocalStream.current && entry.pc.getSenders().length === 0) {
          voiceLocalStream.current.getTracks().forEach(t => entry.pc.addTrack(t, voiceLocalStream.current!));
        }
      } else {
        getOrCreatePeer(p.id);
      }
    });

    peers.current.forEach((entry, uid) => {
      if (!voiceParticipants.find(p => p.id === uid)) {
        entry.pc.close();
        peers.current.delete(uid);
        remoteStreams.current.delete(uid);
        analysers.current.delete(uid);
        connectedRef.current.delete(uid);
        rerender();
      }
    });
  }, [voiceParticipants, getOrCreatePeer, userIDonServer, voiceLocalStream, rerender]);

  const value: VoiceRoomValue = {
    remoteStreams: remoteStreams.current,
    localVideo: localVideo.current,
    videoKind,
    startVideo,
    stopVideo,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {currentVoiceChannel && [...remoteStreams.current.entries()].map(([id, stream]) => (
        <AudioEl key={id} stream={stream} muted={!isHeadphonesActive} />
      ))}
    </Ctx.Provider>
  );
};

// ── The visible card grid ──────────────────────────────────────────────────

function TileVideo({ stream, mirror }: { stream: MediaStream; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return (
    <video ref={ref} autoPlay playsInline muted
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: '#000', transform: mirror ? 'scaleX(-1)' : undefined }} />
  );
}

function initials(name: string) {
  return name.split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || name.slice(0, 2).toUpperCase();
}

export const GuildVoiceStage: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const tr = useTranslation();
  const voice = useVoiceRoom();
  const {
    currentVoiceChannel, voiceParticipants, SpeakersActive, userIDonServer,
    currentUser, currentServerIP, leaveVoiceChannel, voiceLocalStream,
    isMicActive, setMicActive, setMobileActivePanel,
  } = useApp();

  const toggleMic = () => {
    const next = !isMicActive;
    setMicActive(next);
    voiceLocalStream.current?.getAudioTracks().forEach(t => { t.enabled = next; });
  };

  if (!currentVoiceChannel) return null;

  const remoteStreams = voice?.remoteStreams;
  const localVideo = voice?.localVideo ?? null;
  const videoKind = voice?.videoKind ?? null;

  const videoFor = (id: string): { stream: MediaStream; mirror: boolean } | null => {
    if (id === userIDonServer) {
      return localVideo ? { stream: localVideo, mirror: videoKind === 'camera' } : null;
    }
    const s = remoteStreams?.get(id);
    if (s && s.getVideoTracks().some(t => t.readyState === 'live' && !t.muted)) return { stream: s, mirror: false };
    return null;
  };

  const avatarUrl = (raw: string) => raw ? (raw.startsWith('http') ? raw : `${currentServerIP}${raw}`) : '';

  // Self may not be in the presence list yet — make sure there is always a card
  // for the local user.
  const list = [...voiceParticipants];
  if (currentUser && !list.some(p => p.id === userIDonServer)) {
    list.unshift({ id: userIDonServer, username: currentUser.username, nickname: currentUser.username, avatar: currentUser.avatar || '', muted: !isMicActive, deafened: false });
  }

  return (
    <div className="guild-chat-main" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg-primary)', ...style }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <button
          className="mobile-back-btn"
          style={{ display: 'none', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0 4px 0 0', alignItems: 'center' }}
          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setMobileActivePanel('guild-channels'); }}
          onClick={e => { e.preventDefault(); e.stopPropagation(); setMobileActivePanel('guild-channels'); }}
          aria-label="Back"
        >
          <ChevronLeft size={20} />
        </button>
        <Monitor size={16} style={{ color: 'var(--accent-primary)' }} />
        <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 15 }}>{currentVoiceChannel.name}</span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>· {list.length}</span>
      </div>

      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto', padding: 16,
        display: 'grid', gap: 14, alignContent: 'center', justifyContent: 'center', justifyItems: 'center',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 320px))',
      }}>
        {list.map(p => {
          const vid = videoFor(p.id);
          const name = p.nickname || p.username;
          const speaking = !p.muted && SpeakersActive.includes(p.id);
          const av = avatarUrl(p.avatar);
          const isSelf = p.id === userIDonServer;
          return (
            <div key={p.id} style={{
              position: 'relative', width: '100%', maxWidth: 320, aspectRatio: '16 / 10', borderRadius: 14, overflow: 'hidden',
              background: 'var(--bg-secondary, #1e1f22)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: speaking ? '2px solid #3ba55c' : '2px solid transparent',
              boxShadow: speaking ? '0 0 0 3px rgba(59,165,92,0.25)' : 'none',
              transition: 'border-color .1s, box-shadow .1s',
            }}>
              {vid ? (
                <TileVideo stream={vid.stream} mirror={vid.mirror} />
              ) : av ? (
                <img src={av} alt={name} style={{ width: 88, height: 88, borderRadius: '50%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: 88, height: 88, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-primary)', color: '#fff', fontSize: 30, fontWeight: 700 }}>
                  {initials(name)}
                </div>
              )}
              <div style={{
                position: 'absolute', left: 10, bottom: 10, display: 'flex', alignItems: 'center', gap: 6,
                background: 'rgba(0,0,0,0.55)', padding: '4px 10px', borderRadius: 8, maxWidth: 'calc(100% - 20px)',
              }}>
                {p.muted && <MicOff size={13} style={{ color: '#ed4245', flexShrink: 0 }} />}
                <span style={{ fontSize: 13, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {isSelf ? `${name} (${tr('gvr_you')})` : name}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Control bar */}
      <div style={{ flexShrink: 0, padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, borderTop: '1px solid var(--border-color)' }}>
        <button onClick={toggleMic} title={isMicActive ? tr('gvr_mute') : tr('gvr_unmute')} style={ctrlBtn(!isMicActive, !isMicActive ? '#ed4245' : undefined)}>
          {isMicActive ? <Mic size={18} /> : <MicOff size={18} />}
        </button>
        <button onClick={() => (videoKind === 'screen' ? voice?.stopVideo() : voice?.startVideo('screen'))}
          title={videoKind === 'screen' ? tr('gvr_stop_screen') : tr('gvr_share_screen')} style={ctrlBtn(videoKind === 'screen')}>
          {videoKind === 'screen' ? <MonitorOff size={18} /> : <Monitor size={18} />}
        </button>
        <button onClick={() => (videoKind === 'camera' ? voice?.stopVideo() : voice?.startVideo('camera'))}
          title={videoKind === 'camera' ? tr('gvr_stop_camera') : tr('gvr_start_camera')} style={ctrlBtn(videoKind === 'camera')}>
          {videoKind === 'camera' ? <VideoOff size={18} /> : <Video size={18} />}
        </button>
        <button onClick={() => leaveVoiceChannel()} title={tr('voice_disconnect')} style={{ ...ctrlBtn(false), background: '#ed4245', color: '#fff', width: 'auto', padding: '0 18px', gap: 8 }}>
          <PhoneOff size={18} /> <span style={{ fontSize: 14, fontWeight: 600 }}>{tr('voice_disconnect')}</span>
        </button>
      </div>
    </div>
  );
};

function ctrlBtn(active: boolean, bg?: string): React.CSSProperties {
  return {
    minWidth: 44, height: 44, borderRadius: 22, cursor: 'pointer', border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: bg || (active ? 'var(--accent-primary)' : 'var(--bg-tertiary, rgba(255,255,255,0.08))'),
    color: active || bg ? '#fff' : 'var(--text-primary)',
  };
}
