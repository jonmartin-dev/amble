import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import CloudDone from '~icons/material-symbols/cloud-done-outline-rounded';
import CloudOff from '~icons/material-symbols/cloud-off-outline-rounded';
import Login from '~icons/material-symbols/login-rounded';
import Sync from '~icons/material-symbols/sync-rounded';
import Upgrade from '~icons/material-symbols/upgrade-rounded';
import { appUrl } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';
import { applyUpdate, useUpdateReady } from '../lib/pwa.ts';
import { useSyncState } from '../lib/sync.ts';

/** Only a send that takes this long says "Syncing"; quick ones pass without a word. */
const SHOW_SYNCING_AFTER_MS = 700;
const SHOW_SYNCED_FOR_MS = 1800;

const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;

interface Status {
  key: string;
  icon: ReactNode;
  text: string;
  action?: { label: string; run: () => void };
  tone?: 'primary';
}

/**
 * A quiet pill above the toolbar: offline, syncing, or a new version ready. It says nothing while
 * everything is in step, which is almost always.
 */
export function StatusPill() {
  const sync = useSyncState();
  const update = useUpdateReady();
  const [slowSync, setSlowSync] = useState(false);
  const [synced, setSynced] = useState(false);
  const wasBehind = useRef(false);

  useEffect(() => {
    if (!sync.syncing) return setSlowSync(false);
    const t = setTimeout(() => setSlowSync(true), SHOW_SYNCING_AFTER_MS);
    return () => clearTimeout(t);
  }, [sync.syncing]);

  // "All synced" follows only a stretch of changes waiting, never every quick save.
  const behind = sync.pending > 0 && (sync.blocked != null || !sync.online || slowSync);
  useEffect(() => {
    if (behind) wasBehind.current = true;
    else if (wasBehind.current && sync.pending === 0) {
      wasBehind.current = false;
      setSynced(true);
      const t = setTimeout(() => setSynced(false), SHOW_SYNCED_FOR_MS);
      return () => clearTimeout(t);
    }
  }, [behind, sync.pending]);

  let status: Status | null = null;
  if (update) {
    status = {
      key: 'update',
      icon: <Upgrade className="size-[18px]" aria-hidden />,
      text: 'A new version is ready',
      action: { label: 'Reload', run: applyUpdate },
      tone: 'primary',
    };
  } else if (sync.blocked === 'signed-out') {
    status = {
      key: 'signed-out',
      icon: <Login className="size-[18px]" aria-hidden />,
      text: `Sign in to sync ${changes(sync.pending)}`,
      action: { label: 'Sign in', run: () => window.location.assign(appUrl(`/auth/login?return=${encodeURIComponent(location.pathname)}`)) },
    };
  } else if (!sync.online || sync.blocked === 'offline') {
    status = { key: 'offline', icon: <CloudOff className="size-[18px]" aria-hidden />, text: sync.pending ? `Offline · ${changes(sync.pending)} to sync` : 'Offline' };
  } else if (sync.blocked === 'server') {
    status = { key: 'server', icon: <CloudOff className="size-[18px]" aria-hidden />, text: `Can't reach Almanac · ${changes(sync.pending)} to sync` };
  } else if (slowSync && sync.pending) {
    status = {
      key: 'syncing',
      icon: (
        <motion.span animate={{ rotate: -360 }} transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }} className="grid">
          <Sync className="size-[18px]" aria-hidden />
        </motion.span>
      ),
      text: `Syncing ${changes(sync.pending)}`,
    };
  } else if (synced) {
    status = { key: 'synced', icon: <CloudDone className="size-[18px]" aria-hidden />, text: 'All synced' };
  }

  // Snackbars sit just above the pill while it shows.
  useEffect(() => {
    document.documentElement.style.setProperty('--status-pill', status ? '2.75rem' : '0rem');
  }, [status != null]);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 z-10 flex justify-center px-4"
      style={{ bottom: 'calc(max(1.25rem, env(safe-area-inset-bottom)) + var(--toolbar))', paddingLeft: 'calc(var(--rail) + 1rem)' }}
    >
      <AnimatePresence mode="popLayout">
        {status && (
          <motion.div
            key={status.key === 'synced' || status.key === 'update' ? status.key : 'sync'}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.94 }}
            transition={expressive.fastSpatial}
            className={`pointer-events-auto flex h-9 items-center gap-2 rounded-full pr-1.5 pl-3 text-[13px] font-medium shadow-md ${
              status.tone === 'primary' ? 'bg-primary-container text-on-primary-container' : 'bg-surface-highest text-on-surface-variant'
            } ${status.action ? '' : 'pr-3.5'}`}
          >
            {status.icon}
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={status.text} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={expressive.fastEffects}>
                {status.text}
              </motion.span>
            </AnimatePresence>
            {status.action && (
              <button
                type="button"
                onClick={status.action.run}
                className={`ml-1 h-7 rounded-full px-3 text-[13px] font-semibold ${status.tone === 'primary' ? 'bg-primary text-on-primary' : 'bg-secondary-container text-on-secondary-container'}`}
              >
                {status.action.label}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
