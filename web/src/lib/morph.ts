// Where a page came from, so it can grow out of the thing that was tapped and shrink back into it
// (Material's container transform). Anything marked data-morph="<path>" counts: a tap on it, or on
// something inside it, notes its place on screen.
import { reduced } from './motion-settings.ts';

export interface Origin {
  path: string;
  rect: DOMRect;
  radius: number;
  color: string;
  /** Tapped inside a sheet, which the page then has to cover. */
  inSheet: boolean;
  at: number;
}

let last: Origin | null = null;

/** What the person tapped to open `path`, if it was just now. */
export function peekOrigin(path: string): Origin | null {
  return last && last.path === path && Date.now() - last.at < 2000 ? last : null;
}

export function notePress(el: Element) {
  const marked = el.closest<HTMLElement>('[data-morph]');
  if (!marked) return;
  last = { path: marked.dataset.morph!, rect: marked.getBoundingClientRect(), radius: radiusOf(marked), color: colorOf(marked), inSheet: !!marked.closest('[role=dialog]'), at: Date.now() };
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => e.target instanceof Element && notePress(e.target), { capture: true });
}

/** The row a page grows out of or shrinks back into: the one for `path`, if it's on screen. */
export function findRow(path: string): HTMLElement | null {
  const vh = window.innerHeight;
  for (const el of document.querySelectorAll<HTMLElement>(`[data-morph="${CSS.escape(path)}"]`)) {
    const rect = el.getBoundingClientRect();
    if (rect.width && rect.bottom > 0 && rect.top < vh) return el;
  }
  return null;
}

/**
 * Morphs the page from one state to the next with the browser's View Transitions API: `from` (a
 * row, or an open page) becomes whatever `update` returns, which it gets by changing the page
 * (React's update included, with flushSync). The browser animates pictures of the two states on
 * its own, so building the new page never holds up a frame. The look is in styles.css, under
 * "card"; `kind` picks it. Without `from` the pages cross-fade, and without the API (or with the
 * phone's animations off) the page just changes.
 */
export function morph(kind: 'open' | 'close', from: HTMLElement | null, update: () => HTMLElement | null) {
  const start = typeof document !== 'undefined' && 'startViewTransition' in document ? document.startViewTransition.bind(document) : null;
  if (!start || reduced()) {
    // After the caller's own React work is done, which a flushSync inside it would trip over.
    queueMicrotask(update);
    return;
  }
  const root = document.documentElement;
  const mine = (latest = {});
  const spring = kind === 'open' ? OPEN : CLOSE;
  // With nothing to grow from or shrink into, the two pages just cross-fade.
  root.dataset.morph = from ? kind : 'fade';
  root.style.setProperty('--card-ms', `${spring.duration}ms`);
  root.style.setProperty('--card-easing', spring.easing);
  if (from) from.style.viewTransitionName = 'card';
  let to: HTMLElement | null = null;
  const vt = start(() => {
    if (from) from.style.viewTransitionName = '';
    to = update();
    if (to) to.style.viewTransitionName = 'card';
  });
  // Opening, the page travels from the row settled and only its size bounces: a bounce on the long
  // trip up would fling it under the status bar and back.
  let split: Animation[] = [];
  if (from && kind === 'open') void vt.ready.then(() => (split = splitBounce()), () => {});
  void vt.finished.finally(() => {
    for (const a of split) a.cancel();
    if (to) to.style.viewTransitionName = '';
    // A morph that started since (Back tapped mid-open, say) has the page's look now.
    if (latest === mine) delete root.dataset.morph;
  });
}

let latest = {};

/**
 * Opens or closes part of a page (More details, say) with the same API: each part marked
 * `data-unfold` glides to its new place, a part that's new fades in once there's room for it, one
 * that's going fades first, and a `data-unfold="box"` grows or shrinks around them. The browser
 * animates pictures of the parts, so the page's layout changes once rather than on every frame.
 * The look is in styles.css, under "unfold". `update` changes the page (React's flushSync).
 */
