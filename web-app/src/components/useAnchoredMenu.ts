import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Positioning for a menu that pops up at a point — a right-click menu, a
 * long-press menu, an overflow menu.
 *
 * Every one of these has the same three problems, and every copy of the code
 * solved only the first:
 *
 *   1. It must not run off the edge of the window. Clamping the top-left
 *      corner is not enough on its own: once a menu is taller than the space
 *      under the cursor, clamping slides it up so far that it covers the very
 *      message it belongs to.
 *   2. So it flips above the cursor when there is more room there, and only
 *      falls back to clamping — with a scrollbar — when neither side fits.
 *   3. `position: fixed` is relative to the nearest ancestor with a transform,
 *      filter or backdrop-filter, NOT to the window. The chat panel has one,
 *      which is why a menu clamped against `window.innerHeight` still came out
 *      past the bottom of the app. Rendering through a portal to `document.body`
 *      is what makes the viewport coordinates mean what they say.
 *
 * The measurement re-runs whenever the menu changes size, so a submenu opening
 * inside it re-flips instead of growing off-screen.
 */

const MARGIN = 8;

interface Anchor {
  x: number;
  y: number;
}

export interface AnchoredMenu {
  /**
   * Attach to the menu element. Typed non-nullable to match what `ref={}`
   * accepts under the React 18 types this project uses — `useRef<T>(null)`
   * already produces exactly that.
   */
  ref: React.RefObject<HTMLDivElement>;
  /** Position, size cap and overflow — spread onto the menu's own style. */
  style: React.CSSProperties;
  /** Wrap the menu element in this to escape any transformed ancestor. */
  portal: (node: React.ReactNode) => React.ReactPortal | null;
}

/**
 * @param ignore Element that must NOT count as "outside" — the button that
 *   opened the menu. Without it a click on that button closes the menu here and
 *   the button's own handler reopens it, so the menu never appears to shut.
 */
export function useAnchoredMenu(
  anchor: Anchor | null,
  onClose: () => void,
  ignore?: React.RefObject<HTMLElement | null>,
): AnchoredMenu {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<React.CSSProperties>({
    // Off-screen for the first paint: the element has to be laid out before it
    // can be measured, and this way that measuring pass is never visible.
    top: -9999,
    left: -9999,
  });

  const place = useCallback(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    // Measure the natural size, not whatever a previous pass capped it to.
    const width = el.offsetWidth;
    const height = el.scrollHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const below = vh - anchor.y - MARGIN;
    const above = anchor.y - MARGIN;

    let top: number;
    let maxHeight: number | undefined;
    if (height <= below) {
      top = anchor.y;                       // fits under the cursor
    } else if (height <= above) {
      top = anchor.y - height;              // flip up
    } else if (above > below) {
      top = MARGIN;                         // taller than both: use the roomier
      maxHeight = above;                    // side and let it scroll
    } else {
      top = anchor.y;
      maxHeight = below;
    }

    // Horizontally: open to the right, flip left when that would overflow, and
    // clamp as a last resort for a menu wider than the window.
    let left = anchor.x;
    if (left + width > vw - MARGIN) left = anchor.x - width;
    left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - width - MARGIN));

    setPlacement({
      top: Math.max(MARGIN, top),
      left,
      ...(maxHeight ? { maxHeight, overflowY: 'auto' } : null),
    });
  }, [anchor]);

  useLayoutEffect(() => {
    place();
    const el = ref.current;
    if (!el) return;
    // A submenu opening inside the menu changes its height; re-place so it
    // flips rather than growing past the bottom of the window.
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [place]);

  useEffect(() => {
    if (!anchor) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ignore?.current?.contains(target)) return;
      if (ref.current && !ref.current.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose, ignore]);

  const portal = useCallback(
    (node: React.ReactNode) => (typeof document === 'undefined' ? null : createPortal(node, document.body)),
    [],
  );

  return { ref, style: { position: 'fixed', zIndex: 9000, ...placement }, portal };
}
