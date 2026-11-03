// Joining a household's server by scanning a code instead of typing its address. The code holds
// a link to the app at that server, so a phone's camera opens Amble in the browser ready to join,
// and the Android app's scanner reads the server's address out of it, with the code that lets the
// device in (server/auth/pairing.ts) when there is one.
import { encode } from 'uqr';

/** What a code to join a server holds: the app it serves, opened at joining, with the code to get in. */
export const joinLink = (serverUrl: string, code?: string) => `${serverUrl.replace(/\/+$/, '')}/?join${code ? `=${code}` : ''}`;

/** The code to get in from a scanned join link, if it has one. */
export function joinCodeFrom(text: string): string | null {
  try {
    return new URL(text.trim()).searchParams.get('join') || null;
  } catch {
    return null;
  }
}

/** The server's address from a scanned code: a join link, or an address on its own. */
export function serverFromCode(text: string) {
  const raw = text.trim();
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || url.protocol === 'http:') return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    // Not a link: perhaps the address itself.
  }
  return raw;
}

/**
 * A QR code as one SVG path, a unit square for each dark module, with the four-module margin
 * scanners expect. `size` is the whole width, margin included, for the viewBox.
 */
export function qrPath(text: string): { d: string; size: number } {
  const { data, size } = encode(text, { ecc: 'M', border: 4 });
  let d = '';
  data.forEach((row, y) => {
    // Runs of dark modules along the row, one rectangle each.
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let end = x;
      while (row[end + 1]) end++;
      d += `M${x} ${y}h${end - x + 1}v1h-${end - x + 1}z`;
      x = end;
    }
  });
  return { d, size };
}
