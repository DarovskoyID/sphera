import { useEffect, useMemo, useRef, useState } from 'react';
import { Bold, Eraser, Italic, Plus, Sigma } from 'lucide-react';
import { useModuleT } from '@sfera/sdk';
import { display, evaluate, formatNumber, isError, parseRef, ref as cellRef, colName, referenced, FUNC_NAMES } from './formula';
import type { DocSession } from './session';
import type { Cell, Op } from './types';
import { Avatar, IconButton } from './ui';

const ROW_H = 26;
const HEAD_W = 46;
const DEFAULT_W = 110;
// Only the rows on screen are in the DOM: a 5000-row sheet renders ~40 of them.
const OVERSCAN = 6;

export function SheetEditor({ session }: { session: DocSession }) {
  const t = useModuleT();
  const sheet = session.sheet;
  const readOnly = !session.canEdit;
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [active, setActive] = useState('A1');
  const [editing, setEditing] = useState<{ at: string; value: string } | null>(null);
  const [bar, setBar] = useState('');

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight || 600));
    observer.observe(el);
    setHeight(el.clientHeight || 600);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { setBar(sheet.cells[active]?.v ?? ''); }, [active, sheet.cells]);

  const widthOf = (col: number) => sheet.widths[String(col)] ?? DEFAULT_W;
  const cols = useMemo(() => Array.from({ length: sheet.cols }, (_, i) => i), [sheet.cols]);
  const first = Math.max(1, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(sheet.rows, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const rows = useMemo(() => {
    const out: number[] = [];
    for (let y = first; y <= last; y++) out.push(y);
    return out;
  }, [first, last]);
  const highlighted = useMemo(() => new Set(referenced(editing?.value ?? '')), [editing?.value]);

  const setCell = (at: string, value: string) => {
    const cell: Cell = { v: value, ...(sheet.cells[at]?.style ? { style: sheet.cells[at].style } : {}) };
    session.commit([value || cell.style ? { op: 'cell.set', ref: at, cell } : { op: 'cell.clear', ref: at }]);
  };

  const toggleStyle = (key: 'bold' | 'italic') => {
    const current = sheet.cells[active];
    const style = { ...(current?.style ?? {}) };
    style[key] = !style[key];
    session.commit([{ op: 'cell.set', ref: active, cell: { v: current?.v ?? '', style } }]);
  };

  const move = (at: string, dx: number, dy: number) => {
    const pos = parseRef(at);
    if (!pos) return at;
    const next = cellRef(Math.max(0, Math.min(sheet.cols - 1, pos.col + dx)), Math.max(1, Math.min(sheet.rows, pos.row + dy)));
    setActive(next);
    session.cursor(next);
    const pos2 = parseRef(next)!;
    const el = scroller.current;
    if (el) {
      const top = (pos2.row - 1) * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      if (top + ROW_H > el.scrollTop + el.clientHeight - ROW_H) el.scrollTop = top + 2 * ROW_H - el.clientHeight;
    }
    return next;
  };

  const commitEdit = (dy = 1) => {
    if (editing) setCell(editing.at, editing.value);
    setEditing(null);
    if (dy) move(editing?.at ?? active, 0, dy);
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const key = e.key;
    if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? session.redo() : session.undo(); return; }
    if (key === 'ArrowRight' || key === 'Tab') { e.preventDefault(); move(active, 1, 0); return; }
    if (key === 'ArrowLeft') { e.preventDefault(); move(active, -1, 0); return; }
    if (key === 'ArrowDown' || key === 'Enter') { e.preventDefault(); move(active, 0, 1); return; }
    if (key === 'ArrowUp') { e.preventDefault(); move(active, 0, -1); return; }
    if (readOnly) return;
    if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); setCell(active, ''); return; }
    if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setEditing({ at: active, value: key });
    } else if (key === 'F2') {
      e.preventDefault();
      setEditing({ at: active, value: sheet.cells[active]?.v ?? '' });
    }
  };

  const grid = cols.reduce((sum, col) => sum + widthOf(col), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontWeight: 700, fontSize: 13, minWidth: 54, color: 'var(--text-secondary)' }}>{active}</span>
        <Sigma size={15} color="var(--text-tertiary)" />
        <input value={bar} readOnly={readOnly} onChange={e => setBar(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { setCell(active, bar); move(active, 0, 1); }
            if (e.key === 'Escape') setBar(sheet.cells[active]?.v ?? '');
          }}
          placeholder={t('of_formula_ph')}
          style={{ flex: 1, minWidth: 160, border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-secondary)', color: 'var(--text-primary)', padding: '5px 9px', fontSize: 13.5, outline: 'none', fontFamily: bar.startsWith('=') ? 'ui-monospace, Consolas, monospace' : undefined }} />
        {!readOnly && (
          <>
            <IconButton title={t('of_bold')} active={!!sheet.cells[active]?.style?.bold} onClick={() => toggleStyle('bold')}><Bold size={15} /></IconButton>
            <IconButton title={t('of_italic')} active={!!sheet.cells[active]?.style?.italic} onClick={() => toggleStyle('italic')}><Italic size={15} /></IconButton>
            <IconButton title={t('of_clear')} onClick={() => setCell(active, '')}><Eraser size={15} /></IconButton>
            <IconButton title={t('of_add_rows')} onClick={() => session.commit([{ op: 'size', rows: sheet.rows + 50 }])}><Plus size={15} /></IconButton>
          </>
        )}
      </div>

      <div ref={scroller} tabIndex={0} onKeyDown={onGridKey} onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        style={{ flex: 1, overflow: 'auto', outline: 'none', background: 'var(--bg-primary)', position: 'relative' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 2, display: 'flex', width: grid + HEAD_W, background: 'var(--bg-tertiary)' }}>
          <div style={{ width: HEAD_W, flexShrink: 0, borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)' }} />
          {cols.map(col => (
            <div key={col} style={{ width: widthOf(col), flexShrink: 0, textAlign: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--text-tertiary)', padding: '4px 0', borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', position: 'relative' }}>
              {colName(col)}
              {!readOnly && (
                <span role="separator" aria-label={t('of_col_width')} onMouseDown={e => startResize(e, col, widthOf(col), session)}
                  style={{ position: 'absolute', right: -3, top: 0, bottom: 0, width: 6, cursor: 'col-resize' }} />
              )}
            </div>
          ))}
        </div>
        <div style={{ height: (sheet.rows) * ROW_H, position: 'relative', width: grid + HEAD_W }}>
          {rows.map(y => (
            <div key={y} style={{ position: 'absolute', top: (y - 1) * ROW_H, left: 0, display: 'flex', height: ROW_H }}>
              <div style={{ width: HEAD_W, flexShrink: 0, textAlign: 'center', fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: `${ROW_H}px`, background: 'var(--bg-tertiary)', borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', position: 'sticky', left: 0, zIndex: 1 }}>{y}</div>
              {cols.map(col => {
                const at = cellRef(col, y);
                const cell = sheet.cells[at];
                const isActive = at === active;
                const value = cell ? display(sheet.cells, at) : '';
                const numeric = typeof evaluate(sheet.cells, at) === 'number';
                const peers = session.peersAt(at);
                return (
                  <div key={col} onMouseDown={() => { setActive(at); setEditing(null); session.cursor(at); }}
                    onDoubleClick={() => !readOnly && setEditing({ at, value: cell?.v ?? '' })}
                    style={{
                      width: widthOf(col), flexShrink: 0, height: ROW_H, borderRight: '1px solid var(--border-color)',
                      borderBottom: '1px solid var(--border-color)', padding: '0 5px', fontSize: 13,
                      lineHeight: `${ROW_H - 1}px`, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                      textAlign: numeric ? 'right' : 'left', position: 'relative', cursor: 'cell',
                      background: isActive ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)'
                        : highlighted.has(at) ? 'color-mix(in srgb, #f59e0b 16%, transparent)' : 'transparent',
                      outline: isActive ? '2px solid var(--accent-primary)' : undefined, outlineOffset: -1,
                      color: isError(value) ? '#ef4444' : 'var(--text-primary)',
                      fontWeight: cell?.style?.bold ? 700 : 400,
                      fontStyle: cell?.style?.italic ? 'italic' : undefined,
                    }}>
                    {editing?.at === at ? (
                      <input autoFocus value={editing.value} onChange={e => setEditing({ at, value: e.target.value })}
                        onBlur={() => commitEdit(0)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitEdit(1); }
                          if (e.key === 'Tab') { e.preventDefault(); setCell(at, editing.value); setEditing(null); move(at, 1, 0); }
                          if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                        }}
                        style={{ position: 'absolute', inset: 0, border: 'none', outline: 'none', background: 'var(--bg-secondary)', color: 'var(--text-primary)', padding: '0 5px', fontSize: 13, fontFamily: editing.value.startsWith('=') ? 'ui-monospace, Consolas, monospace' : undefined }} />
                    ) : value}
                    {peers.length > 0 && !isActive && (
                      <span style={{ position: 'absolute', right: 1, top: 1 }}><Avatar user={peers[0].user} size={14} ring /></span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div style={{ padding: '4px 12px', borderTop: '1px solid var(--border-color)', fontSize: 11.5, color: 'var(--text-tertiary)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>{t('of_cells')}: {Object.keys(sheet.cells).length}</span>
        <span>{t('of_sum_hint').replace('{names}', FUNC_NAMES.slice(0, 8).join(', '))}</span>
        <span style={{ marginLeft: 'auto' }}>{t('of_selected')}: {selectionSummary(session, active)}</span>
      </div>
    </div>
  );
}

function selectionSummary(session: DocSession, at: string) {
  const value = evaluate(session.sheet.cells, at);
  return typeof value === 'number' ? formatNumber(value) : String(value || '—');
}

function startResize(e: React.MouseEvent, col: number, from: number, session: DocSession) {
  e.preventDefault();
  const startX = e.clientX;
  const onMove = (ev: MouseEvent) => {
    const w = Math.max(40, Math.min(600, Math.round(from + ev.clientX - startX)));
    session.type([{ op: 'width', col, w } as Op]);
  };
  const onUp = () => {
    session.flush();
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}
