import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { CLOSE, findRow, radiusOf, setStageGesture, springEasing, stageGesture, type StageGesture } from '../lib/morph.ts';
import { reduced } from '../lib/motion-demo.ts';
import { setBackGesture } from '../lib/native.ts';
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
  const z = inSheet ? 35 : 9;

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
          phase.current = 'leaving';
          // Shrinks into its row from where the finger left it, starting the frame it lets go, and
          // only then leaves. Without a row on screen to go to, Root's morph fades it out instead.
          const b = box.current;
          const found = b && floating.current && !reduced() ? findRow(path) : null;
          const row = found && !b!.contains(found) ? found : null;
          if (!b || !row) {
            onBack(false);
            return true;
          }
          b.style.pointerEvents = 'none';
          running.current = shrinkInto(b, row, scrim.current);
          // Gone once it has faded onto the row, while the spring still settles out of sight.
          void Promise.all(running.current.slice(2).map((a) => a.finished)).then(() => onBack(true), () => {});
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

/**
 * The page, floating after a drag that went far enough, shrinks into the row it opened from, and
 * once it's nearly there fades onto the row beneath, as the morph's two pictures cross. It's the page
 * as it is, animated in place, so it moves the frame the finger lifts; a morph would first stop to
 * take pictures of the page before and after. The transform and fades run on their own; the clip
 * that keeps it to the row's height is drawn by the page, which has nothing else to do meanwhile.
 * The first two animations are the move and the clip; the rest are the fades, done once the page is
 * out of sight.
 */
function shrinkInto(b: HTMLElement, row: HTMLElement, scrim: HTMLElement | null): Animation[] {
  const width = b.offsetWidth;
  const height = b.offsetHeight;
  const r = row.getBoundingClientRect();
  // About its middle, as the drag left it: the scale that makes it the row's width, and the move that
  // puts its top on the row's.
  const scale = r.width / width;
  const x = r.left + r.width / 2 - (b.offsetLeft + width / 2);
  const y = r.top - height / 2 + (scale * height) / 2;
  const clip = `inset(0px 0px ${Math.max(0, height - r.height / scale)}px 0px round ${radiusOf(row) / scale}px)`;
  const { easing, duration } = CLOSE;
  b.style.transformOrigin = '50% 50%';
  // Apart, so the move isn't held to the page's pace by the clip it would otherwise share an animation with.
  const moves = [
    b.animate({ transform: [b.style.transform || 'none', `translate(${x}px, ${y}px) scale(${scale})`] }, { duration, easing, fill: 'forwards' }),
    b.animate({ clipPath: [b.style.clipPath || 'inset(0px round 0px)', clip] }, { duration, easing, fill: 'forwards' }),
    // The spring is most of the way there by a third of its time; then the row shows through.
    b.animate({ opacity: [1, 0] }, { duration: duration * 0.25, delay: duration * 0.3, easing: 'ease-in-out', fill: 'both' }),
  ];
  if (scrim) moves.push(scrim.animate({ opacity: [scrim.style.opacity || String(SCRIM), '0'] }, { duration: duration * 0.55, easing: 'ease-out', fill: 'forwards' }));
  return moves;
}
