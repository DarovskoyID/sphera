import { handleBanFrame } from '../core/ban/banGuard';
import { wsUrlFor } from '../config/network';

export interface ModuleSocket {
  close(): void;
  /** Send a JSON frame; false while disconnected (the frame is not queued). */
  send(frame: unknown): boolean;
  readonly open: boolean;
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
  /** Connection state changes (connected / lost). */
  onStatus?: (open: boolean) => void;
  /** Extra subprotocols after the auth pair, e.g. a guest pass. */
  protocols?: string[];
}): ModuleSocket {
  let ws: WebSocket | null = null;
  let closed = false;
  let opened = false;
  let backoff = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    const auth = opts.token ? ['ionik.jwt', opts.token] : [];
    ws = new WebSocket(`${wsUrlFor(opts.serverIP)}${opts.path}`, [...auth, ...(opts.protocols ?? [])]);
    ws.onopen = () => {
      backoff = 1000;
      opts.onStatus?.(true);
      if (opened) opts.onReopen?.();
      opened = true;
    };
    ws.onmessage = ev => {
      try {
        const frame = JSON.parse(ev.data);
        if (frame && typeof frame.type === 'string' && !handleBanFrame(frame)) opts.onFrame(frame);
      } catch { /* not a frame */ }
    };
    ws.onclose = () => {
      opts.onStatus?.(false);
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
    send(frame) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    },
    get open() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
  };
}
