// Нодовый редактор ботов — «Инструменты от разработчика».
//
// Открывается по ключу бота (тому, что выдал Сфероник): ключ доказывает, что
// редактируется именно свой бот, и одновременно выбирает бота из списка.
//
// Одна и та же раскладка работает мышью и пальцем: узлы таскаются pointer-
// событиями, холст панорамируется перетаскиванием пустого места, соединения
// собираются в два касания (порт → узел), а панели превращаются в нижние
// шторки на узком экране.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot as BotIcon, Check, Copy, Download, Key, Loader2, Plus, Save, Trash2, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import type { BotAccount } from '../types';
import type { BotEdge, BotGraph, BotNode, BotNodeType } from '../utils/botFlow';
import { EMPTY_GRAPH, NODE_SPECS, graphCommands, specFor, validateGraph } from '../utils/botFlow';
import type { TargetLanguage } from '../utils/botCodegen';
import { generateProject } from '../utils/botCodegen';
import { createZip, downloadBlob } from '../utils/zip';
import { loadFlow, saveFlow, unlockBot } from '../utils/botsApi';

const NODE_WIDTH = 190;
const NODE_HEIGHT = 92;
const GRID = 20;

const uid = () => Math.random().toString(36).slice(2, 10);

/** Phone-sized layout: canvas on top, inspector as a bottom sheet. */
const useIsNarrow = () => {
  const query = '(max-width: 859px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return narrow;
};

interface Props {
  onClose: () => void;
}

