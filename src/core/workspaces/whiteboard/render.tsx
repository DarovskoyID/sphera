import { memo } from 'react';
import { arrowHead, boxPath, endDirection, isBox, linePath, midpoint, penPath } from './geometry';
import type { BoxShape, Doc, LineShape, PenShape, Shape, Style } from './types';

/**
 * Colors "ink" and "paper" follow the app theme on screen (dark text on light
 * paper in the light theme and the other way round) and are fixed on export.
 */
export function color(value: string, exporting = false) {
  if (value === 'ink') return exporting ? '#1f2937' : 'var(--wb-ink)';
  if (value === 'paper') return exporting ? '#ffffff' : 'var(--wb-paper)';
  return value;
}

/** "ink" text on a concrete light or dark fill picks the readable color instead of following the theme. */
function inkOn(fill: string): string | null {
  const m = /^#([0-9a-f]{6})$/i.exec(fill);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#1f2937' : '#f9fafb';
}

const dashArray = (s: Style) => (s.dash === 'dashed' ? `${s.strokeWidth * 4} ${s.strokeWidth * 3}` : s.dash === 'dotted' ? `0 ${s.strokeWidth * 2.2}` : undefined);

function TextBlock({ x, y, w, h, text, style, exporting, placeholder, pad = 8 }: {
  x: number; y: number; w: number; h: number; text: string; style: Style; exporting: boolean; placeholder?: boolean; pad?: number;
}) {
  if (!text) return null;
  const justify = style.vAlign === 'top' ? 'flex-start' : style.vAlign === 'bottom' ? 'flex-end' : 'center';
  return (
    <foreignObject x={x} y={y} width={Math.max(w, 1)} height={Math.max(h, 1)} style={{ pointerEvents: 'none', overflow: 'visible' }}>
      <div
        // xmlns keeps the text when the SVG is exported as a standalone file.
        {...{ xmlns: 'http://www.w3.org/1999/xhtml' }}
        style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: justify, boxSizing: 'border-box',
          padding: pad, color: color(style.textColor, exporting), fontSize: style.fontSize, fontWeight: style.bold ? 700 : 400,
          textAlign: style.align, lineHeight: 1.3, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflow: 'hidden',
          fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif', opacity: placeholder ? 0.45 : 1,
        }}
      >
        {text}
      </div>
    </foreignObject>
  );
}

function BoxView({ s, exporting, editing }: { s: BoxShape; exporting: boolean; editing: boolean }) {
  const st = s.style;
  const common = {
    fill: color(st.fill, exporting), stroke: st.strokeWidth ? color(st.stroke, exporting) : 'none', strokeWidth: st.strokeWidth,
    strokeDasharray: dashArray(st), strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  };
  const text = editing ? '' : s.text;
  const textStyle = st.textColor === 'ink' && inkOn(st.fill) ? { ...st, textColor: inkOn(st.fill)! } : st;
  if (s.type === 'text') {
    return <g opacity={st.opacity}><TextBlock x={s.x} y={s.y} w={s.w} h={s.h} text={text} style={st} exporting={exporting} pad={2} /></g>;
  }
  if (s.type === 'note') {
    return (
      <g opacity={st.opacity}>
        <rect x={s.x + 3} y={s.y + 5} width={s.w} height={s.h} rx={4} fill="rgba(0,0,0,.18)" />
        <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={4} fill={color(st.fill, exporting)} />
        <path d={`M${s.x + s.w - 22},${s.y + s.h} L${s.x + s.w},${s.y + s.h - 22} L${s.x + s.w},${s.y + s.h} Z`} fill="rgba(0,0,0,.08)" />
        <TextBlock x={s.x} y={s.y} w={s.w} h={s.h} text={text} style={{ ...st, textColor: st.textColor === 'ink' ? '#1f2937' : st.textColor }} exporting={exporting} pad={12} />
      </g>
    );
  }
  if (s.type === 'frame') {
    return (
      <g opacity={st.opacity}>
        <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={10} {...common} fill={color(st.fill, exporting)} />
        <text x={s.x + 4} y={s.y - 8} fontSize={13} fontWeight={700} fill={color('ink', exporting)} opacity={0.7}
          style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>{s.text || 'Frame'}</text>
      </g>
    );
  }
  const d = boxPath(s);
  return (
    <g opacity={st.opacity}>
      {s.type === 'ellipse' ? (
        <ellipse cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={s.w / 2} ry={s.h / 2} {...common} />
      ) : d ? (
        <path d={d} {...common} />
      ) : (
        <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={Math.min(st.radius, s.w / 2, s.h / 2)} {...common} />
      )}
      <TextBlock
        x={s.type === 'diamond' || s.type === 'triangle' ? s.x + s.w * 0.15 : s.x}
        y={s.type === 'triangle' ? s.y + s.h * 0.35 : s.y}
        w={s.type === 'diamond' || s.type === 'triangle' ? s.w * 0.7 : s.w}
        h={s.type === 'triangle' ? s.h * 0.65 : s.h}
        text={text} style={textStyle} exporting={exporting}
      />
    </g>
  );
}

function LineView({ s, doc, exporting, editing }: { s: LineShape; doc: Doc; exporting: boolean; editing: boolean }) {
  const st = s.style;
  const stroke = color(st.stroke, exporting);
  const size = 4 + st.strokeWidth * 1.5;
  const heads = (['from', 'to'] as const).map(which => {
    const kind = which === 'to' ? s.arrowEnd : s.arrowStart;
    const { tip, angle } = endDirection(doc, s, which);
    return arrowHead(kind, tip, angle, size);
  });
  const mid = s.text && !editing ? midpoint(doc, s) : null;
  return (
    <g opacity={st.opacity}>
      <path d={linePath(doc, s)} fill="none" stroke={stroke} strokeWidth={st.strokeWidth} strokeDasharray={dashArray(st)} strokeLinecap="round" strokeLinejoin="round" />
      {heads.map((h, i) => h && (
        <path key={i} d={h.d} fill={h.filled ? stroke : 'none'} stroke={stroke} strokeWidth={st.strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {mid && (
        <>
          <rect x={mid.x - Math.min(160, s.text.length * st.fontSize * 0.32 + 10)} y={mid.y - st.fontSize * 0.75} width={Math.min(320, s.text.length * st.fontSize * 0.64 + 20)} height={st.fontSize * 1.5} rx={4}
            fill={color('paper', exporting)} />
          <text x={mid.x} y={mid.y} textAnchor="middle" dominantBaseline="central" fontSize={st.fontSize * 0.85} fill={color(st.textColor, exporting)}
            style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>{s.text}</text>
        </>
      )}
    </g>
  );
}

function PenView({ s, exporting }: { s: PenShape; exporting: boolean }) {
  return (
    <path d={penPath(s.points)} fill="none" stroke={color(s.style.stroke, exporting)} strokeWidth={s.style.strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" opacity={s.style.opacity} />
  );
}

export const ShapeView = memo(function ShapeView({ shape, doc, exporting = false, editing = false }: {
  shape: Shape; doc: Doc; exporting?: boolean; editing?: boolean;
}) {
  if (shape.type === 'line') return <LineView s={shape} doc={doc} exporting={exporting} editing={editing} />;
  if (shape.type === 'pen') return <PenView s={shape} exporting={exporting} />;
  return <BoxView s={shape} exporting={exporting} editing={editing} />;
}, (a, b) => a.shape === b.shape && a.editing === b.editing && a.exporting === b.exporting
  // Connectors move with the shapes they are attached to.
  && (a.shape.type !== 'line' || a.doc === b.doc));

export { isBox };
