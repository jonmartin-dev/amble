// The motion still being tried out: how smart add looks while it reads, picked in Settings while
// Jon tries the choices, and the extras, each on for now. Once he's settled, this file goes.
import { useSyncExternalStore } from 'react';

export const READ_CHOICES = [
  ['now', 'Shimmer'],
  ['along', 'Reads along'],
  ['cards', 'Cards on the way'],
  ['shape', 'Big shape'],
] as const;

export const TOGGLES = [
  ['pull', 'Pull a task down to close it'],
  ['back', 'Back gesture shrinks the page'],
  ['morphAdd', '+ grows into the add sheet'],
  ['press', 'Rows sink in when pressed'],
  ['finish', 'Finishing sweeps the row'],
  ['swipePop', 'Swipes pop and tick at the line'],
  ['cascade', 'Rows cascade in'],
] as const;

export type Motion = { read: (typeof READ_CHOICES)[number][0] } & { [K in (typeof TOGGLES)[number][0]]: boolean };

const DEFAULTS: Motion = {
  read: 'along',
  pull: true,
  back: true,
  morphAdd: true,
  press: true,
  finish: true,
  swipePop: true,
  cascade: true,
};
// A new name from the first round's, so everything starts on again.
const KEY = 'amble.motion-try';

function load(): Motion {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Motion>) };
  } catch {
    return DEFAULTS;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function motionChoices() {
  return current;
}

export function setMotion(patch: Partial<Motion>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private browsing: it lasts until the app closes.
  }
  listeners.forEach((l) => l());
}

export function useMotion() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Whether animations are wanted at all (the phone's "remove animations" setting). */
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
