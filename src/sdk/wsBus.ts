/**
 * Event bus for WebSocket frames. Core sockets publish every parsed frame;
 * modules subscribe by `type` instead of patching the core's if/else chains.
 *
 * Channels:
 *  - 'signaling'  — per-user signaling socket (ws/signaling/). Module pushes
 *                   from the backend arrive as `{type:'module_event', event}`
 *                   and are also re-published under `module:<event>`.
 *  - 'chat'       — the open DM conversation socket.
 */
export type WsChannel = 'signaling' | 'chat';
export type WsFrame = { type: string; [key: string]: unknown };
type Handler = (frame: WsFrame) => void;

const handlers = new Map<string, Set<Handler>>();

const key = (channel: WsChannel, type: string) => `${channel}:${type}`;

export function onWs(channel: WsChannel, type: string, handler: Handler): () => void {
  const k = key(channel, type);
  let set = handlers.get(k);
  if (!set) handlers.set(k, (set = new Set()));
  set.add(handler);
  return () => { set!.delete(handler); };
}

/** Returns true if at least one module handled the frame. */
export function publishWs(channel: WsChannel, frame: WsFrame): boolean {
  const types = [frame.type];
  if (frame.type === 'module_event' && typeof frame.event === 'string') types.push(`module:${frame.event}`);
  let handled = false;
  for (const t of types) {
    const set = handlers.get(key(channel, t));
    if (!set || set.size === 0) continue;
    handled = true;
    for (const h of set) {
      try { h(frame); } catch (e) { console.error(`[wsBus] ${channel}:${t} handler failed`, e); }
    }
  }
  return handled;
}
