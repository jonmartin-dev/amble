import { useMemo } from 'react';
import { joinLink, qrPath } from '../../../shared/qr.ts';

/**
 * A code that brings another phone to the household's server: scanned in the Amble app, or with the
 * phone's camera to open Amble in the browser. Dark on white whatever the theme, as scanners want.
 */
export function JoinCode({ url }: { url: string }) {
  const { d, size } = useMemo(() => qrPath(joinLink(url)), [url]);
  return (
    <figure className="flex flex-col items-center gap-3 rounded-3xl bg-surface-low p-5">
      <svg viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label={`Code to join ${new URL(url).host}`} className="size-52 rounded-2xl bg-white">
        <path d={d} fill="#000" />
      </svg>
      <figcaption className="text-center text-sm text-on-surface-variant">{new URL(url).host}</figcaption>
    </figure>
  );
}
