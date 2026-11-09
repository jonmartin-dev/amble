import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { findRow, radiusOf, setStageGesture, spring, springEasing, stageGesture, type StageGesture } from '../lib/morph.ts';
import { reduced } from '../lib/motion-settings.ts';
import { haptic, setBackGesture } from '../lib/native.ts';
import { typingWithKeyboard } from '../lib/viewport.ts';

/**
 * A task or list on a phone, opened from the page it came from. Opening and closing are a morph
 * of the whole page (morph() in lib/morph.ts, which Root starts). While a finger drags it back
 * (the back gesture, or a pull down from the top) it floats above that page, which stays as it
 * was, scrolled where it was; the rest of the time it sits in the page's place like any other
 * page, so the keyboard, sheets and scrolling work as they always have.
 */
interface Props {
  /** Floating over the page beneath, rather than in its place. Root shows that page while it's on. */
  overlay: boolean;
  setOverlay: (on: boolean) => void;
  /** Built but not shown yet: the morph that opens it starts once it's ready. */
  building: boolean;
  /** Opened from inside a sheet, which it then has to cover while it floats. */
  inSheet: boolean;
  /** The page's address, for the row it shrinks back into. */
  path: string;
  /**
   * Leave the page: a drag or the back gesture went far enough. `closed` when it already shrank
   * into its row, so there's nothing left to morph.
   */
  onBack: (closed: boolean) => void;
  /** Take the phone's back gesture, so the page can follow it. */
  backGesture: boolean;
  pull: boolean;
  children: ReactNode;
}

// The same layout as the page column in main (main.tsx), so floating and in place look the same.
const COLUMN = 'mx-auto max-w-xl px-4 pb-36 medium:max-w-2xl medium:px-6 medium:pb-12';
const SCRIM = 0.32;
// How far a pull down from the top has to go for letting go to close the page.
const CLOSE_PULL = 140;

