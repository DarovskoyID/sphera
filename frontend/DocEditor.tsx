import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckSquare, ChevronDown, Code2, Heading1, Heading2, Heading3, Image as ImageIcon, List, ListOrdered,
  MessageSquarePlus, Minus, Pilcrow, Quote, Table as TableIcon, Trash2,
} from 'lucide-react';
import { useModuleT } from '@sfera/sdk';
import type { DocSession } from './session';
import { uid, type Block, type BlockType, type Op } from './types';
import { Avatar, IconButton, MenuItem, PopMenu } from './ui';

const TYPES: { type: BlockType; icon: React.ReactNode; key: string }[] = [
  { type: 'p', icon: <Pilcrow size={15} />, key: 'of_block_p' },
  { type: 'h1', icon: <Heading1 size={15} />, key: 'of_block_h1' },
  { type: 'h2', icon: <Heading2 size={15} />, key: 'of_block_h2' },
  { type: 'h3', icon: <Heading3 size={15} />, key: 'of_block_h3' },
  { type: 'ul', icon: <List size={15} />, key: 'of_block_ul' },
  { type: 'ol', icon: <ListOrdered size={15} />, key: 'of_block_ol' },
  { type: 'todo', icon: <CheckSquare size={15} />, key: 'of_block_todo' },
  { type: 'quote', icon: <Quote size={15} />, key: 'of_block_quote' },
  { type: 'code', icon: <Code2 size={15} />, key: 'of_block_code' },
  { type: 'divider', icon: <Minus size={15} />, key: 'of_block_divider' },
  { type: 'image', icon: <ImageIcon size={15} />, key: 'of_block_image' },
  { type: 'table', icon: <TableIcon size={15} />, key: 'of_block_table' },
];

