import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Long-press as a stand-in for right-click on touch.
 *
 * Desktop has `contextmenu`; touch has nothing equivalent, and the browser's
 * own long-press gesture is spoken for. On an element marked `draggable`,
 * Android Chrome starts a native drag on long-press and never fires
 * `contextmenu` at all — which is why the context menus on the server bar and
 * the channel list were unreachable on a phone.
 *
 * So the press is timed here instead, and `useIsTouch` below lets the caller
 * drop `draggable` on touch devices, where HTML5 drag-and-drop does not work
 * anyway. Nothing is taken away from desktop.
 */
export function useLongPress(onFire: (x: number, y: number) => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  useEffect(() => cancel, [cancel]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    fired.current = false;
    origin.current = { x: t.clientX, y: t.clientY };
    cancel();
    timer.current = setTimeout(() => {
      fired.current = true;
      onFire(t.clientX, t.clientY);
    }, ms);
  }, [cancel, ms, onFire]);

  // A press that turns into a scroll is not a long press. Ten pixels of slop
  // keeps a resting thumb from cancelling it.
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    const from = origin.current;
    if (!t || !from) return;
    if (Math.abs(t.clientX - from.x) > 10 || Math.abs(t.clientY - from.y) > 10) cancel();
  }, [cancel]);

  const onTouchEnd = useCallback(() => cancel(), [cancel]);

  // Some browsers fire contextmenu after our timer already opened the menu;
  // swallowing it stops the menu being opened twice.
  const onContextMenuCapture = useCallback((e: React.SyntheticEvent) => {
    if (fired.current) e.preventDefault();
  }, []);

  // The tap that ends a long press must not also count as a click, or letting
  // go would open the very thing the menu is offering to act on.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (fired.current) { e.preventDefault(); e.stopPropagation(); fired.current = false; }
  }, []);

  return { onTouchStart, onTouchMove, onTouchEnd, onContextMenuCapture, onClickCapture };
}

/**
 * The second half of the touch gesture: keep holding and the press becomes a
 * drag.
 *
 * `useLongPress` opens the context menu at half a second. Hold past a second
 * and `onArm` fires — the caller closes that menu and takes over the finger,
 * because HTML5 drag-and-drop does not exist on touch and the reorder has to
 * be tracked by hand from there.
 *
 * Sliding before the second is up cancels: at that point the menu is open and
 * a moving finger means the list is being scrolled, not an icon dragged.
 */
export function useDragArm(onArm: (x: number, y: number) => void, ms = 1000) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armed = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  useEffect(() => cancel, [cancel]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    armed.current = false;
    origin.current = { x: t.clientX, y: t.clientY };
    cancel();
    timer.current = setTimeout(() => {
      armed.current = true;
      onArm(t.clientX, t.clientY);
    }, ms);
  }, [cancel, ms, onArm]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    const from = origin.current;
    if (!t || !from || armed.current) return;
    if (Math.abs(t.clientX - from.x) > 10 || Math.abs(t.clientY - from.y) > 10) cancel();
  }, [cancel]);

  const onTouchEnd = useCallback(() => cancel(), [cancel]);

  // Letting go at the end of a drag must not also count as a tap on whatever
  // the icon opens.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (armed.current) { e.preventDefault(); e.stopPropagation(); armed.current = false; }
  }, []);

  return { onTouchStart, onTouchMove, onTouchEnd, onClickCapture };
}

/** True on a device whose primary input is a finger. */
export function useIsTouch(): boolean {
  const [touch, setTouch] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setTouch(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return touch;
}

/**
 * Styles that stop the OS claiming the gesture first: no text selection, no
 * iOS callout bubble, no double-tap zoom.
 */
export const LONG_PRESS_SAFE: React.CSSProperties = {
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
  touchAction: 'manipulation',
};