export const BotStudio: React.FC<Props> = ({ onClose }) => {
  const { authToken, currentServerIP } = useApp();
  const tr = useTranslation();
  // Same lightweight bilingual fallback the rest of the newer screens use.
  const isRu = tr('explore_title') === 'Исследовать Сферу';
  const t = useCallback((ru: string, en: string) => (isRu ? ru : en), [isRu]);
  const ctx = useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
  const narrow = useIsNarrow();

  const [bot, setBot] = useState<BotAccount | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState('');

  const [graph, setGraph] = useState<BotGraph>(EMPTY_GRAPH);
  const [selected, setSelected] = useState<string | null>(null);
  const [pendingPort, setPendingPort] = useState<{ node: string; port: 'out' | 'then' | 'else' } | null>(null);
  const [palette, setPalette] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [language, setLanguage] = useState<TargetLanguage>('python');

  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ kind: 'node' | 'canvas'; id?: string; startX: number; startY: number; originX: number; originY: number } | null>(null);

  // ── unlocking ───────────────────────────────────────────────────────────
  const unlock = useCallback(async () => {
    const token = keyInput.trim();
    if (!token) return;
    setUnlocking(true);
    setError('');
    try {
      const account = await unlockBot(ctx, token);
      setBot(account);
      const saved = await loadFlow(ctx, account.id);
      const loaded = saved.graph as Partial<BotGraph> | null;
      setGraph(loaded && Array.isArray(loaded.nodes)
        ? { nodes: loaded.nodes as BotNode[], edges: (loaded.edges as BotEdge[]) || [] }
        : EMPTY_GRAPH);
    } catch (e) {
      setError(
        (e as Error).message === 'invalid key'
          ? t('Ключ не подходит. Он должен принадлежать вашему боту — возьмите его у Сфероника.',
               'That key does not fit. It must belong to a bot you own — get it from Sferonik.')
          : t('Не удалось открыть редактор. Проверьте соединение и ключ.',
               'Could not open the editor. Check the connection and the key.'),
      );
    } finally {
      setUnlocking(false);
    }
  }, [ctx, keyInput]);

  // ── graph editing ───────────────────────────────────────────────────────
  const addNode = useCallback((type: BotNodeType) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const cx = ((rect ? rect.width / 2 : 300) - view.x) / view.scale - NODE_WIDTH / 2;
    const cy = ((rect ? rect.height / 2 : 220) - view.y) / view.scale - NODE_HEIGHT / 2;
    const id = uid();
    setGraph(g => {
      // Every node is placed at the centre of the view, so without this they
      // would stack exactly on top of each other and look like one node.
      let x = Math.round(cx / GRID) * GRID;
      let y = Math.round(cy / GRID) * GRID;
      while (g.nodes.some(n => Math.abs(n.x - x) < NODE_WIDTH && Math.abs(n.y - y) < NODE_HEIGHT)) {
        x += GRID * 2;
        y += GRID * 2;
      }
      return { ...g, nodes: [...g.nodes, { id, type, x, y, data: {} }] };
    });
    setSelected(id);
    setPalette(false);
  }, [view]);

  const removeNode = useCallback((id: string) => {
    setGraph(g => ({
      nodes: g.nodes.filter(n => n.id !== id),
      edges: g.edges.filter(e => e.from !== id && e.to !== id),
    }));
    setSelected(s => (s === id ? null : s));
  }, []);

  const updateData = useCallback((id: string, key: string, value: string) => {
    setGraph(g => ({
      ...g,
      nodes: g.nodes.map(n => (n.id === id ? { ...n, data: { ...n.data, [key]: value } } : n)),
    }));
  }, []);

  const connect = useCallback((to: string) => {
    setPendingPort(port => {
      if (!port || port.node === to) return null;
      setGraph(g => ({
        ...g,
        edges: [
          // One edge per output port keeps the flow unambiguous.
          ...g.edges.filter(e => !(e.from === port.node && e.port === port.port)),
          { id: uid(), from: port.node, port: port.port, to },
        ],
      }));
      return null;
    });
  }, []);

  const disconnect = useCallback((edgeId: string) => {
    setGraph(g => ({ ...g, edges: g.edges.filter(e => e.id !== edgeId) }));
  }, []);

  // ── pointer interaction ─────────────────────────────────────────────────
  const onPointerDownNode = (e: React.PointerEvent, node: BotNode) => {
    if (pendingPort) { connect(node.id); return; }
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setSelected(node.id);
    dragRef.current = { kind: 'node', id: node.id, startX: e.clientX, startY: e.clientY, originX: node.x, originY: node.y };
  };

  const onPointerDownCanvas = (e: React.PointerEvent) => {
    if (pendingPort) { setPendingPort(null); return; }
    setSelected(null);
    dragRef.current = { kind: 'canvas', startX: e.clientX, startY: e.clientY, originX: view.x, originY: view.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (drag.kind === 'canvas') {
      setView(v => ({ ...v, x: drag.originX + dx, y: drag.originY + dy }));
    } else if (drag.id) {
      const x = drag.originX + dx / view.scale;
      const y = drag.originY + dy / view.scale;
      setGraph(g => ({
        ...g,
        nodes: g.nodes.map(n => (n.id === drag.id ? { ...n, x, y } : n)),
      }));
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.kind === 'node' && drag.id) {
      // Snap to the grid once, on release, so dragging itself stays smooth.
      setGraph(g => ({
        ...g,
        nodes: g.nodes.map(n => (
          n.id === drag.id
            ? { ...n, x: Math.round(n.x / GRID) * GRID, y: Math.round(n.y / GRID) * GRID }
            : n
        )),
      }));
    }
  };

  const zoom = (factor: number) =>
    setView(v => ({ ...v, scale: Math.min(1.8, Math.max(0.4, +(v.scale * factor).toFixed(2))) }));

  // ── persistence & export ────────────────────────────────────────────────
  const commands = useMemo(() => graphCommands(graph), [graph]);
  const problems = useMemo(() => validateGraph(graph, isRu), [graph, isRu]);

  const persist = useCallback(async () => {
    if (!bot) return;
    setSaving(true);
    setError('');
    try {
      await saveFlow(ctx, bot.id, graph, commands);
      setSavedAt(Date.now());
      setBot(b => (b ? { ...b, commands } : b));
    } catch {
      setError(t('Не удалось сохранить схему.', 'Could not save the flow.'));
    } finally {
      setSaving(false);
    }
  }, [bot, commands, ctx, graph]);

  const exportProject = useCallback(() => {
    if (!bot) return;
    const files = generateProject(graph, language, {
      botUsername: bot.username,
      serverUrl: currentServerIP,
    });
    downloadBlob(createZip(files), `${bot.username}-${language}.zip`);
  }, [bot, currentServerIP, graph, language]);

  const selectedNode = graph.nodes.find(n => n.id === selected) || null;

  // ── key screen ──────────────────────────────────────────────────────────
  if (!bot) {
    return (
      <Shell onClose={onClose} title={t('Нодовый редактор бота', 'Bot node editor')}>
        <div style={{ maxWidth: 460, margin: '0 auto', padding: 24, textAlign: 'center' }}>
          <div style={{
            width: 64, height: 64, borderRadius: 18, margin: '0 auto 16px',
            background: 'linear-gradient(135deg,#5865f2,#7c3aed)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Key size={28} color="#fff" />
          </div>
          <h2 style={{ margin: '0 0 8px', fontSize: 20, color: 'var(--text-primary)' }}>
            {t('Введите ключ бота', 'Enter the bot key')}
          </h2>
          <p style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            {isRu
              ? <>Ключ выдаёт <b>Сфероник</b> — откройте его в инструментах разработчика и отправьте <code>/newbot</code>. Редактор открывается только для ваших ботов.</>
              : <>The key is issued by <b>Sferonik</b> — open it in the developer tools and send <code>/newbot</code>. The editor only opens for bots you own.</>}
          </p>
          <input
            value={keyInput}
            onChange={e => setKeyInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') unlock(); }}
            placeholder="sfb_…"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%', padding: '12px 14px', borderRadius: 10, boxSizing: 'border-box',
              border: '1.5px solid var(--border-color)', background: 'var(--bg-tertiary, rgba(0,0,0,.25))',
              color: 'var(--text-primary)', fontSize: 15, fontFamily: 'ui-monospace, monospace',
            }}
          />
          {error && <div style={{ marginTop: 12, color: '#ed4245', fontSize: 13, lineHeight: 1.4 }}>{error}</div>}
          <button
            onClick={unlock}
            disabled={unlocking || !keyInput.trim()}
            style={{
              marginTop: 16, width: '100%', padding: '12px 16px', borderRadius: 10, border: 'none',
              background: 'linear-gradient(135deg,#5865f2,#7c3aed)', color: '#fff',
              fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: keyInput.trim() ? 1 : 0.6,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {unlocking ? <Loader2 size={18} className="spin" /> : <Key size={18} />}
            {t('Открыть редактор', 'Open the editor')}
          </button>
        </div>
      </Shell>
    );
  }

  // ── editor ──────────────────────────────────────────────────────────────
  return (
    <Shell
      onClose={onClose}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <BotIcon size={18} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            @{bot.username}
          </span>
        </span>
      }
      actions={
        <>
          <button className="glass-btn" onClick={() => setPalette(true)} title={t('Добавить узел', 'Add a node')} style={toolButton}>
            <Plus size={16} /> {narrow ? '' : t('Узел', 'Node')}
          </button>
          <button className="glass-btn" onClick={persist} disabled={saving} title={t('Сохранить', 'Save')} style={toolButton}>
            {saving ? <Loader2 size={16} className="spin" /> : savedAt ? <Check size={16} /> : <Save size={16} />}
            {narrow ? '' : t('Сохранить', 'Save')}
          </button>
          <select
            value={language}
            onChange={e => setLanguage(e.target.value as TargetLanguage)}
            style={{ ...toolButton, paddingRight: 8 }}
            title={t('Язык экспорта', 'Export language')}
          >
            <option value="python">Python</option>
            <option value="cpp">C++</option>
            <option value="rust">Rust</option>
          </select>
          <button className="glass-btn" onClick={exportProject} title={t('Скачать проект', 'Download the project')} style={toolButton}>
            <Download size={16} /> {narrow ? '' : t('Скачать', 'Download')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', flex: 1, minHeight: 0 }}>
        {/* Canvas */}
        <div
          ref={canvasRef}
          onPointerDown={onPointerDownCanvas}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={e => { if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 0.9); } }}
          style={{
            position: 'relative', flex: 1, minHeight: narrow ? '48vh' : 0, overflow: 'hidden',
            background:
              'radial-gradient(circle at 1px 1px, rgba(255,255,255,.08) 1px, transparent 0) 0 0/20px 20px, var(--bg-primary, #1e1f22)',
            touchAction: 'none', cursor: pendingPort ? 'crosshair' : 'grab',
          }}
        >
          {pendingPort && (
            <div style={hintBar}>
              {t('Выберите узел, к которому вести связь — или нажмите на пустое место, чтобы отменить',
                 'Pick the node to connect to — or tap empty space to cancel')}
            </div>
          )}
          {graph.nodes.length === 0 && (
            <div style={{ ...hintBar, top: 'auto', bottom: 16, background: 'transparent', color: 'var(--text-tertiary)' }}>
              {t('Пусто. Нажмите «Узел» и начните с триггера «Команда».',
                 'Empty. Press "Node" and start with a "Command" trigger.')}
            </div>
          )}

          <div style={{
            position: 'absolute', left: 0, top: 0,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: '0 0',
          }}>
            <svg
              style={{ position: 'absolute', left: -4000, top: -4000, width: 8000, height: 8000, pointerEvents: 'none' }}
            >
              {graph.edges.map(edge => {
                const from = graph.nodes.find(n => n.id === edge.from);
                const to = graph.nodes.find(n => n.id === edge.to);
                if (!from || !to) return null;
                const ports = specFor(from.type).ports;
                const index = Math.max(0, ports.indexOf(edge.port));
                const x1 = from.x + NODE_WIDTH + 4000;
                const y1 = from.y + 4000 + 34 + index * 22;
                const x2 = to.x + 4000;
                const y2 = to.y + 4000 + NODE_HEIGHT / 2;
                const mid = (x1 + x2) / 2;
                return (
                  <g key={edge.id}>
                    <path
                      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                      stroke={edge.port === 'else' ? '#ed4245' : edge.port === 'then' ? '#3ba55d' : '#8a8f98'}
                      strokeWidth={2} fill="none"
                    />
                    <circle
                      cx={mid} cy={(y1 + y2) / 2} r={9}
                      fill="rgba(0,0,0,.55)" stroke="#8a8f98" strokeWidth={1}
                      style={{ pointerEvents: 'all', cursor: 'pointer' }}
                      onPointerDown={e => { e.stopPropagation(); disconnect(edge.id); }}
                    />
                    <text
                      x={mid} y={(y1 + y2) / 2 + 4} textAnchor="middle"
                      fill="#fff" fontSize={11} style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                      ×
                    </text>
                  </g>
                );
              })}
            </svg>

            {graph.nodes.map(node => {
              const spec = specFor(node.type);
              const isSelected = node.id === selected;
              const summary =
                node.type === 'trigger_command' ? `/${node.data.command || '…'}`
                  : node.type === 'trigger_message' ? (node.data.contains || t('любое сообщение', 'any message'))
                    : node.type === 'reply' ? (node.data.text || '…')
                      : node.type === 'condition' ? (node.data.value || '…')
                        : node.type === 'http_get' ? (node.data.url || '…')
                          : node.type === 'delay' ? `${node.data.seconds || '1'} c`
                            : '';
              return (
                <div
                  key={node.id}
                  onPointerDown={e => onPointerDownNode(e, node)}
                  style={{
                    position: 'absolute', left: node.x, top: node.y,
                    width: NODE_WIDTH, minHeight: NODE_HEIGHT, boxSizing: 'border-box',
                    borderRadius: 12, padding: '10px 12px',
                    background: 'var(--bg-secondary, #2b2d31)',
                    border: `2px solid ${isSelected ? spec.color : 'var(--border-color, rgba(255,255,255,.12))'}`,
                    boxShadow: isSelected ? `0 0 0 3px ${spec.color}33` : '0 4px 14px rgba(0,0,0,.3)',
                    cursor: 'grab', touchAction: 'none', userSelect: 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 3, background: spec.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{spec.title}</span>
                  </div>
                  <div style={{
                    fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.35,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>
                    {summary}
                  </div>
                  {spec.ports.map((port, i) => (
                    <button
                      key={port}
                      onPointerDown={e => { e.stopPropagation(); setPendingPort({ node: node.id, port }); }}
                      title={port === 'then' ? t('Ветка «да»', 'Yes branch')
                        : port === 'else' ? t('Ветка «нет»', 'No branch') : t('Дальше', 'Next')}
                      style={{
                        position: 'absolute', right: -11, top: 26 + i * 22,
                        width: 22, height: 18, borderRadius: 9, cursor: 'pointer',
                        border: '2px solid var(--bg-primary, #1e1f22)',
                        background: port === 'else' ? '#ed4245' : port === 'then' ? '#3ba55d' : '#8a8f98',
                        color: '#fff', fontSize: 9, fontWeight: 800, lineHeight: '14px', padding: 0,
                      }}
                    >
                      {port === 'then' ? t('да', 'yes') : port === 'else' ? t('нет', 'no') : '→'}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>

          <div style={{ position: 'absolute', right: 12, bottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button onClick={() => zoom(1.15)} style={roundButton} title={t('Приблизить', 'Zoom in')}><ZoomIn size={16} /></button>
            <button onClick={() => zoom(0.87)} style={roundButton} title={t('Отдалить', 'Zoom out')}><ZoomOut size={16} /></button>
          </div>
        </div>

        {/* Inspector */}
        <div style={{
          width: narrow ? 'auto' : 300, flexShrink: 0,
          borderLeft: narrow ? 'none' : '1px solid var(--border-color)',
          borderTop: narrow ? '1px solid var(--border-color)' : 'none',
          padding: 14, overflowY: 'auto',
          maxHeight: narrow ? '42vh' : 'none',
          background: 'var(--bg-secondary, #2b2d31)',
        }}>
          {selectedNode ? (
            <NodeInspector
              isRu={isRu}
              node={selectedNode}
              onChange={(key, value) => updateData(selectedNode.id, key, value)}
              onDelete={() => removeNode(selectedNode.id)}
            />
          ) : (
            <FlowSummary
              isRu={isRu}
              bot={bot}
              commands={commands}
              problems={problems}
              savedAt={savedAt}
            />
          )}
          {error && <div style={{ marginTop: 12, color: '#ed4245', fontSize: 13 }}>{error}</div>}
        </div>
      </div>

      {palette && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 60 }} onClick={() => setPalette(false)} />
          <div style={{
            position: 'fixed', zIndex: 61,
            ...(narrow
              ? { left: 0, right: 0, bottom: 0, borderRadius: '16px 16px 0 0', maxHeight: '70vh' }
              : { left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 420, borderRadius: 16, maxHeight: '70vh' }),
            overflowY: 'auto', padding: 14,
            background: 'var(--bg-secondary, #2b2d31)', border: '1px solid var(--border-color)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <b style={{ color: 'var(--text-primary)' }}>{t('Добавить узел', 'Add a node')}</b>
              <button onClick={() => setPalette(false)} style={roundButton}><X size={16} /></button>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {NODE_SPECS.map(spec => (
                <button
                  key={spec.type}
                  onClick={() => addNode(spec.type)}
                  style={{
                    display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left',
                    padding: 12, borderRadius: 10, cursor: 'pointer',
                    background: 'var(--bg-tertiary, rgba(0,0,0,.25))',
                    border: `1px solid ${spec.color}55`, color: 'var(--text-primary)',
                  }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: spec.color, marginTop: 4, flexShrink: 0 }} />
                  <span>
                    <span style={{ display: 'block', fontWeight: 700, fontSize: 14 }}>{isRu ? spec.title : spec.titleEn}</span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.35 }}>
                      {isRu ? spec.hint : spec.hintEn}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </Shell>
  );
};

// ── pieces ────────────────────────────────────────────────────────────────

const toolButton: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 11px', borderRadius: 9, cursor: 'pointer',
  background: 'var(--bg-tertiary, rgba(0,0,0,.25))',
  border: '1px solid var(--border-color, rgba(255,255,255,.12))',
  color: 'var(--text-primary)', fontSize: 13, fontWeight: 600,
};

const roundButton: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 8, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--bg-tertiary, rgba(0,0,0,.35))',
  border: '1px solid var(--border-color, rgba(255,255,255,.12))',
  color: 'var(--text-primary)',
};

const hintBar: React.CSSProperties = {
  position: 'absolute', left: 12, right: 12, top: 12, zIndex: 5,
  padding: '8px 12px', borderRadius: 9, textAlign: 'center',
  background: 'rgba(0,0,0,.55)', color: '#fff', fontSize: 12.5, pointerEvents: 'none',
};

const Shell: React.FC<{
  title: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ title, actions, onClose, children }) => (
  <div style={{
    position: 'fixed', inset: 0, zIndex: 50, display: 'flex', flexDirection: 'column',
    background: 'var(--bg-primary, #1e1f22)',
  }}>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
      borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap',
    }}>
      <button onClick={onClose} style={roundButton} title="Закрыть"><X size={16} /></button>
      <b style={{ color: 'var(--text-primary)', fontSize: 15, minWidth: 0, flex: '1 1 120px' }}>{title}</b>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{actions}</div>
    </div>
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
  </div>
);

const NodeInspector: React.FC<{
  isRu: boolean;
  node: BotNode;
  onChange: (key: string, value: string) => void;
  onDelete: () => void;
}> = ({ isRu, node, onChange, onDelete }) => {
  const spec = specFor(node.type);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: spec.color }} />
        <b style={{ color: 'var(--text-primary)', fontSize: 15 }}>{isRu ? spec.title : spec.titleEn}</b>
      </div>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>
        {isRu ? spec.hint : spec.hintEn}
      </p>
      {spec.fields.map(field => (
        <label key={field.key} style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>
            {isRu ? field.label : field.labelEn}
          </span>
          {field.multiline ? (
            <textarea
              rows={4}
              value={node.data[field.key] || ''}
              placeholder={field.placeholder}
              onChange={e => onChange(field.key, e.target.value)}
              style={inputStyle}
            />
          ) : (
            <input
              value={node.data[field.key] || ''}
              placeholder={field.placeholder}
              onChange={e => onChange(field.key, e.target.value)}
              style={inputStyle}
            />
          )}
        </label>
      ))}
      <button
        onClick={onDelete}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 12px',
          borderRadius: 9, cursor: 'pointer', border: '1px solid rgba(237,66,69,.4)',
          background: 'rgba(237,66,69,.12)', color: '#ed4245', fontSize: 13, fontWeight: 600,
        }}
      >
        <Trash2 size={15} /> {isRu ? 'Удалить узел' : 'Delete node'}
      </button>
    </div>
  );
};

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: 9,
  border: '1px solid var(--border-color)', background: 'var(--bg-tertiary, rgba(0,0,0,.25))',
  color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit', resize: 'vertical',
};

const FlowSummary: React.FC<{
  isRu: boolean;
  bot: BotAccount;
  commands: { command: string; description: string }[];
  problems: string[];
  savedAt: number | null;
}> = ({ isRu, bot, commands, problems, savedAt }) => {
  const [copied, setCopied] = useState(false);
  const t = (ru: string, en: string) => (isRu ? ru : en);
  return (
    <div>
      <b style={{ color: 'var(--text-primary)', fontSize: 15 }}>{bot.display_name}</b>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 14px' }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>@{bot.username}</span>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(`@${bot.username}`);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          style={{ ...roundButton, width: 24, height: 24 }}
          title={t('Скопировать имя', 'Copy the name')}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
        {t('Команды', 'Commands')} ({commands.length})
      </div>
      {commands.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', marginBottom: 14, lineHeight: 1.4 }}>
          {t('Добавьте узел «Команда» — эти команды и появятся в кнопке рядом с полем ввода.',
             'Add a "Command" node — those commands are what the button next to the composer shows.')}
        </div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          {commands.map(c => (
            <div key={c.command} style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 3 }}>
              /{c.command}
              {c.description && <span style={{ color: 'var(--text-tertiary)' }}> — {c.description}</span>}
            </div>
          ))}
        </div>
      )}

      {problems.length > 0 && (
        <div style={{
          padding: 10, borderRadius: 9, marginBottom: 14,
          background: 'rgba(250,168,26,.12)', border: '1px solid rgba(250,168,26,.35)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#faa81a', marginBottom: 4 }}>
            {t('Проверьте схему', 'Check the flow')}
          </div>
          {problems.map(p => (
            <div key={p} style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>• {p}</div>
          ))}
        </div>
      )}

      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: 0 }}>
        {isRu
          ? <>«Сохранить» записывает схему и регистрирует команды на сервере. «Скачать» отдаёт готовый проект на выбранном языке — запускайте его на своём сервере, ключ передаётся через переменную <code>SFERA_BOT_TOKEN</code>.</>
          : <>"Save" stores the flow and registers the commands on the server. "Download" gives you a ready project in the chosen language — run it on your own server; the key is passed via <code>SFERA_BOT_TOKEN</code>.</>}
      </p>
      {savedAt && (
        <div style={{ marginTop: 10, fontSize: 12, color: '#3ba55d' }}>
          {t('Сохранено в', 'Saved at')} {new Date(savedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
};

export default BotStudio;
