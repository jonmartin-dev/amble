// Messages between the app and the worker that runs Amble's API on the device.
import type { PushMessage } from '../../../server/notify/devices.ts';

export type ToWorker =
  | { type: 'init'; basePath: string; userAgent: string }
  | { type: 'request'; id: number; method: string; path: string; headers: [string, string][]; body: string | Blob | ArrayBuffer | null }
  /** Whether a notification the worker asked for was shown. */
  | { type: 'notified'; id: number; ok: boolean };

export type FromWorker =
  | { type: 'ready' }
  /** Another tab has Amble's database open; this one waits for it. */
  | { type: 'busy' }
  | { type: 'failed'; message: string }
  | { type: 'response'; id: number; status: number; headers: [string, string][]; body: ArrayBuffer | null; streaming?: boolean }
  /** The next piece of a response sent as it's written (streaming above), then its end. */
  | { type: 'chunk'; id: number; data: ArrayBuffer }
  | { type: 'end'; id: number; error?: string }
  /** A reminder is due: show it, then say whether that worked. */
  | { type: 'notify'; id: number; message: PushMessage }
  /** Something changed in the background (a size guess, the morning's suggestions): refresh. */
  | { type: 'changed' };
