import { useRef, useEffect, useState, useCallback } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { getIceServers } from '../config/network';

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
      ? { position: 'fixed', inset: 0, zIndex: 9600, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }
      : { position: 'relative', background: 'var(--bg-tertiary)', borderRadius: 6, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0, minWidth: 0 }
    }>
      {children}
      <span style={{ position: 'absolute', bottom: isExp ? 14 : 4, left: isExp ? 16 : 6, fontSize: isExp ? 13 : 11, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderRadius: 4, padding: '2px 6px' }}>
        {label}
      </span>
      <button
        onClick={() => setExpandedTile(isExp ? null : id)}
        title={isExp ? 'Restore' : 'Expand to full window'}
        style={{ position: 'absolute', top: isExp ? 12 : 4, right: isExp ? 12 : 4, background: 'var(--bg-secondary)', border: 'none', borderRadius: 6, padding: isExp ? '6px 8px' : 3, cursor: 'pointer', color: 'var(--text-primary)', display: 'flex' }}
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
  callStartTime: null as number | null,
  wasConnected: false,
  wasVideo: false,
  wasIncoming: false,
};

// ── Component ─────────────────────────────────────────────────────────────────

export const CallWindow = ({ inline = false }: { inline?: boolean }) => {
  const {
    isDemonstrationActive,
    isVideoActive,
    isMicActive,
    isHeadphonesActive,
    setCallActive,
    setDemonstrationActive,
    setVideoActive,
    setMicActive,
    setHeadphonesActive,
    setCallStatus,
    sendSignal,
    onSignalingMessage,
    callTargetId,
    setCallTargetId,
    incomingOffer,
    setIncomingOffer,
    friends,
    addCallMessage,
  } = useApp();


  // Video element refs — recreated on each mount; streams re-attached via useEffect
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteScreenVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  // Keep latest value of isVideoActive accessible from async functions (closures
  // capture the value at call time, but isVideoActive may have just been set by
  // ChatHeader.startCall and not yet propagated through this render).
  const isVideoActiveRef = useRef(isVideoActive);
  isVideoActiveRef.current = isVideoActive;

  // Visual state — initialised from module-level so it's correct after remount
  const [remoteVideoStatus, setRemoteVideoStatus] = useState<string>(
    _call.remoteStream ? 'видео играет' : 'видео выключено'
  );
  const [, setLocalVideoStatus] = useState<string>(
    _call.cameraStream?.active ? 'видео играет' : 'видео выключено'
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
      remoteVideoRef.current.muted = true;
      remoteVideoRef.current.playsInline = true;
      remoteVideoRef.current.play().catch(() => {});
      const hasVideo = _call.remoteStream.getVideoTracks().some(t => t.enabled && !t.muted);
      setRemoteVideoStatus(hasVideo ? 'видео играет' : 'видео выключено');
    }
    if (_call.remoteStream && remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = _call.remoteStream;
      remoteAudioRef.current.play().catch(() => {});
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

  const startAudioVideo = async (wantVideo: boolean) => {
    const needAudio = !_call.audioStream?.active;
    const needVideo = wantVideo && !_call.cameraStream?.active;
    if (!needAudio && !needVideo) return;

    try {
      if (needAudio && needVideo) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        const audioOnly = new MediaStream(stream.getAudioTracks());
        const videoOnly = new MediaStream(stream.getVideoTracks());
        _call.audioStream = audioOnly;
        _call.cameraStream = videoOnly;
      } else if (needAudio) {
        _call.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else if (needVideo) {
        _call.cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
    } catch {
      if (needAudio && !_call.audioStream?.active) {
        try { _call.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { }
      }
    }
  };

  const startAudio = async () => { await startAudioVideo(false); };

  const startCamera = async (): Promise<boolean> => {
    await startAudioVideo(true);
    return !!_call.cameraStream?.active;
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
  // Remote audio plays through a dedicated <audio> element (no autoplay block
  // for hidden audio elements after a user gesture). Remote video plays muted
  // through a <video> element (visual only — sound comes from <audio>).
  const attachRemoteStream = useCallback((stream: MediaStream) => {
    const audioEl = remoteAudioRef.current;
    if (audioEl) {
      audioEl.srcObject = stream;
      audioEl.autoplay = true;
      audioEl.volume = 1;
      const tryPlayAudio = () => {
        audioEl.play().catch(() => setTimeout(tryPlayAudio, 500));
      };
      tryPlayAudio();
    }

    const videoEl = remoteVideoRef.current;
    if (!videoEl) return;
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    const hasVideo = stream.getVideoTracks().some(t => t.enabled && !t.muted);
    const tryPlay = () => {
      videoEl.play()
        .then(() => { if (hasVideo) setRemoteVideoStatus('видео играет'); })
        .catch(() => setTimeout(tryPlay, 500));
    };
    tryPlay();
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
    const pc = new RTCPeerConnection({
      iceServers: getIceServers(),
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'candidate', candidate: event.candidate, to: remoteId });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        if (!_call.wasConnected) {
          _call.wasConnected = true;
          _call.callStartTime = Date.now();
        }
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;

      // Screen share = different stream id from main remote stream
      if (_call.remoteStream && stream.id !== _call.remoteStream.id) {
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
        return;
      }

      // Re-attach on every track event so a late audio track (arriving after video)
      // is picked up by the audio element on Android (srcObject snapshots tracks).
      _call.remoteStream = stream;
      _attachRemoteRef?.current(stream);

      const videoTracks = stream.getVideoTracks();
      const hasActiveVideo = videoTracks.some(t => t.enabled && !t.muted);
      if (!hasActiveVideo) {
        setRemoteVideoStatus('видео выключено');
      }

      videoTracks.forEach(t => {
        t.onunmute = () => setRemoteVideoStatus('видео играет');
        t.onmute = () => {
          const stillHasVideo = stream.getVideoTracks().some(vt => vt.enabled && !vt.muted);
          if (!stillHasVideo) setRemoteVideoStatus('видео выключено');
        };
      });
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

  // ==================== Mic mute sync ====================
  useEffect(() => {
    if (_call.audioStream) {
      _call.audioStream.getAudioTracks().forEach(t => { t.enabled = isMicActive; });
    }
  }, [isMicActive]);

  // ==================== Headphones (remote audio) sync ====================
  useEffect(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.muted = !isHeadphonesActive;
    }
  }, [isHeadphonesActive]);

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
      if (String(_call.targetId) === senderId) {
        stopCall(false, true);
      }
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
    callPeer(targetId);
  }, [callTargetId]);

  // ==================== Call peer ====================
  const callPeer = async (peerId: string) => {
    // Close any leftover RTCPeerConnection from a previous call — otherwise its
    // UDP sockets / ICE state can interfere with the new connection's ICE
    // gathering, causing iceConnectionState=disconnected on subsequent calls.
    if (_call.pc) {
      try { _call.pc.close(); } catch { }
      _call.pc = null;
    }
    _call.remoteStream = null;
    _call.remoteScreenStream = null;

    _call.targetId = String(peerId);
    _call.wasIncoming = false;
    _call.wasConnected = false;
    _call.callStartTime = null;
    setRemotePeerId(String(peerId));
    _call.pendingCandidates = [];

    const wantVideo = isVideoActiveRef.current;
    _call.wasVideo = wantVideo;

    // For voice calls clear any stale camera stream from a previous call so the
    // local "Video off" placeholder shows instead of an empty black <video>.
    if (!wantVideo && _call.cameraStream) {
      _call.cameraStream.getTracks().forEach(t => t.stop());
      _call.cameraStream = null;
      if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    }

    try {
      // Voice call → request only audio.
      // Video call → request audio+video TOGETHER (separate getUserMedia calls
      // on Android Chrome silently kill the audio track of the previous one).
      await startAudioVideo(wantVideo);
      if (wantVideo && cameraVideoRef.current && _call.cameraStream) {
        attachStreamToVideo(cameraVideoRef.current, _call.cameraStream, setLocalVideoStatus, true);
      }
    } catch { }

    const pc = createPeerConnection(String(peerId));
    _call.pc = pc;
    addLocalTracks(pc);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', sdp: offer, withVideo: wantVideo, to: peerId });
    } catch { }
  };

  const processIncomingOffer = async (msg: any) => {
    const senderId = String(msg.from);
    setRemotePeerId(senderId);
    _call.hasAutoCalled = true;
    _call.wasIncoming = true;
    _call.wasConnected = false;
    _call.callStartTime = null;
    setCallTargetId(null);

    const wantVideo = !!msg.withVideo;
    _call.wasVideo = wantVideo;
    setVideoActive(wantVideo);

    // Clear stale camera stream from a previous call when this is voice-only
    if (!wantVideo && _call.cameraStream) {
      _call.cameraStream.getTracks().forEach(t => t.stop());
      _call.cameraStream = null;
      if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    }

    try {
      if (_call.pc) _call.pc.close();
      _call.pc = createPeerConnection(senderId);
      _call.targetId = senderId;
      _call.pendingCandidates = [];
      _call.remoteStream = null;
      _call.remoteScreenStream = null;

      const pc = _call.pc;

      try {
        await startAudioVideo(wantVideo);
        if (wantVideo && cameraVideoRef.current && _call.cameraStream) {
          attachStreamToVideo(cameraVideoRef.current, _call.cameraStream, setLocalVideoStatus, true);
        }
      } catch { }

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

  const stopCall = (notifyRemote = true, remoteInitiated = false) => {
    const targetId = _call.targetId;
    const wasConnected = _call.wasConnected;
    const callStartTime = _call.callStartTime;
    const wasVideo = _call.wasVideo;
    const wasIncoming = _call.wasIncoming;

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
    _call.wasConnected = false;
    _call.callStartTime = null;

    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null;

    // Determine call status and duration
    let callStatus: import('../types').CallStatus;
    let duration: number | undefined;
    if (wasConnected && callStartTime) {
      callStatus = 'completed';
      duration = Math.round((Date.now() - callStartTime) / 1000);
    } else if (notifyRemote && !wasIncoming) {
      callStatus = 'cancelled';
    } else if (!notifyRemote && !wasIncoming) {
      callStatus = 'no_answer';
    } else if (!notifyRemote && wasIncoming) {
      callStatus = 'missed';
    } else {
      callStatus = 'declined';
    }

    if (notifyRemote && targetId) {
      sendSignal({ type: 'call-end', to: targetId, callStatus, duration, video: wasVideo });
    }

    // Only the side that actively ends/cancels sends the call message to chat.
    // The other side will see it via the chat WS broadcast.
    if (!remoteInitiated) {
      addCallMessage({ status: callStatus, duration, video: wasVideo });
    }

    setCallTargetId(null);
    setRemotePeerIdState(null);
    setRemoteVideoStatus('видео выключено');
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

  const callBtnStyle = (bg: string): React.CSSProperties => ({
    width: 48, height: 48, borderRadius: '50%', border: 'none',
    background: bg, color: '#fff', fontWeight: 700, fontSize: 16,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  });

  const videoFill: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'contain', display: 'block' };
  const placeholderStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: 8, width: '100%', height: '100%', background: 'var(--bg-tertiary)',
  };

  const outerStyle: React.CSSProperties = windowExpanded
    ? { position: 'fixed', inset: 0, width: '100vw', height: '100svh', zIndex: 9500, background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', paddingBottom: 'max(env(safe-area-inset-bottom), 24px)' }
    : inline
      ? { height: 420, background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column' }
      : { position: 'fixed', bottom: 0, right: 0, width: 480, height: 420, zIndex: 9500, background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', borderRadius: '12px 12px 0 0', boxShadow: 'var(--shadow-lg)' };

  return (
    <div className="call-window" style={outerStyle}>
      {/* Call header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: 'var(--bg-secondary)', flexShrink: 0 }}>
        {remotePeerId ? (
          <>
            <UserAvatar name={remoteName} avatar={remoteAvatar} size={28} />
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 13, lineHeight: 1.2 }}>{remoteName}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>In call</div>
            </div>
          </>
        ) : (
          <div style={{ flex: 1 }} />
        )}
        <button
          onClick={() => setWindowExpanded(v => !v)}
          title={windowExpanded ? 'Restore window' : 'Maximize call window'}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', padding: 4, borderRadius: 6 }}
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
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Video off</span>
            </div>
          )}
        </Tile>

        <Tile id="remote" label={remoteName} expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
          <video
            ref={remoteVideoRef} autoPlay muted playsInline
            style={{ ...videoFill, display: remoteVideoStatus !== 'видео выключено' ? 'block' : 'none' }}
            
          />
          <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
          {remoteVideoStatus === 'видео выключено' && (
            <div style={placeholderStyle}>
              <UserAvatar name={remoteName} avatar={remoteAvatar} size={48} />
              <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 13 }}>{remoteName}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Video off</span>
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

      {/* Controls — pinned to bottom of call window, always visible above system bar */}
      <div style={{ paddingTop: 10, paddingBottom: '10px', width: '100%', display: 'flex', gap: 10, justifyContent: 'center', flexShrink: 0, background: 'var(--bg-secondary)', position: 'relative', zIndex: 5 }}>
        <button onClick={() => stopCall()} style={callBtnStyle('#e0245e')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <button onClick={() => setMicActive(!isMicActive)} style={callBtnStyle(isMicActive ? '#3a3d44' : '#e0245e')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="1" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="17" x2="12" y2="21" />
            <line x1="8" y1="21" x2="16" y2="21" />
            {!isMicActive && <line x1="3" y1="3" x2="21" y2="21" stroke="#fff" strokeWidth="2.5" />}
          </svg>
        </button>
        <button onClick={() => setHeadphonesActive(!isHeadphonesActive)} style={callBtnStyle(isHeadphonesActive ? '#3a3d44' : '#e0245e')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
            <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3v5z" />
            <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3v5z" />
            {!isHeadphonesActive && <line x1="3" y1="3" x2="21" y2="21" stroke="#fff" strokeWidth="2.5" />}
          </svg>
        </button>
        <button
          onClick={async () => {
            const newState = !isVideoActive;
            if (newState) {
              if (!_call.cameraStream?.active) {
                try {
                  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                  _call.cameraStream = stream;
                } catch { return; }
              } else {
                _call.cameraStream.getVideoTracks().forEach(t => { t.enabled = true; });
              }
              if (cameraVideoRef.current && _call.cameraStream) {
                attachStreamToVideo(cameraVideoRef.current, _call.cameraStream, setLocalVideoStatus, true);
              }
              if (_call.pc && _call.targetId && _call.cameraStream) {
                const videoTrack = _call.cameraStream.getVideoTracks()[0];
                const senders = _call.pc.getSenders();
                if (videoTrack && !senders.some(s => s.track?.id === videoTrack.id)) {
                  _call.pc.addTrack(videoTrack, _call.localMediaStream);
                  try {
                    const offer = await _call.pc.createOffer();
                    await _call.pc.setLocalDescription(offer);
                    sendSignal({ type: 'offer', sdp: offer, withVideo: true, to: _call.targetId });
                  } catch { }
                }
              }
            } else {
              if (_call.cameraStream) {
                _call.cameraStream.getVideoTracks().forEach(t => { t.enabled = false; });
              }
            }
            setVideoActive(newState);
            if (_call.targetId) sendSignal({ type: 'video-toggle', enabled: newState, to: _call.targetId });
          }}
          style={callBtnStyle(isVideoActive ? '#3a3d44' : '#e0245e')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="5" width="14" height="14" rx="2" />
            <path d="M16 10l6-4v12l-6-4z" />
            {!isVideoActive && <line x1="3" y1="3" x2="21" y2="21" stroke="#fff" strokeWidth="2.5" />}
          </svg>
        </button>
        <button onClick={() => setDemonstrationActive(!isDemonstrationActive)} style={callBtnStyle(isDemonstrationActive ? '#43b581' : '#3a3d44')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
            {!isDemonstrationActive && <line x1="3" y1="3" x2="21" y2="21" stroke="#fff" strokeWidth="2.5" />}
          </svg>
        </button>
      </div>
    </div>
  );
};
