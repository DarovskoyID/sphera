import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Copy, LayoutTemplate, Palette, Play, Plus, Trash2, X,
} from 'lucide-react';
import { useModuleT } from '@sfera/sdk';
import type { DocSession } from './session';
import { uid, type DeckData, type Slide, type SlideLayout } from './types';
import { Avatar, IconButton, MenuItem, PopMenu } from './ui';

const LAYOUTS: SlideLayout[] = ['title', 'bullets', 'text', 'two', 'image', 'blank'];

const THEMES: Record<DeckData['theme'], { bg: string; fg: string; accent: string; muted: string }> = {
  light: { bg: '#ffffff', fg: '#16161a', accent: '#4f46e5', muted: '#5c5c6a' },
  dark: { bg: '#17171c', fg: '#f4f4f7', accent: '#8b8bff', muted: '#a6a6b4' },
  ink: { bg: '#10243a', fg: '#eaf2ff', accent: '#64d2ff', muted: '#a8c0da' },
  sky: { bg: '#eef6ff', fg: '#0d2b45', accent: '#0ea5e9', muted: '#4a6b86' },
};

const newSlide = (layout: SlideLayout = 'bullets'): Slide => ({
  id: uid(), layout, title: '', body: '', bullets: [''], notes: '', image: '',
});

/** 16:9 slide, scaled to whatever box it is given. */
function SlideCanvas({ slide, theme, scale = 1, editable, onChange, session }: {
  slide: Slide;
  theme: DeckData['theme'];
  scale?: number;
  editable?: boolean;
  onChange?: (next: Slide) => void;
  session?: DocSession;
}) {
  const t = useModuleT();
  const palette = THEMES[theme] ?? THEMES.light;
  const field = (value: string, set: (v: string) => void, style: React.CSSProperties, placeholder: string) =>
    editable ? (
      <textarea value={value} placeholder={placeholder} onChange={e => set(e.target.value)}
        onFocus={() => session?.cursor(slide.id)}
        style={{ ...style, width: '100%', border: 'none', outline: 'none', resize: 'none', background: 'transparent', color: style.color ?? palette.fg, overflow: 'hidden', fontFamily: 'inherit' }} />
    ) : <div style={style}>{value}</div>;

  const titleStyle: React.CSSProperties = {
    fontSize: (slide.layout === 'title' ? 46 : 32) * scale, fontWeight: 800, lineHeight: 1.15,
    color: palette.fg, marginBottom: 14 * scale,
  };
  const bodyStyle: React.CSSProperties = { fontSize: 20 * scale, lineHeight: 1.5, color: palette.muted };

  const setBullet = (index: number, value: string) => {
    const bullets = [...slide.bullets];
    bullets[index] = value;
    onChange?.({ ...slide, bullets });
  };

  return (
    <div style={{
      background: palette.bg, color: palette.fg, width: '100%', aspectRatio: '16 / 9', borderRadius: 12 * scale,
      padding: 44 * scale, boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column',
      justifyContent: slide.layout === 'title' ? 'center' : 'flex-start', position: 'relative',
    }}>
      {slide.layout !== 'blank' && field(slide.title, v => onChange?.({ ...slide, title: v }), titleStyle, t('of_slide_title'))}
      {slide.layout === 'bullets' && (
        <ul style={{ margin: 0, paddingLeft: 26 * scale, display: 'flex', flexDirection: 'column', gap: 8 * scale }}>
          {slide.bullets.map((bullet, index) => (
            <li key={index} style={{ color: palette.muted }}>
              {editable ? (
                <input value={bullet} placeholder={t('of_slide_bullet')} onChange={e => setBullet(index, e.target.value)}
                  onFocus={() => session?.cursor(slide.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const bullets = [...slide.bullets];
                      bullets.splice(index + 1, 0, '');
                      onChange?.({ ...slide, bullets });
                    }
                    if (e.key === 'Backspace' && !bullet && slide.bullets.length > 1) {
                      e.preventDefault();
                      onChange?.({ ...slide, bullets: slide.bullets.filter((_, i) => i !== index) });
                    }
                  }}
                  style={{ ...bodyStyle, width: '100%', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'inherit' }} />
              ) : <span style={bodyStyle}>{bullet}</span>}
            </li>
          ))}
        </ul>
      )}
      {(slide.layout === 'text' || slide.layout === 'title' || slide.layout === 'blank') &&
        field(slide.body, v => onChange?.({ ...slide, body: v }), { ...bodyStyle, flex: 1 }, t('of_slide_body'))}
      {slide.layout === 'two' && (
        <div style={{ display: 'flex', gap: 24 * scale, flex: 1 }}>
          {field(slide.body, v => onChange?.({ ...slide, body: v }), { ...bodyStyle, flex: 1 }, t('of_slide_body'))}
          <div style={{ flex: 1 }}>
            {slide.image
              ? <img src={slide.image} alt="" style={{ width: '100%', borderRadius: 8 * scale }} />
              : editable && field(slide.image, v => onChange?.({ ...slide, image: v }), { fontSize: 13 * scale, color: palette.muted }, t('of_image_url'))}
          </div>
        </div>
      )}
      {slide.layout === 'image' && (
        slide.image
          ? <img src={slide.image} alt="" style={{ width: '100%', flex: 1, objectFit: 'contain' }} />
          : editable
            ? field(slide.image, v => onChange?.({ ...slide, image: v }), { fontSize: 14 * scale, color: palette.muted }, t('of_image_url'))
            : null
      )}
    </div>
  );
}

