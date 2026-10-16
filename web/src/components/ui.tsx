import { Link, useRouter, useRouterState } from '@tanstack/react-router';
import { AnimatePresence, motion, useDragControls, usePresence, type DragControls, type PanInfo } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import ArrowBack from '~icons/material-symbols/arrow-back-rounded';
import Check from '~icons/material-symbols/check-rounded';
import ChevronRight from '~icons/material-symbols/chevron-right-rounded';
import Close from '~icons/material-symbols/close-rounded';
import type { DayLoad } from '../lib/api.ts';
import { EXPANDED, isDetail, useInPane, useMedia } from '../lib/layout.ts';
import { expressive } from '../lib/motion.ts';
import { typingWithKeyboard, useBackToClose, useScrollLock, useVisualViewport } from '../lib/viewport.ts';

/**
 * Header for a page reached from somewhere else: back arrow and title. The arrow goes back the way
 * the phone's Back does, so the two don't fight; `back` is where it goes when there's nowhere to.
 */
export function SubpageHeader({ title, back = '/settings', action }: { title: ReactNode; back?: string; action?: ReactNode }) {
  const goBack = useBack(back);
  return (
    <header className="mb-2 flex items-center gap-2">
      <button type="button" onClick={goBack} aria-label="Back" className="-ml-2 grid size-12 place-items-center rounded-full hover:bg-surface-high">
        <ArrowBack className="size-6" aria-hidden />
      </button>
      <h1 className="display flex-1 text-[1.75rem] font-medium">{title}</h1>
      {action}
    </header>
  );
}

/**
 * The back arrow at the top of a task or list. In the pane beside a page on a wide screen it's a
 * close button instead, which shuts the pane the same way.
 */
export function BackButton({ onClick }: { onClick: () => void }) {
  const inPane = useInPane();
  const Glyph = inPane ? Close : ArrowBack;
  return (
    <button type="button" onClick={onClick} aria-label={inPane ? 'Close' : 'Back'} className="-ml-2 grid size-12 shrink-0 place-items-center rounded-full hover:bg-surface-high">
      <Glyph className="size-6" aria-hidden />
    </button>
  );
}

/**
 * A link to a list. On a wide screen, while something is already open beside the page, the list
 * takes its place rather than adding a step for Back; whichever is open shows as picked.
 */
export function ListLink({ groupId, className, children }: { groupId: string; className: (open: boolean) => string; children: ReactNode }) {
  const wide = useMedia(EXPANDED);
  const where = useRouterState({ select: (s) => (s.location.pathname === `/list/${groupId}` ? 'this' : isDetail(s.location.pathname) ? 'other' : 'none') });
  return (
    <Link to="/list/$groupId" params={{ groupId }} replace={wide && where !== 'none'} aria-current={where === 'this' || undefined} className={className(where === 'this')}>
      {children}
    </Link>
  );
}

/** Back to wherever the person came from, or a fallback when they landed here directly. */
export function useBack(fallback = '/') {
  const router = useRouter();
  return () => (window.history.length > 1 ? router.history.back() : void router.navigate({ to: fallback }));
}

/** Corners for one item in an M3 Expressive grouped list: round at the ends, tight between. */
export function segment(i: number, n: number) {
  if (n === 1) return 'rounded-3xl';
  if (i === 0) return 'rounded-t-3xl rounded-b-md';
  if (i === n - 1) return 'rounded-t-md rounded-b-3xl';
  return 'rounded-md';
}

export interface RowProps {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  to?: string;
  onClick?: () => void;
}

