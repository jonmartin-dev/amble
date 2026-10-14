import { Link, useRouter } from '@tanstack/react-router';
import { AnimatePresence, motion, useDragControls, type PanInfo } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import ArrowBack from '~icons/material-symbols/arrow-back-rounded';
import Check from '~icons/material-symbols/check-rounded';
import ChevronRight from '~icons/material-symbols/chevron-right-rounded';
import type { DayLoad } from '../lib/api.ts';
import { expressive, standard } from '../lib/motion.ts';
import { useBackToClose, useScrollLock, useVisualViewport } from '../lib/viewport.ts';

/** Header for a page reached from somewhere else: back arrow and title. */
export function SubpageHeader({ title, back = '/settings', action }: { title: ReactNode; back?: string; action?: ReactNode }) {
  return (
    <header className="mb-2 flex items-center gap-2">
      <Link to={back} aria-label="Back" className="-ml-2 grid size-12 place-items-center rounded-full hover:bg-surface-high">
        <ArrowBack className="size-6" aria-hidden />
      </Link>
      <h1 className="display flex-1 text-[1.75rem] font-medium">{title}</h1>
      {action}
    </header>
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
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5">
      {options.map((o, i) => {
        const on = o.value === value;
        const first = i === 0;
        const last = i === options.length - 1;
        return (
          <motion.button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            animate={{
              borderTopLeftRadius: on || first ? 999 : 8,
              borderBottomLeftRadius: on || first ? 999 : 8,
              borderTopRightRadius: on || last ? 999 : 8,
              borderBottomRightRadius: on || last ? 999 : 8,
            }}
            transition={expressive.fastSpatial}
            whileTap={{ scale: 0.96 }}
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 120 || info.velocity.y > 600) onClose();
  };
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
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-label={label}
            className="fixed inset-x-0 z-30 mx-auto flex max-w-xl flex-col overflow-hidden rounded-t-[2rem] bg-surface-low shadow-2xl"
            // The sheet glides to fit what's in it, and rides up with the keyboard.
            initial={{ y: '100%', bottom: view.keyboard }}
            animate={{
              y: 0,
              bottom: view.keyboard,
              ...(natural.height ? { height: Math.min(natural.height, maxHeight) } : {}),
            }}
            exit={{ y: '100%', pointerEvents: 'none' }}
            transition={{ ...expressive.defaultSpatial, bottom: standard.fastSpatial, height: expressive.defaultSpatial }}
            style={{ maxHeight }}
            drag="y"
            dragListener={false}
            dragControls={controls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
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
          </motion.div>
        </>
      )}
    </AnimatePresence>
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

/** Round when open, morphing to a rounded square with a check when done (M3 Expressive shape morph). */
export function Checkbox({ checked, onChange, label, size = 28 }: { checked: boolean; onChange: () => void; label: string; size?: number }) {
  // A tick the person just made gets a small burst; ones that load already ticked don't.
  const [burst, setBurst] = useState(0);
  return (
    <motion.button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        if (!checked) setBurst((b) => b + 1);
        onChange();
      }}
      whileTap={{ scale: 0.85 }}
      animate={{ borderRadius: checked ? size * 0.32 : size / 2 }}
      transition={expressive.fastSpatial}
      style={{ width: size, height: size }}
      className={`relative grid shrink-0 place-items-center border-2 transition-colors ${
        checked ? 'border-primary bg-primary text-on-primary' : 'border-outline text-transparent'
      }`}
    >
      <AnimatePresence initial={false}>
        {checked && (
          <motion.span initial={{ scale: 0, rotate: -45 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }} transition={expressive.fastSpatial}>
            <Check style={{ width: size * 0.7, height: size * 0.7 }} aria-hidden />
          </motion.span>
        )}
      </AnimatePresence>
      {burst > 0 && checked && <Burst key={burst} size={size} />}
    </motion.button>
  );
}

/** Eight dots that spring out from the middle and fade: the moment of finishing something. */
function Burst({ size }: { size: number }) {
  return (
    <span className="pointer-events-none absolute inset-0" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => {
        const angle = (i / 8) * Math.PI * 2;
        const reach = size * 0.95;
        return (
          <motion.span
            key={i}
            className="absolute top-1/2 left-1/2 size-1.5 rounded-full bg-primary"
            style={{ marginLeft: -3, marginTop: -3 }}
            initial={{ x: 0, y: 0, scale: 0.4, opacity: 1 }}
            animate={{ x: Math.cos(angle) * reach, y: Math.sin(angle) * reach, scale: [0.4, 1.2, 0], opacity: [1, 1, 0] }}
            transition={{ duration: 0.55, ease: [0.2, 0, 0, 1] }}
          />
        );
      })}
    </span>
  );
}

/** A selectable pill: tonal when selected. */
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
    <motion.button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      whileTap={{ scale: 0.95 }}
      transition={expressive.fastSpatial}
      className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm transition-colors ${
        selected ? 'bg-secondary-container text-on-secondary-container' : 'border border-outline-variant text-on-surface-variant'
      } ${icon ? 'pl-2.5' : ''}`}
    >
      {icon}
      {children}
    </motion.button>
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
  const pct = loadRatio(load) * 100;
  const heavy = load.level === 'full' || load.level === 'over';
  return (
    <div className={`h-3 overflow-hidden rounded-full ${track} ${className}`}>
      <motion.div
        className={`h-full rounded-full ${heavy ? 'bg-warm' : fill}`}
        initial={false}
        animate={{ width: `${Math.max(pct, load.tasks ? 4 : 2)}%` }}
        transition={expressive.defaultSpatial}
      />
    </div>
  );
}

export function minutesLabel(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
