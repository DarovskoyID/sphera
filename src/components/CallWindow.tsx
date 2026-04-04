import { useRef, useEffect, useState, useCallback } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';

// ── Module-level helpers (never redefined, so video refs stay stable) ──────────

const UserAvatar = ({ name, avatar, size = 80 }: { name: string; avatar: string; size?: number }) => (
  avatar ? (
    <img src={avatar} alt={name} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', border: '3px solid var(--accent-primary, #5865f2)' }} />
  ) : (
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--accent-primary, #5865f2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.4, fontWeight: 700, color: '#fff' }}>
      {name[0]?.toUpperCase() ?? '?'}
    </div>
  )
);

// Tile changes its own wrapper to position:fixed when expanded — video stays in ONE DOM node, ref intact
const Tile = ({ id, label, children, expandedTile, setExpandedTile }: {
  id: string;
  label: string;
  children: React.ReactNode;
  expandedTile: string | null;
  setExpandedTile: (id: string | null) => void;
}) => {
  const isExp = expandedTile === id;
  return (
    <div style={isExp
      ? { position: 'fixed', inset: 0, zIndex: 9600, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }
      : { position: 'relative', background: '#000', borderRadius: 6, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0, minWidth: 0 }
    }>
      {children}
      <span style={{ position: 'absolute', bottom: isExp ? 14 : 4, left: isExp ? 16 : 6, fontSize: isExp ? 13 : 11, color: '#ccc', background: 'rgba(0,0,0,0.55)', borderRadius: 4, padding: '2px 6px' }}>
        {label}
      </span>
      <button
        onClick={() => setExpandedTile(isExp ? null : id)}
        title={isExp ? 'Restore' : 'Expand to full window'}
        style={{ position: 'absolute', top: isExp ? 12 : 4, right: isExp ? 12 : 4, background: 'rgba(0,0,0,0.55)', border: 'none', borderRadius: 6, padding: isExp ? '6px 8px' : 3, cursor: 'pointer', color: '#fff', display: 'flex' }}
      >
        {isExp ? <Minimize2 size={16} /> : <Maximize2 size={12} />}
      </button>
    </div>
  );
};

export const CallWindow = () => {
  const {
    isDemonstrationActive,
    isVideoActive,
    setCallActive,
    setDemonstrationActive,
    setVideoActive,
    setCallStatus,
    sendSignal,
    onSignalingMessage,
    callTargetId,
    setCallTargetId,
    incomingOffer,
    setIncomingOffer,
    friends,
  } = useApp();
  const tr = useTranslation();

  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteScreenVideoRef = useRef<HTMLVideoElement>(null);

  const audioStream = useRef<MediaStream | null>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const localMediaStream = useRef<MediaStream>(new MediaStream());

  const [remoteVideoStatus, setRemoteVideoStatus] = useState<string>('нет видео');
  const [localVideoStatus, setLocalVideoStatus] = useState<string>('нет видео');
  const [remotePeerId, setRemotePeerId] = useState<string | null>(null);
  const [windowExpanded, setWindowExpanded] = useState(false);
  const [expandedTile, setExpandedTile] = useState<string | null>(null); // 'local' | 'remote' | 'screen' | 'remoteScreen'

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const targetIdRef = useRef<string | null>(null);
  const pendingCandidates = useRef<RTCIceCandidate[]>([]);

  const remoteStreamRef = useRef<MediaStream | null>(null);
  const remoteScreenStreamRef = useRef<MediaStream | null>(null);
  const screenSenderRef = useRef<RTCRtpSender | null>(null);
  const [remoteScreenActive, setRemoteScreenActive] = useState(false);

  const hasAutoCalledRef = useRef(false);
  const hasProcessedOffer = useRef(false);

  // ==================== Local video helpers ====================
  const attachStreamToVideo = (
    videoEl: HTMLVideoElement | null,
    stream: MediaStream | null,
    setStatus: (s: string) => void,
    muted = true
  ) => {
    if (!videoEl || !stream) {
      setStatus('нет элемента или srcObject');
      return;
    }
    if (videoEl.srcObject === stream) return;

    videoEl.srcObject = stream;
    videoEl.muted = muted;
    videoEl.playsInline = true;

    videoEl.onloadedmetadata = () => {
      videoEl.play()
        .then(() => setStatus('видео играет'))
        .catch(err => {
          setStatus(err.name);
        });
    };
  };

  const startAudio = async () => {
    if (audioStream.current?.active) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioStream.current = stream;
  };

  const startCamera = async (): Promise<boolean> => {
    if (cameraStream.current?.active) return true;
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    cameraStream.current = stream;
    return true;
  };

  const addLocalTracks = (pc: RTCPeerConnection) => {
    const senders = pc.getSenders();
    if (audioStream.current) {
      audioStream.current.getAudioTracks().forEach(track => {
        if (!senders.some(s => s.track?.id === track.id)) {
          pc.addTrack(track, localMediaStream.current);
        }
      });
    }
    if (cameraStream.current) {
      cameraStream.current.getVideoTracks().forEach(track => {
        if (!senders.some(s => s.track?.id === track.id)) {
          pc.addTrack(track, localMediaStream.current);
        }
      });
    }
    if (screenStream.current) {
      const screenTrack = screenStream.current.getVideoTracks()[0];
      if (screenTrack && !senders.some(s => s.track?.id === screenTrack.id)) {
        const sender = pc.addTrack(screenTrack, screenStream.current);
        screenSenderRef.current = sender;
      }
    }
  };

  const startScreen = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStream.current = stream;
      attachStreamToVideo(screenVideoRef.current, stream, () => {}, true);

      const pc = pcRef.current;

      if (audioStream.current) {
        const audioTrack = audioStream.current.getAudioTracks()[0];
        if (!audioTrack || audioTrack.readyState !== 'live') {
          const newAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (pc) {
            const oldTrack = audioStream.current.getAudioTracks()[0];
            const newTrack = newAudioStream.getAudioTracks()[0];
            if (oldTrack && newTrack) {
              const sender = pc.getSenders().find(s => s.track?.id === oldTrack.id);
              if (sender) await sender.replaceTrack(newTrack);
            }
          }
          audioStream.current.getTracks().forEach(t => t.stop());
          audioStream.current = newAudioStream;
        }
      }

      if (cameraStream.current) {
        const camTrack = cameraStream.current.getVideoTracks()[0];
        if (!camTrack || camTrack.readyState !== 'live') {
          const newCamStream = await navigator.mediaDevices.getUserMedia({ video: true });
          if (pc) {
            const oldTrack = cameraStream.current.getVideoTracks()[0];
            const newTrack = newCamStream.getVideoTracks()[0];
            if (oldTrack && newTrack) {
              const sender = pc.getSenders().find(s => s.track?.id === oldTrack.id);
              if (sender) await sender.replaceTrack(newTrack);
            }
          }
          cameraStream.current.getTracks().forEach(t => t.stop());
          cameraStream.current = newCamStream;
          if (cameraVideoRef.current) {
            cameraVideoRef.current.srcObject = newCamStream;
            cameraVideoRef.current.play().catch(() => {});
          }
        } else {
          if (cameraVideoRef.current) {
            cameraVideoRef.current.play().catch(() => {});
          }
        }
      }

      const targetId = targetIdRef.current;
      if (pc && targetId) {
        const screenTrack = stream.getVideoTracks()[0];
        const sender = pc.addTrack(screenTrack, stream);
        screenSenderRef.current = sender;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({ type: 'offer', sdp: offer, to: targetId });
        sendSignal({ type: 'demo-toggle', enabled: true, to: targetId });
      }

      stream.getVideoTracks()[0].onended = () => {
        setDemonstrationActive(false);
      };
    } catch {
      setDemonstrationActive(false);
    }
  };

  const stopScreen = async () => {
    screenStream.current?.getTracks().forEach(t => t.stop());
    screenStream.current = null;
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;

    const pc = pcRef.current;
    const targetId = targetIdRef.current;
    if (pc && targetId && screenSenderRef.current) {
      pc.removeTrack(screenSenderRef.current);
      screenSenderRef.current = null;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', sdp: offer, to: targetId });
      sendSignal({ type: 'demo-toggle', enabled: false, to: targetId });
    }
  };

  const stopAllMedia = () => {
    audioStream.current?.getTracks().forEach(t => t.stop());
    cameraStream.current?.getTracks().forEach(t => t.stop());
    screenStream.current?.getTracks().forEach(t => t.stop());
    audioStream.current = null;
    cameraStream.current = null;
    screenStream.current = null;
    localMediaStream.current = new MediaStream();
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    setLocalVideoStatus('нет видео');
  };

  // ==================== WebRTC ====================
  const attachRemoteStream = useCallback((stream: MediaStream) => {
    const videoEl = remoteVideoRef.current;
    if (!videoEl) return;
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.playsInline = true;

    const tryPlay = () => {
      videoEl.play()
        .then(() => {
          setRemoteVideoStatus('видео играет');
          setTimeout(() => { if (videoEl) videoEl.muted = false; }, 1000);
        })
        .catch(() => setTimeout(tryPlay, 500));
    };
    tryPlay();
  }, []);

  const createPeerConnection = (remoteId: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'candidate', candidate: event.candidate, to: remoteId });
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;

      if (!remoteStreamRef.current) {
        remoteStreamRef.current = stream;
        attachRemoteStream(stream);
      } else if (stream.id !== remoteStreamRef.current.id) {
        remoteScreenStreamRef.current = stream;
        const screenEl = remoteScreenVideoRef.current;
        if (screenEl) {
          screenEl.srcObject = stream;
          screenEl.muted = true;
          screenEl.playsInline = true;
          screenEl.play().catch(() => {});
        }
        setRemoteScreenActive(true);

        event.track.onended = () => {
          remoteScreenStreamRef.current = null;
          if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null;
          setRemoteScreenActive(false);
        };
        event.track.onmute = () => {
          remoteScreenStreamRef.current = null;
          if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null;
          setRemoteScreenActive(false);
        };
      }
    };

    return pc;
  };

  // ==================== Local video useEffect ====================
  useEffect(() => {
    if (!isVideoActive) return;

    const init = async () => {
      if (!cameraStream.current?.active) {
        await startCamera();
      }
      if (cameraVideoRef.current && cameraStream.current) {
        attachStreamToVideo(cameraVideoRef.current, cameraStream.current, setLocalVideoStatus, true);
      }
    };
    init();
  }, [isVideoActive]);

  // ==================== Screen sharing useEffect ====================
  useEffect(() => {
    if (isDemonstrationActive) {
      startScreen();
    } else {
      stopScreen();
    }
  }, [isDemonstrationActive]);

  // ==================== Handle incoming signals ====================
  // Use a ref to always point to the latest handler — avoids null gaps during re-renders
  const handleSignalRef = useRef<(msg: any) => void>(() => {});

  handleSignalRef.current = async (msg: any) => {
    const senderId = String(msg.from);
    if (!senderId) return;

    if (msg.type === 'offer') {
      if (pcRef.current && String(targetIdRef.current) === senderId) {
        const pc = pcRef.current;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          addLocalTracks(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({ type: 'answer', sdp: answer, to: senderId });
          for (const c of pendingCandidates.current) await pc.addIceCandidate(c);
          pendingCandidates.current = [];
        } catch { }
        return;
      }

      if (pcRef.current && String(targetIdRef.current) !== senderId) {
        sendSignal({ type: 'call-rejected', to: senderId });
        return;
      }
      return;
    } else if (msg.type === 'call-end' || msg.type === 'call-rejected') {
      if (String(targetIdRef.current) === senderId) {
        stopCall(false);
      }
      return;
    }

    // For answer/candidate: ensure we have a PC with this sender
    if (!pcRef.current || String(targetIdRef.current) !== senderId) {
      pcRef.current = createPeerConnection(senderId);
      targetIdRef.current = senderId;
      pendingCandidates.current = [];
    }
    const pc = pcRef.current;

    if (msg.type === 'answer') {
      try {
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        for (const c of pendingCandidates.current) await pc.addIceCandidate(c);
        pendingCandidates.current = [];
      } catch { }
    } else if (msg.type === 'candidate') {
      try {
        if (msg.candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } else {
            pendingCandidates.current.push(msg.candidate);
          }
        }
      } catch { }
    } else if (msg.type === 'video-toggle') {
      if (msg.enabled) {
        setRemoteVideoStatus('видео включено');
      } else {
        setRemoteVideoStatus('видео выключено');
      }
    } else if (msg.type === 'demo-toggle') {
      if (!msg.enabled) {
        remoteScreenStreamRef.current = null;
        if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null;
      }
      setRemoteScreenActive(msg.enabled);
    }
  };

  // Register a stable handler on mount, clear on unmount — no gaps during re-renders
  useEffect(() => {
    const stableHandler = (msg: any) => handleSignalRef.current(msg);
    onSignalingMessage.current = stableHandler;
    return () => {
      if (onSignalingMessage.current === stableHandler) {
        onSignalingMessage.current = null;
      }
    };
  }, []);

  // Process incoming offer stored by IncomingCallModal (user accepted)
  useEffect(() => {
    if (incomingOffer && !hasProcessedOffer.current) {
      hasProcessedOffer.current = true;
      processIncomingOffer(incomingOffer);
      setIncomingOffer(null);
    }
  }, [incomingOffer]);

  // Auto-call target on mount (triggered from ChatMain Phone/Video buttons)
  useEffect(() => {
    if (!callTargetId || hasAutoCalledRef.current || incomingOffer) return;
    hasAutoCalledRef.current = true;
    const targetId = String(callTargetId);
    setCallTargetId(null);
    callPeer(targetId);
  }, [callTargetId]);

  // ==================== Call peer ====================
  const callPeer = async (peerId: string) => {
    targetIdRef.current = String(peerId);
    setRemotePeerId(String(peerId));
    pendingCandidates.current = [];

    try { await startAudio(); } catch { }
    try {
      if (!cameraStream.current?.active) {
        const ok = await startCamera();
        if (ok) setVideoActive(true);
      }
      if (cameraVideoRef.current && cameraStream.current) {
        attachStreamToVideo(cameraVideoRef.current, cameraStream.current, setLocalVideoStatus, true);
      }
    } catch { }

    const pc = createPeerConnection(String(peerId));
    pcRef.current = pc;

    addLocalTracks(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: 'offer', sdp: offer, to: peerId });
  };

  // Process incoming offer from IncomingCallModal (user accepted the call)
  const processIncomingOffer = async (msg: any) => {
    const senderId = String(msg.from);
    setRemotePeerId(senderId);

    // Prevent auto-call effect from also firing
    hasAutoCalledRef.current = true;
    setCallTargetId(null);

    try {
      if (pcRef.current) pcRef.current.close();
      pcRef.current = createPeerConnection(senderId);
      targetIdRef.current = senderId;
      pendingCandidates.current = [];
      remoteStreamRef.current = null;
      remoteScreenStreamRef.current = null;

      const pc = pcRef.current;

      // Start media — failures are non-fatal so the answer is always sent
      try { await startAudio(); } catch { }
      try {
        if (!cameraStream.current?.active) {
          await startCamera();
          setVideoActive(true);
        }
        if (cameraVideoRef.current && cameraStream.current) {
          attachStreamToVideo(cameraVideoRef.current, cameraStream.current, setLocalVideoStatus, true);
        }
      } catch { }

      // Set remote description (the offer)
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));

      // Add local tracks so the answer includes our media
      addLocalTracks(pc);

      // Create and send answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: answer, to: senderId });

      // Replay any ICE candidates buffered while modal was shown
      if (msg.bufferedCandidates?.length) {
        for (const candidateMsg of msg.bufferedCandidates) {
          if (candidateMsg.candidate) {
            try { await pc.addIceCandidate(new RTCIceCandidate(candidateMsg.candidate)); } catch { }
          }
        }
      }

      // Flush any candidates that arrived during processing
      for (const c of pendingCandidates.current) await pc.addIceCandidate(c);
      pendingCandidates.current = [];

    } catch { }

  };

  const stopCall = (notifyRemote = true) => {
    const targetId = targetIdRef.current;

    pcRef.current?.close();
    pcRef.current = null;

    targetIdRef.current = null;
    pendingCandidates.current = [];

    stopAllMedia();

    remoteStreamRef.current = null;
    remoteScreenStreamRef.current = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null;

    if (notifyRemote && targetId) {
      sendSignal({ type: 'call-end', to: targetId });
    }

    hasAutoCalledRef.current = false;
    setCallTargetId(null);
    setRemotePeerId(null);
    setRemoteVideoStatus('нет видео');
    setRemoteScreenActive(false);
    setCallActive(false);
    setCallStatus('inactive');
    setVideoActive(false);
    setDemonstrationActive(false);
  };


  // ==================== UI ====================
  const remoteUser = remotePeerId ? friends.find(f => String(f.id) === remotePeerId) : null;
  const remoteName = remoteUser?.nickname || remoteUser?.username || remotePeerId || '?';
  const remoteAvatar = remoteUser?.avatar || '';

  // Count visible tiles to pick grid layout
  const tileCount = 2 + (isDemonstrationActive ? 1 : 0) + (remoteScreenActive ? 1 : 0);
  const cols = Math.min(tileCount, 2);

  const videoFill: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
  };

  const placeholderStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    height: '100%',
    background: '#1a1a2e',
  };

  const outerStyle: React.CSSProperties = windowExpanded
    ? { position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 9500, background: '#111', display: 'flex', flexDirection: 'column' }
    : { height: 420, background: '#111', display: 'flex', flexDirection: 'column' };

  return (
    <div className="call-window" style={outerStyle}>
      {/* Call header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: 'rgba(0,0,0,0.5)', flexShrink: 0 }}>
        {remotePeerId ? (
          <>
            <UserAvatar name={remoteName} avatar={remoteAvatar} size={28} />
            <div style={{ flex: 1 }}>
              <div style={{ color: '#fff', fontWeight: 600, fontSize: 13, lineHeight: 1.2 }}>{remoteName}</div>
              <div style={{ color: '#aaa', fontSize: 11 }}>{tr('call_active') ?? 'In call'}</div>
            </div>
          </>
        ) : (
          <div style={{ flex: 1 }} />
        )}
        <button
          onClick={() => setWindowExpanded(v => !v)}
          title={windowExpanded ? 'Restore window' : 'Maximize call window'}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', display: 'flex', padding: 4, borderRadius: 6 }}
        >
          {windowExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>

      {/* Video grid */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gridAutoRows: '1fr', gap: 3, padding: 3, minHeight: 0, overflow: 'hidden' }}>
        {/* Local camera */}
        <Tile id="local" label={tr('call_you') ?? 'You'} expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
          <video ref={cameraVideoRef} autoPlay muted playsInline style={{ ...videoFill, display: isVideoActive ? 'block' : 'none' }} />
          {!isVideoActive && (
            <div style={placeholderStyle}>
              <UserAvatar name="Me" avatar="" size={48} />
              <span style={{ color: '#aaa', fontSize: 12 }}>{tr('call_video_off')}</span>
            </div>
          )}
        </Tile>

        {/* Remote camera */}
        <Tile id="remote" label={remoteName} expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
          <video
            ref={remoteVideoRef} autoPlay muted playsInline
            style={{ ...videoFill, display: remoteVideoStatus !== 'видео выключено' ? 'block' : 'none' }}
            onClick={() => { if (remoteVideoRef.current) remoteVideoRef.current.muted = false; }}
          />
          {remoteVideoStatus === 'видео выключено' && (
            <div style={placeholderStyle}>
              <UserAvatar name={remoteName} avatar={remoteAvatar} size={48} />
              <span style={{ color: '#fff', fontWeight: 600, fontSize: 13 }}>{remoteName}</span>
              <span style={{ color: '#aaa', fontSize: 11 }}>{tr('call_remote_video_off')}</span>
            </div>
          )}
        </Tile>

        {/* Local screen share */}
        {isDemonstrationActive && (
          <Tile id="screen" label={tr('call_your_screen') ?? 'Your screen'} expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
            <video ref={screenVideoRef} autoPlay muted playsInline style={videoFill} />
          </Tile>
        )}

        {/* Remote screen share */}
        {remoteScreenActive && (
          <Tile id="remoteScreen" label={`${remoteName} — ${tr('call_screen') ?? 'screen'}`} expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
            <video ref={remoteScreenVideoRef} autoPlay muted playsInline style={videoFill} />
          </Tile>
        )}
      </div>

      {/* Controls */}
      <div style={{ padding: '7px 0', width: '100%', display: 'flex', gap: 10, justifyContent: 'center', flexShrink: 0 }}>
        <button className="icon-btn glass-btn" style={{ background: 'red' }} onClick={() => stopCall()}>X</button>
        <button
          className="icon-btn glass-btn"
          onClick={() => {
            const newState = !isVideoActive;
            setVideoActive(newState);
            if (cameraStream.current) {
              cameraStream.current.getVideoTracks().forEach(track => { track.enabled = newState; });
            }
            if (targetIdRef.current) {
              sendSignal({ type: 'video-toggle', enabled: newState, to: targetIdRef.current });
            }
          }}
        >
          C
        </button>
        <button className="icon-btn glass-btn" onClick={() => {
          if (audioStream.current) {
            audioStream.current.getAudioTracks().forEach(track => { track.enabled = !track.enabled; });
          }
        }}>M</button>
        <button className="icon-btn glass-btn">H</button>
        <button className="icon-btn glass-btn" onClick={() => setDemonstrationActive(!isDemonstrationActive)}>D</button>
      </div>
    </div>
  );
};
