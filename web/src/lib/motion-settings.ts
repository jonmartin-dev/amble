// Settings, Motion: the gestures and touches each person can turn off on this device. All start on.
import { useSyncExternalStore } from 'react';

export const TOGGLES = [
  ['pull', 'Pull down to close', 'Drag an open task or list down to put it away'],
  ['back', 'Back swipe shrinks the page', "The page follows your finger as you swipe back, and springs back if you don't"],
  ['morphAdd', '+ grows into the add sheet', 'The button opens out into the sheet'],
  ['press', 'Rows sink when pressed', 'A row gives a little under your finger'],
  ['finish', 'Finishing sweeps the row', 'Color sweeps across a task as you tick it off, and a line draws through it'],
  ['swipePop', 'Swipes pop at the line', 'A swipe’s icon pops, and the phone ticks, once letting go will act'],
  ['cascade', 'Rows cascade in', 'A page’s rows arrive one after another'],
] as const;

export type Motion = { [K in (typeof TOGGLES)[number][0]]: boolean };

const DEFAULTS: Motion = {
  pull: true,
  back: true,
  morphAdd: true,
  press: true,
  finish: true,
  swipePop: true,
  cascade: true,
};
// The name from while these were being tried out, so what someone turned off then stays off.
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
