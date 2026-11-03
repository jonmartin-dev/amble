import { useMemo, useState } from 'react';
import { qrPath } from '../../../shared/qr.ts';
import { api, ApiError } from '../lib/api.ts';

interface Made {
  code: string;
  link: string;
  expiresAt: string;
  forMe: boolean;
}

/** A link as a QR code, dark on white whatever the theme, as scanners want. */
function Qr({ link, label }: { link: string; label: string }) {
  const { d, size } = useMemo(() => qrPath(link), [link]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label={label} className="size-52 rounded-2xl bg-white">
      <path d={d} fill="#000" />
    </svg>
  );
}

/**
 * Another phone or computer joining the household's server: a code for this person's own, or for
 * someone new (an admin's to make), from the server. Scanned in the Amble app, opened with a phone's
 * camera, or typed with the address. Each works once, for 10 minutes.
 */
export function JoinCode({ url, admin }: { url: string; admin: boolean }) {
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = new URL(url).host;

  const make = async (forMe: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<Omit<Made, 'forMe'>>('/sync/server/settings/codes', { method: 'POST', body: JSON.stringify({ for: forMe ? 'me' : 'someone' }) });
      setMade({ ...res, forMe });
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Couldn't make a code just now.");
    } finally {
      setBusy(false);
    }
  };

  const until = made ? new Date(made.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  const primary = 'rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-on-primary disabled:opacity-40';
  const tonal = 'rounded-full bg-secondary-container px-5 py-2.5 text-sm font-medium text-on-secondary-container disabled:opacity-40';

  return (
    <div className="flex flex-col gap-3">
      {made && (
        <figure className="flex flex-col items-center gap-3 rounded-3xl bg-surface-low p-5">
          <Qr link={made.link} label={`Code to join ${host}`} />
          <p className="display text-3xl font-medium tracking-widest" aria-label={`Code ${made.code.split('').join(' ')}`}>
            {made.code}
          </p>
          <figcaption className="text-center text-sm text-on-surface-variant">
            In Amble on the new phone, choose Use my own server, then Scan the code. A phone’s camera opens Amble in the browser from it too, or type{' '}
            {host} and the code. It {made.forMe ? 'signs in as you' : 'brings in someone new'}, works once, and lasts until {until}.
          </figcaption>
        </figure>
      )}
      {error && <p className="rounded-3xl bg-warm-container p-4 text-sm text-on-warm-container">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void make(true)} className={made ? tonal : primary}>
          {made?.forMe ? 'Another code for me' : 'A code for me'}
        </button>
        {admin && (
          <button type="button" disabled={busy} onClick={() => void make(false)} className={tonal}>
            {made && !made.forMe ? 'Another for someone new' : 'For someone new'}
          </button>
        )}
      </div>
    </div>
  );
}
