/**
 * A web link from what someone typed or pasted. "amazon.com/dp/123" gets https:// in front, the way
 * a browser's address bar reads it. Null when it can't be a web page: words with spaces, a host
 * with no dot, or another kind of link (mailto:, javascript:).
 */
export function webLink(text: string | null | undefined): string | null {
  const typed = text?.trim();
  if (!typed) return null;
  const full = /^[a-z][a-z\d+.-]*:\/\//i.test(typed) ? typed : /^[a-z][a-z\d+.-]*:(?!\d)/i.test(typed) ? null : `https://${typed}`;
  if (!full || !URL.canParse(full)) return null;
  const url = new URL(full);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.') || url.hostname.endsWith('.')) return null;
  return url.toString();
}
