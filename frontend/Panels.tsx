import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, Bold, Circle, Cloud, Copy, Cylinder, Diamond, Frame, Grid3x3,
  Hand, Hexagon, Lock, Unlock, Maximize, Minus, MousePointer2, MoveRight, Pencil, Plus, Redo2, Square, StickyNote, Trash2, Triangle,
  Type, Undo2, Spline, Shapes, ChevronDown,
} from 'lucide-react';
import { useModuleT } from '@sfera/sdk';
import type { BoardSession } from './session';
import { FILLS, NOTE_FILLS, STROKES, type LineShape, type Shape, type Style, type Tool } from './types';
import { isBox } from './geometry';

const floating: CSSProperties = {
  position: 'absolute', zIndex: 20, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
  borderRadius: 12, boxShadow: 'var(--shadow-md)', display: 'flex', alignItems: 'center', gap: 2, padding: 4,
};

function ToolButton({ active, title, onClick, children, disabled, style }: {
  active?: boolean; title: string; onClick: () => void; children: ReactNode; disabled?: boolean; style?: CSSProperties;
}) {
  return (
    <button
      type="button" title={title} aria-label={title} aria-pressed={active} disabled={disabled} onClick={onClick}
      style={{
        width: 36, height: 36, borderRadius: 8, border: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, flexShrink: 0,
        background: active ? 'var(--accent-primary)' : 'transparent', color: active ? '#fff' : 'var(--text-secondary)', ...style,
      }}
      onMouseEnter={e => { if (!active && !disabled) e.currentTarget.style.background = 'var(--hover-bg)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

const SHAPE_TOOLS: { tool: Tool; icon: ReactNode; key: string; label: string }[] = [
  { tool: 'rect', icon: <Square size={17} />, key: 'R', label: 'wb_tool_rect' },
  { tool: 'ellipse', icon: <Circle size={17} />, key: 'O', label: 'wb_tool_ellipse' },
  { tool: 'diamond', icon: <Diamond size={17} />, key: 'D', label: 'wb_tool_diamond' },
  { tool: 'triangle', icon: <Triangle size={17} />, key: '', label: 'wb_tool_triangle' },
  { tool: 'hexagon', icon: <Hexagon size={17} />, key: '', label: 'wb_tool_hexagon' },
  { tool: 'cylinder', icon: <Cylinder size={17} />, key: '', label: 'wb_tool_cylinder' },
  { tool: 'cloud', icon: <Cloud size={17} />, key: '', label: 'wb_tool_cloud' },
];

export function Toolbar({ tool, setTool, lock, setLock, readOnly, mobile }: {
  tool: Tool; setTool: (t: Tool) => void; lock: boolean; setLock: (v: boolean) => void; readOnly: boolean; mobile: boolean;
}) {
  const t = useModuleT();
  const [shapesOpen, setShapesOpen] = useState(false);
  const [lastShape, setLastShape] = useState<Tool>('rect');
  const shapeTool = SHAPE_TOOLS.find(s => s.tool === (SHAPE_TOOLS.some(x => x.tool === tool) ? tool : lastShape))!;
  const tip = (label: string, key: string) => `${t(label)}${key ? ` (${key})` : ''}`;
  const pos: CSSProperties = mobile
    ? { left: '50%', bottom: 12, transform: 'translateX(-50%)', maxWidth: 'calc(100% - 24px)', overflowX: 'auto' }
    : { left: '50%', top: 12, transform: 'translateX(-50%)' };

  return (
    <div role="toolbar" aria-label={t('wb_tools')} style={{ ...floating, ...pos }}>
      <ToolButton title={tip('wb_tool_select', 'V')} active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={17} /></ToolButton>
      <ToolButton title={tip('wb_tool_hand', 'H / Space')} active={tool === 'hand'} onClick={() => setTool('hand')}><Hand size={17} /></ToolButton>
      {!readOnly && (
        <>
          <div style={{ width: 1, height: 22, background: 'var(--border-color)', margin: '0 4px' }} />
          <div style={{ position: 'relative', display: 'flex' }}>
            <ToolButton title={tip(shapeTool.label, shapeTool.key)} active={SHAPE_TOOLS.some(s => s.tool === tool)} onClick={() => setTool(shapeTool.tool)}>{shapeTool.icon}</ToolButton>
            <button type="button" aria-label={t('wb_more_shapes')} title={t('wb_more_shapes')} onClick={() => setShapesOpen(v => !v)}
              style={{ width: 14, border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0 }}>
              <ChevronDown size={12} />
            </button>
            {shapesOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 21 }} onClick={() => setShapesOpen(false)} />
                <div style={{ ...floating, position: 'absolute', zIndex: 22, [mobile ? 'bottom' : 'top']: 44, left: 0, display: 'grid', gridTemplateColumns: 'repeat(4, 36px)' }}>
                  {SHAPE_TOOLS.map(s => (
                    <ToolButton key={s.tool} title={tip(s.label, s.key)} active={tool === s.tool} onClick={() => { setTool(s.tool); setLastShape(s.tool); setShapesOpen(false); }}>{s.icon}</ToolButton>
                  ))}
                </div>
              </>
            )}
          </div>
          <ToolButton title={tip('wb_tool_note', 'N')} active={tool === 'note'} onClick={() => setTool('note')}><StickyNote size={17} /></ToolButton>
          <ToolButton title={tip('wb_tool_text', 'T')} active={tool === 'text'} onClick={() => setTool('text')}><Type size={17} /></ToolButton>
          <ToolButton title={tip('wb_tool_line', 'L')} active={tool === 'line'} onClick={() => setTool('line')}><MoveRight size={17} /></ToolButton>
          <ToolButton title={tip('wb_tool_pen', 'P')} active={tool === 'pen'} onClick={() => setTool('pen')}><Pencil size={17} /></ToolButton>
          <ToolButton title={tip('wb_tool_frame', 'F')} active={tool === 'frame'} onClick={() => setTool('frame')}><Frame size={17} /></ToolButton>
          <div style={{ width: 1, height: 22, background: 'var(--border-color)', margin: '0 4px' }} />
          <ToolButton title={t('wb_tool_lock')} active={lock} onClick={() => setLock(!lock)} style={{ width: 30 }}>
            {lock ? <Lock size={14} /> : <Unlock size={14} />}
          </ToolButton>
        </>
      )}
    </div>
  );
}

export function ZoomBar({ zoom, setZoom, fit, grid, setGrid, session, readOnly, mobile }: {
  zoom: number; setZoom: (z: number) => void; fit: () => void; grid: boolean; setGrid: (v: boolean) => void;
  session: BoardSession; readOnly: boolean; mobile: boolean;
}) {
  const t = useModuleT();
  useSyncExternalStore(session.subscribe, session.snapshot);
  return (
    <div style={{ ...floating, left: 12, [mobile ? 'top' : 'bottom']: 12 }}>
      {!readOnly && (
        <>
          <ToolButton title={`${t('wb_undo')} (Ctrl+Z)`} disabled={!session.canUndo} onClick={() => session.undo()}><Undo2 size={16} /></ToolButton>
          <ToolButton title={`${t('wb_redo')} (Ctrl+Shift+Z)`} disabled={!session.canRedo} onClick={() => session.redo()}><Redo2 size={16} /></ToolButton>
          <div style={{ width: 1, height: 22, background: 'var(--border-color)', margin: '0 2px' }} />
        </>
      )}
      <ToolButton title={t('wb_zoom_out')} onClick={() => setZoom(zoom / 1.25)}><Minus size={16} /></ToolButton>
      <button type="button" title={t('wb_zoom_reset')} onClick={() => setZoom(1)}
        style={{ minWidth: 48, height: 36, border: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
        {Math.round(zoom * 100)}%
      </button>
      <ToolButton title={t('wb_zoom_in')} onClick={() => setZoom(zoom * 1.25)}><Plus size={16} /></ToolButton>
      <ToolButton title={`${t('wb_fit')} (Shift+1)`} onClick={fit}><Maximize size={15} /></ToolButton>
      {!mobile && <ToolButton title={t('wb_grid')} active={grid} onClick={() => setGrid(!grid)}><Grid3x3 size={15} /></ToolButton>}
    </div>
  );
}

function Swatches({ colors, value, onPick, label }: { colors: string[]; value: string; onPick: (c: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 22px)', gap: 5 }}>
      {colors.map(c => {
        const shown = c === 'ink' ? 'var(--wb-ink)' : c === 'paper' ? 'var(--wb-paper)' : c;
        return (
          <button key={c} type="button" role="radio" aria-checked={value === c} title={c} onClick={() => onPick(c)} style={{
            width: 22, height: 22, borderRadius: 6, cursor: 'pointer', padding: 0,
            background: c === 'transparent' ? 'repeating-conic-gradient(#cbd5e1 0 25%, #fff 0 50%) 50% / 8px 8px' : shown,
            border: value === c ? '2px solid var(--accent-primary)' : '1px solid var(--border-color)',
            boxShadow: value === c ? '0 0 0 2px var(--bg-secondary) inset' : 'none',
          }} />
        );
      })}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T | undefined; options: { v: T; label: ReactNode; title: string }[]; onChange: (v: T) => void }) {
  return (
    <div style={{ display: 'inline-flex', background: 'var(--bg-tertiary)', borderRadius: 8, padding: 2, gap: 2, flexWrap: 'wrap' }}>
      {options.map(o => (
        <button key={String(o.v)} type="button" title={o.title} aria-label={o.title} aria-pressed={value === o.v} onClick={() => onChange(o.v)} style={{
          minWidth: 30, height: 28, padding: '0 6px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: value === o.v ? 'var(--bg-primary)' : 'transparent', color: value === o.v ? 'var(--accent-primary)' : 'var(--text-secondary)',
          boxShadow: value === o.v ? 'var(--shadow-sm)' : 'none',
        }}>{o.label}</button>
      ))}
    </div>
  );
}

const common = <K extends keyof Style>(shapes: Shape[], key: K): Style[K] | undefined => {
  const v = shapes[0]?.style[key];
  return shapes.every(s => s.style[key] === v) ? v : undefined;
};

export function PropertiesPanel({ shapes, mobile, update, onDelete, onDuplicate, onReorder, onEditText }: {
  shapes: Shape[];
  mobile: boolean;
  update: (patch: (s: Shape) => Shape | null) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onReorder: (w: 'front' | 'back' | 'forward' | 'backward') => void;
  onEditText: () => void;
}) {
  const t = useModuleT();
  const [collapsed, setCollapsed] = useState(mobile);
  const style = <K extends keyof Style>(key: K, value: Style[K]) => update(s => ({ ...s, style: { ...s.style, [key]: value } }) as Shape);
  const boxes = shapes.filter(isBox);
  const lines = shapes.filter((s): s is LineShape => s.type === 'line');
  const hasText = shapes.some(s => s.type !== 'pen');
  const hasFill = boxes.some(b => b.type !== 'text');
  const onlyNotes = boxes.length > 0 && boxes.every(b => b.type === 'note') && boxes.length === shapes.length;
  const locked = shapes.every(s => s.locked);
  const line = <K extends keyof LineShape>(key: K, value: LineShape[K]) => update(s => (s.type === 'line' ? { ...s, [key]: value } : null));

  const pos: CSSProperties = mobile
    ? { left: 8, right: 8, bottom: 64, maxHeight: collapsed ? 52 : '45vh' }
    : { right: 12, top: 64, width: 232, maxHeight: 'calc(100% - 140px)' };

  return (
    <aside aria-label={t('wb_properties')} style={{ ...floating, ...pos, flexDirection: 'column', alignItems: 'stretch', padding: 12, overflowY: 'auto', gap: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: collapsed ? 0 : 10 }}>
        {mobile && (
          <button type="button" onClick={() => setCollapsed(v => !v)} style={{ flex: 1, textAlign: 'left', border: 'none', background: 'transparent', color: 'var(--text-primary)', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <Shapes size={15} /> {t('wb_properties')} <ChevronDown size={14} style={{ transform: collapsed ? 'rotate(180deg)' : 'none' }} />
          </button>
        )}
        {!mobile && <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: 'var(--text-secondary)' }}>{shapes.length > 1 ? t('wb_selected').replace('{n}', String(shapes.length)) : t(`wb_kind_${shapes[0].type}`)}</span>}
        <ToolButton title={`${t('wb_duplicate')} (Ctrl+D)`} onClick={onDuplicate} style={{ width: 30, height: 30 }}><Copy size={14} /></ToolButton>
        <ToolButton title={locked ? t('wb_unlock') : t('wb_lock')} active={locked} onClick={() => update(s => ({ ...s, locked: !locked }))} style={{ width: 30, height: 30 }}>{locked ? <Lock size={14} /> : <Unlock size={14} />}</ToolButton>
        <ToolButton title={`${t('wb_delete')} (Del)`} onClick={onDelete} style={{ width: 30, height: 30, color: '#ef4444' }}><Trash2 size={14} /></ToolButton>
      </div>
      {!collapsed && (
        <>
          {hasFill && (
            <Row label={t('wb_fill')}>
              <Swatches label={t('wb_fill')} colors={onlyNotes ? NOTE_FILLS : ['paper', ...FILLS]} value={common(shapes, 'fill') ?? ''} onPick={c => style('fill', c)} />
            </Row>
          )}
          {!onlyNotes && (
            <Row label={t('wb_stroke')}>
              <Swatches label={t('wb_stroke')} colors={['ink', ...STROKES]} value={common(shapes, 'stroke') ?? ''} onPick={c => style('stroke', c)} />
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <Seg value={common(shapes, 'strokeWidth')} onChange={v => style('strokeWidth', v)} options={[0, 1, 2, 4, 6].map(v => ({ v, title: `${v}px`, label: v === 0 ? '∅' : <span style={{ width: 14, height: Math.max(1, v), background: 'currentColor', borderRadius: 2 }} /> }))} />
                <Seg value={common(shapes, 'dash')} onChange={v => style('dash', v)} options={[
                  { v: 'solid' as const, title: t('wb_solid'), label: '—' },
                  { v: 'dashed' as const, title: t('wb_dashed'), label: '- -' },
                  { v: 'dotted' as const, title: t('wb_dotted'), label: '···' },
                ]} />
              </div>
            </Row>
          )}
          {lines.length > 0 && (
            <Row label={t('wb_connector')}>
              <Seg value={lines.every(l => l.route === lines[0].route) ? lines[0].route : undefined} onChange={v => line('route', v)} options={[
                { v: 'straight' as const, title: t('wb_route_straight'), label: <MoveRight size={14} /> },
                { v: 'orthogonal' as const, title: t('wb_route_orthogonal'), label: <span style={{ fontSize: 14 }}>⅃</span> },
                { v: 'curved' as const, title: t('wb_route_curved'), label: <Spline size={14} /> },
              ]} />
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                {(['arrowStart', 'arrowEnd'] as const).map(k => (
                  <select key={k} aria-label={t(`wb_${k}`)} title={t(`wb_${k}`)} value={lines.every(l => l[k] === lines[0][k]) ? lines[0][k] : ''}
                    onChange={e => line(k, e.target.value as LineShape['arrowEnd'])}
                    style={{ flex: 1, padding: '5px 4px', borderRadius: 7, border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: 12 }}>
                    <option value="none">{k === 'arrowStart' ? '○ ' : ''}{t('wb_arrow_none')}</option>
                    <option value="arrow">{t('wb_arrow_arrow')}</option>
                    <option value="triangle">{t('wb_arrow_triangle')}</option>
                    <option value="diamond">{t('wb_arrow_diamond')}</option>
                    <option value="circle">{t('wb_arrow_circle')}</option>
                  </select>
                ))}
              </div>
            </Row>
          )}
          {hasText && (
            <Row label={t('wb_text')}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Seg value={common(shapes, 'fontSize')} onChange={v => style('fontSize', v)} options={[12, 16, 20, 28, 40].map(v => ({ v, title: `${v}px`, label: ({ 12: 'S', 16: 'M', 20: 'L', 28: 'XL', 40: '2X' } as Record<number, string>)[v] }))} />
                <ToolButton title={t('wb_bold')} active={common(shapes, 'bold') === true} onClick={() => style('bold', !(common(shapes, 'bold') === true))} style={{ width: 30, height: 30 }}><Bold size={14} /></ToolButton>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <Seg value={common(shapes, 'align')} onChange={v => style('align', v)} options={[
                  { v: 'left' as const, title: t('wb_align_left'), label: <AlignLeft size={14} /> },
                  { v: 'center' as const, title: t('wb_align_center'), label: <AlignCenter size={14} /> },
                  { v: 'right' as const, title: t('wb_align_right'), label: <AlignRight size={14} /> },
                ]} />
                <Seg value={common(shapes, 'vAlign')} onChange={v => style('vAlign', v)} options={[
                  { v: 'top' as const, title: t('wb_valign_top'), label: <ArrowUpToLine size={14} /> },
                  { v: 'middle' as const, title: t('wb_valign_middle'), label: '≡' },
                  { v: 'bottom' as const, title: t('wb_valign_bottom'), label: <ArrowDownToLine size={14} /> },
                ]} />
              </div>
              <Swatches label={t('wb_text_color')} colors={['ink', ...STROKES]} value={common(shapes, 'textColor') ?? ''} onPick={c => style('textColor', c)} />
              {shapes.length === 1 && (
                <button type="button" onClick={onEditText} style={{ marginTop: 8, width: '100%', padding: '6px 0', borderRadius: 7, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12.5, cursor: 'pointer' }}>
                  {t('wb_edit_text')} (Enter)
                </button>
              )}
            </Row>
          )}
          {boxes.some(b => b.type === 'rect') && (
            <Row label={t('wb_radius')}>
              <input type="range" min={0} max={40} value={common(shapes, 'radius') ?? 8} onChange={e => style('radius', Number(e.target.value))} style={{ width: '100%' }} />
            </Row>
          )}
          <Row label={t('wb_opacity')}>
            <input type="range" min={10} max={100} step={5} value={Math.round((common(shapes, 'opacity') ?? 1) * 100)} onChange={e => style('opacity', Number(e.target.value) / 100)} style={{ width: '100%' }} aria-label={t('wb_opacity')} />
          </Row>
          <Row label={t('wb_layer')}>
            <Seg value={undefined as string | undefined} onChange={v => onReorder(v as 'front')} options={[
              { v: 'back', title: `${t('wb_to_back')} (Alt+[)`, label: '⤓' },
              { v: 'backward', title: `${t('wb_backward')} ([)`, label: '↓' },
              { v: 'forward', title: `${t('wb_forward')} (])`, label: '↑' },
              { v: 'front', title: `${t('wb_to_front')} (Alt+])`, label: '⤒' },
            ]} />
          </Row>
        </>
      )}
    </aside>
  );
}
