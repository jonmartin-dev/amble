import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import Add from '~icons/material-symbols/add-rounded';
import Chart from '~icons/material-symbols/bar-chart-rounded';
import CalendarOutline from '~icons/material-symbols/calendar-month-outline-rounded';
import CalendarFilled from '~icons/material-symbols/calendar-month-rounded';
import ListOutline from '~icons/material-symbols/list-alt-outline-rounded';
import ListFilled from '~icons/material-symbols/list-alt-rounded';
import SunOutline from '~icons/material-symbols/wb-sunny-outline-rounded';
import SunFilled from '~icons/material-symbols/wb-sunny-rounded';
import { haptic } from '../lib/native.ts';

/** The app's four pages, in the toolbar on a phone and down the rail on a wider screen. */
export const NAV_ITEMS = [
  { to: '/', label: 'Today', Icon: SunOutline, ActiveIcon: SunFilled },
  { to: '/backlog', label: 'Backlog', Icon: ListOutline, ActiveIcon: ListFilled },
  { to: '/calendar', label: 'Calendar', Icon: CalendarOutline, ActiveIcon: CalendarFilled },
  { to: '/stats', label: 'Stats', Icon: Chart, ActiveIcon: Chart },
] as const;

// Each button is 48px wide with 4px between them.
const STEP = 52;

/** `away`: slid down out of sight, on pages with their own back arrow. */
export function FloatingToolbar({ onAdd, label, away = false }: { onAdd: () => void; label: string; away?: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));
  const active = NAV_ITEMS.findIndex(({ to }) => isActive(to));
  // On a page that isn't one of these, the pill fades where it last was.
  const last = useRef(0);
  if (active >= 0) last.current = active;

  // Scrolling down a page, it shrinks a little toward the bottom edge to get out of the way of
  // what's being read. Scrolling back up, reaching the top, or going to another page brings it
  // back. Not reaching the end: on a short page that comes at once, and it shrank and grew in a
  // blink. An attribute rather than state, so scrolling never renders anything.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current!;
    el.removeAttribute('data-compact');
    let from = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      // A few pixels either way is a finger settling, not a change of direction.
      if (Math.abs(y - from) < 8) return;
      el.toggleAttribute('data-compact', y > from && y > 48);
      from = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [pathname]);

  return (
    <div
      className={`toolbar fixed inset-x-0 z-10 flex justify-center px-4 medium:hidden ${away ? 'toolbar-away' : ''}`}
      // Its own layer when a task or list morphs open or closed (lib/morph.ts), so it stays on top
      // rather than going under the card and popping back in after.
      style={{ bottom: 'max(1.25rem, env(safe-area-inset-bottom))', viewTransitionName: 'toolbar' }}
      inert={away}
    >
      {/* Material's vibrant toolbar: a color the pages' cards don't use, so it stands off whatever
          scrolls under it, and the + in the accent nothing else on a page wears. */}
      <div ref={body} className="toolbar-body flex items-center gap-3">
        <nav aria-label="Main" className="relative flex items-center gap-1 rounded-full bg-primary-container p-2 shadow-lg">
          {/* One pill that slides between tabs. A CSS transition keeps it on the GPU, so it glides
              the moment a tab is tapped, even while the new page is still being built. */}
          <span
            aria-hidden
            className="toolbar-pill absolute top-2 left-2 size-12 rounded-full bg-surface-container"
            style={{ transform: `translateX(${last.current * STEP}px) scale(${active >= 0 ? 1 : 0.6})`, opacity: active >= 0 ? 1 : 0 }}
          />
          {NAV_ITEMS.map(({ to, label, Icon, ActiveIcon }) => {
            const active = isActive(to);
            const Glyph = active ? ActiveIcon : Icon;
            return (
              <Link
                key={to}
                to={to}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                onClick={() => !active && haptic('pick')}
                className="relative grid size-12 place-items-center rounded-full text-on-primary-container"
              >
                <Glyph className={`relative size-6 ${active ? 'text-on-surface' : ''}`} aria-hidden />
              </Link>
            );
          })}
        </nav>
        <button type="button" aria-label={label} onClick={onAdd} data-morph="add" className="grid size-14 place-items-center rounded-2xl bg-tertiary-container text-on-tertiary-container shadow-lg">
          <Add className="size-6" aria-hidden />
        </button>
      </div>
    </div>
  );
}
