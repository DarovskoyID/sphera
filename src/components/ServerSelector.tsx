import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from '../i18n/useTranslation';
import { loadServers, saveServers, loadSelectedServer, saveSelectedServer, pingServer, pingStun, API_BASE_URL, type ServerEntry } from '../config/network';
import { useApp } from '../context/AppContext';

const card: React.CSSProperties = { background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border-color)', padding: 16, marginBottom: 10 };
const fieldInput: React.CSSProperties = { width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' as const };

const MarqueeInput: React.FC<{
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  style?: React.CSSProperties;
}> = ({ placeholder, value, onChange, onKeyDown, style }) => {
  const [focused, setFocused] = useState(false);
  const showMarquee = !value && !focused;
  const wrapRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    if (!showMarquee) return;
    const wrap = wrapRef.current;
    const text = textRef.current;
    if (!wrap || !text) return;

    const measure = () => text.scrollWidth - wrap.clientWidth;
    let dist = measure();
    if (dist <= 0) return;

    const SPEED = 30; // px per second
    const PAUSE = 1500; // ms pause at each end
    let offset = 0;
    let direction = -1; // -1 = scroll left, 1 = scroll right
    let pauseUntil = performance.now() + PAUSE;
    let prev = performance.now();

    const tick = (now: number) => {
      if (now < pauseUntil) {
        animRef.current = requestAnimationFrame(tick);
        return;
      }
      const dt = (now - Math.max(prev, pauseUntil)) / 1000;
      prev = now;
      offset += direction * SPEED * dt;

      if (offset < -dist) {
        offset = -dist;
        direction = 1;
        pauseUntil = now + PAUSE;
      } else if (offset > 0) {
        offset = 0;
        direction = -1;
        pauseUntil = now + PAUSE;
        dist = measure();
      }

      text.style.transform = `translateX(${offset}px)`;
      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [showMarquee, placeholder]);

  return (
    <div style={{ position: 'relative', ...style }}>
      <input
        style={{ ...fieldInput, width: '100%', color: value ? 'var(--text-primary)' : 'transparent', caretColor: 'var(--text-primary)' }}
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        placeholder={focused ? placeholder : ''}
      />
      {showMarquee && (
        <div
          ref={wrapRef}
          style={{
            position: 'absolute', top: 0, left: 12, right: 12, bottom: 0,
            display: 'flex', alignItems: 'center',
            overflow: 'hidden', pointerEvents: 'none',
          }}
        >
          <span
            ref={textRef}
            style={{ whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: 14 }}
          >
            {placeholder}
          </span>
        </div>
      )}
    </div>
  );
};

interface Props {
  compact?: boolean;
  maxListHeight?: number;
}

export const ServerSelector: React.FC<Props> = ({ compact, maxListHeight }) => {
  const tr = useTranslation();
  const { setCurrentServerIP } = useApp();
  const [servers, setServers] = useState<ServerEntry[]>(loadServers);
  const [selected, setSelected] = useState(loadSelectedServer);
  const [pings, setPings] = useState<Record<string, number | null | 'loading'>>({});
  const [stunStatus, setStunStatus] = useState<Record<string, boolean | 'loading' | 'none'>>({});
  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState('');
  const [expandedTurn, setExpandedTurn] = useState<string | null>(null);

  const serversRef = useRef(servers);
  serversRef.current = servers;

  const runPings = useCallback(() => {
    serversRef.current.forEach(s => {
      setPings(prev => ({ ...prev, [s.url]: 'loading' }));
      pingServer(s.url).then(ms => {
        setPings(prev => ({ ...prev, [s.url]: ms }));
      });
      const stunKey = s.url;
      if (s.turn_host) {
        setStunStatus(prev => ({ ...prev, [stunKey]: 'loading' }));
        pingStun(s.turn_host, s.turn_port || 3478, s.turn_username, s.turn_credential).then(ok => {
          setStunStatus(prev => ({ ...prev, [stunKey]: ok }));
        });
      } else {
        setStunStatus(prev => ({ ...prev, [stunKey]: 'none' }));
      }
    });
  }, []);

  useEffect(() => { runPings(); }, [runPings]);

  const handleSelect = (url: string) => {
    setSelected(url);
    saveSelectedServer(url);
    setCurrentServerIP(url);
  };

  const handleAdd = () => {
    setAddError('');
    let url = newUrl.trim();
    if (!url) return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    url = url.replace(/\/+$/, '');
    if (servers.some(s => s.url === url)) {
      setAddError(tr('srv_already_exists'));
      return;
    }
    const name = newName.trim() || url.replace(/^https?:\/\//, '').split(':')[0];
    const updated = [...servers, { url, name }];
    setServers(updated);
    saveServers(updated);
    setNewUrl('');
    setNewName('');
    setPings(prev => ({ ...prev, [url]: 'loading' }));
    pingServer(url).then(ms => {
      setPings(prev => ({ ...prev, [url]: ms }));
    });
  };

  const handleRemove = (url: string) => {
    if (url === API_BASE_URL || servers.length <= 1) return;
    const updated = servers.filter(s => s.url !== url);
    setServers(updated);
    saveServers(updated);
    if (selected === url) {
      handleSelect(updated[0].url);
    }
  };

  const updateServer = (url: string, patch: Partial<ServerEntry>) => {
    const updated = servers.map(s => s.url === url ? { ...s, ...patch } : s);
    setServers(updated);
    saveServers(updated);
  };

  const pingBadge = (url: string) => {
    const p = pings[url];
    if (p === 'loading') return <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>...</span>;
    if (p === null || p === undefined) return <span style={{ fontSize: 11, color: '#ef4444' }}>{tr('srv_offline')}</span>;
    const color = p < 100 ? '#22c55e' : p < 300 ? '#f59e0b' : '#ef4444';
    return <span style={{ fontSize: 11, color, fontWeight: 600 }}>{p} ms</span>;
  };

  const stunBadge = (url: string) => {
    const st = stunStatus[url];
    if (st === 'none' || st === undefined) return <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>STUN —</span>;
    if (st === 'loading') return <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>STUN ...</span>;
    if (st === true) return <span style={{ fontSize: 10, color: '#22c55e', fontWeight: 600 }}>STUN ✓</span>;
    return <span style={{ fontSize: 10, color: '#ef4444' }}>STUN ✗</span>;
  };

  return (
    <div>
      {!compact && <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{tr('srv_title')}</h3>}

      <button
        onClick={runPings}
        style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: 12, padding: '4px 0', marginBottom: 8 }}
      >{tr('srv_refresh_ping')}</button>

      <div style={maxListHeight ? { maxHeight: maxListHeight, overflowY: 'auto' } : undefined}>
      {servers.map(s => {
        const isTurnOpen = expandedTurn === s.url;
        return (
        <div
          key={s.url}
          style={{
            ...card,
            border: selected === s.url ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
            background: selected === s.url ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
          }}
        >
          <div
            onClick={() => handleSelect(s.url)}
            style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
          >
            <div style={{
              width: 20, height: 20, borderRadius: '50%',
              border: `2px solid ${selected === s.url ? 'var(--accent-primary)' : 'var(--border-color)'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              {selected === s.url && <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--accent-primary)' }} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.url}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {stunBadge(s.url)}
              {pingBadge(s.url)}
              {s.url !== API_BASE_URL && (
                <button
                  onClick={e => { e.stopPropagation(); handleRemove(s.url); }}
                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }}
                  title={tr('srv_remove')}
                >&times;</button>
              )}
            </div>
          </div>
          {s.url !== API_BASE_URL && (<>
          <div style={{ marginTop: 6 }}>
            <span
              onClick={e => { e.stopPropagation(); setExpandedTurn(isTurnOpen ? null : s.url); }}
              style={{ fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}
            >
              {isTurnOpen ? '▲' : '▼'} TURN / STUN
              {!isTurnOpen && s.turn_host ? ` (${s.turn_host})` : ''}
            </span>
          </div>
          {isTurnOpen && (
            <div onClick={e => e.stopPropagation()} style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  style={{ ...fieldInput, flex: 3 }}
                  placeholder={tr('srv_turn_host')}
                  value={s.turn_host || ''}
                  onChange={e => updateServer(s.url, { turn_host: e.target.value })}
                />
                <input
                  style={{ ...fieldInput, flex: 1 }}
                  placeholder={tr('srv_turn_port')}
                  type="number"
                  value={s.turn_port || ''}
                  onChange={e => updateServer(s.url, { turn_port: e.target.value ? Number(e.target.value) : undefined })}
                />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  style={{ ...fieldInput, flex: 1 }}
                  placeholder={tr('srv_turn_user')}
                  value={s.turn_username || ''}
                  onChange={e => updateServer(s.url, { turn_username: e.target.value })}
                />
                <input
                  style={{ ...fieldInput, flex: 1 }}
                  placeholder={tr('srv_turn_password')}
                  type="password"
                  value={s.turn_credential || ''}
                  onChange={e => updateServer(s.url, { turn_credential: e.target.value })}
                />
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{tr('srv_turn_hint')}</div>
            </div>
          )}
          </>)}
        </div>
        );
      })}

      </div>

      <div style={{ ...card, padding: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>{tr('srv_add_server')}</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <MarqueeInput
            style={{ flex: 2 }}
            placeholder={tr('srv_url_placeholder')}
            value={newUrl}
            onChange={setNewUrl}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <input
            style={{ ...fieldInput, flex: 1 }}
            placeholder={tr('srv_name_placeholder')}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
        </div>
        {addError && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 6 }}>{addError}</div>}
        <button
          onClick={handleAdd}
          style={{
            padding: '6px 16px', borderRadius: 6, border: 'none',
            background: 'var(--accent-primary)', color: '#fff', fontSize: 13,
            fontWeight: 600, cursor: 'pointer',
          }}
        >{tr('srv_add')}</button>
      </div>
    </div>
  );
};
