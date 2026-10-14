import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import Check from '~icons/material-symbols/check-rounded';
import Copy from '~icons/material-symbols/content-copy-outline-rounded';
import { SubpageHeader } from '../components/ui.tsx';
import { useSnackbar } from '../lib/snackbar.tsx';
import { api } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';

interface Connections {
  mcpUrl: string;
  connections: { id: string; clientName: string; createdAt: string; lastUsedAt: string | null }[];
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function ago(iso: string | null) {
  if (!iso) return 'not used yet';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (minutes < 60) return `used ${rtf.format(-minutes, 'minute')}`;
  if (minutes < 60 * 24) return `used ${rtf.format(-Math.round(minutes / 60), 'hour')}`;
  return `used ${rtf.format(-Math.round(minutes / 1440), 'day')}`;
}

export function ConnectionsPage() {
  const queryClient = useQueryClient();
  const snack = useSnackbar();
  const { data } = useQuery({ queryKey: ['connections'], queryFn: () => api<Connections>('/connections') });
  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/connections/${id}`, { method: 'DELETE' }),
    onError: (e: Error) => snack({ message: e.message }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['connections'] }),
  });
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!data) return;
    await navigator.clipboard.writeText(data.mcpUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <>
      <SubpageHeader title="Connect Claude" />

      <section className="mt-4 rounded-[2rem] bg-secondary-container p-5 text-on-secondary-container">
        <div className="flex items-center gap-3">
          <Sparkle className="size-6" aria-hidden />
          <h2 className="display text-xl font-medium">Use Almanac from Claude</h2>
        </div>
        <p className="mt-2">
          Ask Claude to add tasks, plan your week, hand something to someone, or put milk on the grocery list. It works in Claude on the
          web, the desktop and phone apps, and Claude Code.
        </p>
        <ol className="mt-4 flex list-decimal flex-col gap-2 pl-5">
          <li>In Claude, open Settings, then Connectors, and choose Add custom connector.</li>
          <li>Name it Almanac and paste this address:</li>
        </ol>
        <div className="mt-3 flex items-center gap-2 rounded-2xl bg-surface-lowest p-2 pl-4 text-on-surface">
          <code className="min-w-0 flex-1 truncate text-sm">{data?.mcpUrl ?? '…'}</code>
          <motion.button
            type="button"
            onClick={() => void copy()}
            whileTap={{ scale: 0.92 }}
            transition={expressive.fastSpatial}
            aria-label="Copy address"
            className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-on-primary"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={copied ? 'done' : 'copy'}
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={expressive.fastSpatial}
              >
                {copied ? <Check className="size-5" /> : <Copy className="size-5" />}
              </motion.span>
            </AnimatePresence>
          </motion.button>
        </div>
        <p className="mt-3 text-sm">Then choose Connect and allow it on the Almanac page that opens. Claude acts as you, and only you.</p>
      </section>

      <h2 className="mt-8 mb-3 px-1 text-sm font-medium text-primary">Connected</h2>
      {data && data.connections.length === 0 && (
        <p className="rounded-3xl bg-surface-low p-5 text-on-surface-variant">Nothing is connected yet.</p>
      )}
      <ul className="flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {data?.connections.map((c) => (
            <motion.li
              key={c.id}
              layout
              exit={{ opacity: 0, scale: 0.95 }}
              transition={expressive.fastSpatial}
              className="flex items-center gap-4 rounded-3xl bg-surface-low p-4"
            >
              <div className="grid size-11 place-items-center rounded-full bg-tertiary-container text-on-tertiary-container">
                <Sparkle className="size-5" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{c.clientName}</p>
                <p className="text-sm text-on-surface-variant">
                  Since {day(c.createdAt)}, {ago(c.lastUsedAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => disconnect.mutate(c.id)}
                className="rounded-full px-4 py-2 text-sm font-medium text-primary hover:bg-surface-high"
              >
                Disconnect
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </>
  );
}
