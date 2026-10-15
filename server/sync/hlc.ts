// A hybrid logical clock: wall-clock milliseconds, a counter for changes in the same millisecond
// (or when another device's clock is ahead), and which device it was. Readings compare as plain
// strings, and every reading is later than any this device has made or seen.

const MS_WIDTH = 9;
const COUNTER_WIDTH = 4;
export const SITE_LENGTH = 8;

export function newSite(): string {
  let site = '';
  const bytes = crypto.getRandomValues(new Uint8Array(SITE_LENGTH));
  for (const b of bytes) site += (b % 36).toString(36);
  return site;
}

const format = (ms: number, counter: number, site: string) =>
  `${ms.toString(36).padStart(MS_WIDTH, '0')}.${counter.toString(36).padStart(COUNTER_WIDTH, '0')}.${site}`;

export function parse(hlc: string) {
  const [ms, counter, site] = hlc.split('.');
  return { ms: parseInt(ms!, 36), counter: parseInt(counter!, 36), site: site! };
}

export const siteOf = (hlc: string) => hlc.slice(-SITE_LENGTH);

export class Clock {
  private ms = 0;
  private counter = 0;
  readonly site: string;
  private readonly now: () => number;

  constructor(site: string, now: () => number = Date.now) {
    this.site = site;
    this.now = now;
  }

  /** A new reading, later than every one before it. */
  tick(): string {
    const wall = this.now();
    if (wall > this.ms) {
      this.ms = wall;
      this.counter = 0;
    } else this.counter++;
    return format(this.ms, this.counter, this.site);
  }

  /** Moves the clock past a reading from another device. */
  see(hlc: string | null | undefined) {
    if (!hlc) return;
    const { ms, counter } = parse(hlc);
    if (ms > this.ms || (ms === this.ms && counter > this.counter)) {
      this.ms = ms;
      this.counter = counter;
    }
  }
}