export function DeckEditor({ session }: { session: DocSession }) {
  const t = useModuleT();
  const deck = session.deck;
  const readOnly = !session.canEdit;
  const [current, setCurrent] = useState(0);
  const [present, setPresent] = useState(false);
  const [menu, setMenu] = useState<{ kind: 'layout' | 'theme'; x: number; y: number } | null>(null);

  useEffect(() => {
    if (deck.order.length || readOnly) return;
    session.commit([{ op: 'slide.put', slide: { ...newSlide('title'), title: session.title } }]);
  }, [deck.order.length, readOnly, session]);

  const slideId = deck.order[Math.min(current, deck.order.length - 1)];
  const slide = slideId ? deck.slides[slideId] : undefined;

  const add = (layout: SlideLayout = 'bullets') => {
    const next = newSlide(layout);
    session.commit([{ op: 'slide.put', slide: next, at: current + 1 }]);
    setCurrent(Math.min(deck.order.length, current + 1));
  };

  const duplicate = () => {
    if (!slide) return;
    session.commit([{ op: 'slide.put', slide: { ...slide, id: uid() }, at: current + 1 }]);
    setCurrent(current + 1);
  };

  const remove = () => {
    if (!slideId) return;
    session.commit([{ op: 'slide.del', id: slideId }]);
    setCurrent(Math.max(0, current - 1));
  };

  const moveSlide = (delta: number) => {
    if (!slideId) return;
    const order = [...deck.order];
    const to = Math.max(0, Math.min(order.length - 1, current + delta));
    order.splice(to, 0, ...order.splice(current, 1));
    session.commit([{ op: 'order', order }]);
    setCurrent(to);
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ width: 168, flexShrink: 0, borderRight: '1px solid var(--border-color)', overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {deck.order.map((id, index) => (
          <button key={id} type="button" onClick={() => setCurrent(index)}
            style={{ border: index === current ? '2px solid var(--accent-primary)' : '1px solid var(--border-color)', borderRadius: 9, padding: 0, overflow: 'hidden', cursor: 'pointer', background: 'transparent', position: 'relative' }}>
            <SlideCanvas slide={deck.slides[id]} theme={deck.theme} scale={0.2} />
            <span style={{ position: 'absolute', left: 4, bottom: 3, fontSize: 10, color: 'var(--text-tertiary)' }}>{index + 1}</span>
            {session.peersAt(id).slice(0, 2).map((p, i) => (
              <span key={p.channel} style={{ position: 'absolute', right: 3 + i * 14, top: 3 }}><Avatar user={p.user} size={13} ring /></span>
            ))}
          </button>
        ))}
        {!readOnly && (
          <button type="button" onClick={() => add()}
            style={{ border: '1px dashed var(--border-color)', borderRadius: 9, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', padding: '10px 0', fontSize: 12.5 }}>
            <Plus size={14} /> {t('of_slide_add')}
          </button>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
          <IconButton title={t('of_present')} onClick={() => setPresent(true)}><Play size={15} /></IconButton>
          {!readOnly && slide && (
            <>
              <IconButton title={t('of_layout')} onClick={e => setMenu({ kind: 'layout', x: e.clientX, y: e.clientY })}><LayoutTemplate size={15} /></IconButton>
              <IconButton title={t('of_theme')} onClick={e => setMenu({ kind: 'theme', x: e.clientX, y: e.clientY })}><Palette size={15} /></IconButton>
              <IconButton title={t('of_slide_copy')} onClick={duplicate}><Copy size={15} /></IconButton>
              <IconButton title={t('of_slide_up')} onClick={() => moveSlide(-1)}><ChevronLeft size={15} /></IconButton>
              <IconButton title={t('of_slide_down')} onClick={() => moveSlide(1)}><ChevronRight size={15} /></IconButton>
              <IconButton title={t('of_slide_remove')} onClick={remove}><Trash2 size={15} /></IconButton>
            </>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            {deck.order.length ? `${current + 1} / ${deck.order.length}` : ''}
          </span>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          {slide && (
            <>
              <div style={{ width: '100%', maxWidth: 820, boxShadow: 'var(--shadow-lg)', borderRadius: 12 }}>
                <SlideCanvas slide={slide} theme={deck.theme} editable={!readOnly} session={session}
                  onChange={next => session.type([{ op: 'slide.put', slide: next }])} />
              </div>
              <div style={{ width: '100%', maxWidth: 820 }}>
                <div style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>{t('of_notes')}</div>
                <textarea value={slide.notes} readOnly={readOnly} placeholder={t('of_notes_ph')}
                  onChange={e => session.type([{ op: 'slide.put', slide: { ...slide, notes: e.target.value } }])}
                  style={{ width: '100%', minHeight: 64, border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--bg-secondary)', color: 'var(--text-primary)', padding: 10, fontSize: 13.5, outline: 'none', resize: 'vertical' }} />
              </div>
            </>
          )}
        </div>
      </div>

      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.kind === 'layout'
            ? LAYOUTS.map(layout => (
              <MenuItem key={layout} label={t(`of_layout_${layout}`)}
                onClick={() => { if (slide) session.commit([{ op: 'slide.put', slide: { ...slide, layout } }]); setMenu(null); }} />
            ))
            : (Object.keys(THEMES) as DeckData['theme'][]).map(theme => (
              <MenuItem key={theme} label={t(`of_theme_${theme}`)}
                onClick={() => { session.commit([{ op: 'theme', theme }]); setMenu(null); }} />
            ))}
        </PopMenu>
      )}

      {present && <Present session={session} from={current} onClose={() => setPresent(false)} />}
    </div>
  );
}

function Present({ session, from, onClose }: { session: DocSession; from: number; onClose: () => void }) {
  const t = useModuleT();
  const deck = session.deck;
  const [index, setIndex] = useState(from);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) setIndex(i => Math.min(deck.order.length - 1, i + 1));
      if (['ArrowLeft', 'PageUp'].includes(e.key)) setIndex(i => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    box.current?.requestFullscreen?.().catch(() => { /* a plain overlay is fine */ });
    return () => {
      window.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => { /* already closed */ });
    };
  }, [deck.order.length, onClose]);

  const id = deck.order[index];
  return (
    <div ref={box} style={{ position: 'fixed', inset: 0, zIndex: 9000, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 'min(100vw, calc(100vh * 16 / 9))' }}>
        {id && <SlideCanvas slide={deck.slides[id]} theme={deck.theme} scale={1.6} />}
      </div>
      <div style={{ position: 'absolute', bottom: 14, right: 16, display: 'flex', alignItems: 'center', gap: 10, color: '#fff', opacity: 0.75 }}>
        <button type="button" aria-label={t('of_slide_up')} onClick={() => setIndex(i => Math.max(0, i - 1))}
          style={{ border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer' }}><ChevronLeft size={22} /></button>
        <span style={{ fontSize: 13 }}>{index + 1} / {deck.order.length}</span>
        <button type="button" aria-label={t('of_slide_down')} onClick={() => setIndex(i => Math.min(deck.order.length - 1, i + 1))}
          style={{ border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer' }}><ChevronRight size={22} /></button>
        <button type="button" aria-label={t('of_close')} onClick={onClose}
          style={{ border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer' }}><X size={20} /></button>
      </div>
    </div>
  );
}
