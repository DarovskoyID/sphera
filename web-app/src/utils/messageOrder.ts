// Message ordering.
//
// A conversation must read strictly oldest-to-newest by timestamp, never by
// the order things happened to reach the client. Messages can arrive late or
// out of order — a gateway replaying what was missed while offline, a second
// device syncing, a slow delivery — and appending those to the end puts an old
// message under today's, which also throws off the date dividers (they are
// derived from the array order).
//
// Ordering is numeric, not lexicographic: `created_at` strings are only
// comparable as text when every one of them uses an identical format, and a
// stray offset ("+03:00" vs "Z") or differing fractional-second precision
// silently breaks that.

interface Ordered {
  id: string | number;
  created_at: string;
}

function timeOf(m: Ordered): number {
  const t = Date.parse(m.created_at);
  // An unparseable timestamp sorts last rather than poisoning the comparison
  // with NaN, which would leave the whole array in an arbitrary order.
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

/**
 * Sort oldest first. Messages sharing a timestamp fall back to their id so the
 * result is deterministic — otherwise two messages sent in the same
 * millisecond could swap places on every re-render.
 */
export function sortByDate<T extends Ordered>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const d = timeOf(a) - timeOf(b);
    if (d !== 0) return d;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Add one message and keep the list ordered. Appending is the common case
 * (the message really is the newest), so that path avoids a full sort.
 */
export function insertByDate<T extends Ordered>(list: T[], msg: T): T[] {
  const last = list[list.length - 1];
  if (!last || timeOf(msg) >= timeOf(last)) return [...list, msg];
  return sortByDate([...list, msg]);
}
