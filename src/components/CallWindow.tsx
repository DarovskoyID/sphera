import { useRef, useEffect, useState, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';

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
          console.log('PLAY ERROR:', err.name);
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
    if (!videoEl) {
      console.warn('remoteVideoRef is null in attachRemoteStream');
      return;
    }
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.playsInline = true;

    const tryPlay = () => {
      videoEl.play()
        .then(() => {
          setRemoteVideoStatus('видео играет');
          setTimeout(() => { if (videoEl) videoEl.muted = false; }, 1000);
        })
        .catch(err => {
          console.log('Remote play error:', err.name, '- retrying...');
          setTimeout(tryPlay, 500);
        });
    };
    tryPlay();
  }, []);

  const createPeerConnection = (remoteId: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'candidate', candidate: event.candidate, to: remoteId });
    };

    pc.oniceconnectionstatechange = () => {
      console.log('ICE state:', pc.iceConnectionState);
    };

    pc.ontrack = (event) => {
      console.log('ontrack:', event.track.kind, 'streams:', event.streams.length);
      const stream = event.streams[0];
      if (!stream) return;

      if (!remoteStreamRef.current) {
        remoteStreamRef.current = stream;
        attachRemoteStream(stream);
      } else if (stream.id !== remoteStreamRef.current.id) {
        console.log('Remote screen track received');
        remoteScreenStreamRef.current = stream;
        const screenEl = remoteScreenVideoRef.current;
        if (screenEl) {
          screenEl.srcObject = stream;
          screenEl.muted = true;
          screenEl.playsInline = true;
          screenEl.play().catch(e => console.error('Screen play error:', e));
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
      } else {
        console.log('Additional track on camera stream:', event.track.kind);
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

    console.log('handleSignal:', msg.type, 'from:', senderId, 'targetId:', targetIdRef.current);

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
        } catch (e) {
          console.error('Renegotiation error:', e);
        }
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
      console.warn('No PC for sender', senderId, '- creating new one');
      pcRef.current = createPeerConnection(senderId);
      targetIdRef.current = senderId;
      pendingCandidates.current = [];
    }
    const pc = pcRef.current;

    if (msg.type === 'answer') {
      try {
        console.log('Processing answer, PC state:', pc.signalingState);
        if (pc.signalingState !== 'have-local-offer') {
          console.warn('Ignoring stale answer, state:', pc.signalingState);
          return;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));

        for (const c of pendingCandidates.current) await pc.addIceCandidate(c);
        pendingCandidates.current = [];
        console.log('Answer processed successfully');
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
    pendingCandidates.current = [];

    try { await startAudio(); } catch (e) { console.warn('Audio failed:', e); }
    try {
      if (!cameraStream.current?.active) {
        const ok = await startCamera();
        if (ok) setVideoActive(true);
      }
      if (cameraVideoRef.current && cameraStream.current) {
        attachStreamToVideo(cameraVideoRef.current, cameraStream.current, setLocalVideoStatus, true);
      }
    } catch (e) { console.warn('Camera failed:', e); }

    const pc = createPeerConnection(String(peerId));
    pcRef.current = pc;

    addLocalTracks(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    console.log('Sending offer to', peerId);
    sendSignal({ type: 'offer', sdp: offer, to: peerId });
  };

  // Process incoming offer from IncomingCallModal (user accepted the call)
  const processIncomingOffer = async (msg: any) => {
    const senderId = String(msg.from);

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
      try { await startAudio(); } catch (e) { console.warn('Audio failed:', e); }
      try {
        if (!cameraStream.current?.active) {
          await startCamera();
          setVideoActive(true);
        }
        if (cameraVideoRef.current && cameraStream.current) {
          attachStreamToVideo(cameraVideoRef.current, cameraStream.current, setLocalVideoStatus, true);
        }
      } catch (e) { console.warn('Camera failed (device may be in use):', e); }

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
        console.log('Replaying', msg.bufferedCandidates.length, 'buffered candidates');
        for (const candidateMsg of msg.bufferedCandidates) {
          if (candidateMsg.candidate) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidateMsg.candidate));
            } catch (e) {
              console.error('Buffered candidate error:', e);
            }
          }
        }
      }

      // Flush any candidates that arrived during processing
      for (const c of pendingCandidates.current) await pc.addIceCandidate(c);
      pendingCandidates.current = [];

      console.log('Answer sent successfully (from incoming offer)');
    } catch (e) {
      console.error('Offer handling error:', e);
    }
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
    setRemoteVideoStatus('нет видео');
    setRemoteScreenActive(false);
    setCallActive(false);
    setCallStatus('inactive');
    setVideoActive(false);
    setDemonstrationActive(false);
  };

  useEffect(() => {
    console.log('localVideoStatus:', localVideoStatus);
  }, [localVideoStatus]);
  useEffect(() => {
    console.log('remoteVideoStatus:', remoteVideoStatus);
  }, [remoteVideoStatus]);

  // ==================== UI ====================
  return (
    <div className="call-window" style={{ height: 350, background: 'black', display: 'flex', flexDirection: 'column' }}>
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
            {tr('call_video_off')}
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
            {tr('call_remote_video_off')}
          </div>
        )}

        {isDemonstrationActive && (
          <video
            ref={screenVideoRef}
            autoPlay
            muted
            playsInline
            style={{ width: 300, backgroundColor: '#111' }}
          />
        )}

        {remoteScreenActive && (
          <video
            ref={remoteScreenVideoRef}
            autoPlay
            muted
            playsInline
            style={{ width: 300, backgroundColor: '#111' }}
          />
        )}
      </div>

      <div style={{ margin: '9px 0', width: '100%', display: 'flex', gap: 12, justifyContent: 'center' }}>
        <button className="icon-btn glass-btn" style={{ background: 'red' }} onClick={() => stopCall()}>X</button>
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
          }}
        >
          C
        </button>
        <button className="icon-btn glass-btn" onClick={() => {
          if (audioStream.current) {
            audioStream.current.getAudioTracks().forEach(track => {
              track.enabled = !track.enabled;
              console.log('Mic toggled:', track.enabled);
            });
          }
        }}>M</button>
        <button className="icon-btn glass-btn">H</button>
        <button className="icon-btn glass-btn" onClick={() => setDemonstrationActive(!isDemonstrationActive)}>D</button>
      </div>
    </div>
  );
};
