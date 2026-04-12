import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useApp } from '../context/AppContext';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Audio element for a single remote stream
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
  } = useApp();

  const peers = useRef<Map<string, PeerEntry>>(new Map());
  const remoteStreams = useRef<Map<string, MediaStream>>(new Map());
  const [, forceUpdate] = useState(0);
  const rerender = useCallback(() => forceUpdate(n => n + 1), []);

  // ── Start local media ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        voiceLocalStream.current = stream;
      } catch {
        // mic denied — still join without audio
      }
    })();
    return () => {
      cancelled = true;
      voiceLocalStream.current?.getTracks().forEach(t => t.stop());
      voiceLocalStream.current = null;
    };
  }, [voiceLocalStream]);

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

    // Add local tracks
    if (voiceLocalStream.current) {
      voiceLocalStream.current.getTracks().forEach(t =>
        pc.addTrack(t, voiceLocalStream.current!)
      );
    }

    // Remote audio
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      remoteStreams.current.set(remoteId, stream);
      rerender();
    };

    // ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendVoiceSignal(remoteId, { type: 'candidate', candidate: e.candidate.toJSON() });
      }
    };

    // Negotiation needed — only the "polite" side defers, but here we trigger offers
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
  }, [sendVoiceSignal, rerender, voiceLocalStream]);

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

      // "polite" peer = the one with the numerically higher user ID
      // "impolite" peer = lower ID — never backs down from its offer
      const polite = userIDonServer > from;

      const entry = getOrCreatePeer(from);
      const { pc } = entry;

      try {
        if (payload.type === 'offer') {
          const offerCollision =
            entry.makingOffer || pc.signalingState !== 'stable';

          entry.ignoreOffer = !polite && offerCollision;
          if (entry.ignoreOffer) return;

          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp!));
          await pc.setLocalDescription();
          sendVoiceSignal(from, { type: 'answer', sdp: pc.localDescription });

        } else if (payload.type === 'answer') {
          if (pc.signalingState === 'stable') return; // already settled, ignore
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
    // Connect to any participant we haven't connected to yet
    voiceParticipants.forEach(p => {
      if (p.id === userIDonServer) return;
      if (connectedRef.current.has(p.id)) return;
      connectedRef.current.add(p.id);

      // Only the "impolite" (lower ID) side initiates — prevents glare
      if (userIDonServer < p.id) {
        const entry = getOrCreatePeer(p.id);
        // Trigger negotiation by adding tracks if not done yet
        if (voiceLocalStream.current) {
          const senders = entry.pc.getSenders();
          if (senders.length === 0) {
            voiceLocalStream.current.getTracks().forEach(t =>
              entry.pc.addTrack(t, voiceLocalStream.current!)
            );
          }
        }
      }
      // The "polite" (higher ID) side waits for an offer from the other side
      // but we still create the peer entry so it's ready to receive signals
      else {
        getOrCreatePeer(p.id);
      }
    });

    // Clean up peers whose participants have left
    peers.current.forEach((entry, uid) => {
      if (!voiceParticipants.find(p => p.id === uid)) {
        entry.pc.close();
        peers.current.delete(uid);
        remoteStreams.current.delete(uid);
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