export function unfold(update: () => void) {
  const start = typeof document !== 'undefined' && 'startViewTransition' in document ? document.startViewTransition.bind(document) : null;
  if (!start || reduced()) return update();
  const root = document.documentElement;
  const mine = (latest = {});
  root.dataset.morph = 'unfold';
  root.style.setProperty('--card-ms', `${UNFOLD.duration}ms`);
  root.style.setProperty('--card-easing', UNFOLD.easing);
  void start(update).finished.finally(() => {
    if (latest === mine) delete root.dataset.morph;
  });
}

/**
 * A new set of colors for the whole app (Appearance) cross-fades in, rather than every surface
 * flipping in the same frame. The browser fades a picture of before into after; the look is in
 * styles.css, under "recolor".
 */
export function recolor(update: () => void) {
  const start = typeof document !== 'undefined' && 'startViewTransition' in document ? document.startViewTransition.bind(document) : null;
  if (!start || reduced()) return update();
  const root = document.documentElement;
  const mine = (latest = {});
  root.dataset.morph = 'recolor';
  void start(update).finished.finally(() => {
    if (latest === mine) delete root.dataset.morph;
  });
}

const OPEN = springEasing(0.68, 230);
// Material's expressive default spatial spring, as the parts of a page move.
const UNFOLD = springEasing(0.8, 380);
const TRAVEL = springEasing(0.92, 230);
const CLOSE = springEasing(0.85, 380);

/** Replaces the browser's own animation of the card with the same move on two springs. */
function splitBounce(): Animation[] {
  const pseudoElement = '::view-transition-group(card)';
  const own = document.getAnimations().find((a) => (a.effect as KeyframeEffect | null)?.pseudoElement === pseudoElement);
  const frames = (own?.effect as KeyframeEffect | undefined)?.getKeyframes();
  if (!own || !frames || frames.length < 2) return [];
  const [a, b] = [frames[0]!, frames.at(-1)!];
  own.cancel();
  const root = document.documentElement;
  return [
    root.animate({ transform: [a.transform as string, b.transform as string] }, { pseudoElement, ...TRAVEL, fill: 'both' }),
    root.animate({ width: [a.width as string, b.width as string], height: [a.height as string, b.height as string] }, { pseudoElement, ...OPEN, fill: 'both' }),
  ];
}

export function radiusOf(el: Element) {
  return parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
}

/** The first solid background in it, the row's own color. */
function colorOf(el: Element) {
  for (const e of [el, ...el.querySelectorAll(':scope > *, :scope > * > *')]) {
    const bg = getComputedStyle(e).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return getComputedStyle(document.body).backgroundColor;
}

/**
 * Material's spring (damping ratio and stiffness, unit mass) released from rest: where it is at a
 * time in seconds, 0 to 1 and past it as it overshoots, and how many seconds until it settles.
 */
export function spring(dampingRatio: number, stiffness: number) {
  const w0 = Math.sqrt(stiffness);
  const zeta = dampingRatio;
  const at = (t: number) => {
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    }
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  };
  let end = 0.05;
  while (end < 3 && Math.abs(1 - at(end)) + Math.abs(1 - at(end + 0.016)) > 0.002) end += 0.016;
  return { at, seconds: end };
}

/**
 * A spring as a CSS easing, for animations the browser runs on its own, sampled until it settles.
 * Returns the easing and how long it takes.
 */
export function springEasing(dampingRatio: number, stiffness: number) {
  const { at, seconds } = spring(dampingRatio, stiffness);
  const n = 40;
  const points = Array.from({ length: n + 1 }, (_, i) => +at((seconds * i) / n).toFixed(4));
  points[n] = 1;
  return { easing: `linear(${points.join(', ')})`, duration: Math.round(seconds * 1000) };
}

/** Material's emphasized easing, for things that move a long way across the screen. */
export const EMPHASIZED = 'cubic-bezier(0.2, 0, 0, 1)';
export const EMPHASIZED_ACCELERATE = 'cubic-bezier(0.3, 0, 0.8, 0.15)';

/** The open page's answer to a drag or the phone's back gesture: how far along, then go or stay. */
export interface StageGesture {
  start(kind: 'pull' | 'back', edge?: 'left' | 'right'): void;
  move(progress: number, dy?: number): void;
  /** False when no drag was under way. */
  end(commit: boolean): boolean;
}
let gesture: StageGesture | null = null;
export const stageGesture = () => gesture;
export function setStageGesture(g: StageGesture | null) {
  gesture = g;
}