export function DetailStage({ overlay, setOverlay, building, inSheet, path, onBack, backGesture, pull, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const floating = useRef(overlay);
  floating.current = overlay;
  // Where each page was scrolled: the one beneath (the window, while this is in its place) and this.
  const listScroll = useRef(0);
  const detailY = useRef(0);
  const handoff = useRef<'float' | 'settle' | null>(null);
  const phase = useRef<'still' | 'dragging' | 'leaving'>('still');
  const running = useRef<Animation[]>([]);
  const gesture = useRef<{ kind: 'pull' | 'back'; edge: 'left' | 'right'; progress: number } | null>(null);
  // Where the drag has the page: its move, size and corners, which the landing starts from.
  const pose = useRef<Pose>({ x: 0, y: 0, scale: 1, round: 0 });
  // The row it goes back into, kept out of sight while the page floats, so there's an empty place
  // for the page to land in rather than the row already there; and the copy of it that rides in on
  // the page as it lands (landOnRow).
  const dest = useRef<HTMLElement | null>(null);
  const ghost = useRef<HTMLElement | null>(null);
  const showDest = () => {
    if (dest.current) dest.current.style.visibility = '';
    dest.current = null;
  };
  const z = inSheet ? 35 : 9;
  useEffect(
    () => () => {
      ghost.current?.remove();
      showDest();
    },
    [],
  );

  const clear = () => {
    for (const a of running.current) a.cancel();
    running.current = [];
    const b = box.current;
    if (!b) return;
    b.style.transform = '';
    b.style.clipPath = '';
    b.style.transformOrigin = '';
  };
  const float = () => {
    if (floating.current) return;
    detailY.current = window.scrollY;
    handoff.current = 'float';
    setOverlay(true);
  };
  const settle = () => {
    clear();
    showDest();
    phase.current = 'still';
    if (!floating.current) return;
    listScroll.current = window.scrollY;
    detailY.current = box.current?.scrollTop ?? 0;
    handoff.current = 'settle';
    setOverlay(false);
  };

  // Where the page beneath was scrolled when this opened over it.
  useLayoutEffect(() => {
    listScroll.current = window.scrollY;
  }, []);

  // Moving between floating and in place: each page keeps where it was scrolled.
  useLayoutEffect(() => {
    const step = handoff.current;
    handoff.current = null;
    if (step === 'float' && overlay) {
      if (box.current) box.current.scrollTop = detailY.current;
      window.scrollTo(0, listScroll.current);
      // The page beneath was hidden; it shows as it was rather than rising in again.
      document
        .querySelector<HTMLElement>('[data-tab][data-shown]')
        ?.getAnimations({ subtree: true })
        .forEach((a) => a.finish());
      // Its row makes way for the page, which may come back down into it.
      const row = !reduced() ? findRow(path) : null;
      if (row && !box.current?.contains(row)) {
        row.style.visibility = 'hidden';
        dest.current = row;
      }
    } else if (step === 'settle' && !overlay) {
      window.scrollTo(0, detailY.current);
    }
  }, [overlay]);

  // A drag or the back gesture: the page shrinks as it goes, then goes or comes back.
  useEffect(() => {
    const g: StageGesture = {
      start(kind, edge = 'left') {
        if (phase.current !== 'still' || building) return;
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
        pose.current = { x, y, scale: 1 - 0.12 * p, round: Math.min(28, p * 140) };
        b.style.transformOrigin = '50% 50%';
        b.style.transform = `translate(${x}px, ${y}px) scale(${pose.current.scale})`;
        b.style.clipPath = `inset(0px round ${pose.current.round}px)`;
        if (scrim.current) scrim.current.style.opacity = String(SCRIM * (1 - 0.6 * p));
      },
      end(commit) {
        const d = gesture.current;
        gesture.current = null;
        if (!d || phase.current !== 'dragging') return false;
        if (commit) {
          phase.current = 'leaving';
          // Lands in its row from where the finger left it, starting the frame it lets go, and only
          // then leaves. Without a row on screen to go to, Root's morph fades it out instead.
          const b = box.current;
          const row = b && floating.current ? dest.current : null;
          if (!b || !row) {
            showDest();
            onBack(false);
            return true;
          }
          b.style.pointerEvents = 'none';
          const landing = landOnRow(b, row, pose.current, scrim.current, z + 1);
          running.current = landing.animations;
          ghost.current = landing.ghost;
          void landing.done.then(() => {
            // Settled: the copy is exactly where the real row is, so the row comes back as it and the
            // page go.
            b.style.opacity = '0';
            landing.ghost.remove();
            ghost.current = null;
            showDest();
            onBack(true);
          }, () => {});
          return true;
        }
        // Not far enough: back to full size (a transform, which the phone animates on its own),
        // then in place again.
        const b = box.current;
        if (!b) {
          settle();
          return true;
        }
        const { easing, duration } = springEasing(0.8, 500);
        const back = [b.animate({ transform: [b.style.transform || 'none', 'none'] }, { duration, easing })];
        if (scrim.current) back.push(scrim.current.animate({ opacity: [scrim.current.style.opacity || '0', String(SCRIM)] }, { duration: 200 }));
        b.style.transform = '';
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

  // Pulling down from the top of the page, from anywhere on it: the title, a field that isn't being
  // typed in, the empty space below. Not from a sheet or the toolbar over it, nor from the field
  // being typed in while the keyboard is up (that drag moves the cursor), nor from something
  // scrolled inside it.
  useEffect(() => {
    const b = box.current;
    if (!pull || !b) return;
    let mode: 'idle' | 'maybe' | 'drag' = 'idle';
    let x0 = 0;
    let y0 = 0;
    let last = { y: 0, t: 0, v: 0 };
    // Past the line where letting go closes it, which clicks once as it's crossed.
    let past = false;
    const atTop = () => (floating.current ? b.scrollTop : window.scrollY) <= 0;
    const onPage = (target: Element) => {
      if (floating.current ? !b.contains(target) : target.closest('[role="dialog"], nav, .toolbar')) return false;
      const field = target.closest('textarea, input, [contenteditable]');
      if (field && field === document.activeElement && typingWithKeyboard()) return false;
      for (let el: Element | null = target; el && el !== b && el !== document.body; el = el.parentElement) if (el.scrollTop > 0) return false;
      return true;
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || phase.current !== 'still' || !atTop()) return void (mode = 'idle');
      if (!(e.target instanceof Element) || !onPage(e.target)) return void (mode = 'idle');
      mode = 'maybe';
      past = false;
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
      if (dy > CLOSE_PULL !== past) {
        past = !past;
        if (past) haptic('line');
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (mode !== 'drag') return void (mode = 'idle');
      mode = 'idle';
      const dy = (e.changedTouches[0]?.clientY ?? y0) - y0;
      g()?.end(dy > CLOSE_PULL || (last.v > 0.6 && dy > 40));
    };
    const g = stageGesture;
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [pull]);

  return (
    <>
      {overlay && !building && (
        <div ref={scrim} aria-hidden className="pointer-events-none fixed inset-y-0 right-0 bg-black" style={{ left: 'var(--rail)', zIndex: z - 1, opacity: SCRIM }} />
      )}
      <div
        ref={box}
        data-stage
        className={overlay ? 'fixed inset-y-0 right-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-surface' : undefined}
        style={overlay ? { left: 'var(--rail)', zIndex: z, visibility: building ? 'hidden' : undefined } : undefined}
      >
        <div className={overlay ? COLUMN : undefined} style={overlay ? { paddingTop: 'max(1.5rem, env(safe-area-inset-top))' } : undefined}>
          {children}
        </div>
      </div>
    </>
  );
}

interface Pose {
  x: number;
  y: number;
  scale: number;
  /** The corners, in the page's own pixels. */
  round: number;
}

// The landing: a quick spring with a little bounce, so the page settles into its row rather than
// stopping dead. Nine tenths of the way in under 100 ms, 8% past at 160 ms, and back.
const LAND = spring(0.62, 650);

/**
 * The page, floating after a drag that went far enough, lands in the row it opened from. One
 * spring carries it: it moves onto the row and shrinks to the row's width, overshooting a little and
 * coming back, while its height shrinks to the row's on a log scale (so it looks even, and never
 * squashes past it). A copy of the row rides on it, placed and sized as the page will be when it
 * lands, and fades in as the page's own content fades out, so it's the row that arrives and settles;
 * then it sits exactly on the real one. It's the page as it is, animated in place, so it moves the
 * frame the finger lifts; a morph would first stop to take pictures of before and after. The moves
 * and fades run on their own; the clip that keeps the page to the row's height is drawn by the page,
 * which has nothing else to do meanwhile.
 */
function landOnRow(b: HTMLElement, row: HTMLElement, from: Pose, scrim: HTMLElement | null, z: number) {
  const width = b.offsetWidth;
  const height = b.offsetHeight;
  const cx = b.offsetLeft + width / 2;
  const cy = height / 2;
  const r = row.getBoundingClientRect();
  // Where it lands, about its middle: the row's width, and its top on the row's.
  const scale = r.width / width;
  const x = r.left + r.width / 2 - cx;
  const y = r.top - cy + (scale * height) / 2;
  const tall = r.height / scale;
  const round = radiusOf(row) / scale;

  const ghost = row.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('data-morph');
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, {
    // The row itself is out of sight until the page lands.
    visibility: 'visible',
    position: 'fixed',
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    margin: '0',
    zIndex: String(z),
    pointerEvents: 'none',
    opacity: '0',
    // The page's middle where it lands, so the copy scales and moves with the page.
    transformOrigin: `${cx + x - r.left}px ${cy + y - r.top}px`,
  });
  document.body.append(ghost);

  const { at, seconds } = LAND;
  const duration = Math.round(seconds * 1000);
  const page: Keyframe[] = [];
  const clip: Keyframe[] = [];
  const copy: Keyframe[] = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const p = i === n ? 1 : at((seconds * i) / n);
    const q = Math.min(p, 1);
    const px = from.x + (x - from.x) * p;
    const py = from.y + (y - from.y) * p;
    const ps = from.scale + (scale - from.scale) * p;
    const offset = i / n;
    page.push({ offset, transform: `translate(${px}px, ${py}px) scale(${ps})` });
    clip.push({ offset, clipPath: `inset(0px 0px ${height - height * Math.pow(tall / height, q)}px 0px round ${from.round + (round - from.round) * q}px)` });
    copy.push({ offset, transform: `translate(${px - x}px, ${py - y}px) scale(${ps / scale})` });
  }
  b.style.transformOrigin = '50% 50%';
  const content = b.firstElementChild;
  const animations = [
    // Apart, so the move isn't held to the page's pace by the clip it would otherwise share an animation with.
    b.animate(page, { duration, fill: 'forwards' }),
    b.animate(clip, { duration, fill: 'forwards' }),
    ghost.animate(copy, { duration, fill: 'forwards' }),
    // By a quarter of the way the page is mostly the row's size: its content hands over to the row's.
    ghost.animate({ opacity: [0, 1] }, { duration: duration * 0.2, delay: duration * 0.2, easing: 'ease-out', fill: 'both' }),
    ...(content ? [content.animate({ opacity: [1, 0] }, { duration: duration * 0.2, delay: duration * 0.25, easing: 'ease-in', fill: 'both' })] : []),
    ...(scrim ? [scrim.animate({ opacity: [scrim.style.opacity || String(SCRIM), '0'] }, { duration: duration * 0.5, easing: 'ease-out', fill: 'forwards' })] : []),
  ];
  return { animations, ghost, done: Promise.all(animations.slice(0, 3).map((a) => a.finished)) };
}
