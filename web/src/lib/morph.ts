// Where a page came from, so it can grow out of the thing that was tapped and shrink back into it
// (Material's container transform). Anything marked data-morph="<path>" counts: a tap on it, or on
// something inside it, notes its place on screen and a copy of how it looked.

export interface Origin {
  path: string;
  rect: DOMRect;
  radius: number;
  color: string;
  ghost: HTMLElement;
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
  last = { path: marked.dataset.morph!, rect: marked.getBoundingClientRect(), radius: radiusOf(marked), color: colorOf(marked), ghost: ghostOf(marked), inSheet: !!marked.closest('[role=dialog]'), at: Date.now() };
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => e.target instanceof Element && notePress(e.target), { capture: true });
}

/** The thing a page can shrink back into: the same row, if it's still on screen. */
export function findTarget(path: string, not: Element | null) {
  const vh = window.innerHeight;
  for (const el of document.querySelectorAll<HTMLElement>(`[data-morph="${CSS.escape(path)}"]`)) {
    if (not?.contains(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width && rect.bottom > 0 && rect.top < vh) return { el, rect, radius: radiusOf(el), color: colorOf(el), ghost: ghostOf(el) };
  }
  return null;
}

function radiusOf(el: Element) {
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

function ghostOf(el: HTMLElement) {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.removeAttribute('data-morph');
  copy.querySelectorAll('[data-morph]').forEach((e) => e.removeAttribute('data-morph'));
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  return copy;
}

/**
 * A spring as a CSS easing, for animations the browser runs on its own: Material's damping ratio
 * and stiffness (unit mass), sampled until it settles. Returns the easing and how long it takes.
 */
export function springEasing(dampingRatio: number, stiffness: number) {
  const w0 = Math.sqrt(stiffness);
  const zeta = dampingRatio;
  const x = (t: number) => {
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    }
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  };
  let end = 0.05;
  while (end < 3 && Math.abs(1 - x(end)) + Math.abs(1 - x(end + 0.016)) > 0.002) end += 0.016;
  const n = 40;
  const points = Array.from({ length: n + 1 }, (_, i) => +x((end * i) / n).toFixed(4));
  points[n] = 1;
  return { easing: `linear(${points.join(', ')})`, duration: Math.round(end * 1000) };
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
