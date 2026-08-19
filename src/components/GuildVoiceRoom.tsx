import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Monitor, Video, VideoOff, MonitorOff, PhoneOff, Maximize2, Minimize2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { getIceServers, getSelectedServerEntry, fetchPoolIceServers } from '../config/network';
const SPEAKING_THRESHOLD = 15; // 0–255 RMS; tune as needed

function AudioEl({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay style={{ display: 'none' }} />;
}

/** A single video tile in the stage — used for both local and remote feeds. */
function VideoTile({ stream, label, mirror, accent }: { stream: MediaStream; label: string; mirror?: boolean; accent?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return (
    <div style={{
      position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#000',
      border: accent ? '2px solid var(--accent-primary)' : '1px solid rgba(255,255,255,0.1)',
      aspectRatio: '16 / 9', minWidth: 0,
    }}>
      {/* Muted: the audio for every remote already plays through AudioEl, and the
          local preview must never echo the user back to themselves. */}
      <video ref={ref} autoPlay playsInline muted
        style={{ width: '100%', height: '100%', objectFit: 'contain', transform: mirror ? 'scaleX(-1)' : undefined }} />
      <span style={{
        position: 'absolute', left: 8, bottom: 8, fontSize: 12, fontWeight: 600, color: '#fff',
        background: 'rgba(0,0,0,0.55)', padding: '3px 8px', borderRadius: 6, maxWidth: 'calc(100% - 16px)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{label}</span>
    </div>
  );
}

interface PeerEntry {
  pc: RTCPeerConnection;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

export const GuildVoiceRoom: React.FC = () => {
  const {
    currentVoiceChannel,
    voiceParticipants,
    sendVoiceSignal,
    voiceSignalHandler,
    voiceLocalStream,
    userIDonServer,
    setSpeakersActive,
    leaveVoiceChannel,
    authToken,
    currentServerIP,
  } = useApp();
  const tr = useTranslation();

  const peers = useRef<Map<string, PeerEntry>>(new Map());
  // Valid (possibly HMAC-temporary) TURN creds fetched from /api/turn/. Guild
  // voice must use these — the static creds don't authenticate against a coturn
  // running in use-auth-secret mode, so relayed audio (behind NAT) would fail.
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

  // ── Outgoing video (screen share / camera) ─────────────────────────────────
  // Kept in a ref so peer callbacks always see the current track, and mirrored
  // into state so the stage re-renders when it turns on or off.
  const localVideo = useRef<MediaStream | null>(null);
  const [videoKind, setVideoKind] = useState<'screen' | 'camera' | null>(null);
  const [stageOpen, setStageOpen] = useState(true);

  // Push the local video track onto one peer connection (adds a sender, which
  // fires onnegotiationneeded and renegotiates automatically).
  const addVideoToPeer = useCallback((pc: RTCPeerConnection) => {
    const stream = localVideo.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const already = pc.getSenders().some(s => s.track === track);
    if (!already) pc.addTrack(track, stream);
  }, []);

  const stopVideo = useCallback(() => {
    const stream = localVideo.current;
    if (stream) {
      const tracks = stream.getTracks();
      peers.current.forEach(({ pc }) => {
        pc.getSenders().forEach(s => {
          if (s.track && tracks.includes(s.track)) {
            try { pc.removeTrack(s); } catch { /* peer already closing */ }
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
      // Replace any feed already running.
      if (localVideo.current) stopVideo();
      localVideo.current = stream;
      setVideoKind(kind);
      setStageOpen(true);
      // Stopping a screen share from the browser's own "Stop sharing" bar ends
      // the track directly — mirror that back into our state.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopVideo());
      peers.current.forEach(({ pc }) => addVideoToPeer(pc));
      rerender();
    } catch {
      // permission denied or the picker was dismissed — nothing to do
    }
  }, [addVideoToPeer, stopVideo, rerender]);

  // ── Audio analysis ─────────────────────────────────────────────────────────
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
    } catch { /* mic permission denied or stream inactive */ }
  }, [getAudioCtx]);

  // Poll every 80 ms and push speaking user IDs into shared state
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      analysers.current.clear();
      audioCtx.current?.close();
      audioCtx.current = null;
      setSpeakersActive([]);
    };
  }, [setSpeakersActive]);

  // ── Start local media ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        voiceLocalStream.current = stream;
        setupAnalyser(userIDonServer, stream);
        // Add tracks to peers created before media was ready (race condition fix)
        peers.current.forEach(({ pc }) => {
          if (pc.getSenders().filter(s => s.track).length === 0) {
            stream.getTracks().forEach(t => pc.addTrack(t, stream));
          }
        });
      } catch {
        // mic denied — still join without audio
      }
    })();
    return () => {
      cancelled = true;
      voiceLocalStream.current?.getTracks().forEach(t => t.stop());
      voiceLocalStream.current = null;
      analysers.current.delete(userIDonServer);
    };
  }, [voiceLocalStream, setupAnalyser, userIDonServer]);

  // ── Stop any local video when the channel is left ──────────────────────────
  useEffect(() => {
    return () => {
      localVideo.current?.getTracks().forEach(t => t.stop());
      localVideo.current = null;
    };
  }, []);

  // ── Cleanup all peers on unmount ───────────────────────────────────────────
  useEffect(() => {
    return () => {
      peers.current.forEach(({ pc }) => pc.close());
      peers.current.clear();
      remoteStreams.current.clear();
    };
  }, []);

  // ── Get or create a peer connection (perfect negotiation pattern) ──────────
  const getOrCreatePeer = useCallback((remoteId: string): PeerEntry => {
    if (peers.current.has(remoteId)) return peers.current.get(remoteId)!;

    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    const entry: PeerEntry = { pc, makingOffer: false, ignoreOffer: false };
    peers.current.set(remoteId, entry);

    if (voiceLocalStream.current) {
      voiceLocalStream.current.getTracks().forEach(t =>
        pc.addTrack(t, voiceLocalStream.current!)
      );
    }
    // A share already running when this peer joins has to reach it too.
    addVideoToPeer(pc);

    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      remoteStreams.current.set(remoteId, stream);
      setupAnalyser(remoteId, stream);
      // A remote muting/ending their camera should clear their tile.
      e.track.addEventListener('ended', rerender);
      e.track.addEventListener('mute', rerender);
      e.track.addEventListener('unmute', rerender);
      rerender();
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendVoiceSignal(remoteId, { type: 'candidate', candidate: e.candidate.toJSON() });
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        sendVoiceSignal(remoteId, { type: 'offer', sdp: pc.localDescription });
      } catch {
      } finally {
        entry.makingOffer = false;
      }
    };

    return entry;
  }, [sendVoiceSignal, rerender, voiceLocalStream, setupAnalyser, addVideoToPeer]);

  // ── Signal handler (perfect negotiation) ──────────────────────────────────
  useEffect(() => {
    voiceSignalHandler.current = async (data: unknown) => {
      const msg = data as {
        from: string;
        payload: {
          type: string;
          sdp?: RTCSessionDescriptionInit;
          candidate?: RTCIceCandidateInit;
        };
      };
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
      } catch {
      }
    };

    return () => { voiceSignalHandler.current = null; };
  }, [getOrCreatePeer, sendVoiceSignal, voiceSignalHandler, userIDonServer]);

  // ── Connect to new participants, clean up departed ones ────────────────────
  const connectedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    voiceParticipants.forEach(p => {
      if (p.id === userIDonServer) return;
      if (connectedRef.current.has(p.id)) return;
      connectedRef.current.add(p.id);

      if (userIDonServer < p.id) {
        const entry = getOrCreatePeer(p.id);
        if (voiceLocalStream.current) {
          const senders = entry.pc.getSenders();
          if (senders.length === 0) {
            voiceLocalStream.current.getTracks().forEach(t =>
              entry.pc.addTrack(t, voiceLocalStream.current!)
            );
          }
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

  if (!currentVoiceChannel) return null;

  const nameOf = (id: string) =>
    voiceParticipants.find(p => p.id === id)?.nickname
    || voiceParticipants.find(p => p.id === id)?.username
    || tr('gvr_someone');

  // Everything with a live video track: remote cameras/screens plus our own.
  const remoteVideos = [...remoteStreams.current.entries()]
    .filter(([, s]) => s.getVideoTracks().some(t => t.readyState === 'live' && !t.muted));
  const hasStage = !!localVideo.current || remoteVideos.length > 0;

  return (
    <>
      {[...remoteStreams.current.entries()].map(([id, stream]) => (
        <AudioEl key={id} stream={stream} />
      ))}

      {/* The video stage — sits over the chat area, Discord-style, whenever
          anyone in the channel is sharing. */}
      {hasStage && stageOpen && (
        <div style={{
          position: 'fixed', left: 0, right: 0, top: 0, bottom: 76, zIndex: 8000,
          background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
          display: 'flex', flexDirection: 'column', padding: 16, gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ color: '#fff', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Monitor size={16} /> {currentVoiceChannel.name}
            </div>
            <button onClick={() => setStageOpen(false)} title={tr('gvr_minimize')}
              style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', borderRadius: 8, padding: 8, cursor: 'pointer', display: 'flex' }}>
              <Minimize2 size={16} />
            </button>
          </div>
          <div style={{
            flex: 1, minHeight: 0, display: 'grid', gap: 12, overflow: 'auto',
            gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 340px), 1fr))`,
            alignContent: 'center',
          }}>
            {localVideo.current && (
              <VideoTile stream={localVideo.current} accent mirror={videoKind === 'camera'}
                label={`${tr('gvr_you')}${videoKind === 'screen' ? ` · ${tr('gvr_screen')}` : ''}`} />
            )}
            {remoteVideos.map(([id, stream]) => (
              <VideoTile key={id} stream={stream} label={nameOf(id)} />
            ))}
          </div>
        </div>
      )}

      {/* Persistent control bar while connected to voice. */}
      <div style={{
        position: 'fixed', left: '50%', bottom: 16, transform: 'translateX(-50%)',
        zIndex: 8100, display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--bg-secondary, #1e1f22)', border: '1px solid var(--border-color)',
        borderRadius: 999, padding: '7px 10px', boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
      }}>
        <button onClick={() => (videoKind === 'screen' ? stopVideo() : startVideo('screen'))}
          title={videoKind === 'screen' ? tr('gvr_stop_screen') : tr('gvr_share_screen')}
          style={ctrlBtn(videoKind === 'screen')}>
          {videoKind === 'screen' ? <MonitorOff size={18} /> : <Monitor size={18} />}
        </button>
        <button onClick={() => (videoKind === 'camera' ? stopVideo() : startVideo('camera'))}
          title={videoKind === 'camera' ? tr('gvr_stop_camera') : tr('gvr_start_camera')}
          style={ctrlBtn(videoKind === 'camera')}>
          {videoKind === 'camera' ? <VideoOff size={18} /> : <Video size={18} />}
        </button>
        {hasStage && !stageOpen && (
          <button onClick={() => setStageOpen(true)} title={tr('gvr_expand')} style={ctrlBtn(false)}>
            <Maximize2 size={18} />
          </button>
        )}
        <div style={{ width: 1, height: 22, background: 'var(--border-color)', margin: '0 2px' }} />
        <button onClick={() => { stopVideo(); leaveVoiceChannel(); }} title={tr('voice_disconnect')}
          style={{ ...ctrlBtn(false), background: '#ed4245', color: '#fff' }}>
          <PhoneOff size={18} />
        </button>
      </div>
    </>
  );
};

function ctrlBtn(active: boolean): React.CSSProperties {
  return {
    width: 40, height: 40, borderRadius: '50%', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: 'none',
    background: active ? 'var(--accent-primary)' : 'var(--bg-tertiary, rgba(255,255,255,0.08))',
    color: active ? '#fff' : 'var(--text-primary)',
  };
}
