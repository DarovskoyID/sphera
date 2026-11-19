// "Hide this bit" — the composer control that wraps the selected text in the
// spoiler markers.
//
// Typing `||…||` by hand works and is documented under Settings → Formatting,
// but nobody discovers it there, and it is fiddly on a phone where placing a
// caret is already the hard part. So the affordance appears where the decision
// is made: select the words to hide, and a button offers to hide them.
//
// It shows up only while there is a selection in the composer. A permanent
// button would be one more icon in a row that already has several, for
// something used a few times a month.

import { useEffect, useState } from 'react';
import { EyeOff } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';

const MARKER = '||';

interface Props {
  /** The composer this acts on. */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Its current text, and how to replace it. */
  value: string;
  onChange: (next: string) => void;
}

/** Where the selection is, or null when there is nothing selected. */
function selectionOf(el: HTMLTextAreaElement | null): { start: number; end: number } | null {
  if (!el || document.activeElement !== el) return null;
  const { selectionStart: start, selectionEnd: end } = el;
  if (start === null || end === null || start === end) return null;
  return { start, end };
}

export const HideSelectionButton: React.FC<Props> = ({ inputRef, value, onChange }) => {
  const tr = useTranslation();
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);

  // `selectionchange` is the only event that covers every way a selection can
  // be made — dragging, shift-arrows, double-click, the phone's own handles.
  // It fires on the document rather than the element, hence the filter.
  useEffect(() => {
    const sync = () => setSelection(selectionOf(inputRef.current));
    document.addEventListener('selectionchange', sync);
    // The composer may already hold a selection when this mounts.
    sync();
    return () => document.removeEventListener('selectionchange', sync);
  }, [inputRef]);

  // A selection that no longer fits the text is stale — the message was sent,
  // or cleared, and the offsets now point past the end.
  const active = selection && selection.end <= value.length ? selection : null;
  if (!active) return null;

  const hide = () => {
    const { start, end } = active;
    const chosen = value.slice(start, end);

    // Trailing whitespace inside the markers would be hidden along with the
    // words and leave a gap the reader cannot explain, so it stays outside.
    const leading = chosen.length - chosen.trimStart().length;
    const trailing = chosen.length - chosen.trimEnd().length;
    const inner = chosen.slice(leading, chosen.length - trailing);
    if (!inner) return;

    const from = start + leading;
    const to = end - trailing;
    onChange(`${value.slice(0, from)}${MARKER}${inner}${MARKER}${value.slice(to)}`);

    // Put the caret after the hidden run, with the selection kept, so a second
    // thought about which words to hide does not mean starting over.
    const el = inputRef.current;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(from + MARKER.length, to + MARKER.length);
    });
  };

  return (
    <button
      type="button"
      className="composer-icon-btn"
      title={tr('spoiler_hide_selection')}
      aria-label={tr('spoiler_hide_selection')}
      // The composer must not lose its selection to this click, or there would
      // be nothing left to hide by the time the handler runs.
      onMouseDown={e => e.preventDefault()}
      onClick={hide}
    >
      <EyeOff size={20} />
    </button>
  );
};
