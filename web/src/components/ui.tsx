import { AnimatePresence, motion, useDragControls, type PanInfo } from 'motion/react';
import { useEffect, type ReactNode } from 'react';
import Check from '~icons/material-symbols/check-rounded';
import type { DayLoad } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';

/** M3 bottom sheet with a scrim. Drag it down, tap outside, or press Escape to close. */
export function Sheet({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  // Only the handle starts a drag, so scrolling inside the sheet still works.
  const controls = useDragControls();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 120 || info.velocity.y > 600) onClose();
  };

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
            className="fixed inset-x-0 bottom-0 z-30 mx-auto max-h-[88dvh] max-w-xl overflow-y-auto rounded-t-[2rem] bg-surface-low px-5 pt-3"
            style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%', pointerEvents: 'none' }}
            transition={expressive.defaultSpatial}
            drag="y"
            dragListener={false}
            dragControls={controls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={onDragEnd}
          >
            <div
              onPointerDown={(e) => controls.start(e)}
              className="-mx-5 -mt-3 mb-2 flex cursor-grab touch-none justify-center pt-3 pb-3"
              aria-hidden
            >
              <div className="h-1 w-8 rounded-full bg-outline-variant" />
            </div>
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/** Round when open, morphing to a rounded square with a check when done (M3 Expressive shape morph). */
export function Checkbox({ checked, onChange, label, size = 28 }: { checked: boolean; onChange: () => void; label: string; size?: number }) {
  return (
    <motion.button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      whileTap={{ scale: 0.85 }}
      animate={{ borderRadius: checked ? size * 0.32 : size / 2 }}
      transition={expressive.fastSpatial}
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center border-2 transition-colors ${
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
    </motion.button>
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
  const pct = Math.min(load.plannedMinutes / load.capacityMinutes, 1) * 100;
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
