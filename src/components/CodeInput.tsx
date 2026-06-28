import { useRef } from 'react';

export const CODE_LENGTH = 6;

interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  disabled?: boolean;
  /** Called when the last box is filled and the whole code is complete. */
  onComplete?: (value: string) => void;
}

// Only digits + letters; the backend normalises to uppercase, so we do too.
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

/**
 * OTP-style code entry: one box per character. Typing auto-advances, Backspace
 * steps back, arrows navigate, and pasting the whole code fills every box at
 * once (paste works from any box, not just the first).
 */
export const CodeInput = ({
  value, onChange, length = CODE_LENGTH, disabled, onComplete,
}: CodeInputProps) => {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const chars = Array.from({ length }, (_, i) => value[i] ?? '');

  const commit = (next: string) => {
    const v = sanitize(next).slice(0, length);
    onChange(v);
    if (v.length === length) onComplete?.(v);
  };

  const focusBox = (i: number) => {
    const el = boxes.current[Math.max(0, Math.min(length - 1, i))];
    el?.focus();
    el?.select();
  };

  // Write `text` (one or many chars) starting at box `start`.
  const writeFrom = (start: number, text: string) => {
    const s = sanitize(text);
    if (!s) return;
    const arr = value.split('');
    while (arr.length < length) arr.push('');
    let j = start;
    for (const ch of s) {
      if (j >= length) break;
      arr[j] = ch;
      j++;
    }
    commit(arr.join(''));
    focusBox(j);
  };

  const handleChange = (i: number, raw: string) => {
    if (raw === '') {
      // Cleared via selection/delete.
      const arr = value.split('');
      while (arr.length < length) arr.push('');
      arr[i] = '';
      commit(arr.join(''));
      return;
    }
    writeFrom(i, raw);
  };

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const arr = value.split('');
      while (arr.length < length) arr.push('');
      if (arr[i]) {
        arr[i] = '';
        commit(arr.join(''));
      } else if (i > 0) {
        arr[i - 1] = '';
        commit(arr.join(''));
        focusBox(i - 1);
      }
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault();
      focusBox(i - 1);
    } else if (e.key === 'ArrowRight' && i < length - 1) {
      e.preventDefault();
      focusBox(i + 1);
    }
  };

  const handlePaste = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    // A full-code paste should always fill from the start.
    const text = e.clipboardData.getData('text');
    writeFrom(sanitize(text).length >= length ? 0 : i, text);
  };

  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
      {chars.map((c, i) => (
        <input
          key={i}
          ref={el => { boxes.current[i] = el; }}
          type="text"
          inputMode="text"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`Code character ${i + 1}`}
          maxLength={1}
          value={c}
          disabled={disabled}
          autoFocus={i === 0}
          onChange={e => handleChange(i, e.target.value)}
          onKeyDown={e => handleKeyDown(i, e)}
          onPaste={e => handlePaste(i, e)}
          onFocus={e => {
            e.target.select();
            e.target.style.borderColor = 'var(--accent-primary)';
            e.target.style.boxShadow = '0 0 0 3px var(--glass-shadow)';
          }}
          onBlur={e => {
            e.target.style.boxShadow = 'none';
            e.target.style.borderColor = c ? 'var(--accent-primary)' : 'var(--border-color)';
          }}
          style={{
            width: 46,
            height: 56,
            textAlign: 'center',
            fontSize: 24,
            fontWeight: 700,
            color: 'var(--text-primary)',
            background: 'var(--bg-primary)',
            border: `1.5px solid ${c ? 'var(--accent-primary)' : 'var(--border-color)'}`,
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
            caretColor: 'var(--accent-primary)',
            textTransform: 'uppercase',
            transition: 'border-color 0.15s, box-shadow 0.15s',
          }}
        />
      ))}
    </div>
  );
};
