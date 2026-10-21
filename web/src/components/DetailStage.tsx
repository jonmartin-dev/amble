import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { reduced } from '../lib/motion-demo.ts';
import { EMPHASIZED, findTarget, setStageGesture, springEasing, stageGesture, type Origin, type StageGesture } from '../lib/morph.ts';
import { setBackGesture } from '../lib/native.ts';

/**
 * A task or list on a phone, opened over the page it came from. While it opens, closes or follows
 * a finger it floats above that page (which stays as it was, scrolled where it was); the rest of
 * the time it sits in the page's place like any other page, so the keyboard, sheets and scrolling
 * work as they always have.
 */
interface Props {
  path: string;
  origin: Origin | null;
  /** Floating over the page beneath, rather than in its place. Root shows that page while it's on. */
  overlay: boolean;
  setOverlay: (on: boolean) => void;
  /** False when it takes the place of another open page, which it does without moving. */
  entering: boolean;
  leaving: boolean;
  onGone: () => void;
  /** Leave the page: a drag or the back gesture went far enough. */
  onBack: () => void;
  /** Take the phone's back gesture, so the page can follow it. */
  backGesture: boolean;
  pull: boolean;
  children: ReactNode;
}

// The same layout as the page column in main (main.tsx), so floating and in place look the same.
const COLUMN = 'mx-auto max-w-xl px-4 pb-36 medium:max-w-2xl medium:px-6 medium:pb-12';
const SCRIM = 0.32;