/** Markdown shortcuts: typing "## " at the start of a line changes the block. */
const SHORTCUTS: [RegExp, BlockType][] = [
  [/^# $/, 'h1'], [/^## $/, 'h2'], [/^### $/, 'h3'],
  [/^[-*] $/, 'ul'], [/^1\. $/, 'ol'], [/^\[\] $/, 'todo'], [/^\[ \] $/, 'todo'],
  [/^> $/, 'quote'], [/^``` $/, 'code'], [/^--- $/, 'divider'],
];

const FONT: Record<string, React.CSSProperties> = {
  h1: { fontSize: 27, fontWeight: 800, lineHeight: 1.25 },
  h2: { fontSize: 21, fontWeight: 750, lineHeight: 1.3 },
  h3: { fontSize: 17.5, fontWeight: 700, lineHeight: 1.35 },
  quote: { fontStyle: 'italic', color: 'var(--text-secondary)' },
  code: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13.5, background: 'var(--bg-tertiary)', borderRadius: 8, padding: '10px 12px' },
};

function newBlock(type: BlockType = 'p', text = ''): Block {
  const block: Block = { id: uid(), type, text };
  if (type === 'table') block.rows = [['', ''], ['', '']];
  return block;
}

function AutoTextarea({ value, onChange, onKeyDown, onFocus, style, placeholder, readOnly, focusAt }: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
  style?: React.CSSProperties;
  placeholder?: string;
  readOnly?: boolean;
  focusAt?: 'start' | 'end' | null;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(resize, [value, resize]);
  useEffect(() => {
    if (!focusAt || !ref.current) return;
    const el = ref.current;
    el.focus();
    const at = focusAt === 'start' ? 0 : el.value.length;
    el.setSelectionRange(at, at);
  }, [focusAt]);
  return (
    <textarea ref={ref} value={value} readOnly={readOnly} placeholder={placeholder} rows={1}
      onChange={e => { onChange(e.target.value); resize(); }} onKeyDown={onKeyDown} onFocus={onFocus}
      style={{
        width: '100%', border: 'none', outline: 'none', resize: 'none', background: 'transparent',
        color: 'var(--text-primary)', font: 'inherit', fontSize: 15.5, lineHeight: 1.6, padding: 0,
        overflow: 'hidden', ...style,
      }} />
  );
}

export function DocEditor({ session, onComment }: { session: DocSession; onComment?: (anchor: string) => void }) {
  const t = useModuleT();
  const { blocks, order } = session.doc;
  const [focus, setFocus] = useState<{ id: string; at: 'start' | 'end' } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const readOnly = !session.canEdit;

  useEffect(() => {
    if (order.length || readOnly) return;
    session.commit([{ op: 'block.put', block: newBlock('h1', '') }, { op: 'block.put', block: newBlock('p', '') }]);
  }, [order.length, readOnly, session]);

  const put = (block: Block, coalesce = true) => {
    const op: Op = { op: 'block.put', block };
    if (coalesce) session.type([op]);
    else session.commit([op]);
  };

  const insertAfter = (id: string, type: BlockType = 'p', text = '') => {
    const block = newBlock(type, text);
    const at = order.indexOf(id) + 1;
    session.commit([{ op: 'block.put', block, at }]);
    setFocus({ id: block.id, at: 'start' });
    return block;
  };

  const remove = (id: string) => {
    const index = order.indexOf(id);
    session.commit([{ op: 'block.del', id }]);
    const prev = order[index - 1];
    if (prev) setFocus({ id: prev, at: 'end' });
  };

  const onKey = (block: Block) => (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el.selectionStart === el.value.length;
    if (e.key === 'Enter' && !e.shiftKey && block.type !== 'code') {
      e.preventDefault();
      session.flush();
      const tail = el.value.slice(el.selectionStart);
      if (tail) put({ ...block, text: el.value.slice(0, el.selectionStart) }, false);
      // A list keeps the list going; an empty list item drops back to a paragraph.
      const listish = block.type === 'ul' || block.type === 'ol' || block.type === 'todo';
      if (listish && !el.value.trim()) {
        put({ ...block, type: 'p' }, false);
        return;
      }
      insertAfter(block.id, listish ? block.type : 'p', tail);
      return;
    }
    if (e.key === 'Backspace' && atStart) {
      const index = order.indexOf(block.id);
      if (block.type !== 'p') { e.preventDefault(); put({ ...block, type: 'p' }, false); return; }
      if (index <= 0) return;
      e.preventDefault();
      session.flush();
      const prevId = order[index - 1];
      const prev = blocks[prevId];
      if (prev && prev.type !== 'divider' && prev.type !== 'table') {
        session.commit([{ op: 'block.put', block: { ...prev, text: prev.text + el.value } }, { op: 'block.del', id: block.id }]);
        setFocus({ id: prevId, at: 'end' });
      } else {
        remove(block.id);
      }
      return;
    }
    if (e.key === 'ArrowUp' && atStart) {
      const prev = order[order.indexOf(block.id) - 1];
      if (prev) { e.preventDefault(); setFocus({ id: prev, at: 'end' }); }
    }
    if (e.key === 'ArrowDown' && atEnd) {
      const next = order[order.indexOf(block.id) + 1];
      if (next) { e.preventDefault(); setFocus({ id: next, at: 'start' }); }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? session.redo() : session.undo();
    }
  };

  const onText = (block: Block) => (value: string) => {
    for (const [pattern, type] of SHORTCUTS) {
      if (pattern.test(value)) {
        session.flush();
        put({ ...block, type, text: '' }, false);
        return;
      }
    }
    put({ ...block, text: value });
  };

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '8px 20px 50vh' }}>
      {order.map(id => {
        const block = blocks[id];
        if (!block) return null;
        const peers = session.peersAt(id);
        const marker = block.type === 'ul' ? '•' : block.type === 'ol' ? `${order.filter(x => blocks[x]?.type === 'ol' && order.indexOf(x) <= order.indexOf(id)).length}.` : '';
        return (
          <div key={id} data-block={id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '2px 0', position: 'relative' }}>
            {!readOnly && (
              <button type="button" title={t('of_block_menu')} aria-label={t('of_block_menu')}
                onClick={e => setMenu({ id, x: e.clientX, y: e.clientY })}
                style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', padding: '4px 0', opacity: 0.55, flexShrink: 0 }}>
                <ChevronDown size={14} />
              </button>
            )}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 8, alignItems: 'flex-start', borderLeft: block.type === 'quote' ? '3px solid var(--border-color)' : undefined, paddingLeft: block.type === 'quote' ? 12 : 0 }}>
              {block.type === 'todo' && (
                <input type="checkbox" checked={!!block.done} disabled={readOnly} style={{ marginTop: 6 }}
                  onChange={e => put({ ...block, done: e.target.checked }, false)} />
              )}
              {marker && <span style={{ color: 'var(--text-tertiary)', fontSize: 15.5, lineHeight: 1.6, minWidth: 16 }}>{marker}</span>}
              {block.type === 'divider' ? (
                <hr style={{ flex: 1, border: 'none', borderTop: '1px solid var(--border-color)', margin: '12px 0' }} />
              ) : block.type === 'image' ? (
                <div style={{ flex: 1 }}>
                  {block.url ? <img src={block.url} alt={block.alt ?? ''} style={{ maxWidth: '100%', borderRadius: 10 }} /> : null}
                  <AutoTextarea value={block.url ?? ''} readOnly={readOnly} placeholder={t('of_image_url')}
                    onChange={v => put({ ...block, url: v })} onFocus={() => session.cursor(id)}
                    style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }} />
                </div>
              ) : block.type === 'table' ? (
                <TableBlock block={block} readOnly={readOnly} onChange={rows => put({ ...block, rows })} />
              ) : (
                <AutoTextarea value={block.text} readOnly={readOnly}
                  placeholder={order[0] === id ? t('of_doc_placeholder') : ''}
                  onChange={onText(block)} onKeyDown={onKey(block)}
                  onFocus={() => { setFocus(null); session.cursor(id); }}
                  focusAt={focus?.id === id ? focus.at : null}
                  style={{
                    ...FONT[block.type], textDecoration: block.type === 'todo' && block.done ? 'line-through' : undefined,
                    color: block.type === 'todo' && block.done ? 'var(--text-tertiary)' : undefined,
                  }} />
              )}
              {peers.length > 0 && (
                <span style={{ display: 'flex', gap: 2, marginTop: 4, flexShrink: 0 }}>
                  {peers.map(p => <Avatar key={p.channel} user={p.user} size={18} ring />)}
                </span>
              )}
              {onComment && (
                <IconButton title={t('of_comment_add')} onClick={() => onComment(id)}><MessageSquarePlus size={14} /></IconButton>
              )}
            </div>
          </div>
        );
      })}
      {!readOnly && (
        <button type="button" onClick={() => insertAfter(order[order.length - 1] ?? '')}
          style={{ marginTop: 10, border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 13.5, padding: '6px 0' }}>
          + {t('of_block_add')}
        </button>
      )}
      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {TYPES.map(item => (
            <MenuItem key={item.type} icon={item.icon} label={t(item.key)}
              onClick={() => {
                const block = blocks[menu.id];
                if (block) session.commit([{ op: 'block.put', block: { ...newBlock(item.type, block.text), id: block.id } }]);
                setMenu(null);
              }} />
          ))}
          <MenuItem icon={<Trash2 size={15} />} label={t('of_block_remove')} danger
            onClick={() => { remove(menu.id); setMenu(null); }} />
        </PopMenu>
      )}
    </div>
  );
}

function TableBlock({ block, readOnly, onChange }: { block: Block; readOnly: boolean; onChange: (rows: string[][]) => void }) {
  const t = useModuleT();
  const rows = block.rows ?? [['', '']];
  const set = (y: number, x: number, value: string) => {
    const next = rows.map(row => [...row]);
    next[y][x] = value;
    onChange(next);
  };
  return (
    <div style={{ flex: 1, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {rows.map((row, y) => (
            <tr key={y}>
              {row.map((cell, x) => (
                <td key={x} style={{ border: '1px solid var(--border-color)', padding: 0 }}>
                  <input value={cell} readOnly={readOnly} onChange={e => set(y, x, e.target.value)}
                    style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '6px 8px', fontSize: 13.5, fontWeight: y === 0 ? 700 : 400 }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button type="button" onClick={() => onChange([...rows, rows[0].map(() => '')])}
            style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12.5 }}>+ {t('of_table_row')}</button>
          <button type="button" onClick={() => onChange(rows.map(row => [...row, '']))}
            style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12.5 }}>+ {t('of_table_col')}</button>
        </div>
      )}
    </div>
  );
}
