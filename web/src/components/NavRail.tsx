import { Link } from '@tanstack/react-router';
import { motion } from 'motion/react';
import Add from '~icons/material-symbols/add-rounded';
import SettingsOutline from '~icons/material-symbols/settings-outline-rounded';
import SettingsFilled from '~icons/material-symbols/settings-rounded';
import { expressive } from '../lib/motion.ts';
import { NAV_ITEMS } from './FloatingToolbar.tsx';

/**
 * M3 Expressive navigation rail, for screens wider than a phone: the add button at the top, the
 * four pages under it, and Settings at the foot. `current` is the page showing, which on a wide
 * screen stays lit while a task is open beside it.
 */
export function NavRail({ current, settings, onAdd, label }: { current: string | null; settings: boolean; onAdd: () => void; label: string }) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-y-0 left-0 z-10 hidden flex-col items-center overflow-y-auto pb-4 [scrollbar-width:none] medium:flex"
      style={{ width: 'var(--rail)', paddingTop: 'max(1.5rem, env(safe-area-inset-top))', paddingLeft: 'env(safe-area-inset-left)' }}
    >
      <motion.button
        type="button"
        aria-label={label}
        onClick={onAdd}
        whileTap={{ scale: 0.9, borderRadius: '40%' }}
        transition={expressive.fastSpatial}
        className="grid size-14 shrink-0 place-items-center rounded-2xl bg-primary text-on-primary shadow-md"
      >
        <Add className="size-7" aria-hidden />
      </motion.button>
      <div className="mt-7 flex flex-col gap-2">
        {NAV_ITEMS.map(({ to, label, Icon, ActiveIcon }) => (
          <RailItem key={to} to={to} label={label} active={current === to} Icon={current === to ? ActiveIcon : Icon} />
        ))}
      </div>
      <div className="mt-auto pt-4">
        <RailItem to="/settings" label="Settings" active={settings} Icon={settings ? SettingsFilled : SettingsOutline} />
      </div>
    </nav>
  );
}

function RailItem({ to, label, active, Icon }: { to: string; label: string; active: boolean; Icon: (typeof NAV_ITEMS)[number]['Icon'] }) {
  return (
    <Link to={to} aria-current={active ? 'page' : undefined} className="group flex w-20 flex-col items-center gap-1 py-1 text-on-surface-variant">
      <span className="relative grid h-8 w-14 place-items-center">
        {/* The indicator grows out from the middle as a page is picked (CSS, so it's quick to start). */}
        <span aria-hidden className={`rail-pill absolute inset-0 rounded-full bg-secondary-container ${active ? '' : 'rail-pill-off'}`} />
        <span aria-hidden className="absolute inset-0 rounded-full bg-on-surface opacity-0 transition-opacity group-hover:opacity-[0.08]" />
        <Icon className={`relative size-6 ${active ? 'text-on-secondary-container' : ''}`} aria-hidden />
      </span>
      <span className={`text-xs font-medium ${active ? 'text-on-surface' : ''}`}>{label}</span>
    </Link>
  );
}
