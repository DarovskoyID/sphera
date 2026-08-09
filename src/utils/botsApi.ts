// Thin client for the bot endpoints (/api/bots/…).
//
// The global fetch wrapper in AppContext already attaches X-Ionik-Client, so
// these helpers only need the bearer token and the currently selected server.

import type { BotAccount, ChatBot } from '../types';

interface Ctx {
  token: string;
  serverIP: string;
}

async function call<T>(ctx: Ctx, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${ctx.serverIP}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch { /* non-JSON error body */ }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const listBots = (ctx: Ctx) =>
  call<{ bots: BotAccount[] }>(ctx, '/api/bots/').then(r => r.bots);

export const createBot = (ctx: Ctx, username: string, displayName: string, description = '') =>
  call<BotAccount>(ctx, '/api/bots/', {
    method: 'POST',
    body: JSON.stringify({ username, display_name: displayName, description }),
  });

export const deleteBot = (ctx: Ctx, botId: string) =>
  call<void>(ctx, `/api/bots/${botId}/`, { method: 'DELETE' });

export const rotateToken = (ctx: Ctx, botId: string) =>
  call<BotAccount>(ctx, `/api/bots/${botId}/token/`, { method: 'POST' });

/** Exchange a bot key for its profile (+ saved graph). Owner-only. */
export const unlockBot = (ctx: Ctx, token: string) =>
  call<BotAccount & { flow: unknown }>(ctx, '/api/bots/unlock/', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });

export const loadFlow = (ctx: Ctx, botId: string) =>
  call<{ graph: any; commands: { command: string; description: string }[] }>(
    ctx, `/api/bots/${botId}/flow/`,
  );

export const saveFlow = (
  ctx: Ctx, botId: string, graph: unknown,
  commands: { command: string; description: string }[],
) =>
  call<{ ok: boolean }>(ctx, `/api/bots/${botId}/flow/`, {
    method: 'PUT',
    body: JSON.stringify({ graph, commands }),
  });

export const openSferonik = (ctx: Ctx) =>
  call<{ conversation_id: string; bot: BotAccount }>(ctx, '/api/bots/sferonik/');

/** Bots (and their commands) reachable from one composer. */
export const chatBots = (ctx: Ctx, target: { userId?: string; channelId?: string }) => {
  const query = target.userId
    ? `user_id=${encodeURIComponent(target.userId)}`
    : `channel_id=${encodeURIComponent(target.channelId || '')}`;
  return call<{ bots: ChatBot[] }>(ctx, `/api/bots/commands/?${query}`).then(r => r.bots);
};

export const addBotToGuild = (ctx: Ctx, botId: string, guildId: string) =>
  call<{ ok: boolean }>(ctx, `/api/bots/${botId}/guilds/${guildId}/`, { method: 'POST' });

export const removeBotFromGuild = (ctx: Ctx, botId: string, guildId: string) =>
  call<void>(ctx, `/api/bots/${botId}/guilds/${guildId}/remove/`, { method: 'DELETE' });
