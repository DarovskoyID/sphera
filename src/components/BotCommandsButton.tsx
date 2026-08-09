// The "/" button next to the composer.
//
// It appears only where a bot can actually hear you: a DM with a bot, or a
// guild channel whose server has a bot on it. The command list is whatever the
// bot registered through the API (or through the node editor), so it updates
// without a client release.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Slash } from 'lucide-react';
import type { ChatBot } from '../types';
import { useTranslation } from '../i18n/useTranslation';
import { chatBots } from '../utils/botsApi';
import { BotBadge } from './BotBadge';

interface Props {
  token: string;
  serverIP: string;
  /** DM with this user… */
  userId?: string;
  /** …or this guild text channel. */
  channelId?: string;
  /** Insert the chosen command into the composer, ready to be sent. */
  onPick: (text: string) => void;
}

export const BotCommandsButton: React.FC<Props> = ({ token, serverIP, userId, channelId, onPick }) => {
  const tr = useTranslation();
  const isRu = tr('explore_title') === 'Исследовать Сферу';
  const [bots, setBots] = useState<ChatBot[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const target = userId ? { userId } : channelId ? { channelId } : null;
  const targetKey = userId || channelId || '';

  useEffect(() => {
    let cancelled = false;
    if (!token || !targetKey) { setBots([]); return; }
    chatBots({ token, serverIP }, userId ? { userId } : { channelId })
      .then(list => { if (!cancelled) setBots(list); })
      .catch(() => { if (!cancelled) setBots([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, serverIP, targetKey]);

  useEffect(() => { setOpen(false); }, [targetKey]);

  const pick = useCallback((bot: ChatBot, command: string) => {
    // In a channel several bots can share a command name, so address the bot
    // explicitly there; in a DM there is only one listener.
    const suffix = channelId && bots.length > 1 ? `@${bot.username}` : '';
    onPick(`/${command}${suffix} `);
    setOpen(false);
  }, [bots.length, channelId, onPick]);

  if (!target || bots.length === 0) return null;

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex' }}>
      <button
        className={`composer-icon-btn ${open ? 'active' : ''}`}
        title={isRu ? 'Команды бота' : 'Bot commands'}
        onClick={() => setOpen(v => !v)}
      >
        <Slash size={20} />
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: 'absolute', bottom: '100%', left: 0, marginBottom: 8, zIndex: 41,
              minWidth: 240, maxWidth: 'min(340px, calc(100vw - 32px))',
              maxHeight: 'min(320px, 50vh)', overflowY: 'auto',
              background: 'var(--bg-secondary, #2b2d31)', borderRadius: 10, padding: 5,
              border: '1px solid var(--border-color, rgba(255,255,255,.1))',
              boxShadow: '0 8px 24px rgba(0,0,0,.35)',
            }}
          >
            {bots.map(bot => (
              <div key={bot.user_id}>
                <div style={{
                  display: 'flex', alignItems: 'center',
                  padding: '6px 10px 4px', fontSize: 11, fontWeight: 700,
                  color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.4px',
                }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {bot.display_name || bot.username}
                  </span>
                  <BotBadge />
                </div>
                {bot.commands.map(cmd => (
                  <button
                    key={`${bot.user_id}:${cmd.command}`}
                    onClick={() => pick(bot, cmd.command)}
                    style={{
                      display: 'block', width: '100%', padding: '8px 10px', borderRadius: 7,
                      border: 'none', background: 'transparent', cursor: 'pointer',
                      color: 'var(--text-primary)', textAlign: 'left',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,.06))'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 600 }}>/{cmd.command}</div>
                    {cmd.description && (
                      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.3 }}>
                        {cmd.description}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
