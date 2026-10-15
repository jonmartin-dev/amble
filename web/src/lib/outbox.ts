// Changes waiting to reach the server. The app adds each change here and shows it straight away;
// the outbox sends them in the order they were made, from the app or, once the app is closed, from
// the service worker. Each carries a key so a resend is never applied twice, and its age so a
// change made offline doesn't overwrite one someone made after it.
import { FAILED, OUTBOX, tx } from './idb.ts';

export interface Op {
  seq?: number;
  /** Idempotency key: the server keeps its first answer for it. */
  key: string;
  /** Who made it. Only sent while that person is signed in. */
  memberId: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  /** Under /api, e.g. "/tasks/<id>/complete". */
  path: string;
  body?: unknown;
  /** When it was made (ms since epoch). */
  at: number;
  /** What it was, for messages: "Finish Water the plants". */
  label: string;
}

export interface Failure {
  seq?: number;
  label: string;
  message: string;
  at: number;
}

/** Why sending stopped with changes still waiting. */
export type Blocked = 'offline' | 'server' | 'signed-out' | 'busy';

export interface FlushResult {
  sent: Op[];
  failed: Failure[];
  blocked: Blocked | null;
}

const SEND_TIMEOUT_MS = 15_000;

export const addOp = (op: Op) => tx<IDBValidKey>(OUTBOX, 'readwrite', (s) => s.add(op));
export const listOps = () => tx<Op[]>(OUTBOX, 'readonly', (s) => s.getAll());
export const countOps = () => tx<number>(OUTBOX, 'readonly', (s) => s.count());
export const clearOps = () => tx(OUTBOX, 'readwrite', (s) => void s.clear());
const removeOp = (seq: number) => tx(OUTBOX, 'readwrite', (s) => void s.delete(seq));

const addFailure = (f: Failure) => tx(FAILED, 'readwrite', (s) => void s.add(f));
/** Changes the server turned down, oldest first, removed as they're read. */
export async function takeFailures(): Promise<Failure[]> {
  const all = await tx<Failure[]>(FAILED, 'readonly', (s) => s.getAll());
  if (all.length) await tx(FAILED, 'readwrite', (s) => void s.clear());
  return all;
}

/** One sender at a time across the app's tabs and its service worker. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  return locks ? locks.request('almanac-outbox', fn) : fn();
}

/**
 * Sends waiting changes in order until none are left or something stops it. A change the server
 * turns down is dropped and reported; anything that might work later (no connection, a server
 * error) stops the queue so later changes don't overtake it.
 */
export function flush(send: (path: string, init: RequestInit) => Promise<Response>): Promise<FlushResult> {
  return exclusive(async () => {
    const result: FlushResult = { sent: [], failed: [], blocked: null };
    for (const op of await listOps()) {
      let res: Response;
      try {
        res = await send(op.path, {
          method: op.method,
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': op.key,
            'Almanac-Member': op.memberId,
            'Almanac-Age': String(Math.max(0, Date.now() - op.at)),
          },
          body: op.body === undefined ? undefined : JSON.stringify(op.body),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        result.blocked = 'offline';
        return result;
      }
      if (res.ok) {
        await removeOp(op.seq!);
        result.sent.push(op);
        continue;
      }
      const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      if (res.status === 401) result.blocked = 'signed-out';
      else if (res.status === 409 && body?.code === 'in-progress') result.blocked = 'busy';
      else if (res.status >= 500 || res.status === 408 || res.status === 429) result.blocked = 'server';
      if (result.blocked) return result;
      const failure = { label: op.label, message: body?.error ?? `The server said no (${res.status}).`, at: Date.now() };
      await removeOp(op.seq!);
      await addFailure(failure);
      result.failed.push(failure);
    }
    return result;
  });
}
