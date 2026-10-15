// The in-process scheduler: once a minute it runs whatever background work is due. Each job
// decides for itself whether anything needs doing, so a missed tick (a restart, a slow Google)
// just means the next one catches up.

export interface Job {
  name: string;
  run: () => Promise<unknown>;
}

const TICK_MS = 60_000;
const FIRST_TICK_MS = 5000;

/** A job's work at most once per `ms`, for chores that don't need every minute. */
export function every(ms: number, run: () => unknown): () => Promise<unknown> {
  let last = 0;
  return async () => {
    if (Date.now() - last < ms) return;
    last = Date.now();
    return run();
  };
}

export function startJobs(jobs: Job[]) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const job of jobs) {
        try {
          await job.run();
        } catch (err) {
          console.warn(`Background job "${job.name}" failed:`, err instanceof Error ? err.message : err);
        }
      }
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, FIRST_TICK_MS);
  const every = setInterval(tick, TICK_MS);
  // On the server they mustn't keep the process alive; a browser's timers have no such thing.
  (first as { unref?: () => void }).unref?.();
  (every as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
