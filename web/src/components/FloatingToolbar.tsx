import { Link, useRouterState } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { useRef } from 'react';
import { expressive } from '../lib/motion.ts';
import Add from '~icons/material-symbols/add-rounded';
import Chart from '~icons/material-symbols/bar-chart-rounded';
import CalendarOutline from '~icons/material-symbols/calendar-month-outline-rounded';
import CalendarFilled from '~icons/material-symbols/calendar-month-rounded';
import ListOutline from '~icons/material-symbols/list-alt-outline-rounded';
import ListFilled from '~icons/material-symbols/list-alt-rounded';
import SunOutline from '~icons/material-symbols/wb-sunny-outline-rounded';
import SunFilled from '~icons/material-symbols/wb-sunny-rounded';

const items = [
  { to: '/', label: 'Today', Icon: SunOutline, ActiveIcon: SunFilled },
  { to: '/backlog', label: 'Backlog', Icon: ListOutline, ActiveIcon: ListFilled },
  { to: '/calendar', label: 'Calendar', Icon: CalendarOutline, ActiveIcon: CalendarFilled },
  { to: '/stats', label: 'Stats', Icon: Chart, ActiveIcon: Chart },
] as const;

// Each button is 48px wide with 4px between them.
const STEP = 52;

export function FloatingToolbar({ onAdd }: { onAdd: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));
  const active = items.findIndex(({ to }) => isActive(to));
  // On a page that isn't one of these, the pill fades where it last was.
  const last = useRef(0);
  if (active >= 0) last.current = active;

  return (
    <div
      className="fixed inset-x-0 z-10 flex justify-center gap-3 px-4"
      style={{ bottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
    >
      <nav aria-label="Main" className="relative flex items-center gap-1 rounded-full bg-surface-highest p-2 shadow-lg">
        {/* One pill that slides between tabs. A CSS transition keeps it on the GPU, so it glides
            the moment a tab is tapped, even while the new page is still being built. */}
        <span
          aria-hidden
          className="toolbar-pill absolute top-2 left-2 size-12 rounded-full bg-primary-container"
          style={{ transform: `translateX(${last.current * STEP}px) scale(${active >= 0 ? 1 : 0.6})`, opacity: active >= 0 ? 1 : 0 }}
        />
        {items.map(({ to, label, Icon, ActiveIcon }) => {
          const active = isActive(to);
          const Glyph = active ? ActiveIcon : Icon;
          return (
            <Link
              key={to}
              to={to}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className="relative grid size-12 place-items-center rounded-full text-on-surface-variant"
            >
              <Glyph className={`relative size-6 ${active ? 'text-on-primary-container' : ''}`} aria-hidden />
            </Link>
          );
        })}
      </nav>
      <motion.button
        type="button"
        aria-label="Add a task"
        onClick={onAdd}
        whileTap={{ scale: 0.9, borderRadius: '40%' }}
        transition={expressive.fastSpatial}
        className="grid size-16 place-items-center rounded-[1.25rem] bg-primary text-on-primary shadow-lg"
      >
        <Add className="size-7" aria-hidden />
      </motion.button>
    </div>
  );
}
