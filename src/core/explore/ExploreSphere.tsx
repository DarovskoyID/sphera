import React, { useEffect, useMemo, useState } from 'react';
import {
  BookOpen, Bot, Briefcase, Building2, CalendarCheck, Check, Code, Compass, Database, Download, Gamepad2, Globe, Home,
  Loader2, MessageCircle, Music, Newspaper, NotebookPen, Palette, PenTool, Plug, Puzzle, RefreshCw, Rss, Search,
  Sparkles, Trash2, Trophy, Users, Video, type LucideIcon,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n/useTranslation';
import { useSlot, type ExploreSearchResult, type SlotEntry } from '../../sdk/slots';
import { installModule, uninstallModule, updateModule, useModules, type ModuleInfo } from '../modules/registry';
import { CardGridSkeleton } from '../../components/Skeleton';

const CATEGORIES = [
  { icon: Gamepad2, ru: 'Игры', en: 'Gaming', tag: 'gaming', color: '#5865f2' },
  { icon: Music, ru: 'Музыка', en: 'Music', tag: 'music', color: '#eb459e' },
  { icon: Code, ru: 'Технологии', en: 'Tech', tag: 'tech', color: '#57f287' },
  { icon: BookOpen, ru: 'Образование', en: 'Education', tag: 'education', color: '#fee75c' },
  { icon: Palette, ru: 'Творчество', en: 'Creative', tag: 'creative', color: '#ed4245' },
  { icon: Trophy, ru: 'Киберспорт', en: 'Esports', tag: 'esports', color: '#f47b67' },
  { icon: Newspaper, ru: 'Новости', en: 'News', tag: 'news', color: '#3b82f6' },
  { icon: MessageCircle, ru: 'Общение', en: 'Social', tag: 'social', color: '#3ba55d' },
  { icon: Sparkles, ru: 'Другое', en: 'Other', tag: 'other', color: '#a78bfa' },
];

const MODULE_ICONS: Record<string, LucideIcon> = {
  bot: Bot, rss: Rss, 'notebook-pen': NotebookPen, home: Home, users: Users, globe: Globe,
  video: Video, 'pen-tool': PenTool, 'calendar-check': CalendarCheck, briefcase: Briefcase,
  building: Building2, database: Database, plug: Plug,
};

const sectionTitle: React.CSSProperties = {
  margin: '0 0 14px', fontSize: 13, fontWeight: 700, color: 'var(--text-tertiary)',
  textTransform: 'uppercase', letterSpacing: '0.5px',
};

function pick(map: Record<string, string>, lang: string) {
  return map[lang] || map.en || map.ru || Object.values(map)[0] || '';
}

function ModuleCard({ m, lang, isRu, canManage }: { m: ModuleInfo; lang: string; isRu: boolean; canManage: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const Icon = MODULE_ICONS[m.icon] ?? Puzzle;
  const run = async (action: 'install' | 'uninstall' | 'update') => {
    setBusy(true);
    setError('');
    try {
      if (action === 'uninstall') await uninstallModule(m.id);
      else if (action === 'update') await updateModule(m.id);
      else await installModule(m.id);
    } catch (e) {
      const body = (e as { body?: { error?: string; modules?: string[] } }).body;
      setError(body?.error === 'required_by'
        ? `${isRu ? 'Нужен модулям' : 'Required by'}: ${body.modules?.join(', ')}`
        : body?.error === 'locked'
          ? (isRu ? 'Сейчас удалить нельзя: модуль используется (например, на сервере есть семьи)' : 'Cannot be removed while in use (e.g. families exist)')
          : String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: 12,
      background: 'var(--bg-secondary)', border: `1px solid ${m.installed ? 'var(--accent-primary)' : 'var(--border-color)'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: m.installed ? 'linear-gradient(135deg,#5865f2,#7c3aed)' : 'var(--bg-tertiary)',
        }}>
          <Icon size={20} color={m.installed ? '#fff' : 'var(--text-secondary)'} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{pick(m.name, lang)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            v{m.version}
            {m.updateAvailable && m.latestVersion && (
              <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}> → v{m.latestVersion}</span>
            )}
          </div>
        </div>
        {m.installed && m.deployed && !m.pending && <Check size={16} style={{ color: 'var(--accent-primary)' }} />}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4, flex: 1 }}>{pick(m.description, lang)}</div>
      {m.deps.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{isRu ? 'Требует' : 'Requires'}: {m.deps.join(', ')}</div>
      )}
      {(error || m.error) && <div style={{ fontSize: 11, color: '#ef4444', wordBreak: 'break-word' }}>{error || m.error}</div>}
      {m.pending ? (
        <div style={{
          padding: '8px 0', borderRadius: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'var(--bg-tertiary)',
        }}>
          <Loader2 size={14} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
          {m.pending === 'restarting'
            ? (m.manualRestart ? (isRu ? 'Перезапустите сервер' : 'Restart the server') : (isRu ? 'Перезапуск сервера…' : 'Restarting server…'))
            : m.pending === 'updating' ? (isRu ? 'Обновление из репозитория…' : 'Updating from repository…')
              : (isRu ? 'Загрузка из репозитория…' : 'Downloading from repository…')}
        </div>
      ) : canManage && (
        <div style={{ display: 'flex', gap: 8 }}>
          {m.installed && m.updateAvailable && (
            <button onClick={() => run('update')} disabled={busy} style={cardBtn(true, busy)}>
              <RefreshCw size={14} /> {isRu ? 'Обновить' : 'Update'}
            </button>
          )}
          <button onClick={() => run(m.installed ? 'uninstall' : 'install')} disabled={busy} style={cardBtn(!m.installed, busy)}>
            {m.installed ? <Trash2 size={14} /> : <Download size={14} />}
            {busy ? '…' : m.installed ? (isRu ? 'Удалить' : 'Uninstall') : (isRu ? 'Установить' : 'Install')}
          </button>
        </div>
      )}
    </div>
  );
}

const cardBtn = (primary: boolean, busy: boolean): React.CSSProperties => ({
  flex: 1, padding: '8px 0', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: busy ? 0.6 : 1,
  border: primary ? 'none' : '1px solid var(--border-color)',
  background: primary ? 'var(--accent-primary)' : 'transparent',
  color: primary ? '#fff' : 'var(--text-secondary)',
});

type Section = { provider: SlotEntry<'explore.search'>; results: ExploreSearchResult[]; loading: boolean };

function useProviderResults(query: string) {
  const providers = useSlot('explore.search');
  const [sections, setSections] = useState<Section[]>([]);
  const key = providers.map(p => `${p.moduleId}:${p.id}`).join('|');

  useEffect(() => {
    if (!providers.length) { setSections([]); return; }
    const ctrl = new AbortController();
    setSections(providers.map(p => ({ provider: p, results: [], loading: true })));
    const timer = setTimeout(() => {
      providers.forEach((p, i) => {
        p.search(query, ctrl.signal)
          .then(results => setSections(prev => prev.map((s, j) => (j === i ? { ...s, results, loading: false } : s))))
          .catch(() => setSections(prev => prev.map((s, j) => (j === i ? { ...s, loading: false } : s))));
      });
    }, query ? 300 : 0);
    return () => { clearTimeout(timer); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, key]);

  return { providers, sections };
}

function ResultCard({ r, serverIP }: { r: ExploreSearchResult; serverIP: string }) {
  const avatar = r.avatar ? (r.avatar.startsWith('http') ? r.avatar : serverIP + r.avatar) : '';
  const hue = Math.abs((r.title.charCodeAt(0) || 65) * 47) % 360;
  return (
    <div
      onClick={r.open}
      style={{
        display: 'flex', gap: 12, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', alignItems: 'center',
        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', transition: 'border-color .15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-primary)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}
    >
      {avatar
        ? <img src={avatar} alt="" style={{ width: 40, height: 40, borderRadius: 12, objectFit: 'cover', flexShrink: 0 }} />
        : <div style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, background: `linear-gradient(135deg,hsl(${hue},55%,50%),hsl(${(hue + 60) % 360},45%,40%))`, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 }}>{r.title[0]?.toUpperCase()}</div>}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
          {r.badge && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 600, background: 'rgba(88,101,242,0.15)', color: 'var(--accent-primary)', flexShrink: 0 }}>{r.badge}</span>}
        </div>
        {r.subtitle && <div style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{r.subtitle}</div>}
      </div>
    </div>
  );
}

/**
 * «Исследовать сферу»: install/uninstall modules, module tools, and search.
 * The search bar exists only while some installed module provides search
 * (servers, channels); without them there is nothing to search.
 */
export const ExploreSphere: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const { currentServerIP, language } = useApp();
  const tr = useTranslation();
  const isRu = language === 'ru';
  const modules = useModules();
  const cards = useSlot('explore.card');
  const [query, setQuery] = useState('');
  const { providers, sections } = useProviderResults(query);
  const hasSearch = providers.length > 0;

  useEffect(() => { if (!hasSearch) setQuery(''); }, [hasSearch]);

  const sorted = useMemo(
    () => [...modules.modules].sort((a, b) => Number(b.installed) - Number(a.installed) || a.id.localeCompare(b.id)),
    [modules.modules],
  );

  return (
    <div data-tour="explore-view" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)', ...style }}>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ position: 'relative', padding: '40px 24px 32px', background: 'linear-gradient(135deg, #1a1147 0%, #0d1b3e 40%, #0a2540 70%, #0d1f2d 100%)' }}>
          <div style={{ maxWidth: 600 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg, #5865f2, #7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Compass size={22} color="#fff" />
              </div>
              <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: '#fff' }}>{tr('explore_title')}</h1>
            </div>
            <p style={{ margin: hasSearch ? '0 0 20px' : 0, fontSize: 14, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>
              {hasSearch ? tr('explore_subtitle') : (isRu ? 'Добавляйте в Сферу только то, чем пользуетесь' : 'Add to Sfera only what you use')}
            </p>
            {hasSearch && (
              <div style={{ position: 'relative', maxWidth: 420 }}>
                <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.7)' }} />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder={tr('explore_search_placeholder')}
                  style={{ width: '100%', padding: '11px 16px 11px 40px', borderRadius: 12, border: '1.5px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)', color: '#fff', fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
            )}
          </div>
        </div>

        {!query && (
          <div style={{ padding: '20px 24px 0' }}>
            <h3 style={sectionTitle}>{isRu ? 'Модули' : 'Modules'}</h3>
            {modules.canManage && modules.repoError && (
              <div style={{ margin: '-6px 0 12px', fontSize: 12, color: '#f59e0b' }}>
                {isRu ? 'Репозиторий модулей недоступен, показаны только модули на сервере' : 'Module repository is unreachable; showing modules on this server only'}
              </div>
            )}
            {modules.loaded && !modules.canManage && sorted.length > 0 && (
              <div style={{ margin: '-6px 0 12px', fontSize: 12, color: 'var(--text-tertiary)' }}>
                {isRu ? 'Модули на сервере устанавливает администратор' : 'Modules on this server are managed by the administrator'}
              </div>
            )}
            {!modules.loaded ? <CardGridSkeleton cards={3} /> : sorted.length === 0 ? (
              <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{isRu ? 'На этом сервере нет модулей' : 'No modules on this server'}</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
                {sorted.map(m => <ModuleCard key={m.id} m={m} lang={language} isRu={isRu} canManage={modules.canManage} />)}
              </div>
            )}
          </div>
        )}

        {!query && cards.length > 0 && (
          <div style={{ padding: '24px 24px 0' }}>
            <h3 style={sectionTitle}>{isRu ? 'Инструменты' : 'Tools'}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
              {cards.map(card => <card.render key={`${card.moduleId}:${card.id}`} />)}
            </div>
          </div>
        )}

        {hasSearch && (
          <div style={{ padding: '24px 24px 8px' }}>
            <h3 style={sectionTitle}>{isRu ? 'Категории' : 'Categories'}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
              {CATEGORIES.map(cat => {
                const Icon = cat.icon;
                const active = query === '#' + cat.tag;
                return (
                  <div key={cat.tag} onClick={() => setQuery(active ? '' : '#' + cat.tag)} style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '14px 8px', borderRadius: 10, cursor: 'pointer',
                    background: active ? `${cat.color}22` : 'var(--bg-secondary)', border: `1px solid ${active ? cat.color : 'var(--border-color)'}`,
                  }}>
                    <Icon size={22} style={{ color: cat.color }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>{isRu ? cat.ru : cat.en}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {sections.map(({ provider, results, loading }) => (
          <div key={`${provider.moduleId}:${provider.id}`} style={{ padding: '20px 24px 0' }}>
            <h3 style={sectionTitle}>{typeof provider.label === 'function' ? provider.label() : provider.label}</h3>
            {loading ? <CardGridSkeleton cards={3} /> : results.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-tertiary)', fontSize: 13, padding: '8px 0' }}>
                <Globe size={18} style={{ opacity: 0.5 }} /> {query ? (isRu ? 'Ничего не найдено' : 'Nothing found') : tr('explore_empty')}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
                {results.map(r => <ResultCard key={r.id} r={r} serverIP={currentServerIP} />)}
              </div>
            )}
          </div>
        ))}

        <div style={{ height: 32 }} />
      </div>
    </div>
  );
};
