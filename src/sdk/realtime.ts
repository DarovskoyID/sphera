import { wsUrlFor } from '../config/network';

export interface ModuleSocket {
  close(): void;
}

/**
 * A reconnecting WebSocket to a module endpoint (`/ws/m/<module>/...`), authenticated
 * the same way as core sockets. `onReopen` fires after every reconnect so the caller
 * can re-read what it missed while offline.
 */
export function openModuleSocket(opts: {
  serverIP: string;
  token: string;
  path: string;
  onFrame: (frame: { type: string; [k: string]: unknown }) => void;
  onReopen?: () => void;
}): ModuleSocket {
  let ws: WebSocket | null = null;
  let closed = false;
  let opened = false;
  let backoff = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    ws = new WebSocket(`${wsUrlFor(opts.serverIP)}${opts.path}`, ['ionik.jwt', opts.token]);
    ws.onopen = () => {
      backoff = 1000;
      if (opened) opts.onReopen?.();
      opened = true;
    };
    ws.onmessage = ev => {
      try {
        const frame = JSON.parse(ev.data);
        if (frame && typeof frame.type === 'string') opts.onFrame(frame);
      } catch { /* not a frame */ }
    };
    ws.onclose = () => {
      if (closed) return;
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
  };
  connect();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
