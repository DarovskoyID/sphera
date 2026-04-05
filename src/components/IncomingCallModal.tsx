import { useEffect, useRef } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';

export const IncomingCallModal = () => {
  const {
    isCallActive,
    incomingOffer,
    setIncomingOffer,
    setCallActive,
    setCallTargetId,
    setCurrentChat,
    sendSignal,
    signalingPeers,
    onSignalingMessage,
    friends,
  } = useApp();
  const tr = useTranslation();

  const bufferedCandidates = useRef<any[]>([]);
  const isCallActiveRef = useRef(isCallActive);
  isCallActiveRef.current = isCallActive;

  const incomingOfferRef = useRef(incomingOffer);
  incomingOfferRef.current = incomingOffer;

  // Re-register handler when call ends (CallWindow unmounts and nulls onSignalingMessage)
  const handlerRef = useRef<((msg: any) => void) | null>(null);

  if (!handlerRef.current) {
    handlerRef.current = (msg: any) => {
      if (isCallActiveRef.current) return;

      if (msg.type === 'offer' && msg.from) {
        bufferedCandidates.current = [];
        setIncomingOffer(msg);
      } else if (msg.type === 'candidate' && msg.from && incomingOfferRef.current) {
        bufferedCandidates.current.push(msg);
      }
    };
  }

  // Set handler when not in a call — re-runs when isCallActive changes to false
  useEffect(() => {
    if (isCallActive) return;
    onSignalingMessage.current = handlerRef.current;
    return () => {
      if (onSignalingMessage.current === handlerRef.current) {
        onSignalingMessage.current = null;
      }
    };
  }, [isCallActive]);

  const callerPeer = incomingOffer
    ? signalingPeers.find(p => String(p.id) === String(incomingOffer.from))
    : null;
  const callerFriend = incomingOffer
    ? friends.find(f => String(f.id) === String(incomingOffer.from))
    : null;
  const callerName = callerFriend?.nickname || callerFriend?.username || callerPeer?.name || String(incomingOffer?.from ?? '');
  const callerAvatar = callerFriend?.avatar || '';

  const accept = () => {
    if (!incomingOffer) return;
    const offerWithCandidates = {
      ...incomingOffer,
      bufferedCandidates: [...bufferedCandidates.current],
    };
    bufferedCandidates.current = [];
    setIncomingOffer(offerWithCandidates);
    setCallTargetId(String(incomingOffer.from));
    // Open the chat with the caller — set chat first, then navigate to home
    setCurrentChat(String(incomingOffer.from));
    setCallActive(true);
  };

  const reject = () => {
    if (!incomingOffer) return;
    sendSignal({ type: 'call-rejected', to: incomingOffer.from });
    bufferedCandidates.current = [];
    setIncomingOffer(null);
  };

  if (isCallActive || !incomingOffer) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        backgroundColor: '#222',
        borderRadius: 12,
        padding: 24,
        minWidth: 320,
        maxWidth: 400,
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
        textAlign: 'center',
      }}>
        {callerAvatar ? (
          <img
            src={callerAvatar}
            alt={callerName}
            style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', margin: '0 auto 16px', display: 'block', border: '3px solid var(--accent-primary, #5865f2)' }}
          />
        ) : (
          <div style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            background: 'var(--accent-primary, #5865f2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
            fontSize: 28,
            fontWeight: 700,
            color: '#fff',
          }}>
            {callerName ? callerName[0].toUpperCase() : <Phone size={28} color="#fff" />}
          </div>
        )}
        <h2 style={{ margin: '0 0 4px 0', color: '#fff', fontSize: 20 }}>{callerName}</h2>
        <p style={{ margin: '0 0 24px 0', color: '#aaa', fontSize: 14 }}>
          {tr('call_incoming')} · {tr('call_calling_you')}
        </p>
        <div style={{ display: 'flex', gap: 16, justifyContent: 'center' }}>
          <button
            onClick={reject}
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              backgroundColor: '#ff4444',
              color: '#fff',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
            title={tr('call_decline')}
          >
            <PhoneOff size={24} />
          </button>
          <button
            onClick={accept}
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              backgroundColor: '#44cc44',
              color: '#fff',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
            title={tr('call_accept')}
          >
            <Phone size={24} />
          </button>
        </div>
      </div>
    </div>
  );
};
