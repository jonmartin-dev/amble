import { Link } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import History from '~icons/material-symbols/history-rounded';
import Logout from '~icons/material-symbols/logout-rounded';
import SettingsIcon from '~icons/material-symbols/settings-outline-rounded';
import { expressive } from '../lib/motion.ts';
import { signOut } from '../lib/persist.ts';
import { useMe } from '../lib/queries.ts';
import { Avatar } from './Avatar.tsx';

export function PageHeader({ eyebrow, title }: { eyebrow?: ReactNode; title: ReactNode }) {
  const me = useMe();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <header className="mb-6 flex items-start justify-between gap-4">
      <div>
        {eyebrow && <p className="text-sm text-on-surface-variant">{eyebrow}</p>}
        <h1 className="display mt-1 text-[2.25rem] leading-[1.1] font-medium">{title}</h1>
      </div>
      {me && (
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            aria-label="Account"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="rounded-full transition-transform active:scale-95"
          >
            <Avatar member={me} size={40} />
          </button>
          <AnimatePresence>
            {open && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9, y: -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -8 }}
                transition={expressive.fastSpatial}
                style={{ transformOrigin: 'top right' }}
                className="absolute right-0 z-20 mt-2 w-60 rounded-3xl bg-surface-high p-2 shadow-lg"
              >
                <div className="px-3 py-2">
                  <p className="font-medium">{me.name}</p>
                  <p className="truncate text-sm text-on-surface-variant">{me.email}</p>
                </div>
                <Link
                  to="/settings"
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left hover:bg-surface-highest"
                >
                  <SettingsIcon className="size-5" aria-hidden />
                  Settings
                </Link>
                <Link
                  to="/activity"
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left hover:bg-surface-highest"
                >
                  <History className="size-5" aria-hidden />
                  Activity
                </Link>
                <button
                  type="button"
                  onClick={() => void signOut(qc)}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left hover:bg-surface-highest"
                >
                  <Logout className="size-5" aria-hidden />
                  Sign out
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </header>
  );
}