/** A grouped list of rows that link somewhere, open something, or hold a control. */
export function ListGroup({ rows, label }: { rows: RowProps[]; label?: string }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-0.5">
      {rows.map((r, i) => {
        const inner = (
          <>
            {r.icon && <span className="grid size-10 shrink-0 place-items-center text-on-surface-variant">{r.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className="block">{r.title}</span>
              {r.subtitle && <span className="block text-sm text-on-surface-variant">{r.subtitle}</span>}
            </span>
            {r.trailing ?? (r.to ? <ChevronRight className="size-6 shrink-0 text-on-surface-variant" aria-hidden /> : null)}
          </>
        );
        const cls = `flex w-full items-center gap-3 bg-surface-low px-3 py-3 text-left ${segment(i, rows.length)}`;
        return (
          <li key={i}>
            {r.to ? (
              <Link to={r.to} className={`${cls} transition-colors hover:bg-surface-container`}>
                {inner}
              </Link>
            ) : r.onClick ? (
              <button type="button" onClick={r.onClick} className={`${cls} transition-colors hover:bg-surface-container`}>
                {inner}
              </button>
            ) : (
              <div className={cls}>{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** M3 switch: the handle grows and shows a check when on. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-8 w-13 shrink-0 rounded-full border-2 transition-colors ${
        checked ? 'border-primary bg-primary' : 'border-outline bg-surface-highest'
      }`}
    >
      <motion.span
        className={`absolute top-1/2 grid place-items-center rounded-full ${checked ? 'bg-on-primary text-primary' : 'bg-outline'}`}
        initial={false}
        animate={{ left: checked ? 22 : 6, width: checked ? 24 : 16, height: checked ? 24 : 16, y: '-50%' }}
        transition={expressive.fastSpatial}
      >
        {checked && <Check className="size-4" aria-hidden />}
      </motion.span>
    </button>
  );
}

/** M3 Expressive connected button group: the selected segment morphs to a full pill. */
export function ButtonGroup<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  // M3 Expressive's connected button group: round outer ends, 8dp inner corners that tighten to
  // 4dp while pressed, and the selected one fully round. Round is exactly half the height: a larger
  // number makes the browser scale every corner of the button down to fit, squaring the inner ones
  // and making the shape jump as it animates.
  const round = size === 'sm' ? 20 : 24;
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5">
      {options.map((o, i) => {
        const on = o.value === value;
        const first = i === 0;
        const last = i === options.length - 1;
        const corners = (inner: number) => ({
          borderTopLeftRadius: on || first ? round : inner,
          borderBottomLeftRadius: on || first ? round : inner,
          borderTopRightRadius: on || last ? round : inner,
          borderBottomRightRadius: on || last ? round : inner,
        });
        return (
          <motion.button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            initial={false}
            animate={corners(8)}
            transition={expressive.fastSpatial}
            whileTap={corners(4)}
            className={`flex flex-1 items-center justify-center gap-2 text-sm font-medium transition-colors ${size === 'sm' ? 'h-10' : 'h-12'} ${
              on ? 'bg-primary text-on-primary' : 'bg-surface-high text-on-surface'
            }`}
          >
            {on ? <Check className="size-5" aria-hidden /> : o.icon}
            {o.label}
          </motion.button>
        );
      })}
    </div>
  );
}

/**
 * M3 bottom sheet with a scrim. Drag the handle down, tap outside, press Escape or the phone's
 * Back to close. It rides on top of the on-screen keyboard, and `footer` (a text box, the main
 * buttons) stays pinned just above it while the body scrolls.
 */
export function Sheet({
  open,
  onClose,
  label,
  children,
  footer,
  header,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children?: ReactNode;
  footer?: ReactNode;
  header?: ReactNode;
}) {
  // Only the handle starts a drag, so scrolling inside the sheet still works.
  const controls = useDragControls();
  const view = useVisualViewport(open);
  useScrollLock(open);
  useBackToClose(open, onClose);
  // On a wide screen, a task opened from the sheet shows beside the page the sheet is on, so the
  // sheet gets out of its way. (On a phone the page, sheet and all, waits behind the task for Back.)
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const at = useRef(pathname);
  useEffect(() => {
    if (pathname === at.current) return;
    at.current = pathname;
    if (open && matchMedia(EXPANDED).matches) onClose();
  }, [pathname, open, onClose]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 120 || info.velocity.y > 600) onClose();
  };
  // A tap beside the sheet while typing only puts the keyboard away, as Back does, and the sheet
  // stays with what's typed. Asked as the tap starts: by the time it lands the box has let go.
  const typing = useRef(false);
  const keyboardUp = view.keyboard > 0;
  const maxHeight = Math.max(240, view.height - (keyboardUp ? 8 : view.height * 0.1));
  const natural = useNaturalHeight(open);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-20 bg-black/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            // Stop catching touches the moment it starts closing, not when the fade ends.
            exit={{ opacity: 0, pointerEvents: 'none' }}
            onPointerDown={() => (typing.current = typingWithKeyboard())}
            onClick={() => {
              if (!typing.current) return onClose();
              typing.current = false;
              if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
            }}
          />
          {/* Rides up with the keyboard, centered on the page beside the rail. */}
          <div
            className="sheet-keyboard fixed inset-x-0 bottom-0 z-30 mx-auto max-w-xl"
            style={{ left: 'var(--rail)', ...(view.keyboard && { transform: `translateY(${-view.keyboard}px)` }) }}
          >
            <SheetPanel
              label={label}
              // The sheet glides to fit what's in it.
              height={natural.height ? Math.min(natural.height, maxHeight) : undefined}
              maxHeight={maxHeight}
              controls={controls}
              onDragEnd={onDragEnd}
            >
              <div ref={natural.header} onPointerDown={(e) => controls.start(e)} className="shrink-0 cursor-grab touch-none px-5 pt-3 pb-1">
                <div className="mx-auto mb-2 h-1 w-8 rounded-full bg-outline-variant" aria-hidden />
                {header}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5">
                <div ref={natural.body} className={children ? 'pb-1' : ''}>
                  {children}
                </div>
              </div>
              <div ref={natural.footer} className={`shrink-0 px-5 ${footer ? 'pt-2' : ''}`}>
                {footer}
              </div>
              {/* Room for the home indicator, which the keyboard hides while it's up. */}
              <div ref={natural.spacer} className="shrink-0" style={{ height: keyboardUp ? 10 : 'max(1.25rem, env(safe-area-inset-bottom))' }} />
            </SheetPanel>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

/**
 * The sheet itself. It slides in and out as browser animations, which run on the GPU even while
 * the page is busy; Motion only follows a drag on the handle and glides the height to fit.
 */
function SheetPanel({
  label,
  height,
  maxHeight,
  controls,
  onDragEnd,
  children,
}: {
  label: string;
  height?: number;
  maxHeight: number;
  controls: DragControls;
  onDragEnd: (e: unknown, info: PanInfo) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isPresent, safeToRemove] = usePresence();
  useEffect(() => {
    if (isPresent) return;
    const el = ref.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return safeToRemove();
    // Down from wherever it is, partway through a drag included, and no more taps on the way out.
    el.style.pointerEvents = 'none';
    const style = getComputedStyle(el);
    const from = style.transform === 'none' ? 'translateY(0)' : style.transform;
    el.animate([{ transform: from }, { transform: 'translateY(100%)' }], {
      duration: 420,
      easing: style.getPropertyValue('--spring').trim() || 'ease-in',
      fill: 'forwards',
    }).finished.then(safeToRemove, safeToRemove);
  }, [isPresent, safeToRemove]);

  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-label={label}
      className="sheet-in flex flex-col overflow-hidden rounded-t-[2rem] bg-surface-low shadow-2xl"
      animate={height ? { height } : undefined}
      transition={expressive.defaultSpatial}
      style={{ maxHeight }}
      drag="y"
      dragListener={false}
      dragControls={controls}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.6 }}
      onDragEnd={onDragEnd}
    >
      {children}
    </motion.div>
  );
}

/** Measures how tall a sheet's parts want to be, so the sheet can animate to fit them. */
function useNaturalHeight(open: boolean) {
  const header = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!open) {
      setHeight(0);
      return;
    }
    const parts = [header, body, footer, spacer].map((r) => r.current).filter((el): el is HTMLDivElement => !!el);
    const measure = () => setHeight(parts.reduce((sum, el) => sum + el.offsetHeight, 0));
    const ro = new ResizeObserver(measure);
    parts.forEach((el) => ro.observe(el));
    measure();
    return () => ro.disconnect();
  }, [open]);
  return { header, body, footer, spacer, height };
}

/**
 * Round when open, morphing to a rounded square with a check when done (M3 Expressive shape morph).
 * Plain CSS rather than Motion: a list mounts one per row, and these stay cheap to build.
 */
export function Checkbox({ checked, onChange, label, size = 28 }: { checked: boolean; onChange: () => void; label: string; size?: number }) {
  // A tick the person just made gets a small burst; ones that load already ticked don't.
  const [burst, setBurst] = useState(0);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        if (!checked) setBurst((b) => b + 1);
        onChange();
      }}
      style={{ width: size, height: size, borderRadius: checked ? size * 0.32 : size / 2 }}
      className={`check relative grid shrink-0 place-items-center border-2 ${
        checked ? 'border-primary bg-primary text-on-primary' : 'border-outline text-transparent'
      }`}
    >
      <span className="check-mark grid" style={{ transform: checked ? 'none' : 'scale(0) rotate(-45deg)' }}>
        <Check style={{ width: size * 0.7, height: size * 0.7 }} aria-hidden />
      </span>
      {burst > 0 && checked && <Burst key={burst} size={size} />}
    </button>
  );
}

/**
 * Eight dots that spring out from the middle and fade: the moment of finishing something. Each dot
 * flies along its own turned track with the same keyframes, which keeps the animation on the GPU.
 */
function Burst({ size }: { size: number }) {
  return (
    <span className="pointer-events-none absolute inset-0" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <span key={i} className="absolute top-1/2 left-1/2 size-0" style={{ transform: `rotate(${i * 45}deg) scale(${size / 28})` }}>
          <span className="burst-dot absolute -top-[3px] -left-[3px] size-1.5 rounded-full bg-primary" />
        </span>
      ))}
    </span>
  );
}

/** A selectable M3 chip (`.chip` in styles.css): outlined until picked, then tonal and round. */
export function Chip({
  selected,
  onClick,
  children,
  icon,
}: {
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <button type="button" aria-pressed={selected ?? false} onClick={onClick} className="chip">
      {icon}
      {children}
    </button>
  );
}

/**
 * A row that scrolls sideways. Whatever runs past an edge fades out there, so a chip cut off at
 * the side reads as "more this way" rather than as a mistake.
 */
export function ScrollRow({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const update = () => {
      const start = row.scrollLeft > 1;
      const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
      row.dataset.fade = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
    };
    update();
    row.addEventListener('scroll', update, { passive: true });
    // Its size, and what's in it (a chip's label growing, chips coming and going).
    const resized = new ResizeObserver(update);
    resized.observe(row);
    const changed = new MutationObserver(update);
    changed.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      row.removeEventListener('scroll', update);
      resized.disconnect();
      changed.disconnect();
    };
  }, []);
  return (
    <div ref={ref} className={`scroll-row ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-7 mb-2 flex items-center justify-between px-1">
      <h2 className="text-sm font-medium text-primary">{children}</h2>
      {action}
    </div>
  );
}

const loadWords: Record<DayLoad['level'], string> = { light: 'Light', moderate: 'Steady', full: 'Full', over: 'Too much' };

export function loadWord(load: DayLoad) {
  return load.tasks === 0 ? 'Wide open' : loadWords[load.level];
}

/** How full a day is. Heavy days turn amber. */
/** How much of a day's capacity is planned, from 0 to 1 (a day off with anything on it is full). */
export function loadRatio(load: DayLoad) {
  if (load.capacityMinutes === 0) return load.plannedMinutes > 0 ? 1 : 0;
  return Math.min(load.plannedMinutes / load.capacityMinutes, 1);
}

export function LoadBar({
  load,
  className = '',
  track = 'bg-on-primary-container/15',
  fill = 'bg-primary',
}: {
  load: DayLoad;
  className?: string;
  track?: string;
  fill?: string;
}) {
  const pct = Math.max(loadRatio(load) * 100, load.tasks ? 4 : 2);
  const heavy = load.level === 'full' || load.level === 'over';
  return (
    <div className={`h-3 overflow-hidden rounded-full ${track} ${className}`}>
      {/* Full width, slid left so only `pct` of it shows: the round end stays round. */}
      <div className={`fill-glide h-full rounded-full ${heavy ? 'bg-warm' : fill}`} style={{ transform: `translateX(${pct - 100}%)` }} />
    </div>
  );
}

export function minutesLabel(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
