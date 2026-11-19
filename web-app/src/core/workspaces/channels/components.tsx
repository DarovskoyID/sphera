import { useCommercial, workspaceEnabled } from '../../commercial/store';
import { useEffect, useState, type CSSProperties } from 'react';
import { Rss, X } from 'lucide-react';
import { navigate, reportError, useCore, useModuleStore, useModuleT } from '@sfera/sdk';
import * as feed from './store';
import { ROUTE, useChannelId } from './useFeed';
import { PersonalChannelFeed } from './PersonalChannelFeed';
import type { FeedChannel } from './types';

export function ChannelsConnector({ children }: { children: React.ReactNode }) {
  const { authToken, currentServerIP, currentServer } = useCore();
  useCommercial();
  const enabled = workspaceEnabled('channels', currentServerIP, currentServer);
  useEffect(() => {
    feed.connect(enabled && authToken ? { token: authToken, serverIP: currentServerIP } : null);
  }, [authToken, currentServerIP, enabled]);
  useEffect(() => () => feed.connect(null), []);
  return <>{children}</>;
}

export function openChannel(setCurrentServer: (s: string) => void, id: string) {
  setCurrentServer(navigate.moduleRoute(ROUTE, id));
}

/** The feed for `channels:<id>`; loads the channel and keeps its socket open. */
export function ChannelRoute({ style }: { style?: CSSProperties }) {
  const id = useChannelId();
  const t = useModuleT();
  const loaded = useModuleStore(feed.store, s => !!s.byId[id]);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!id) return;
    setMissing(false);
    feed.openChannel(id).catch(() => setMissing(true));
    return () => feed.closeChannel();
  }, [id]);
  if (missing && !loaded) {
    return <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>{t('ch_not_found')}</div>;
  }
  return <PersonalChannelFeed style={style} />;
}

function iconUrl(ch: FeedChannel, serverIP: string) {
  return ch.icon ? (ch.icon.startsWith('http') ? ch.icon : `${serverIP}${ch.icon}`) : '';
}

/** Subscribed channels in the left rail. */
export function ChannelRail() {
  const { currentServer, setCurrentServer, currentServerIP } = useCore();
  const t = useModuleT();
  const channels = useModuleStore(feed.store, s => s.channels);
  return (
    <>
      {channels.map(ch => {
        const route = navigate.moduleRoute(ROUTE, ch.id);
        const src = iconUrl(ch, currentServerIP);
        return (
          <div key={ch.id} style={{ position: 'relative', display: 'flex' }}>
            <button
              className={`server-icon ${currentServer === route ? 'active' : ''}`}
              title={`${ch.name} (${t('pcf_channel')})`}
              onClick={() => setCurrentServer(route)}
              style={{ borderRadius: 14, padding: 0, overflow: 'hidden', border: 'none', background: src ? 'var(--bg-tertiary)' : 'linear-gradient(135deg,#5865f2,#4752c4)' }}
            >
              {src
                ? <img src={src} alt={ch.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ fontSize: 15, fontWeight: 800, color: '#fff' }}>{ch.name.slice(0, 2).toUpperCase()}</span>}
            </button>
            <span title={t('pcf_personal_channel')} style={{
              position: 'absolute', bottom: -3, right: -3, width: 17, height: 17, borderRadius: '50%',
              background: 'var(--accent-primary)', border: '2.5px solid var(--bg-secondary)', pointerEvents: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Rss size={8.5} color="#fff" />
            </span>
          </div>
        );
      })}
    </>
  );
}

function Dialog({ title, hint, onClose, children }: { title: string; hint?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <div className="modal-header">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        {hint && <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '8px 0 12px' }}>{hint}</p>}
        {children}
      </div>
    </div>
  );
}

export function CreateChannelDialog({ onClose }: { onClose: () => void }) {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const ch = await feed.createChannel(name.trim(), desc.trim());
      onClose();
      openChannel(setCurrentServer, ch.id);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('guild_create_channel_title')} hint={t('guild_channel_desc')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input className="input-field" placeholder={t('guild_channel_name')} value={name} onChange={e => setName(e.target.value)} maxLength={100} autoFocus />
        <input className="input-field" placeholder={t('ch_description')} value={desc} onChange={e => setDesc(e.target.value)} maxLength={500} />
        <button className="btn-primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? t('ch_creating') : t('guild_create_channel_btn')}
        </button>
      </form>
    </Dialog>
  );
}

export function JoinChannelDialog({ onClose }: { onClose: () => void }) {
  const t = useModuleT();
  const { setCurrentServer } = useCore();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    try {
      const ch = await feed.join({ invite_code: code.trim() });
      onClose();
      openChannel(setCurrentServer, ch.id);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('guild_join_channel_title')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 16 }}>
        <input className="input-field" placeholder={t('guild_channel_invite_code')} value={code} onChange={e => setCode(e.target.value)} autoFocus />
        <button className="btn-primary" type="submit" disabled={busy || !code.trim()}>
          {busy ? t('ch_joining') : t('ch_join')}
        </button>
      </form>
    </Dialog>
  );
}
