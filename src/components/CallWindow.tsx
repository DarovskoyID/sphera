import { useRef, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';

export const CallWindow = () => {
  const {
    isDemonstrationActive,
    isVideoActive,
    setCallActive,
    setDemonstrationActive,
    setVideoActive,
    setCallStatus,
    sendSignal,
    signalingPeers,
    onSignalingMessage,
  } = useApp();


  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const cameraStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);

  const [remoteVideoStatus, setRemoteVideoStatus] = useState<string>('нет видео');
  const [localVideoStatus, setLocalVideoStatus] = useState<string>('нет видео');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const targetIdRef = useRef<string | null>(null);
  const pendingCandidates = useRef<RTCIceCandidate[]>([]);

  const remoteStreamRef = useRef<MediaStream | null>(null);
  const remoteScreenStreamRef = useRef<MediaStream | null>(null);
  const screenSenderRef = useRef<RTCRtpSender | null>(null);
  const [remoteScreenActive, setRemoteScreenActive] = useState(false);

  // ==================== Локальное видео ====================
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
          console.log('PLAY ERROR:', err.name);
          setStatus(err.name);
        });
    };
  };

  const startCamera = async (): Promise<boolean> => {
    if (cameraStream.current?.active) return true;
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    cameraStream.current = stream;
    return true;
  };

  const startScreen = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStream.current = stream;
      attachStreamToVideo(screenVideoRef.current, stream, () => {}, true);

      const pc = pcRef.current;
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
    } catch (e) {
      console.error('Screen capture error:', e);
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
    cameraStream.current?.getTracks().forEach(t => t.stop());
    screenStream.current?.getTracks().forEach(t => t.stop());
    cameraStream.current = null;
    screenStream.current = null;
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    setLocalVideoStatus('нет видео');
  };

  // ==================== WebRTC ====================
  const createPeerConnection = (remoteId: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'candidate', candidate: event.candidate, to: remoteId });
    };

    pc.ontrack = (event) => {
      console.log('ontrack triggered', event.track.kind, 'readyState:', event.track.readyState, 'streams:', event.streams.length);

      const remoteStream = event.streams[0];

      const isCameraStream = remoteStreamRef.current && remoteStream
        && remoteStreamRef.current.id === remoteStream.id;
      const isFirstTrack = !remoteStreamRef.current;
      const isScreenTrack = event.track.kind === 'video' && !isFirstTrack && !isCameraStream;

      if (isScreenTrack) {
        console.log('🖥️ Screen track received');
        remoteScreenStreamRef.current = new MediaStream([event.track]);

        const screenEl = screenVideoRef.current;
        if (screenEl) {
          screenEl.srcObject = remoteScreenStreamRef.current;
          screenEl.muted = true;
          screenEl.playsInline = true;
          screenEl.play().catch(e => console.error('Screen play error:', e));
        }
        setRemoteScreenActive(true);

        event.track.onended = () => {
          console.log('🖥️ Remote screen track ended');
          remoteScreenStreamRef.current = null;
          if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
          setRemoteScreenActive(false);
        };
        return;
      }

      // Camera/audio track
      if (!remoteStreamRef.current && remoteStream) {
        remoteStreamRef.current = remoteStream;
        console.log('Remote stream set, id:', remoteStream.id);
      } else if (remoteStreamRef.current && !remoteStreamRef.current.getTracks().some(t => t.id === event.track.id)) {
        remoteStreamRef.current.addTrack(event.track);
      }
      console.log('Camera track:', event.track.kind, 'Total tracks:', remoteStreamRef.current?.getTracks().length);

      const videoEl = remoteVideoRef.current;
      if (!videoEl) {
        console.error('Video element ref is null!');
        return;
      }

      if (!videoEl.srcObject) {
        videoEl.srcObject = remoteStreamRef.current;
        videoEl.muted = true;
        videoEl.playsInline = true;
      }

      const playPromise = videoEl.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            console.log('✅ Remote video playing successfully');
            setRemoteVideoStatus('видео играет');
            setTimeout(() => {
              if (videoEl) {
                videoEl.muted = false;
                console.log('🔊 Remote audio unmuted after 1s');
              }
            }, 1000);
          })
          .catch(err => {
            console.error('❌ Play error:', err.name, err.message);
            setRemoteVideoStatus(`ошибка: ${err.name}`);
            setTimeout(() => {
              videoEl.play()
                .then(() => console.log('✅ Retry: Remote video playing'))
                .catch(e => console.error('❌ Retry failed:', e.name));
            }, 100);
          });
      }
    };

    return pc;
  };

  const addLocalTracks = (pc: RTCPeerConnection) => {
    if (cameraStream.current) cameraStream.current.getTracks().forEach(track => pc.addTrack(track, cameraStream.current!));
    if (isDemonstrationActive && screenStream.current) screenStream.current.getTracks().forEach(track => pc.addTrack(track, screenStream.current!));
  };

  // ==================== Локальное видео useEffect ====================
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

  // ==================== Демонстрация экрана useEffect ====================
  useEffect(() => {
    if (isDemonstrationActive) {
      startScreen();
    } else {
      stopScreen();
    }
  }, [isDemonstrationActive]);

  // ==================== Handle incoming signals from WebSocket ====================
  const handleSignal = async (msg: any) => {
    const senderId = msg.from;
    if (!senderId) return;

    // On new offer: always create a fresh peer connection
    if (msg.type === 'offer') {
      if (pcRef.current) pcRef.current.close();
      pcRef.current = createPeerConnection(senderId);
      targetIdRef.current = senderId;
      pendingCandidates.current = [];
    } else if (!pcRef.current || targetIdRef.current !== senderId) {
      pcRef.current = createPeerConnection(senderId);
      targetIdRef.current = senderId;
      pendingCandidates.current = [];
    }
    const pc = pcRef.current;

    if (msg.type === 'offer') {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendSignal({ type: 'answer', sdp: answer, to: senderId });

        for (const c of pendingCandidates.current) await pc.addIceCandidate(c);
        pendingCandidates.current = [];

        console.log('Answer sent successfully');
      } catch (e) {
        console.error('Offer handling error:', e);
      }

    } else if (msg.type === 'answer') {
      try {
        // Ignore answer if we're not expecting one (connection is stable)
        if (pc.signalingState !== 'have-local-offer') {
          console.warn('Ignoring stale answer, state:', pc.signalingState);
          return;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));

        for (const c of pendingCandidates.current) await pc.addIceCandidate(c);
        pendingCandidates.current = [];
      } catch (e) {
        console.error('Answer handling error:', e);
      }
    } else if (msg.type === 'candidate') {
      try {
        if (msg.candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } else {
            pendingCandidates.current.push(msg.candidate);
          }
        }
      } catch (e) {
        console.error('Candidate handling error:', e);
      }
    } else if (msg.type === 'video-toggle') {
      console.log('📥 video-toggle received:', msg.enabled);

      if (msg.enabled) {
        setRemoteVideoStatus('видео включено');
      } else {
        setRemoteVideoStatus('видео выключено');
      }
    } else if (msg.type === 'demo-toggle') {
      console.log('📥 demo-toggle received:', msg.enabled);
      setRemoteScreenActive(msg.enabled);
    }
  };

  // Register signal handler on mount
  useEffect(() => {
    onSignalingMessage.current = handleSignal;
    return () => {
      onSignalingMessage.current = null;
    };
  });

  // ==================== Call peer ====================
  const callPeer = async (peerId: string) => {
    targetIdRef.current = peerId;
    pendingCandidates.current = [];

    if (!cameraStream.current?.active) {
      const ok = await startCamera();
      if (ok) setVideoActive(true);
    }

    if (cameraVideoRef.current && cameraStream.current) {
      attachStreamToVideo(cameraVideoRef.current, cameraStream.current, setLocalVideoStatus, true);
    }

    const pc = createPeerConnection(peerId);
    pcRef.current = pc;

    addLocalTracks(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    sendSignal({ type: 'offer', sdp: offer, to: peerId });
  };

  const stopCall = () => {
    pcRef.current?.close();
    pcRef.current = null;

    targetIdRef.current = null;
    pendingCandidates.current = [];

    stopAllMedia();

    remoteStreamRef.current = null;
    remoteScreenStreamRef.current = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;

    setRemoteVideoStatus('нет видео');
    setRemoteScreenActive(false);
    setCallActive(false);
    setCallStatus('inactive');
    setVideoActive(false);
    setDemonstrationActive(false);
  };

  useEffect(() => {
    console.log(localVideoStatus);
  }, [localVideoStatus]);
  useEffect(() => {
    console.log(remoteVideoStatus);
  }, [remoteVideoStatus]);

  // ==================== UI ====================
  return (
    <div className="call-window" style={{ height: 350, background: 'black', display: 'flex', flexDirection: 'column' }}>
      <div style={{ color: 'white', padding: 10 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {signalingPeers.map(peer => (
            <button key={peer.id} onClick={() => callPeer(peer.id)}>Call {peer.name}</button>
          ))}
          {signalingPeers.length === 0 && <span>No peers online</span>}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 20, alignItems: 'center' }}>
        {isVideoActive ? (
          <video ref={cameraVideoRef} autoPlay muted playsInline style={{ width: 300 }} />
        ) : (
          <div style={{
            width: 200,
            height: 200,
            backgroundColor: '#00ff00',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#000',
            fontWeight: 'bold',
            fontSize: 16,
            borderRadius: 8
          }}>
            Видео отключено
          </div>
        )}

        <video
          ref={remoteVideoRef}
          autoPlay
          muted
          playsInline
          className={remoteVideoStatus === 'видео выключено' ? 'hidden' : ''}
          style={{ width: 300, backgroundColor: '#000' }}
          onClick={() => {
            const v = remoteVideoRef.current;
            if (v) {
              v.muted = false;
              console.log('Unmuted remote audio');
            }
          }}
        />
        {remoteVideoStatus === 'видео выключено' && (
          <div style={{
            width: 300,
            height: 200,
            background: '#222',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            У собеседника выключено видео
          </div>
        )}

        <video
          ref={screenVideoRef}
          autoPlay
          muted
          playsInline
          className={(!isDemonstrationActive && !remoteScreenActive) ? 'hidden' : ''}
          style={{ width: 300, backgroundColor: '#111' }}
        />
      </div>

      <div style={{ margin: '9px 0', width: '100%', display: 'flex', gap: 12, justifyContent: 'center' }}>
        <button className="icon-btn glass-btn" style={{ background: 'red' }} onClick={stopCall}>X</button>
        <button
          className="icon-btn glass-btn"
          onClick={() => {
            const newState = !isVideoActive;
            setVideoActive(newState);

            if (cameraStream.current) {
              cameraStream.current.getVideoTracks().forEach(track => {
                track.enabled = newState;
              });
            }

            if (targetIdRef.current) {
              sendSignal({
                type: 'video-toggle',
                enabled: newState,
                to: targetIdRef.current,
              });
            }

            console.log('📤 Sent video-toggle:', newState);
          }}
        >
          C
        </button>
        <button className="icon-btn glass-btn" onClick={() => {
          if (cameraStream.current) {
            cameraStream.current.getAudioTracks().forEach(track => {
              track.enabled = !track.enabled;
              console.log('🎤 Mic toggled:', track.enabled);
            });
          }
        }}>M</button>
        <button className="icon-btn glass-btn">H</button>
        <button className="icon-btn glass-btn" onClick={() => setDemonstrationActive(!isDemonstrationActive)}>D</button>
      </div>
    </div>
  );
};
