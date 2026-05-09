import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useApp } from '../context/AppContext';

const ICE_SERVERS = [
  { urls: 'stun:bottomweb.ru:3478' },
  {
    urls: [
      'turn:bottomweb.ru:3478?transport=udp',
      'turn:bottomweb.ru:3478?transport=tcp',
    ],
    username: 'ionikuser',
    credential: 'ionikturn123',
  },
];
const SPEAKING_THRESHOLD = 15; // 0–255 RMS; tune as needed

function AudioEl({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay style={{ display: 'none' }} />;
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
  } = useApp();

  const peers = useRef<Map<string, PeerEntry>>(new Map());
  const remoteStreams = useRef<Map<string, MediaStream>>(new Map());
  const [, forceUpdate] = useState(0);
  const rerender = useCallback(() => forceUpdate(n => n + 1), []);

  // ── Audio analysis ─────────────────────────────────────────────────────────
  const audioCtx = useRef<AudioContext | null>(null);
  const analysers = useRef<Map<string, { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }>>(new Map());

  const getAudioCtx = useCallback((): AudioContext => {
    if (!audioCtx.current) audioCtx.current = new AudioContext();
    return audioCtx.current;
  }, []);

  const setupAnalyser = useCallback((userId: string, stream: MediaStream) => {
    if (analysers.current.has(userId)) return;
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

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry: PeerEntry = { pc, makingOffer: false, ignoreOffer: false };
    peers.current.set(remoteId, entry);

    if (voiceLocalStream.current) {
      voiceLocalStream.current.getTracks().forEach(t =>
        pc.addTrack(t, voiceLocalStream.current!)
      );
    }

    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      remoteStreams.current.set(remoteId, stream);
      setupAnalyser(remoteId, stream);
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
  }, [sendVoiceSignal, rerender, voiceLocalStream, setupAnalyser]);

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

  return (
    <>
      {[...remoteStreams.current.entries()].map(([id, stream]) => (
        <AudioEl key={id} stream={stream} />
      ))}
    </>
  );
};