export function DetailStage({ path, origin, overlay, setOverlay, entering, leaving, onGone, onBack, backGesture, pull, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const floating = useRef(overlay);
  floating.current = overlay;
  // Where each page was scrolled: the one beneath (the window, while this is in its place) and this.
  const listScroll = useRef(0);
  const detailY = useRef(0);
  const handoff = useRef<'float' | 'settle' | null>(null);
  const phase = useRef<'entering' | 'still' | 'dragging' | 'leaving'>('entering');
  const running = useRef<Animation[]>([]);
  const ghost = useRef<HTMLElement | null>(null);
  const gesture = useRef<{ kind: 'pull' | 'back'; edge: 'left' | 'right'; progress: number } | null>(null);
  const z = origin?.inSheet ? 35 : 9;

  const stop = () => {
    for (const a of running.current) {
      try {
        a.commitStyles();
      } catch {
        // An element that's gone keeps nothing.
      }
      a.cancel();
    }
    running.current = [];
  };
  const dropGhost = () => {
    ghost.current?.remove();
    ghost.current = null;
  };
  const clear = () => {
    for (const el of [box.current, inner.current, scrim.current]) {
      if (!el) continue;
      el.style.transform = '';
      el.style.clipPath = '';
      el.style.opacity = '';
      el.style.backgroundColor = '';
      el.style.transformOrigin = '';
      el.style.translate = '';
      el.style.scale = '';
    }
  };
  const float = () => {
    if (floating.current) return;
    detailY.current = window.scrollY;
    handoff.current = 'float';
    setOverlay(true);
  };
  const settle = () => {
    stop();
    dropGhost();
    clear();
    phase.current = 'still';
    if (!floating.current) return;
    listScroll.current = window.scrollY;
    detailY.current = box.current?.scrollTop ?? 0;
    handoff.current = 'settle';
    setOverlay(false);
  };

  // Moving between floating and in place: each page keeps where it was scrolled.
  useLayoutEffect(() => {
    const step = handoff.current;
    handoff.current = null;
    if (step === 'float' && overlay) {
      if (box.current) box.current.scrollTop = detailY.current;
      window.scrollTo(0, listScroll.current);
      // The page beneath was hidden; it shows as it was rather than rising in again.
      beneath()
        ?.getAnimations({ subtree: true })
        .forEach((a) => a.finish());
    } else if (step === 'settle' && !overlay) {
      window.scrollTo(0, detailY.current);
    }
  }, [overlay]);

  // Opening.
  useLayoutEffect(() => {
    listScroll.current = window.scrollY;
    const b = box.current!;
    const i = inner.current!;
    if (reduced() || !entering) return settle();
    const moves = enter(origin, b, i, scrim.current!, ghost);
    running.current = moves;
    void Promise.all(moves.map((a) => a.finished)).then(
      () => phase.current === 'entering' && settle(),
      () => {},
    );
    return () => {
      for (const a of moves) a.cancel();
      dropGhost();
    };
    // Only on the way in; it's the same page from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing: floating first, then back into the row it came from.
  const left = useRef(false);
  useLayoutEffect(() => {
    if (!leaving || left.current) return;
    phase.current = 'leaving';
    if (!floating.current) return float();
    left.current = true;
    stop();
    dropGhost();
    if (reduced()) return onGone();
    running.current = leave(path, box.current!, inner.current!, scrim.current, ghost);
    void Promise.all(running.current.map((a) => a.finished)).then(onGone, () => {});
  }, [leaving, overlay, path, onGone]);

  // A drag or the back gesture: the page shrinks as it goes, then goes or comes back.
  useEffect(() => {
    const g: StageGesture = {
      start(kind, edge = 'left') {
        if (phase.current !== 'still') return;
        phase.current = 'dragging';
        gesture.current = { kind, edge, progress: 0 };
        float();
      },
      move(progress, dy = 0) {
        const d = gesture.current;
        const b = box.current;
        if (!d || !b || phase.current !== 'dragging') return;
        d.progress = progress;
        const p = Math.min(Math.max(progress, 0), 1);
        // Material's predictive back: smaller, rounder, nudged the way the finger goes.
        const x = d.kind === 'back' ? (d.edge === 'left' ? 1 : -1) * p * 24 : 0;
        const y = d.kind === 'pull' ? Math.max(dy, 0) * 0.45 : 0;
        b.style.transformOrigin = '50% 50%';
        b.style.transform = `translate(${x}px, ${y}px) scale(${1 - 0.12 * p})`;
        b.style.clipPath = `inset(0px round ${Math.min(28, p * 140)}px)`;
        if (scrim.current) scrim.current.style.opacity = String(SCRIM * (1 - 0.6 * p));
      },
      end(commit) {
        const d = gesture.current;
        gesture.current = null;
        if (!d || phase.current !== 'dragging') return false;
        if (commit) {
          onBack();
          return true;
        }
        // Not far enough: back to full size, then in place again.
        const b = box.current;
        if (!b) {
          settle();
          return true;
        }
        const { easing, duration } = springEasing(0.8, 500);
        const back = [
          b.animate({ transform: [b.style.transform || 'none', 'none'], clipPath: [b.style.clipPath || 'inset(0px round 0px)', 'inset(0px round 0px)'] }, { duration, easing }),
        ];
        if (scrim.current) back.push(scrim.current.animate({ opacity: [scrim.current.style.opacity || '0', '0'] }, { duration: 200 }));
        b.style.transform = '';
        b.style.clipPath = '';
        running.current = back;
        void Promise.all(back.map((a) => a.finished)).then(settle, () => {});
        return true;
      },
    };
    setStageGesture(g);
    return () => {
      if (stageGesture() === g) setStageGesture(null);
    };
  });

  // The phone's back gesture comes here while the page is open.
  useEffect(() => {
    if (!backGesture) return;
    setBackGesture(true);
    return () => setBackGesture(false);
  }, [backGesture]);

  // Pulling down from the top of the page.
  useEffect(() => {
    const b = box.current;
    if (!pull || !b) return;
    let mode: 'idle' | 'maybe' | 'drag' = 'idle';
    let x0 = 0;
    let y0 = 0;
    let last = { y: 0, t: 0, v: 0 };
    const atTop = () => (floating.current ? b.scrollTop : window.scrollY) <= 0;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || phase.current !== 'still' || !atTop()) return void (mode = 'idle');
      if (e.target instanceof Element && e.target.closest('textarea, input, [contenteditable], .scroll-row')) return void (mode = 'idle');
      mode = 'maybe';
      x0 = t.clientX;
      y0 = t.clientY;
      last = { y: t.clientY, t: e.timeStamp, v: 0 };
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (mode === 'idle' || !t) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (mode === 'maybe') {
        if (dy <= 0 || Math.abs(dx) > dy) {
          if (Math.abs(dx) + Math.abs(dy) > 8) mode = 'idle';
          return;
        }
        e.preventDefault();
        if (dy < 12) return;
        mode = 'drag';
        g()?.start('pull');
      }
      e.preventDefault();
      const dt = e.timeStamp - last.t;
      if (dt > 0) last = { y: t.clientY, t: e.timeStamp, v: (t.clientY - last.y) / dt };
      g()?.move((dy - 12) / (window.innerHeight * 0.55), dy - 12);
    };
    const onEnd = (e: TouchEvent) => {
      if (mode !== 'drag') return void (mode = 'idle');
      mode = 'idle';
      const dy = (e.changedTouches[0]?.clientY ?? y0) - y0;
      g()?.end(dy > 140 || (last.v > 0.6 && dy > 40));
    };
    const g = stageGesture;
    b.addEventListener('touchstart', onStart, { passive: true });
    b.addEventListener('touchmove', onMove, { passive: false });
    b.addEventListener('touchend', onEnd);
    b.addEventListener('touchcancel', onEnd);
    return () => {
      b.removeEventListener('touchstart', onStart);
      b.removeEventListener('touchmove', onMove);
      b.removeEventListener('touchend', onEnd);
      b.removeEventListener('touchcancel', onEnd);
    };
  }, [pull]);

  return (
    <>
      {overlay && <div ref={scrim} aria-hidden className="pointer-events-none fixed inset-y-0 right-0 bg-black opacity-0" style={{ left: 'var(--rail)', zIndex: z - 1 }} />}
      <div
        ref={box}
        data-stage={path}
        className={overlay ? 'fixed inset-y-0 right-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-surface' : undefined}
        style={overlay ? { left: 'var(--rail)', zIndex: z } : undefined}
      >
        <div ref={inner} className={overlay ? COLUMN : undefined} style={overlay ? { paddingTop: 'max(1.5rem, env(safe-area-inset-top))' } : undefined}>
          {children}
        </div>
      </div>
    </>
  );
}

/** The page beneath, while it shows. */
function beneath() {
  return document.querySelector<HTMLElement>('[data-tab][data-shown]');
}

// Springs: a little bounce on the way in, settled on the way back.
const IN = springEasing(0.68, 230);
const OUT = springEasing(0.85, 380);
// The page's trip from the row is long, and a bounce on it would fling the page up under the status
// bar and back; it travels settled, and the bounce is in its size and its parts arriving.
const TRAVEL = springEasing(0.92, 230);

/** The ghost: a copy of the row, laid where the row is in the stage's own scrolled space. */
function placeGhost(copy: HTMLElement, b: HTMLElement, l: number, t: number, w: number, h: number) {
  Object.assign(copy.style, { position: 'absolute', left: `${l}px`, top: `${t + b.scrollTop}px`, width: `${w}px`, height: `${h}px`, margin: '0', transformOrigin: '0 0', pointerEvents: 'none', zIndex: '1' });
  b.appendChild(copy);
  return copy;
}

function enter(origin: Origin | null, b: HTMLElement, i: HTMLElement, s: HTMLElement, ghost: { current: HTMLElement | null }): Animation[] {
  const { easing, duration } = IN;
  const page = getComputedStyle(b).backgroundColor;
  if (!origin) {
    // Opened from somewhere that isn't a row (a reminder, a link): it rises and sharpens into place.
    return [
      b.animate({ opacity: [0, 1], transform: ['scale(0.92)', 'none'] }, { duration: 320, easing: EMPHASIZED }),
      s.animate({ opacity: [0, SCRIM] }, { duration: 320, fill: 'forwards' }),
    ];
  }
  const frame = b.getBoundingClientRect();
  const vw = frame.width;
  const vh = frame.height;
  const l = origin.rect.left - frame.left;
  const t = origin.rect.top - frame.top;
  const w = origin.rect.width;
  const h = origin.rect.height;
  const column = i.getBoundingClientRect();
  const k = w / column.width;
  const out: Animation[] = [
    b.animate(
      {
        clipPath: [`inset(${t}px ${vw - l - w}px ${vh - t - h}px ${l}px round ${origin.radius}px)`, 'inset(0px 0px 0px 0px round 0px)'],
        backgroundColor: [origin.color, page],
      },
      { duration, easing },
    ),
    i.animate({ transformOrigin: ['0 0', '0 0'], translate: [`${l - (column.left - frame.left)}px ${t}px`, '0px 0px'] }, TRAVEL),
    i.animate({ transformOrigin: ['0 0', '0 0'], scale: [String(k), '1'] }, { duration, easing }),
    // The page shows as the card grows (the spring has it full size by about 40% of the way),
    // crossing with the row it grew from, so the card is never empty.
    i.animate({ opacity: [0, 0, 1, 1], offset: [0, 0.03, 0.25, 1] } as PropertyIndexedKeyframes, { duration, fill: 'backwards' }),
    s.animate({ opacity: [0, SCRIM] }, { duration: Math.min(duration, 450), fill: 'forwards' }),
  ];
  ghost.current = placeGhost(origin.ghost, b, l, t, w, h);
  out.push(
    ghost.current.animate({ transform: ['none', `translate(${-l}px, ${-t}px) scale(${vw / w})`] }, { duration, easing }),
    ghost.current.animate({ opacity: [1, 1, 0, 0], offset: [0, 0.08, 0.25, 1] } as PropertyIndexedKeyframes, { duration, fill: 'forwards' }),
  );
  // The page's parts arrive one after another, each rising on a bouncy spring and showing quickly.
  const step = springEasing(0.62, 260);
  [...i.children].slice(0, 10).forEach((part, n) => {
    const delay = 30 + n * 30;
    out.push(
      part.animate({ transform: ['translateY(36px)', 'none'] }, { ...step, delay, fill: 'backwards' }),
      part.animate({ opacity: [0, 1] }, { duration: 140, easing: 'ease-out', delay, fill: 'backwards' }),
    );
  });
  return out;
}

function leave(path: string, b: HTMLElement, i: HTMLElement, s: HTMLElement | null, ghost: { current: HTMLElement | null }): Animation[] {
  const from = { transform: b.style.transform || 'none', clipPath: b.style.clipPath || 'inset(0px 0px 0px 0px round 0px)' };
  const scrimFrom = s ? Number(s.style.opacity || getComputedStyle(s).opacity) : 0;
  const out: Animation[] = [];
  if (s) out.push(s.animate({ opacity: [scrimFrom, 0] }, { duration: 300, fill: 'forwards' }));
  const target = findTarget(path, b);
  if (!target) {
    out.push(b.animate({ transform: [from.transform, 'scale(0.9)'], opacity: [1, 0] }, { duration: 260, easing: EMPHASIZED, fill: 'forwards' }));
    return out;
  }
  const { easing, duration } = OUT;
  // Measured without the drag's transform: the clip is in the stage's own space.
  const vw = b.clientWidth;
  const vh = b.clientHeight;
  const l = target.rect.left - (parseFloat(getComputedStyle(b).left) || 0);
  const t = target.rect.top;
  const w = target.rect.width;
  const h = target.rect.height;
  const columnLeft = i.offsetLeft;
  const k = w / i.offsetWidth;
  const y = b.scrollTop;
  out.push(
    b.animate(
      {
        transform: [from.transform, 'none'],
        clipPath: [from.clipPath, `inset(${t}px ${vw - l - w}px ${vh - t - h}px ${l}px round ${target.radius}px)`],
        backgroundColor: [getComputedStyle(b).backgroundColor, target.color],
      },
      { duration, easing, fill: 'forwards' },
    ),
    i.animate({ transformOrigin: ['0 0', '0 0'], transform: ['none', `translate(${l - columnLeft}px, ${t + y * (1 - k)}px) scale(${k})`] }, { duration, easing, fill: 'forwards' }),
    i.animate({ opacity: [1, 0] }, { duration: duration * 0.35, fill: 'forwards' }),
  );
  ghost.current = placeGhost(target.ghost, b, l, t, w, h);
  out.push(
    ghost.current.animate({ transform: [`translate(${-l}px, ${-t}px) scale(${vw / w})`, 'none'] }, { duration, easing, fill: 'forwards' }),
    ghost.current.animate({ opacity: [0, 0, 1], offset: [0, 0.3, 0.75] } as PropertyIndexedKeyframes, { duration, fill: 'forwards' }),
  );
  return out;
}
