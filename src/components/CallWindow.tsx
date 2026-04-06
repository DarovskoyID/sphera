import { useRef, useEffect, useState, useCallback } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useApp } from '../context/AppContext';

// ── Module-level helpers (never redefined) ────────────────────────────────────

const UserAvatar = ({ name, avatar, size = 80 }: { name: string; avatar: string; size?: number }) => (
  avatar ? (
    <img src={avatar} alt={name} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', border: '3px solid var(--accent-primary, #5865f2)' }} />
  ) : (
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--accent-primary, #5865f2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.4, fontWeight: 700, color: '#fff' }}>
      {name[0]?.toUpperCase() ?? '?'}
    </div>
  )
);

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

// ── Module-level stream attachment pointers ───────────────────────────────────
// Updated on every render so pc.ontrack always reaches the live video element,
// even after the component unmounts and remounts (inline ↔ floating transition).
let _attachRemoteRef: { current: (stream: MediaStream) => void } | null = null;
let _attachRemoteScreenRef: { current: (stream: MediaStream) => void } | null = null;
let _clearRemoteScreenRef: { current: () => void } | null = null;

// ── Module-level call state ───────────────────────────────────────────────────
// Lives outside React so WebRTC connection survives component unmount/remount
// when the user navigates away from the chat while a call is active.
const _call = {
  pc: null as RTCPeerConnection | null,
  audioStream: null as MediaStream | null,
  cameraStream: null as MediaStream | null,
  screenStream: null as MediaStream | null,
  localMediaStream: new MediaStream(),
  remoteStream: null as MediaStream | null,
  remoteScreenStream: null as MediaStream | null,
  screenSender: null as RTCRtpSender | null,
  targetId: null as string | null,
  pendingCandidates: [] as RTCIceCandidate[],
  hasAutoCalled: false,
  hasProcessedOffer: false,
  remotePeerId: null as string | null,
  remoteScreenActive: false,
};

// ── Component ─────────────────────────────────────────────────────────────────

export const CallWindow = ({ inline = false }: { inline?: boolean }) => {
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


  // Video element refs — recreated on each mount; streams re-attached via useEffect
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteScreenVideoRef = useRef<HTMLVideoElement>(null);

  // Visual state — initialised from module-level so it's correct after remount
  const [remoteVideoStatus, setRemoteVideoStatus] = useState<string>(
    _call.remoteStream ? 'видео играет' : 'нет видео'
  );
  const [, setLocalVideoStatus] = useState<string>(
    _call.cameraStream?.active ? 'видео играет' : 'нет видео'
  );
  const [windowExpanded, setWindowExpanded] = useState(false);
  const [expandedTile, setExpandedTile] = useState<string | null>(null);

  // These two need to stay in sync with _call so remounts read correct value
  const [remotePeerId, setRemotePeerIdState] = useState<string | null>(_call.remotePeerId);
  const [remoteScreenActive, setRemoteScreenActiveState] = useState(_call.remoteScreenActive);

  const setRemotePeerId = (id: string | null) => {
    _call.remotePeerId = id;
    setRemotePeerIdState(id);
  };
  const setRemoteScreenActive = (v: boolean) => {
    _call.remoteScreenActive = v;
    setRemoteScreenActiveState(v);
  };

  // On mount: re-attach streams that survived the previous unmount
  useEffect(() => {
    if (_call.cameraStream?.active && cameraVideoRef.current) {
      cameraVideoRef.current.srcObject = _call.cameraStream;
      cameraVideoRef.current.muted = true;
      cameraVideoRef.current.playsInline = true;
      cameraVideoRef.current.play().catch(() => {});
      setLocalVideoStatus('видео играет');
    }
    if (_call.remoteStream && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = _call.remoteStream;
      remoteVideoRef.current.muted = false;
      remoteVideoRef.current.playsInline = true;
      remoteVideoRef.current.play().catch(() => {});
      setRemoteVideoStatus('видео играет');
    }
    if (_call.screenStream?.active && screenVideoRef.current) {
      screenVideoRef.current.srcObject = _call.screenStream;
      screenVideoRef.current.play().catch(() => {});
    }
    if (_call.remoteScreenStream && remoteScreenVideoRef.current) {
      remoteScreenVideoRef.current.srcObject = _call.remoteScreenStream;
      remoteScreenVideoRef.current.play().catch(() => {});
    }
  }, []); // only on mount

  // ==================== Local video helpers ====================
  const attachStreamToVideo = (
    videoEl: HTMLVideoElement | null,
    stream: MediaStream | null,
    setStatus: (s: string) => void,
    muted = true
  ) => {
    if (!videoEl || !stream) return;
    if (videoEl.srcObject === stream) return;
    videoEl.srcObject = stream;
    videoEl.muted = muted;
    videoEl.playsInline = true;
    videoEl.onloadedmetadata = () => {
      videoEl.play()
        .then(() => setStatus('видео играет'))
        .catch(err => setStatus(err.name));
    };
  };

  const startAudio = async () => {
    if (_call.audioStream?.active) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _call.audioStream = stream;
  };

  const startCamera = async (): Promise<boolean> => {
    if (_call.cameraStream?.active) return true;
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    _call.cameraStream = stream;
    return true;
  };

  const addLocalTracks = (pc: RTCPeerConnection) => {
    const senders = pc.getSenders();
    if (_call.audioStream) {
      _call.audioStream.getAudioTracks().forEach(track => {
        if (!senders.some(s => s.track?.id === track.id))
          pc.addTrack(track, _call.localMediaStream);
      });
    }
    if (_call.cameraStream) {
      _call.cameraStream.getVideoTracks().forEach(track => {
        if (!senders.some(s => s.track?.id === track.id))
          pc.addTrack(track, _call.localMediaStream);
      });
    }
    if (_call.screenStream) {
      const screenTrack = _call.screenStream.getVideoTracks()[0];
      if (screenTrack && !senders.some(s => s.track?.id === screenTrack.id)) {
        _call.screenSender = pc.addTrack(screenTrack, _call.screenStream);
      }
    }
  };

  const startScreen = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      _call.screenStream = stream;
      attachStreamToVideo(screenVideoRef.current, stream, () => {}, true);

      const pc = _call.pc;

      if (_call.audioStream) {
        const audioTrack = _call.audioStream.getAudioTracks()[0];
        if (!audioTrack || audioTrack.readyState !== 'live') {
          const newAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (pc) {
            const oldTrack = _call.audioStream.getAudioTracks()[0];
            const newTrack = newAudioStream.getAudioTracks()[0];
            if (oldTrack && newTrack) {
              const sender = pc.getSenders().find(s => s.track?.id === oldTrack.id);
              if (sender) await sender.replaceTrack(newTrack);
            }
          }
          _call.audioStream.getTracks().forEach(t => t.stop());
          _call.audioStream = newAudioStream;
        }
      }

      if (_call.cameraStream) {
        const camTrack = _call.cameraStream.getVideoTracks()[0];
        if (!camTrack || camTrack.readyState !== 'live') {
          const newCamStream = await navigator.mediaDevices.getUserMedia({ video: true });
          if (pc) {
            const oldTrack = _call.cameraStream.getVideoTracks()[0];
            const newTrack = newCamStream.getVideoTracks()[0];
            if (oldTrack && newTrack) {
              const sender = pc.getSenders().find(s => s.track?.id === oldTrack.id);
              if (sender) await sender.replaceTrack(newTrack);
            }
          }
          _call.cameraStream.getTracks().forEach(t => t.stop());
          _call.cameraStream = newCamStream;
          if (cameraVideoRef.current) {
            cameraVideoRef.current.srcObject = newCamStream;
            cameraVideoRef.current.play().catch(() => {});
          }
        } else {
          cameraVideoRef.current?.play().catch(() => {});
        }
      }

      if (pc && _call.targetId) {
        const screenTrack = stream.getVideoTracks()[0];
        _call.screenSender = pc.addTrack(screenTrack, stream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({ type: 'offer', sdp: offer, to: _call.targetId });
        sendSignal({ type: 'demo-toggle', enabled: true, to: _call.targetId });
      }

      stream.getVideoTracks()[0].onended = () => setDemonstrationActive(false);
    } catch {
      setDemonstrationActive(false);
    }
  };

  const stopScreen = async () => {
    _call.screenStream?.getTracks().forEach(t => t.stop());
    _call.screenStream = null;
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;

    if (_call.pc && _call.targetId && _call.screenSender) {
      _call.pc.removeTrack(_call.screenSender);
      _call.screenSender = null;
      const offer = await _call.pc.createOffer();
      await _call.pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', sdp: offer, to: _call.targetId });
      sendSignal({ type: 'demo-toggle', enabled: false, to: _call.targetId });
    }
  };

  const stopAllMedia = () => {
    _call.audioStream?.getTracks().forEach(t => t.stop());
    _call.cameraStream?.getTracks().forEach(t => t.stop());
    _call.screenStream?.getTracks().forEach(t => t.stop());
    _call.audioStream = null;
    _call.cameraStream = null;
    _call.screenStream = null;
    _call.localMediaStream = new MediaStream();
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
          if (stream.getVideoTracks().length > 0) {
            setRemoteVideoStatus('видео играет');
            setTimeout(() => { if (videoEl) videoEl.muted = false; }, 1000);
          } else {
            // Audio-only stream — unmute immediately, keep video status as "no video"
            videoEl.muted = false;
          }
        })
        .catch(() => setTimeout(tryPlay, 500));
    };
    tryPlay();

    // Also watch for video tracks being added later (remote enables camera mid-call)
    stream.onaddtrack = (e) => {
      if (e.track.kind === 'video') setRemoteVideoStatus('видео играет');
    };
    stream.onremovetrack = (e) => {
      if (e.track.kind === 'video' && stream.getVideoTracks().length === 0)
        setRemoteVideoStatus('нет видео');
    };
  }, []);

  const attachRemoteScreenStream = useCallback((stream: MediaStream) => {
    const screenEl = remoteScreenVideoRef.current;
    if (!screenEl) return;
    screenEl.srcObject = stream;
    screenEl.muted = true;
    screenEl.playsInline = true;
    screenEl.play().catch(() => {});
  }, []);

  const clearRemoteScreen = useCallback(() => {
    if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null;
  }, []);

  // Keep module-level pointers up-to-date on every render so that pc.ontrack
  // (created once, never replaced) always reaches the current mounted refs.
  const _attachRemoteLocalRef = useRef(attachRemoteStream);
  const _attachRemoteScreenLocalRef = useRef(attachRemoteScreenStream);
  const _clearRemoteScreenLocalRef = useRef(clearRemoteScreen);
  _attachRemoteLocalRef.current = attachRemoteStream;
  _attachRemoteScreenLocalRef.current = attachRemoteScreenStream;
  _clearRemoteScreenLocalRef.current = clearRemoteScreen;
  _attachRemoteRef = _attachRemoteLocalRef;
  _attachRemoteScreenRef = _attachRemoteScreenLocalRef;
  _clearRemoteScreenRef = _clearRemoteScreenLocalRef;

  const createPeerConnection = (remoteId: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'candidate', candidate: event.candidate, to: remoteId });
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;

      if (!_call.remoteStream) {
        _call.remoteStream = stream;
        _attachRemoteRef?.current(stream);
      } else if (stream.id === _call.remoteStream.id) {
        // New track added to the existing remote stream (e.g. camera enabled mid-call)
        if (event.track.kind === 'video') {
          _attachRemoteRef?.current(stream);
        }
      } else if (stream.id !== _call.remoteStream.id) {
        _call.remoteScreenStream = stream;
        _attachRemoteScreenRef?.current(stream);
        setRemoteScreenActive(true);

        event.track.onended = () => {
          _call.remoteScreenStream = null;
          _clearRemoteScreenRef?.current();
          setRemoteScreenActive(false);
        };
        event.track.onmute = () => {
          _call.remoteScreenStream = null;
          _clearRemoteScreenRef?.current();
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
      if (!_call.cameraStream?.active) await startCamera();
      if (cameraVideoRef.current && _call.cameraStream) {
        attachStreamToVideo(cameraVideoRef.current, _call.cameraStream, setLocalVideoStatus, true);
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
  const handleSignalRef = useRef<(msg: any) => void>(() => {});

  handleSignalRef.current = async (msg: any) => {
    const senderId = String(msg.from);
    if (!senderId) return;

    if (msg.type === 'offer') {
      if (_call.pc && String(_call.targetId) === senderId) {
        const pc = _call.pc;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          addLocalTracks(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({ type: 'answer', sdp: answer, to: senderId });
          for (const c of _call.pendingCandidates) await pc.addIceCandidate(c);
          _call.pendingCandidates = [];
        } catch { }
        return;
      }
      if (_call.pc && String(_call.targetId) !== senderId) {
        sendSignal({ type: 'call-rejected', to: senderId });
        return;
      }
      return;
    } else if (msg.type === 'call-end' || msg.type === 'call-rejected') {
      if (String(_call.targetId) === senderId) stopCall(false);
      return;
    }

    if (!_call.pc || String(_call.targetId) !== senderId) {
      _call.pc = createPeerConnection(senderId);
      _call.targetId = senderId;
      _call.pendingCandidates = [];
    }
    const pc = _call.pc;

    if (msg.type === 'answer') {
      try {
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        for (const c of _call.pendingCandidates) await pc.addIceCandidate(c);
        _call.pendingCandidates = [];
      } catch { }
    } else if (msg.type === 'candidate') {
      try {
        if (msg.candidate) {
          if (pc.remoteDescription?.type) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } else {
            _call.pendingCandidates.push(msg.candidate);
          }
        }
      } catch { }
    } else if (msg.type === 'video-toggle') {
      setRemoteVideoStatus(msg.enabled ? 'видео включено' : 'видео выключено');
    } else if (msg.type === 'demo-toggle') {
      if (!msg.enabled) {
        _call.remoteScreenStream = null;
        if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null;
      }
      setRemoteScreenActive(msg.enabled);
    }
  };

  useEffect(() => {
    const stableHandler = (msg: any) => handleSignalRef.current(msg);
    onSignalingMessage.current = stableHandler;
    return () => {
      if (onSignalingMessage.current === stableHandler) onSignalingMessage.current = null;
    };
  }, []);

  // Process incoming offer stored by IncomingCallModal (user accepted)
  useEffect(() => {
    if (incomingOffer && !_call.hasProcessedOffer) {
      _call.hasProcessedOffer = true;
      processIncomingOffer(incomingOffer);
      setIncomingOffer(null);
    }
  }, [incomingOffer]);

  // Auto-call target on mount
  useEffect(() => {
    if (!callTargetId || _call.hasAutoCalled || incomingOffer) return;
    _call.hasAutoCalled = true;
    const targetId = String(callTargetId);
    setCallTargetId(null);
    callPeer(targetId, isVideoActive);
  }, [callTargetId]);

  // ==================== Call peer ====================
  const callPeer = async (peerId: string, withVideo: boolean) => {
    _call.targetId = String(peerId);
    setRemotePeerId(String(peerId));
    _call.pendingCandidates = [];

    try { await startAudio(); } catch { }
    if (withVideo) {
      try {
        if (!_call.cameraStream?.active) await startCamera();
        if (cameraVideoRef.current && _call.cameraStream) {
          attachStreamToVideo(cameraVideoRef.current, _call.cameraStream, setLocalVideoStatus, true);
        }
      } catch { }
    }

    const pc = createPeerConnection(String(peerId));
    _call.pc = pc;
    addLocalTracks(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: 'offer', sdp: offer, to: peerId, withVideo });
  };

  const processIncomingOffer = async (msg: any) => {
    const senderId = String(msg.from);
    setRemotePeerId(senderId);
    _call.hasAutoCalled = true;
    setCallTargetId(null);

    try {
      if (_call.pc) _call.pc.close();
      _call.pc = createPeerConnection(senderId);
      _call.targetId = senderId;
      _call.pendingCandidates = [];
      _call.remoteStream = null;
      _call.remoteScreenStream = null;

      const pc = _call.pc;

      try { await startAudio(); } catch { }
      if (msg.withVideo) {
        try {
          if (!_call.cameraStream?.active) {
            await startCamera();
            setVideoActive(true);
          }
          if (cameraVideoRef.current && _call.cameraStream) {
            attachStreamToVideo(cameraVideoRef.current, _call.cameraStream, setLocalVideoStatus, true);
          }
        } catch { }
      }

      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      addLocalTracks(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: answer, to: senderId });

      if (msg.bufferedCandidates?.length) {
        for (const candidateMsg of msg.bufferedCandidates) {
          if (candidateMsg.candidate) {
            try { await pc.addIceCandidate(new RTCIceCandidate(candidateMsg.candidate)); } catch { }
          }
        }
      }
      for (const c of _call.pendingCandidates) await pc.addIceCandidate(c);
      _call.pendingCandidates = [];
    } catch { }
  };

  const stopCall = (notifyRemote = true) => {
    const targetId = _call.targetId;

    _call.pc?.close();
    _call.pc = null;
    _call.targetId = null;
    _call.pendingCandidates = [];

    stopAllMedia();

    _call.remoteStream = null;
    _call.remoteScreenStream = null;
    _call.hasAutoCalled = false;
    _call.hasProcessedOffer = false;
    _call.remotePeerId = null;
    _call.remoteScreenActive = false;

    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null;

    if (notifyRemote && targetId) sendSignal({ type: 'call-end', to: targetId });

    setCallTargetId(null);
    setRemotePeerIdState(null);
    setRemoteVideoStatus('нет видео');
    setRemoteScreenActiveState(false);
    setCallActive(false);
    setCallStatus('inactive');
    setVideoActive(false);
    setDemonstrationActive(false);
  };

  // ==================== UI ====================
  const remoteUser = remotePeerId ? friends.find(f => String(f.id) === remotePeerId) : null;
  const remoteName = remoteUser?.nickname || remoteUser?.username || remotePeerId || '?';
  const remoteAvatar = remoteUser?.avatar || '';

  const tileCount = 2 + (isDemonstrationActive ? 1 : 0) + (remoteScreenActive ? 1 : 0);
  const cols = Math.min(tileCount, 2);

  const videoFill: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'contain', display: 'block' };
  const placeholderStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: 8, width: '100%', height: '100%', background: '#1a1a2e',
  };

  const outerStyle: React.CSSProperties = windowExpanded
    ? { position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 9500, background: '#111', display: 'flex', flexDirection: 'column' }
    : inline
      ? { height: 420, background: '#111', display: 'flex', flexDirection: 'column' }
      : { position: 'fixed', bottom: 0, right: 0, width: 480, height: 420, zIndex: 9500, background: '#111', display: 'flex', flexDirection: 'column', borderRadius: '12px 12px 0 0', boxShadow: '0 -4px 32px rgba(0,0,0,0.7)' };

  return (
    <div className="call-window" style={outerStyle}>
      {/* Call header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: 'rgba(0,0,0,0.5)', flexShrink: 0 }}>
        {remotePeerId ? (
          <>
            <UserAvatar name={remoteName} avatar={remoteAvatar} size={28} />
            <div style={{ flex: 1 }}>
              <div style={{ color: '#fff', fontWeight: 600, fontSize: 13, lineHeight: 1.2 }}>{remoteName}</div>
              <div style={{ color: '#aaa', fontSize: 11 }}>In call</div>
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
        <Tile id="local" label="You" expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
          <video ref={cameraVideoRef} autoPlay muted playsInline style={{ ...videoFill, display: isVideoActive ? 'block' : 'none' }} />
          {!isVideoActive && (
            <div style={placeholderStyle}>
              <UserAvatar name="Me" avatar="" size={48} />
              <span style={{ color: '#aaa', fontSize: 12 }}>Video off</span>
            </div>
          )}
        </Tile>

        <Tile id="remote" label={remoteName} expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
          <video
            ref={remoteVideoRef} autoPlay muted playsInline
            style={{ ...videoFill, display: remoteVideoStatus === 'видео играет' ? 'block' : 'none' }}
            onClick={() => { if (remoteVideoRef.current) remoteVideoRef.current.muted = false; }}
          />
          {remoteVideoStatus !== 'видео играет' && (
            <div style={placeholderStyle}>
              <UserAvatar name={remoteName} avatar={remoteAvatar} size={48} />
              <span style={{ color: '#fff', fontWeight: 600, fontSize: 13 }}>{remoteName}</span>
              <span style={{ color: '#aaa', fontSize: 11 }}>Video off</span>
            </div>
          )}
        </Tile>

        {isDemonstrationActive && (
          <Tile id="screen" label="Your screen" expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
            <video ref={screenVideoRef} autoPlay muted playsInline style={videoFill} />
          </Tile>
        )}

        {remoteScreenActive && (
          <Tile id="remoteScreen" label={`${remoteName} — screen`} expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
            <video ref={remoteScreenVideoRef} autoPlay muted playsInline style={videoFill} />
          </Tile>
        )}
      </div>

      {/* Controls */}
      <div style={{ padding: '7px 0', width: '100%', display: 'flex', gap: 10, justifyContent: 'center', flexShrink: 0 }}>
        <button className="icon-btn glass-btn" style={{ background: 'red' }} onClick={() => stopCall()}>X</button>
        <button
          className="icon-btn glass-btn"
          onClick={async () => {
            const newState = !isVideoActive;
            setVideoActive(newState);

            if (newState) {
              // Turning ON: start camera if not running, add track to PC, renegotiate
              try {
                if (!_call.cameraStream?.active) await startCamera();
                if (cameraVideoRef.current && _call.cameraStream)
                  attachStreamToVideo(cameraVideoRef.current, _call.cameraStream, setLocalVideoStatus, true);

                const pc = _call.pc;
                if (pc && _call.cameraStream) {
                  const videoTrack = _call.cameraStream.getVideoTracks()[0];
                  if (videoTrack) {
                    const senders = pc.getSenders();
                    const existing = senders.find(s => s.track?.kind === 'video' && s.track?.id === videoTrack.id);
                    if (!existing) {
                      pc.addTrack(videoTrack, _call.localMediaStream);
                      const offer = await pc.createOffer();
                      await pc.setLocalDescription(offer);
                      sendSignal({ type: 'offer', sdp: offer, to: _call.targetId!, withVideo: true });
                    } else {
                      videoTrack.enabled = true;
                    }
                  }
                }
              } catch { }
            } else {
              // Turning OFF: just disable the track, no renegotiation needed
              _call.cameraStream?.getVideoTracks().forEach(t => { t.enabled = false; });
            }

            if (_call.targetId) sendSignal({ type: 'video-toggle', enabled: newState, to: _call.targetId });
          }}
        >
          C
        </button>
        <button className="icon-btn glass-btn" onClick={() => {
          if (_call.audioStream) {
            _call.audioStream.getAudioTracks().forEach(track => { track.enabled = !track.enabled; });
          }
        }}>M</button>
        <button className="icon-btn glass-btn">H</button>
        <button className="icon-btn glass-btn" onClick={() => setDemonstrationActive(!isDemonstrationActive)}>D</button>
      </div>
    </div>
  );
};
