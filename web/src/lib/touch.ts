// What a touch feels like, everywhere in the app at once: a ripple spreads from the finger over
// whatever was pressed (Material's ripple), and ticking something off, flipping a switch or picking
// one of a few choices clicks the phone (Android's own haptics). One set of listeners on the page,
// so every control has them, including ones added later.
import { motionChoices, reduced } from './motion-settings.ts';
import { haptic, type Feel } from './native.ts';

// The controls with a pressed state layer in styles.css, the same list.
const CONTROLS = [
  'button:not(:disabled)',
  'a[href]',
  "[role='button']:not([aria-disabled='true'])",
  "[role='radio']",
  "[role='checkbox']",
  "[role='switch']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  'summary',
  "label:has(> input:is([type='checkbox'], [type='radio'], [type='file'], [type='date']))",
  '.state-layer',
].join(',');
// One that draws no state layer (bg-none, such as a task's title in its row) leaves the press to
// the control it's in.
const LEAVES = '.bg-none, [data-no-ripple]';
// A touch ripples once the phone calls it a press, as Android's own lists do: the WebView marks the
// control pressed (:active) after the finger has stayed put about 100ms, and never for one that's
// starting to scroll. A quicker tap ripples as it lifts, and a mouse at once. Timers can't do this:
// the WebView holds them back while a touch starts, so 100ms comes out nearer 200. Checked each
// frame instead, with this as the latest it waits.
const PRESS_WAIT = 150;
// Further than this and it's a scroll or a swipe, not a press.
const SLOP = 10;
// Compose's ripple: it starts at 30% of the longer side and spreads to just past the farthest
// corner in 225ms, its middle drifting from the finger to the control's, while it fades in over
// 75ms. Let go, it finishes spreading and fades out over 150ms.
const SPREAD_MS = 225;
const FADE_IN_MS = 75;
const FADE_OUT_MS = 150;
const START = 0.3;
const PAST_CORNER = 10;

interface Ripple {
  release(): void;
  cancel(): void;
}

// How many ripples each control has going, and whether it was made relative to hold them.
const holding = new WeakMap<HTMLElement, { count: number; madeRelative: boolean }>();

function pressed(target: EventTarget | null): HTMLElement | null {
  let el = target instanceof Element ? target.closest<HTMLElement>(CONTROLS) : null;
  while (el?.matches(LEAVES)) el = el.parentElement?.closest<HTMLElement>(CONTROLS) ?? null;
  return el;
}

/** Marks the control as rippling, so its flat pressed tint stays off (styles.css). */
function hold(el: HTMLElement) {
  const h = holding.get(el);
  if (h) {
    h.count++;
    return true;
  }
  let madeRelative = false;
  if (getComputedStyle(el).position === 'static') {
    // Something placed inside it against an outer box would move: that one keeps the flat tint.
    for (const child of el.querySelectorAll('*')) if (getComputedStyle(child).position === 'absolute') return false;
    el.style.position = 'relative';
    madeRelative = true;
  }
  holding.set(el, { count: 1, madeRelative });
  el.dataset.ripple = '';
  return true;
}

function letGo(el: HTMLElement) {
  const h = holding.get(el);
  if (!h || --h.count > 0) return;
  holding.delete(el);
  delete el.dataset.ripple;
  if (h.madeRelative) el.style.position = '';
}

/** A ripple from where the finger is (in the page's pixels), clipped to the control's shape. */
function spread(el: HTMLElement, x: number, y: number): Ripple | null {
  const box = el.getBoundingClientRect();
  // The ripple sits inside the border; a control that's scaled (a row sinking) scales it too.
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (!w || !h || !box.width || !box.height) return null;
  const px = ((x - box.left) * el.offsetWidth) / box.width - el.clientLeft;
  const py = ((y - box.top) * el.offsetHeight) / box.height - el.clientTop;
  const radius = Math.hypot(w, h) / 2 + PAST_CORNER;

  const wrap = document.createElement('span');
  wrap.className = 'ripple';
  wrap.setAttribute('aria-hidden', 'true');
  // An empty checkbox's own color is transparent; its ripple is the text's color.
  if (getComputedStyle(el).color === 'rgba(0, 0, 0, 0)') wrap.style.color = 'var(--md-on-surface)';
  const dot = document.createElement('span');
  dot.style.width = dot.style.height = `${radius * 2}px`;
  wrap.append(dot);
  el.append(wrap);

  const grow = dot.animate(
    [
      { transform: `translate(${px - radius}px, ${py - radius}px) scale(${(START * Math.max(w, h)) / radius})` },
      { transform: `translate(${w / 2 - radius}px, ${h / 2 - radius}px)` },
    ],
    { duration: SPREAD_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
  );
  dot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN_MS, fill: 'forwards' });

  let gone = false;
  const fade = () => {
    if (gone) return;
    gone = true;
    const done = () => {
      wrap.remove();
      letGo(el);
    };
    wrap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_OUT_MS, fill: 'forwards' }).finished.then(done, done);
  };
  return { release: () => void grow.finished.then(fade, fade), cancel: fade };
}

/**
 * Starts the ripple and the clicks. The ripple can be turned off in Settings, Motion, and stays off
 * when the phone removes animations; the flat pressed tint shows instead.
 */
export function startTouch() {
  let press: { el: HTMLElement; id: number; x: number; y: number; at: number; frame?: number; ripple?: Ripple | null } | null = null;

  const begin = () => {
    if (!press || press.ripple !== undefined) return;
    cancelAnimationFrame(press.frame ?? 0);
    press.ripple = spread(press.el, press.x, press.y);
    if (!press.ripple) letGo(press.el);
  };
  const watch = () => {
    if (!press || press.ripple !== undefined) return;
    if (press.el.matches(':active') || performance.now() - press.at >= PRESS_WAIT) begin();
    else press.frame = requestAnimationFrame(watch);
  };
  const end = (cancelled: boolean) => {
    if (!press) return;
    cancelAnimationFrame(press.frame ?? 0);
    if (press.ripple === undefined) {
      if (cancelled) letGo(press.el);
      else begin();
    }
    if (cancelled) press.ripple?.cancel();
    else press.ripple?.release();
    press = null;
  };

  addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isPrimary || e.button !== 0 || !motionChoices().ripple || reduced()) return;
      end(true);
      const el = pressed(e.target);
      // Held from the touch on, so the flat tint never shows for a moment before the ripple.
      if (!el || !hold(el)) return;
      press = { el, id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() };
      if (e.pointerType === 'mouse') begin();
      else press.frame = requestAnimationFrame(watch);
    },
    { capture: true, passive: true },
  );
  addEventListener(
    'pointermove',
    (e) => {
      if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) end(true);
    },
    { capture: true, passive: true },
  );
  addEventListener('pointerup', (e) => press && e.pointerId === press.id && end(false), { capture: true, passive: true });
  addEventListener('pointercancel', (e) => press && e.pointerId === press.id && end(true), { capture: true, passive: true });

  // Before the control's own handler, so what it shows is still what it was.
  addEventListener(
    'click',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[role='checkbox'], [role='switch'], [role='radio'], [aria-pressed]") : null;
      if (!el || el.matches(":disabled, [aria-disabled='true']")) return;
      const role = el.getAttribute('role');
      const on = (el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed')) === 'true';
      // A picked choice picked again changes nothing; a toggle button clicks both ways.
      const feel: Feel | null = role === 'checkbox' ? (on ? 'undone' : 'done') : role === 'switch' ? (on ? 'off' : 'on') : role === 'radio' && on ? null : 'pick';
      if (feel) haptic(feel);
    },
    { capture: true },
  );
}
