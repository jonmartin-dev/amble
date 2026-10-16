import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import CloudDone from '~icons/material-symbols/cloud-done-outline-rounded';
import Login from '~icons/material-symbols/login-rounded';
import Sync from '~icons/material-symbols/sync-rounded';
import Upgrade from '~icons/material-symbols/upgrade-rounded';
import { refreshStatus, syncNow, useDriveSync } from '../lib/drive-sync.ts';
import { signInToServer, useServerReturn } from '../lib/server-sync.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { expressive } from '../lib/motion.ts';
import { applyUpdate, useUpdateReady } from '../lib/pwa.ts';
import { useSyncState } from '../lib/sync.ts';

/** Only a write that takes this long says "Saving"; quick ones (nearly all) pass without a word. */
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
 * A quiet pill above the toolbar: sync paused, saving, or a new version ready. It says nothing while
 * everything is in step, which is almost always.
 */
export function StatusPill() {
  const sync = useSyncState();
  const update = useUpdateReady();
  const drive = useDriveSync();
  const snack = useSnackbar();
  // Back from signing in to the household's server again.
  useServerReturn('server-again', (outcome) => {
    if (!outcome.ok) snack({ message: outcome.error });
    void refreshStatus().then(() => syncNow());
  });
  const [slowSync, setSlowSync] = useState(false);
  const [synced, setSynced] = useState(false);
  const wasBehind = useRef(false);

  useEffect(() => {
    if (!sync.syncing) return setSlowSync(false);
    const t = setTimeout(() => setSlowSync(true), SHOW_SYNCING_AFTER_MS);
    return () => clearTimeout(t);
  }, [sync.syncing]);

  // "All saved" follows only a stretch of changes waiting, never every quick save.
  const behind = sync.pending > 0 && slowSync;
  useEffect(() => {
    if (behind) wasBehind.current = true;
    else if (wasBehind.current && sync.pending === 0) {
      wasBehind.current = false;
      setSynced(true);
      const t = setTimeout(() => setSynced(false), SHOW_SYNCED_FOR_MS);
      return () => clearTimeout(t);
    }
  }, [behind, sync.pending]);

  // Changes go straight into the database on this device; only syncing can be waiting.
  const server = drive.status?.target?.kind === 'server' ? drive.status.target.url : null;
  let status: Status | null = null;
  if (update) {
    status = {
      key: 'update',
      icon: <Upgrade className="size-[18px]" aria-hidden />,
      text: 'A new version is ready',
      action: { label: 'Reload', run: applyUpdate },
      tone: 'primary',
    };
  } else if (server && drive.status?.error === 'Your server needs you to sign in again.') {
    status = {
      key: 'drive',
      icon: <Login className="size-[18px]" aria-hidden />,
      text: 'Sync paused',
      action: { label: 'Sign in', run: () => void signInToServer(server, 'server-again') },
    };
  } else if (drive.needsGoogle && drive.status?.on) {
    status = {
      key: 'drive',
      icon: <Sync className="size-[18px]" aria-hidden />,
      text: drive.status.waiting ? 'Changes to sync' : 'Sync paused',
      action: { label: 'Continue', run: () => void syncNow({ tap: true }).catch(() => {}) },
    };
  } else if (slowSync && sync.pending) {
    status = {
      key: 'syncing',
      icon: (
        <motion.span animate={{ rotate: -360 }} transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }} className="grid">
          <Sync className="size-[18px]" aria-hidden />
        </motion.span>
      ),
      text: `Saving ${changes(sync.pending)}`,
    };
  } else if (synced) {
    status = { key: 'synced', icon: <CloudDone className="size-[18px]" aria-hidden />, text: 'All saved' };
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
