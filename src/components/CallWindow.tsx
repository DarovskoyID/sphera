import React, { useRef, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';

export const CallWindow = () => {
  const {
    setCallActive,
    setDemonstrationActive,
    setVideoActive,
    setCallStatus,
    isDemonstrationActive,
    isVideoActive
  } = useApp();

  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const cameraStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const myIdRef = useRef<string | null>(null);

  const [serverUrl, setServerUrl] = useState("http://localhost:8888");
  const [myId, setMyId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Array<{ id: string; name: string }>>([]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [remoteVideoStatus, setRemoteVideoStatus] = useState<string>('нет видео');
  const [localVideoStatus, setLocalVideoStatus] = useState<string>('нет видео');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const targetIdRef = useRef<string | null>(null);
  const pendingCandidates = useRef<RTCIceCandidate[]>([]);

  // 🔹 Единый remote поток
  const remoteStreamRef = useRef<MediaStream | null>(null);

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
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    screenStream.current = stream;
    attachStreamToVideo(screenVideoRef.current, stream, () => {}, false);
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
      if (event.candidate) sendSignal(remoteId, { type: 'candidate', candidate: event.candidate });
    };

    pc.ontrack = (event) => {
      console.log('ontrack triggered', event.track.kind, 'readyState:', event.track.readyState);

      // 🔹 Инициализация единственного remoteStream
      if (!remoteStreamRef.current) {
        remoteStreamRef.current = new MediaStream();
        console.log('Remote stream created');
      }

      // 🔹 Добавляем новый трек, если его ещё нет
      if (!remoteStreamRef.current.getTracks().some(t => t.id === event.track.id)) {
        remoteStreamRef.current.addTrack(event.track);
        console.log('Track added:', event.track.kind, 'Total tracks:', remoteStreamRef.current.getTracks().length);
      }

      // 🔹 Устанавливаем srcObject в video элемент
      const videoEl = remoteVideoRef.current;
      if (!videoEl) {
        console.error('Video element ref is null!');
        return;
      }
      
      console.log('Video element found, current srcObject:', videoEl.srcObject ? 'SET' : 'NULL');
      
      // Устанавливаем srcObject при первом track'е
      if (!videoEl.srcObject) {
        videoEl.srcObject = remoteStreamRef.current;
        videoEl.muted = true;
        videoEl.playsInline = true;
        console.log('srcObject assigned to video element');
      }
      
      // 🔹 ВАЖНО: Попытка воспроизведения КАЖДЫЙ раз при новом треке
      console.log('Attempting to play remote video...');
      const playPromise = videoEl.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            console.log('✅ Remote video playing successfully');
            setRemoteVideoStatus('видео играет');
          })
          .catch(err => {
            console.error('❌ Play error:', err.name, err.message);
            setRemoteVideoStatus(`ошибка: ${err.name}`);
            // Пробуем повторить через 100ms
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
    if (cameraVideoRef.current && cameraStream.current) {
      attachStreamToVideo(cameraVideoRef.current, cameraStream.current, setLocalVideoStatus, true);
    }
  }, [isVideoActive]);

  // ==================== Сигнализация ====================
  const sendSignal = async (to: string, data: any) => {
    const id = myIdRef.current || myId;
    if (!id) {
      console.error('myId is not set');
      return;
    }
    const payload = { ...data, from: id };
    try {
      const response = await fetch(`${serverUrl}/message?peer_id=${id}&to=${to}`, { 
        method: 'POST', 
        body: JSON.stringify(payload) 
      });
      if (!response.ok) {
        console.error('Failed to send signal:', response.status);
      } else {
        console.log('Signal sent successfully:', data.type);
      }
    } catch (error) {
      console.error('Error sending signal:', error);
    }
  };

  const callPeer = async (peerId: string) => {
    setTargetId(peerId);
    targetIdRef.current = peerId;
    pendingCandidates.current = [];

    if (!cameraStream.current?.active) {
      const ok = await startCamera();
      if (ok) setVideoActive(true);
    }

    const pc = createPeerConnection(peerId);
    pcRef.current = pc;
    
    // ✅ ВАЖНО: добавляем локальные треки ДО создания offer
    addLocalTracks(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    sendSignal(peerId, { type: 'offer', sdp: offer });
  };

  const handleSignal = async (msg: any, senderId: string) => {
    if (!pcRef.current || targetIdRef.current !== senderId) {
      pcRef.current = createPeerConnection(senderId);
      targetIdRef.current = senderId;
      setTargetId(senderId);
      pendingCandidates.current = [];
    }
    const pc = pcRef.current;

    if (msg.type === 'offer') {
      try {
        // ✅ Устанавливаем удаленное описание (видео будет приходить от инициатора)
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        
        // ✅ Получатель НЕ отправляет видео - создаём пустой ответ
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendSignal(senderId, { type: 'answer', sdp: answer });
        
        // Добавляем ожидающих кандидатов
        for (const c of pendingCandidates.current) await pc.addIceCandidate(c);
        pendingCandidates.current = [];
        
        console.log('Answer sent successfully');
      } catch (e) {
        console.error('Offer handling error:', e);
      }

    } else if (msg.type === 'answer') {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        
        // Добавляем ожидающих кандидатов
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
    }
  };

  const waitForMessages = async (id: string) => {
    while (true) {
      const res = await fetch(`${serverUrl}/wait?peer_id=${id}`);
      const text = await res.text();
      if (!text) continue;

      const lines = text.split('\n').filter(Boolean);

      for (const line of lines) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          const [name, newId] = line.split(',');
          setPeers(prev => prev.some(p => p.id === newId) ? prev : [...prev, { id: newId, name }]);
          continue;
        }
        await handleSignal(msg, msg.from);
      }
    }
  };

  const signIn = async () => {
    try {
      const name = `user_${Math.floor(Math.random() * 1000)}`;
      const res = await fetch(`${serverUrl}/sign_in?${name}`);
      
      if (!res.ok) {
        console.error('Sign in failed:', res.status);
        setRemoteVideoStatus(`Ошибка сервера: ${res.status}`);
        return;
      }
      
      const text = await res.text();
      const lines = text.split('\n').filter(Boolean);
      
      if (lines.length === 0) {
        console.error('Empty response from server');
        return;
      }
      
      const userId = lines[0].split(',')[1];
      myIdRef.current = userId;
      setMyId(userId);
      console.log('Signed in with ID:', userId);

      const peersList = lines.slice(1).map(line => {
        const [name, id] = line.split(',');
        return { id, name };
      });
      setPeers(peersList);
      console.log('Peers list updated:', peersList);

      waitForMessages(userId);
    } catch (error) {
      console.error('Sign in error:', error);
      setRemoteVideoStatus('Ошибка подключения к серверу');
    }
  };

  const stopCall = () => {
    pcRef.current?.close();
    pcRef.current = null;

    targetIdRef.current = null;
    setTargetId(null);
    pendingCandidates.current = [];

    stopAllMedia();

    remoteStreamRef.current = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    setRemoteVideoStatus('нет видео');
    setCallActive(false);
    setCallStatus('inactive');
    setVideoActive(false);
    setDemonstrationActive(false);
  };

  // ==================== UI ====================
  return (
    <div style={{ height: 350, background: 'black', display: 'flex', flexDirection: 'column' }}>
      <div style={{ color: 'white', padding: 10 }}>
        <input value={serverUrl} onChange={e => setServerUrl(e.target.value)} />
        <button onClick={signIn}>Connect</button>

        <div>
          {peers.map(peer => (
            <button key={peer.id} onClick={() => callPeer(peer.id)}>Call {peer.name}</button>
          ))}
        </div>

        <div style={{ fontSize: 12, color: 'lime' }}>Local: {localVideoStatus}</div>
        <div style={{ fontSize: 12, color: 'yellow' }}>Remote: {remoteVideoStatus}</div>
      </div>

      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 20 }}>
        {isVideoActive && <video ref={cameraVideoRef} autoPlay muted playsInline style={{ width: 300 }} />}
        
        {/* 🔹 Remote video: autoplay с muted=true для браузера, звук включаем после клика */}
        <video
          ref={remoteVideoRef}
          autoPlay
          muted
          playsInline
          style={{ width: 300, backgroundColor: '#000' }}
          onClick={() => {
            const v = remoteVideoRef.current;
            if (v) {
              v.muted = false; // включаем звук после клика
              console.log('Unmuted remote audio');
            }
          }}
        />
      </div>

      <div style={{ margin: '9px 0', width: '100%', display: 'flex', gap: 12, justifyContent: 'center' }}> 
        <button className="icon-btn glass-btn" style={{ background: 'red' }} onClick={stopCall}>X</button> 
        <button className="icon-btn glass-btn" onClick={() => setVideoActive(!isVideoActive)}>C</button> 
        <button className="icon-btn glass-btn" onClick={()=> console.log("m")}>M</button> 
        <button className="icon-btn glass-btn">H</button> 
        <button className="icon-btn glass-btn" onClick={() => setDemonstrationActive(!isDemonstrationActive)}>D</button> 
      </div> 
    </div>
  );
};