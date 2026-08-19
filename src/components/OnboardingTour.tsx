import React, { useEffect, useState, useCallback } from 'react';
import { MessageCircle, Users, Mic, ShieldCheck, Sparkles } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';
import { useApp } from '../context/AppContext';

const SEEN_KEY = 'sfera_onboarding_v1_done';
export const ONBOARDING_REPLAY_EVENT = 'sfera:onboarding-replay';

/** Ask for the tour to be shown again — wired to the settings button. */
export function replayOnboarding() {
  window.dispatchEvent(new Event(ONBOARDING_REPLAY_EVENT));
}

/**
 * A short, first-launch tour. It shows once after the first sign-in (a flag in
 * localStorage keeps it from coming back), and can be replayed from settings,
 * which is why the trigger lives in a window event rather than a prop.
 */
export const OnboardingTour: React.FC = () => {
  const tr = useTranslation();
  const { authToken } = useApp();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  // First launch after registration: no flag yet and the user is signed in.
  useEffect(() => {
    if (authToken && !localStorage.getItem(SEEN_KEY)) {
      setStep(0);
      setOpen(true);
    }
  }, [authToken]);

  // Replay from settings.
  useEffect(() => {
    const onReplay = () => { setStep(0); setOpen(true); };
    window.addEventListener(ONBOARDING_REPLAY_EVENT, onReplay);
    return () => window.removeEventListener(ONBOARDING_REPLAY_EVENT, onReplay);
  }, []);

  const finish = useCallback(() => {
    localStorage.setItem(SEEN_KEY, '1');
    setOpen(false);
  }, []);

  const steps = [
    { icon: <Sparkles size={30} />, title: tr('onb_s1_title'), body: tr('onb_s1_body') },
    { icon: <MessageCircle size={30} />, title: tr('onb_s2_title'), body: tr('onb_s2_body') },
    { icon: <Users size={30} />, title: tr('onb_s3_title'), body: tr('onb_s3_body') },
    { icon: <Mic size={30} />, title: tr('onb_s4_title'), body: tr('onb_s4_body') },
    { icon: <ShieldCheck size={30} />, title: tr('onb_s5_title'), body: tr('onb_s5_body') },
  ];

  if (!open) return null;
  const s = steps[step];
  const isLast = step === steps.length - 1;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200000,
      background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{
        width: 440, maxWidth: '100%', borderRadius: 18, padding: 28,
        background: 'var(--bg-secondary, #2b2d31)', border: '1px solid var(--border-color)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)', textAlign: 'center',
      }}>
        <div style={{
          width: 64, height: 64, borderRadius: 18, margin: '0 auto 18px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
          background: 'linear-gradient(135deg, var(--accent-primary), #7c3aed)',
        }}>
          {s.icon}
        </div>
        <h2 style={{ margin: '0 0 10px', color: 'var(--text-primary)', fontSize: 21, fontWeight: 700 }}>{s.title}</h2>
        <p style={{ margin: '0 0 22px', color: 'var(--text-secondary)', fontSize: 14.5, lineHeight: 1.5 }}>{s.body}</p>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 7, marginBottom: 22 }}>
          {steps.map((_, i) => (
            <span key={i} style={{
              width: i === step ? 22 : 8, height: 8, borderRadius: 99,
              background: i === step ? 'var(--accent-primary)' : 'var(--bg-tertiary, rgba(255,255,255,0.15))',
              transition: 'width .2s',
            }} />
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <button
            onClick={finish}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', fontSize: 13.5, cursor: 'pointer', padding: '8px 4px' }}
          >
            {tr('onb_skip')}
          </button>
          <div style={{ display: 'flex', gap: 10 }}>
            {step > 0 && (
              <button
                onClick={() => setStep(v => v - 1)}
                style={{ padding: '9px 16px', borderRadius: 10, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', fontSize: 14, cursor: 'pointer' }}
              >
                {tr('onb_back')}
              </button>
            )}
            <button
              onClick={() => (isLast ? finish() : setStep(v => v + 1))}
              style={{ padding: '9px 18px', borderRadius: 10, background: 'var(--accent-primary)', color: '#fff', border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              {isLast ? tr('onb_done') : tr('onb_next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
