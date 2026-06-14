import React, { useState, useEffect, useCallback } from 'react';
import { Search, Users, LogIn } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';

interface ExploreGuild {
  id: string;
  name: string;
  description: string;
  icon: string;
  banner: string;
  member_count: number;
  invite_code: string;
}

export const ExploreServers: React.FC = () => {
  const { currentServerIP, authToken, joinGuild, selectGuild } = useApp();
  const tr = useTranslation();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ExploreGuild[]>([]);
  const [loading, setLoading] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${currentServerIP}/api/guilds/explore/?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) setResults(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, [currentServerIP, authToken]);

  useEffect(() => { load(''); }, [load]);

  useEffect(() => {
    const t = setTimeout(() => load(search), 300);
    return () => clearTimeout(t);
  }, [search, load]);

  const handleJoin = async (g: ExploreGuild) => {
    setJoining(g.id);
    try {
      const joined = await joinGuild(g.invite_code);
      if (joined) selectGuild(joined);
      setResults(prev => prev.filter(r => r.id !== g.id));
    } catch { /* ignore */ }
    setJoining(null);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      <div style={{ padding: '24px 32px 16px', borderBottom: '1px solid var(--border-color)' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>{tr('explore_title')}</h2>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-secondary)' }}>{tr('explore_subtitle')}</p>
        <div style={{ position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={tr('explore_search_placeholder')}
            style={{ width: '100%', padding: '8px 12px 8px 32px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 32px' }}>
        {loading && results.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', marginTop: 40 }}>{tr('explore_loading')}</p>
        ) : results.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', marginTop: 40 }}>{tr('explore_empty')}</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {results.map(g => (
              <div key={g.id} style={{ borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {g.banner ? (
                  <div style={{ height: 80, background: `url(${g.banner.startsWith('http') ? g.banner : currentServerIP + g.banner}) center/cover` }} />
                ) : (
                  <div style={{ height: 80, background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--bg-tertiary) 100%)' }} />
                )}
                <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {g.icon ? (
                      <img src={g.icon.startsWith('http') ? g.icon : currentServerIP + g.icon} alt="" style={{ width: 36, height: 36, borderRadius: 12, objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: 36, height: 36, borderRadius: 12, background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16 }}>
                        {g.name[0]?.toUpperCase()}
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Users size={11} /> {g.member_count}
                      </div>
                    </div>
                  </div>
                  {g.description && (
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{g.description}</p>
                  )}
                  <button
                    onClick={() => handleJoin(g)}
                    disabled={joining === g.id}
                    style={{ marginTop: 'auto', padding: '6px 0', borderRadius: 6, border: 'none', background: 'var(--accent-primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: joining === g.id ? 0.6 : 1 }}
                  >
                    <LogIn size={14} /> {tr('explore_join')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
