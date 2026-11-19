import React, { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { useApp } from '../context/AppContext';

const SEEN_KEY = 'sfera_onboarding_v1_done';
export const ONBOARDING_REPLAY_EVENT = 'sfera:onboarding-replay';

/** Ask for the tour to be shown again — wired to the settings button. */
export function replayOnboarding() {
  window.dispatchEvent(new Event(ONBOARDING_REPLAY_EVENT));
}

type StepMode = 'info' | 'click';
interface Step {
  /** CSS selector of the element to spotlight; omitted = centered card. */
  target?: string;
  /** 'click' waits for the user to actually click the target before moving on. */
  mode: StepMode;
  ru: { title: string; body: string };
  en: { title: string; body: string };
  /** Extra one-line call to action shown on a click step. */
  cueRu?: string;
  cueEn?: string;
}

const STEPS: Step[] = [
  {
    mode: 'info',
    ru: {
      title: 'Добро пожаловать в Сферу',
      body: 'Это короткое интерактивное обучение. Оно проведёт вас по основным разделам — на каждом шаге просто нажимайте подсвеченные кнопки. Пройти его снова можно в любой момент из настроек внешнего вида.',
    },
    en: {
      title: 'Welcome to Sfera',
      body: 'A short, hands-on tour. It walks you through the main areas — on each step just press the highlighted button. You can replay it any time from Appearance settings.',
    },
  },
  {
    target: '[data-tour="server-dock"]',
    mode: 'info',
    ru: {
      title: 'Панель навигации',
      body: 'Это ваша главная панель. Наверху — настройки, личные сообщения и «Исследовать сферу». Ниже появляется то, что добавляют установленные модули: серверы, каналы, дневники, боты.',
    },
    en: {
      title: 'The navigation dock',
      body: 'Your main dock. At the top: settings, direct messages and Explore. Below appears whatever your installed modules add: servers, channels, diaries, bots.',
    },
  },
  {
    target: '[data-tour="nav-home"]',
    mode: 'click',
    ru: {
      title: 'Личные сообщения',
      body: 'Начнём с личных сообщений. Здесь живут переписки с друзьями, голосовые и видеозвонки.',
    },
    en: {
      title: 'Direct messages',
      body: 'Let’s start with direct messages — your conversations with friends, plus voice and video calls.',
    },
    cueRu: 'Нажмите кнопку «Дом», чтобы открыть личные сообщения.',
    cueEn: 'Press the Home button to open direct messages.',
  },
  {
    target: '[data-tour="dm-sidebar"]',
    mode: 'info',
    ru: {
      title: 'Друзья и переписки',
      body: 'В этом списке — ваши друзья и диалоги. Через поиск сверху можно найти человека по имени и добавить в друзья, а затем написать ему или позвонить. Непрочитанные и запросы в друзья подсвечиваются здесь же.',
    },
    en: {
      title: 'Friends and chats',
      body: 'This list holds your friends and conversations. Use the search at the top to find someone by name and add them, then message or call them. Unread chats and friend requests show up here too.',
    },
  },
  {
    target: '[data-tour="nav-explore"]',
    mode: 'click',
    ru: {
      title: 'Обзор',
      body: 'Теперь заглянем в «Исследовать сферу» — здесь добавляются модули.',
    },
    en: {
      title: 'Explore',
      body: 'Now let’s open Explore — this is where modules are added.',
    },
    cueRu: 'Нажмите кнопку «Обзор» (компас).',
    cueEn: 'Press the Explore button (the compass).',
  },
  {
    target: '[data-tour="explore-view"]',
    mode: 'info',
    ru: {
      title: 'Что можно найти',
      body: 'Сфера собирается из модулей: серверы, каналы, боты, личные дневники, семейный центр. Устанавливайте только нужное — и удаляйте, когда не нужно. Когда установлены серверы или каналы, здесь же появляется поиск по ним.',
    },
    en: {
      title: 'What you’ll find',
      body: 'Sfera is built from modules: servers, channels, bots, personal diaries, the family centre. Install only what you need and remove it when you don’t. With servers or channels installed, their search appears here too.',
    },
  },
  {
    target: '[data-tour="nav-add"]',
    mode: 'info',
    ru: {
      title: 'Создать своё',
      body: 'Кнопка «плюс» появляется, когда модулю есть что создать: сервер, канал или вход по коду приглашения.',
    },
    en: {
      title: 'Make your own',
      body: 'The plus button appears once a module has something to create: a server, a channel, or joining by invite code.',
    },
  },
  {
    target: '[data-tour="nav-settings"]',
    mode: 'click',
    ru: {
      title: 'Настройки',
      body: 'И последнее — настройки, где собрано всё про ваш аккаунт и приватность.',
    },
    en: {
      title: 'Settings',
      body: 'Last stop — settings, where everything about your account and privacy lives.',
    },
    cueRu: 'Нажмите кнопку настроек (шестерёнка).',
    cueEn: 'Press the settings button (the gear).',
  },
  {
    target: '[data-tour="settings-view"]',
    mode: 'info',
    ru: {
      title: 'Всё под контролем',
      body: 'Здесь — профиль, приватность и фильтр контента, уведомления, устройства (в том числе выход из всех сеансов) и внешний вид. В разделе «Внешний вид» можно в любой момент запустить это обучение заново. Готово — приятного общения!',
    },
    en: {
      title: 'You’re all set',
      body: 'Here you’ll find your profile, privacy and the content filter, notifications, devices (including sign out everywhere) and appearance. In Appearance you can replay this tour any time. That’s it — enjoy!',
    },
  },
];

const PAD = 6;

interface Rect { top: number; left: number; width: number; height: number; }

/**
 * An interactive, step-by-step tour. It spotlights a real control, dims and
 * blocks the rest of the screen, and on "click" steps waits for the user to
 * actually press the highlighted button before advancing. Shows once after the
 * first sign-in and can be replayed from settings.
 */
export const OnboardingTour: React.FC = () => {
  const { authToken, language, currentServerIP } = useApp();
  const isRu = language === 'ru';
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const advancingRef = useRef(false);
  const decidedRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(220);

  // First launch after registration. "Completed" is the account's own flag on
  // the server, so clearing the browser's cookies/local storage does NOT bring
  // the tour back — a returning account is recognised as having seen it.
  useEffect(() => {
    if (!authToken || !currentServerIP || decidedRef.current) return;
    if (localStorage.getItem(SEEN_KEY)) { decidedRef.current = true; return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${currentServerIP}/api/auth/settings/`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok || cancelled) return;
        const cfg = await res.json();
        decidedRef.current = true;
        if (cfg.onboarding_completed) {
          // Already done on another device / before the cookies were cleared —
          // cache it locally and never show it here.
          localStorage.setItem(SEEN_KEY, '1');
        } else if (!cancelled) {
          setStep(0);
          setOpen(true);
        }
      } catch {
        // Offline or the server is unreachable — don't pop the tour on a guess.
      }
    })();
    return () => { cancelled = true; };
  }, [authToken, currentServerIP]);

  // Replay from settings.
  useEffect(() => {
    const onReplay = () => { setStep(0); setOpen(true); };
    window.addEventListener(ONBOARDING_REPLAY_EVENT, onReplay);
    return () => window.removeEventListener(ONBOARDING_REPLAY_EVENT, onReplay);
  }, []);

  const finish = useCallback(() => {
    localStorage.setItem(SEEN_KEY, '1');
    setOpen(false);
    // Remember it on the account too, so a cleared browser won't replay it.
    if (authToken && currentServerIP) {
      fetch(`${currentServerIP}/api/auth/settings/update/`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ onboarding_completed: true }),
      }).catch(() => undefined);
    }
  }, [authToken, currentServerIP]);

  const current = STEPS[step];
  const goNext = useCallback(() => {
    advancingRef.current = false;
    setStep(s => (s >= STEPS.length - 1 ? s : s + 1));
  }, []);

  // Track the spotlighted element's position, re-measuring as the layout shifts
  // (navigation, resize, scroll). Polling keeps it correct without wiring into
  // every place that can move it.
  useEffect(() => {
    if (!open) return;
    if (!current.target) { setRect(null); return; }
    let raf = 0;
    const measure = () => {
      const el = document.querySelector(current.target!);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      } else {
        setRect(null);
      }
    };
    measure();
    const id = window.setInterval(measure, 200);
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      cancelAnimationFrame(raf);
    };
  }, [open, current, step]);

  // On a "click" step, wait for the real click on the highlighted element and
  // then advance — letting the click through so it actually navigates.
  useEffect(() => {
    if (!open || current.mode !== 'click' || !current.target) return;
    const onClick = (e: MouseEvent) => {
      const el = document.querySelector(current.target!);
      if (el && e.target instanceof Node && el.contains(e.target) && !advancingRef.current) {
        advancingRef.current = true;
        // Give the app a moment to react to the click (navigate/render) before
        // the next step tries to find its target.
        window.setTimeout(goNext, 450);
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [open, current, goNext]);

  // Measure the card so placement can keep it fully on-screen and off the dock.
  useLayoutEffect(() => {
    if (!open) return;
    const h = cardRef.current?.offsetHeight;
    if (h && Math.abs(h - cardH) > 1) setCardH(h);
  });

  if (!open) return null;

  const isLast = step === STEPS.length - 1;
  const txt = isRu ? current.ru : current.en;
  const cue = current.mode === 'click' ? (isRu ? current.cueRu : current.cueEn) : undefined;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const hole = rect
    ? { top: Math.max(0, rect.top - PAD), left: Math.max(0, rect.left - PAD), width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
    : null;

  const mask: React.CSSProperties = { position: 'fixed', background: 'rgba(0,0,0,0.62)', zIndex: 300000 };
  const swallow = (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); };

  // Tooltip placement uses the card's *measured* height (its text varies, and a
  // fixed guess overlapped the mobile dock). Prefer below the hole, flip above
  // when there isn't room, and fall back to the roomier side; centre it when the
  // step has no target.
  const CARD_W = Math.min(380, vw - 24);
  const GAP = 16;
  let cardTop: number;
  let cardLeft: number;
  if (hole) {
    const belowSpace = vh - (hole.top + hole.height);
    const aboveSpace = hole.top;
    // Sit right next to the highlighted element (below it, or above it when
    // there's no room below — e.g. the bottom dock on mobile), keeping a clear
    // gap so the card points at what it describes instead of floating away.
    if (belowSpace >= cardH + GAP) {
      cardTop = hole.top + hole.height + GAP;
    } else if (aboveSpace >= cardH + GAP) {
      cardTop = hole.top - GAP - cardH;
    } else if (aboveSpace >= belowSpace) {
      cardTop = Math.max(12, hole.top - GAP - cardH);
    } else {
      cardTop = Math.min(vh - cardH - 12, hole.top + hole.height + GAP);
    }
    cardTop = Math.max(12, Math.min(cardTop, vh - cardH - 12));
    cardLeft = Math.min(Math.max(12, hole.left + hole.width / 2 - CARD_W / 2), vw - CARD_W - 12);
  } else {
    cardTop = Math.max(12, vh / 2 - cardH / 2);
    cardLeft = vw / 2 - CARD_W / 2;
  }

  return (
    <>
      {/* Dim + block everything except the spotlighted hole. */}
      {hole ? (
        <>
          <div style={{ ...mask, top: 0, left: 0, width: '100vw', height: hole.top }} onClick={swallow} />
          <div style={{ ...mask, top: hole.top + hole.height, left: 0, width: '100vw', height: Math.max(0, vh - hole.top - hole.height) }} onClick={swallow} />
          <div style={{ ...mask, top: hole.top, left: 0, width: hole.left, height: hole.height }} onClick={swallow} />
          <div style={{ ...mask, top: hole.top, left: hole.left + hole.width, width: Math.max(0, vw - hole.left - hole.width), height: hole.height }} onClick={swallow} />
          {/* On an info step the element stays bright but must not be clickable —
              only the "click" steps hand control to the real button. */}
          {current.mode === 'info' && (
            <div style={{ position: 'fixed', top: hole.top, left: hole.left, width: hole.width, height: hole.height, zIndex: 300001, background: 'transparent' }} onClick={swallow} />
          )}
          {/* Ring around the spotlight. */}
          <div style={{
            position: 'fixed', top: hole.top, left: hole.left, width: hole.width, height: hole.height,
            border: '2px solid var(--accent-primary)', borderRadius: 12, zIndex: 300002, pointerEvents: 'none',
            boxShadow: '0 0 0 3px rgba(var(--accent-rgb, 0 112 243), 0.35)',
          }} />
        </>
      ) : (
        <div style={{ ...mask, inset: 0, width: '100vw', height: '100vh' }} onClick={swallow} />
      )}

      {/* Tooltip / control card. */}
      <div ref={cardRef} style={{
        position: 'fixed', top: cardTop, left: cardLeft, width: CARD_W, zIndex: 300003,
        background: 'var(--bg-secondary, #2b2d31)', border: '1px solid var(--border-color)',
        borderRadius: 14, padding: 18, boxShadow: '0 18px 50px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <h3 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 17, fontWeight: 700 }}>{txt.title}</h3>
          <button onClick={finish} title={isRu ? 'Пропустить' : 'Skip'}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 2, display: 'flex' }}>
            <X size={18} />
          </button>
        </div>
        <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5 }}>{txt.body}</p>

        {cue && (
          <div style={{
            marginTop: 12, padding: '9px 12px', borderRadius: 9, fontSize: 13.5, fontWeight: 600,
            color: 'var(--accent-primary)', background: 'rgba(var(--accent-rgb, 0 112 243), 0.12)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ display: 'inline-flex', width: 8, height: 8, borderRadius: 99, background: 'var(--accent-primary)', flexShrink: 0, animation: 'none' }} />
            {cue}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 5 }}>
            {STEPS.map((_, i) => (
              <span key={i} style={{
                width: i === step ? 18 : 7, height: 7, borderRadius: 99, transition: 'width .2s',
                background: i === step ? 'var(--accent-primary)' : 'var(--bg-tertiary, rgba(255,255,255,0.15))',
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && (
              <button onClick={() => setStep(s => Math.max(0, s - 1))}
                style={{ padding: '8px 14px', borderRadius: 9, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', fontSize: 13.5, cursor: 'pointer' }}>
                {isRu ? 'Назад' : 'Back'}
              </button>
            )}
            {current.mode === 'info' ? (
              <button onClick={() => (isLast ? finish() : goNext())}
                style={{ padding: '8px 16px', borderRadius: 9, background: 'var(--accent-primary)', color: '#fff', border: 'none', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}>
                {isLast ? (isRu ? 'Готово' : 'Done') : (isRu ? 'Далее' : 'Next')}
              </button>
            ) : (
              <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)', alignSelf: 'center' }}>
                {isRu ? 'Ждём нажатия…' : 'Waiting for your click…'}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
};
