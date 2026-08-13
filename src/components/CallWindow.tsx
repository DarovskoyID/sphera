import { useRef, useEffect, useState, useCallback } from 'react';
import { Maximize2, Minimize2, Info, SwitchCamera } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { getIceServers, getSelectedServerEntry, getResolvedTurn, fetchPoolIceServers, pingServer, pingStun, API_BASE_URL, APP_HOST, type ServerEntry } from '../config/network';

// ── Module-level helpers (never redefined) ────────────────────────────────────

function useIsMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = () => setMobile(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return mobile;
}

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
  const tr = useTranslation();
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
        title={isExp ? tr('call_tile_restore') : tr('call_tile_expand')}
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
  activeIceServers: null as RTCIceServer[] | null,
};

// Сбалансированный пул ICE/TURN с бэкенда (/api/turn/), обновляется на старте
// звонка. null → используем статический getIceServers() (фолбэк, звонок не ломается).
let _poolIce: RTCIceServer[] | null = null;

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
    currentServerIP,
    authToken,
  } = useApp();

  // На старте звонка тянем сбалансированную TURN-ноду из пула. Если бэкенд не
  // ответил — _poolIce остаётся null и createPeerConnection берёт статику.
  useEffect(() => {
    let alive = true;
    (async () => {
      const pool = await fetchPoolIceServers(currentServerIP, authToken);
      if (alive && pool) _poolIce = pool;
    })();
    return () => { alive = false; };
  }, [currentServerIP, authToken]);


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
  const tr = useTranslation();
  const [remoteVideoStatus, setRemoteVideoStatus] = useState<string>(
    _call.remoteStream ? 'playing' : 'off'
  );
  const [, setLocalVideoStatus] = useState<string>(
    _call.cameraStream?.active ? 'playing' : 'off'
  );
  const [windowExpanded, setWindowExpanded] = useState(false);
  const [expandedTile, setExpandedTile] = useState<string | null>(null);
  const [isRinging, setIsRinging] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [connInfo, setConnInfo] = useState<{ candidateType?: string; protocol?: string; localAddr?: string; remoteAddr?: string } | null>(null);
  const [infoPing, setInfoPing] = useState<number | null | 'loading'>(null);
  const [infoStun, setInfoStun] = useState<boolean | 'loading' | 'local' | null>(null);
  const dialToneRef = useRef<HTMLAudioElement | null>(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setLocalVideoStatus('playing');
    }
    if (_call.remoteStream && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = _call.remoteStream;
      remoteVideoRef.current.muted = true;
      remoteVideoRef.current.playsInline = true;
      remoteVideoRef.current.play().catch(() => {});
      const hasVideo = _call.remoteStream.getVideoTracks().some(t => t.enabled && !t.muted);
      setRemoteVideoStatus(hasVideo ? 'playing' : 'off');
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

  // Gather connection info when info popup opens
  useEffect(() => {
    if (!showInfo) return;
    const entry = getSelectedServerEntry();
    setInfoPing('loading');
    pingServer(entry?.url || API_BASE_URL).then(ms => setInfoPing(ms));
    // Determine STUN host/port from active ICE servers
    const active = _call.activeIceServers;
    let stunHost = '';
    let stunPort = 3478;
    let stunUser: string | undefined;
    let stunCred: string | undefined;
    if (active && active.length > 0) {
      const rawUrls = active[0]?.urls;
      const firstUrl = Array.isArray(rawUrls) ? rawUrls[0] : rawUrls;
      const m = (firstUrl || '').match(/^stun:(.+):(\d+)$/);
      if (m) { stunHost = m[1]; stunPort = Number(m[2]); }
      const turnEntry = active[1];
      if (turnEntry && 'username' in turnEntry) { stunUser = turnEntry.username; stunCred = turnEntry.credential as string; }
    }
    if (!stunHost) {
      const turn = getResolvedTurn(entry);
      stunHost = turn.host; stunPort = turn.port; stunUser = turn.username; stunCred = turn.credential;
    }
    setInfoStun('loading');
    pingStun(stunHost, stunPort, stunUser, stunCred).then(ok => setInfoStun(ok));
    const pc = _call.pc;
    if (pc) {
      pc.getStats().then(stats => {
        let activePairId: string | undefined;
        stats.forEach((report: any) => {
          if (report.type === 'transport' && report.selectedCandidatePairId) {
            activePairId = report.selectedCandidatePairId;
          }
        });
        if (activePairId) {
          const pair = stats.get(activePairId) as any;
          if (pair) {
            const remote = stats.get(pair.remoteCandidateId) as any;
            const local = stats.get(pair.localCandidateId) as any;
            setConnInfo({
              candidateType: remote?.candidateType,
              protocol: local?.protocol,
              localAddr: local ? `${local.address}:${local.port}` : undefined,
              remoteAddr: remote ? `${remote.address}:${remote.port}` : undefined,
            });
            return;
          }
        }
        // Fallback: find succeeded pair
        stats.forEach((report: any) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            const remote = stats.get(report.remoteCandidateId) as any;
            const local = stats.get(report.localCandidateId) as any;
            setConnInfo({
              candidateType: remote?.candidateType,
              protocol: local?.protocol,
              localAddr: local ? `${local.address}:${local.port}` : undefined,
              remoteAddr: remote ? `${remote.address}:${remote.port}` : undefined,
            });
          }
        });
      }).catch(() => {});
    } else {
      setConnInfo(null);
    }
  }, [showInfo]);

  // Cleanup dial tone on unmount
  useEffect(() => {
    return () => {
      if (dialToneRef.current) { dialToneRef.current.pause(); dialToneRef.current = null; }
      if (ringTimeoutRef.current) { clearTimeout(ringTimeoutRef.current); ringTimeoutRef.current = null; }
    };
  }, []);

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
        .then(() => setStatus('playing'))
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
    setLocalVideoStatus('off');
  };

  // ==================== Dial tone (caller side) ====================
  const startDialTone = () => {
    setIsRinging(true);
    const audio = new Audio('/rington.mp3');
    audio.loop = true;
    audio.volume = 0.5;
    audio.play().catch(() => {});
    dialToneRef.current = audio;
    if (ringTimeoutRef.current) clearTimeout(ringTimeoutRef.current);
    ringTimeoutRef.current = setTimeout(() => {
      stopCall(true, false, true);
    }, 60000);
  };

  const stopDialTone = () => {
    setIsRinging(false);
    if (dialToneRef.current) {
      dialToneRef.current.pause();
      dialToneRef.current.currentTime = 0;
      dialToneRef.current = null;
    }
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
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
        .then(() => { if (hasVideo) setRemoteVideoStatus('playing'); })
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

  // Возвращает валидные ICE-серверы для звонка. Coturn работает в режиме
  // use-auth-secret, поэтому статические логин/пароль он отклоняет — нужны
  // временные креды из /api/turn/. Тянем их синхронно (await) на КАЖDОЙ
  // стороне звонка, чтобы и звонящий, и отвечающий получили рабочий TURN.
  // Если бэкенд недоступен — откатываемся на статику (звонок в LAN не ломается).
  const resolveIceServers = async (): Promise<RTCIceServer[]> => {
    try {
      const pool = await fetchPoolIceServers(currentServerIP, authToken);
      if (pool) { _poolIce = pool; return pool; }
    } catch { /* ignore */ }
    if (_poolIce) return _poolIce;
    return getIceServers(getSelectedServerEntry());
  };

  const createPeerConnection = (remoteId: string, customIceServers?: RTCIceServer[]): RTCPeerConnection => {
    const iceServers = customIceServers || _poolIce || getIceServers(getSelectedServerEntry());
    _call.activeIceServers = iceServers;
    const pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'candidate', candidate: event.candidate, to: remoteId });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        if (!_call.wasConnected) {
          _call.wasConnected = true;
          _call.callStartTime = Date.now();
          stopDialTone();
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
        setRemoteVideoStatus('off');
      }

      videoTracks.forEach(t => {
        t.onunmute = () => setRemoteVideoStatus('playing');
        t.onmute = () => {
          const stillHasVideo = stream.getVideoTracks().some(vt => vt.enabled && !vt.muted);
          if (!stillHasVideo) setRemoteVideoStatus('off');
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
      const sigIce = msg.turnHost ? getIceServers({ url: '', name: '', turn_host: msg.turnHost, turn_port: msg.turnPort, turn_username: msg.turnUser, turn_credential: msg.turnCred }) : undefined;
      _call.pc = createPeerConnection(senderId, sigIce);
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
      setRemoteVideoStatus(msg.enabled ? 'playing' : 'off');
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

    const iceServers = await resolveIceServers();
    const pc = createPeerConnection(String(peerId), iceServers);
    _call.pc = pc;
    addLocalTracks(pc);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', sdp: offer, withVideo: wantVideo, to: peerId });
    } catch { }

    startDialTone();
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
      // Отвечающий тянет СВОИ валидные временные TURN-креды (use-auth-secret),
      // а не полагается на переданные звонящим — иначе TURN-авторизация падает
      // и relay-кандидаты не появляются, звонок не соединяется.
      const iceServers = await resolveIceServers();
      _call.pc = createPeerConnection(senderId, iceServers);
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

  const stopCall = (notifyRemote = true, remoteInitiated = false, timedOut = false) => {
    stopDialTone();
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
    _call.activeIceServers = null;

    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null;

    // Determine call status and duration
    let callStatus: import('../types').CallStatus;
    let duration: number | undefined;
    if (wasConnected && callStartTime) {
      callStatus = 'completed';
      duration = Math.round((Date.now() - callStartTime) / 1000);
    } else if (timedOut) {
      callStatus = 'no_answer';
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
    setRemoteVideoStatus('off');
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

  const isMobile = useIsMobile();
  // Mobile 1:1 video call: show the peer full-screen with our own camera as a
  // small picture-in-picture in the corner (instead of the side-by-side grid).
  // Applies to both the inline (in-chat) and floating call — the .call-window
  // CSS already makes it fill the screen on mobile. Falls back to the grid while
  // screen-sharing. Desktop is unchanged.
  const mobilePip = isMobile && !isDemonstrationActive && !remoteScreenActive;
  // Which stream fills the screen on mobile (tap the PiP to swap the views).
  const [pipSwapped, setPipSwapped] = useState(false);
  // Front (user) / back (environment) phone camera. The button flips it by
  // grabbing a new stream and hot-swapping the outgoing track (replaceTrack).
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [switchingCamera, setSwitchingCamera] = useState(false);

  // Only offer the flip when there is somewhere to flip to. The list is only
  // complete once camera permission has been granted, so it is re-read when
  // our camera comes on.
  const [hasSecondCamera, setHasSecondCamera] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (alive) setHasSecondCamera(devices.filter(d => d.kind === 'videoinput').length > 1);
      } catch { /* enumeration blocked — leave the button hidden */ }
    };
    check();
    navigator.mediaDevices?.addEventListener?.('devicechange', check);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', check);
    };
  }, [isVideoActive]);

  /** The sender carrying our camera — never the screen-share one. */
  const cameraSender = () =>
    _call.pc?.getSenders().find(s => s.track?.kind === 'video' && s !== _call.screenSender) || null;

  const openCamera = (mode: 'user' | 'environment', exact: boolean) =>
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: exact ? { exact: mode } : { ideal: mode } },
      audio: false,
    });

  const switchCamera = async () => {
    if (switchingCamera) return;
    const next = facingMode === 'user' ? 'environment' : 'user';
    const oldStream = _call.cameraStream;
    setSwitchingCamera(true);
    try {
      let newStream: MediaStream;
      try {
        // `exact` is what actually moves to the other lens. With `ideal` a
        // phone is free to hand back the camera it already has open, which is
        // why the button appeared to do nothing at all.
        newStream = await openCamera(next, true);
      } catch {
        // Most phones cannot hold both cameras open at once, so that request
        // fails while the first camera is still live. Let go of it and ask
        // again — this is the path nearly every Android device takes.
        oldStream?.getVideoTracks().forEach(t => t.stop());
        newStream = await openCamera(next, true).catch(() => openCamera(next, false));
      }

      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) throw new Error('no video track');

      // Matched by kind rather than by track id: the old track may already be
      // stopped, and an id match breaks after the first successful switch.
      const sender = cameraSender();
      if (sender) await sender.replaceTrack(newTrack);

      oldStream?.getTracks().forEach(t => t.stop());
      _call.cameraStream = newStream;
      if (cameraVideoRef.current) {
        cameraVideoRef.current.srcObject = newStream;
        cameraVideoRef.current.play().catch(() => {});
      }
      setFacingMode(next);
    } catch {
      // The flip failed after we had already let go of the old camera, so the
      // call would be left sending a dead track. Put the original one back.
      if (!_call.cameraStream?.active) {
        try {
          const back = await openCamera(facingMode, false);
          const backTrack = back.getVideoTracks()[0];
          const sender = cameraSender();
          if (backTrack && sender) await sender.replaceTrack(backTrack);
          _call.cameraStream = back;
          if (cameraVideoRef.current) {
            cameraVideoRef.current.srcObject = back;
            cameraVideoRef.current.play().catch(() => {});
          }
        } catch { /* nothing left to try */ }
      }
    } finally {
      setSwitchingCamera(false);
    }
  };

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
    <div className={`call-window${inline ? ' inline-call' : ''}`} style={outerStyle}>
      {/* Call header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: 'var(--bg-secondary)', flexShrink: 0 }}>
        {remotePeerId ? (
          <>
            <UserAvatar name={remoteName} avatar={remoteAvatar} size={28} />
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 13, lineHeight: 1.2 }}>{remoteName}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{tr('call_in_call')}</div>
            </div>
          </>
        ) : (
          <div style={{ flex: 1 }} />
        )}
        <div style={{ position: 'relative' }}>
          <button
            onMouseEnter={() => setShowInfo(true)}
            onMouseLeave={() => setShowInfo(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', padding: 4, borderRadius: 6 }}
            title={tr('call_info')}
          >
            <Info size={16} />
          </button>
          {showInfo && (() => {
            const entry = getSelectedServerEntry();
            const isMain = entry?.url === API_BASE_URL || !entry;
            const serverName = isMain ? 'Main' : (entry?.name || entry?.url || '');
            const active = _call.activeIceServers;
            const rawUrls = active?.[0]?.urls;
            const firstUrl = Array.isArray(rawUrls) ? rawUrls[0] : rawUrls;
            const activeMatch = (firstUrl || '').match(/^stun:(.+):(\d+)$/);
            const activeHost = activeMatch?.[1] || '';
            const activePort = activeMatch?.[2] || '';
            const isMainStun = activeHost === APP_HOST || !activeHost;
            const iceState = _call.pc?.iceConnectionState;
            const row = (label: string, value: React.ReactNode) => (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
                {value}
              </div>
            );
            return (
              <div
                onMouseEnter={() => setShowInfo(true)}
                onMouseLeave={() => setShowInfo(false)}
                style={{
                  position: 'absolute', top: '100%', right: 0, zIndex: 100,
                  background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                  borderRadius: 8, padding: 12, minWidth: 200, boxShadow: 'var(--shadow-lg)',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>{tr('call_info')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
                  {row(tr('call_info_server'), <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{serverName}</span>)}
                  {!isMain && row('URL', <span style={{ color: 'var(--text-primary)', fontSize: 10, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry?.url}</span>)}
                  {row(tr('call_info_ping'), <span style={{ color: infoPing === 'loading' ? 'var(--text-secondary)' : infoPing === null ? '#ef4444' : (infoPing as number) < 100 ? '#22c55e' : (infoPing as number) < 300 ? '#f59e0b' : '#ef4444', fontWeight: 600 }}>
                    {infoPing === 'loading' ? '...' : infoPing === null ? 'offline' : `${infoPing} ms`}
                  </span>)}
                  {row(tr('call_info_stun'), <span style={{ fontWeight: 600, color: infoStun === 'loading' ? 'var(--text-secondary)' : infoStun === true ? '#22c55e' : infoStun === 'local' ? '#3b82f6' : infoStun === false ? '#ef4444' : 'var(--text-secondary)' }}>
                    {infoStun === 'loading' ? '...' : infoStun === true ? (isMainStun ? '✓ Main' : `✓ ${activeHost}:${activePort}`) : infoStun === 'local' ? (isMainStun ? 'LAN · Main' : `LAN · ${activeHost}`) : infoStun === false ? (isMainStun ? '✗ Main' : `✗ ${activeHost}`) : '—'}
                  </span>)}
                  {_call.pc && (<>
                    <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
                    {row(tr('call_info_status'), <span style={{ fontWeight: 600, color: iceState === 'connected' || iceState === 'completed' ? '#22c55e' : iceState === 'failed' ? '#ef4444' : '#f59e0b' }}>
                      {iceState === 'connected' || iceState === 'completed' ? tr('call_info_connected') : iceState === 'failed' ? 'Failed' : tr('call_info_connecting')}
                    </span>)}
                    {connInfo?.candidateType && row(tr('call_info_type'), <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                      {connInfo.candidateType === 'relay' ? 'TURN relay' : connInfo.candidateType === 'srflx' ? 'STUN' : connInfo.candidateType}{connInfo.protocol ? ` / ${connInfo.protocol}` : ''}
                    </span>)}
                  </>)}
                </div>
              </div>
            );
          })()}
        </div>
        <button
          onClick={() => setWindowExpanded(v => !v)}
          title={windowExpanded ? tr('call_restore') : tr('call_maximize')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', padding: 4, borderRadius: 6 }}
        >
          {windowExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>

      {/* Mobile 1:1: one stream full-screen + the other as a corner PiP.
          Tap the PiP (or the switch button) to swap which is full-screen. Both
          <video> elements stay mounted (only their style changes) so their
          srcObject / playback survive the swap. */}
      {mobilePip ? (() => {
        const bigRemote = !pipSwapped;
        const swap = () => setPipSwapped(v => !v);
        const fullVideo: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' };
        const pipVideo: React.CSSProperties = { position: 'absolute', right: 12, bottom: 12, width: 100, height: 138, objectFit: 'cover', borderRadius: 12, border: '2px solid rgba(255,255,255,0.18)', boxShadow: '0 4px 16px rgba(0,0,0,0.45)', background: '#000', zIndex: 3, cursor: 'pointer' };
        const fullPh: React.CSSProperties = { ...placeholderStyle, position: 'absolute', inset: 0 };
        const pipPh: React.CSSProperties = { position: 'absolute', right: 12, bottom: 12, width: 100, height: 138, borderRadius: 12, border: '2px solid rgba(255,255,255,0.18)', boxShadow: '0 4px 16px rgba(0,0,0,0.45)', background: 'var(--bg-tertiary)', zIndex: 3, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };
        const remoteOn = remoteVideoStatus !== 'off';
        return (
        <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden', background: '#000' }}>
          {/* Remote video — always mounted; full or PiP depending on swap */}
          <video
            ref={remoteVideoRef} autoPlay muted playsInline onClick={bigRemote ? undefined : swap}
            style={{ ...(bigRemote ? fullVideo : pipVideo), display: remoteOn ? 'block' : 'none' }}
          />
          <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
          {/* Own camera — always mounted; PiP or full depending on swap */}
          <video
            ref={cameraVideoRef} autoPlay muted playsInline onClick={bigRemote ? swap : undefined}
            style={{ ...(bigRemote ? pipVideo : fullVideo), display: isVideoActive ? 'block' : 'none' }}
          />
          {/* Remote placeholder (video off) */}
          {!remoteOn && (
            <div style={bigRemote ? fullPh : pipPh} onClick={bigRemote ? undefined : swap}>
              <div style={isRinging ? { animation: 'call-pulse 1.5s ease-in-out infinite' } : undefined}>
                <UserAvatar name={remoteName} avatar={remoteAvatar} size={bigRemote ? 72 : 34} />
              </div>
              {bigRemote && <>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 15 }}>{remoteName}</span>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                  {isRinging ? (tr('call_ringing') || tr('call_calling_you')) : tr('call_video_off')}
                </span>
              </>}
            </div>
          )}
          {/* Own placeholder (camera off) */}
          {!isVideoActive && (
            <div style={bigRemote ? pipPh : fullPh} onClick={bigRemote ? swap : undefined}>
              <UserAvatar name="Me" avatar="" size={bigRemote ? 34 : 72} />
            </div>
          )}
          {/* Flip phone camera (front ↔ back) — only meaningful while our
              camera is on. Tapping the PiP itself swaps the two views. */}
          {isVideoActive && hasSecondCamera && (
            <button
              onClick={switchCamera}
              disabled={switchingCamera}
              title={tr('call_switch_camera')}
              aria-label={tr('call_switch_camera')}
              style={{ position: 'absolute', top: 12, left: 12, zIndex: 5, width: 40, height: 40, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.45)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: switchingCamera ? 'default' : 'pointer', opacity: switchingCamera ? 0.5 : 1 }}
            >
              <SwitchCamera size={20} />
            </button>
          )}
        </div>
        );
      })() : (
      <>
      {/* Video grid */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gridAutoRows: '1fr', gap: 3, padding: 3, minHeight: 0, overflow: 'hidden' }}>
        <Tile id="local" label={tr('call_you')} expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
          <video ref={cameraVideoRef} autoPlay muted playsInline style={{ ...videoFill, display: isVideoActive ? 'block' : 'none' }} />
          {!isVideoActive && (
            <div style={placeholderStyle}>
              <UserAvatar name="Me" avatar="" size={48} />
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{tr('call_video_off')}</span>
            </div>
          )}
        </Tile>

        <Tile id="remote" label={remoteName} expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
          <video
            ref={remoteVideoRef} autoPlay muted playsInline
            style={{ ...videoFill, display: remoteVideoStatus !== 'off' ? 'block' : 'none' }}
            
          />
          <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
          {remoteVideoStatus === 'off' && (
            <div style={placeholderStyle}>
              <div style={isRinging ? { animation: 'call-pulse 1.5s ease-in-out infinite' } : undefined}>
                <UserAvatar name={remoteName} avatar={remoteAvatar} size={48} />
              </div>
              <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 13 }}>{remoteName}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                {isRinging ? (tr('call_ringing') || tr('call_calling_you')) : tr('call_video_off')}
              </span>
            </div>
          )}
        </Tile>

        {isDemonstrationActive && (
          <Tile id="screen" label={tr('call_your_screen')} expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
            <video ref={screenVideoRef} autoPlay muted playsInline style={videoFill} />
          </Tile>
        )}

        {remoteScreenActive && (
          <Tile id="remoteScreen" label={tr('call_remote_screen').replace('{name}', remoteName)} expandedTile={expandedTile} setExpandedTile={setExpandedTile}>
            <video ref={remoteScreenVideoRef} autoPlay muted playsInline style={videoFill} />
          </Tile>
        )}
      </div>
      </>
      )}

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
