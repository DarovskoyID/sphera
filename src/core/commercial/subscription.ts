/** Format the API's absolute expiration time in the viewer's local timezone. */
export function formatSubscriptionExpiry(value: string | null | undefined, language: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(language, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(date);
}
