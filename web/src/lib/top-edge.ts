// What the top of the screen does once a page has scrolled up under a phone's status bar. Picked
// in Appearance while the looks are being tried out, on this device only. styles.css draws each
// one (data-edge on the page), and TopBar shows the page's name in the last.
import { useEffect, useSyncExternalStore, type RefObject } from 'react';

export const EDGES = [
  ['fade', 'Fade', 'The page fades out just below the status bar'],
  ['solid', 'Clean edge', "The page slides under the status bar's own color, with nothing added"],
  ['line', 'Thin line', 'A hairline shows under the status bar'],
  ['tonal', 'Tinted bar', "The status bar takes a deeper tone, like Android's own apps"],
  ['title', "Tinted bar with the page's name", 'The same, and the name moves up into it once the big title has gone'],
] as const;

export type Edge = (typeof EDGES)[number][0];

const KEY = 'amble.top-edge';

function load(): Edge {
  try {
    const saved = localStorage.getItem(KEY);
    return EDGES.find(([id]) => id === saved)?.[0] ?? 'fade';
  } catch {
    return 'fade';
  }
}

let current = load();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Puts the picked look on the page, before the first paint. */
export function applyEdge() {
  document.documentElement.dataset.edge = current;
}

export function setEdge(edge: Edge) {
  current = edge;
  try {
    localStorage.setItem(KEY, edge);
  } catch {
    // Private browsing: it lasts until the app closes.
  }
  applyEdge();
  notify();
}

export function useEdge() {
  return useSyncExternalStore(subscribe, () => current);
}

/** Each page's big title while the page is built and running, for the bar to show once it's gone. */
export interface BarTitle {
  el: HTMLElement;
  text: string;
}
let titles: readonly BarTitle[] = [];

/** Offers a page's big title (the heading `ref` points at) to the bar. */
export function useBarTitle(ref: RefObject<HTMLElement | null>, text: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !text) return;
    const title = { el, text };
    titles = [...titles, title];
    notify();
    return () => {
      titles = titles.filter((t) => t !== title);
      notify();
    };
  }, [ref, text]);
}

export function useBarTitles() {
  return useSyncExternalStore(subscribe, () => titles);
}
