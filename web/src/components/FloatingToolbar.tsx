import { Link, useRouterState } from '@tanstack/react-router';
import { motion } from 'motion/react';
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

export function FloatingToolbar({ onAdd }: { onAdd: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div
      className="fixed inset-x-0 z-10 flex justify-center gap-3 px-4"
      style={{ bottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
    >
      <nav aria-label="Main" className="flex items-center gap-1 rounded-full bg-surface-highest p-2 shadow-lg">
        {items.map(({ to, label, Icon, ActiveIcon }) => {
          const active = to === '/' ? pathname === '/' : pathname.startsWith(to);
          const Glyph = active ? ActiveIcon : Icon;
          return (
            <Link
              key={to}
              to={to}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className="relative grid size-12 place-items-center rounded-full text-on-surface-variant"
            >
              {active && (
                <motion.span
                  layoutId="toolbar-indicator"
                  transition={expressive.fastSpatial}
                  className="absolute inset-0 rounded-full bg-primary-container"
                />
              )}
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
