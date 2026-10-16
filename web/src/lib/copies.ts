// A copy of everything on this device as one file to keep, and putting one back in place of
// what's here (server/domain/copies.ts does the work, in the device's worker).
import { Capacitor } from '@capacitor/core';
import { deviceFetch } from './device.ts';
import { saveFile } from './native.ts';

async function failure(res: Response, fallback: string) {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? fallback);
}

/** Saves a copy: on Android where the person picks, in a browser to its downloads. False when they backed out. */
export async function saveCopy(): Promise<boolean> {
  const res = await deviceFetch('/copy');
  if (!res.ok) throw await failure(res, "Couldn't make a copy. Try again.");
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'amble.amble';
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (Capacitor.isNativePlatform()) return saveFile(name, 'application/octet-stream', bytes);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/** Puts a saved copy in place of everything on this device, then starts the app again on it. */
export async function restoreCopy(file: File) {
  const res = await deviceFetch('/copy', { method: 'POST', body: await file.arrayBuffer() });
  if (!res.ok) throw await failure(res, "That copy couldn't be restored.");
  location.reload();
}
