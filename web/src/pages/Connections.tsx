import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import Check from '~icons/material-symbols/check-rounded';
import Copy from '~icons/material-symbols/content-copy-outline-rounded';
import { ButtonGroup, SectionTitle, SubpageHeader } from '../components/ui.tsx';
import { useSnackbar } from '../lib/snackbar.tsx';
import { api } from '../lib/api.ts';
import { onDevice } from '../lib/device.ts';
import { expressive } from '../lib/motion.ts';

interface Connections {
  mcpUrl: string;
  connections: { id: string; clientName: string; createdAt: string; lastUsedAt: string | null }[];
}

type Assistant = 'claude' | 'chatgpt';

const ASSISTANTS: { value: Assistant; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'chatgpt', label: 'ChatGPT' },
];

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function ago(iso: string | null) {
  if (!iso) return 'not used yet';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (minutes < 60) return `used ${rtf.format(-minutes, 'minute')}`;
  if (minutes < 60 * 24) return `used ${rtf.format(-Math.round(minutes / 60), 'hour')}`;
  return `used ${rtf.format(-Math.round(minutes / 1440), 'day')}`;
}

/** The connector's address with a copy button. Shown whole, since people sometimes type it. */
function Address({ url }: { url: string | undefined }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="mt-2 -ml-5 flex items-center gap-2 rounded-2xl bg-surface-lowest p-2 pl-4 text-on-surface">
      <code className="min-w-0 flex-1 text-sm break-all">{url ?? '…'}</code>
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
  );
}

function Steps({ assistant, url }: { assistant: Assistant; url: string | undefined }) {
  if (assistant === 'claude') {
    return (
      <>
        <ol className="flex list-decimal flex-col gap-3 pl-5">
          <li>In Claude, open Settings, then Connectors, and choose Add custom connector.</li>
          <li>
            Name it Amble and paste this address:
            <Address url={url} />
          </li>
          <li>Choose Connect, then Allow on the Amble page that opens.</li>
        </ol>
        <p className="mt-4 text-sm">It works in Claude on the web, the desktop and phone apps, and Claude Code.</p>
      </>
    );
  }
  return (
    <>
      <ol className="flex list-decimal flex-col gap-3 pl-5">
        <li>In ChatGPT on the web, open Settings, then Apps, then Advanced settings, and turn on Developer mode.</li>
        <li>
          Back in Apps, choose Create. Name it Amble and paste this address:
          <Address url={url} />
        </li>
        <li>Pick OAuth for authentication, then Allow on the Amble page that opens, and choose Create.</li>
      </ol>
      <p className="mt-4 text-sm">
        Developer mode is a ChatGPT beta, only on the web. On Business, Enterprise and Edu plans ChatGPT can add and change things; on
        Pro it can only look. In a chat, pick Amble from the tools menu or type @Amble.
      </p>
    </>
  );
}

/** On a device with no server: what connecting an assistant takes. */
function NeedsServer() {
  return (
    <>
      <SubpageHeader title="Connect an assistant" />
      <p className="px-1 text-on-surface-variant">
        Ask Claude or ChatGPT to add tasks, plan your week, hand something to someone, or put milk on the grocery list.
      </p>
      <section className="mt-5 rounded-[2rem] bg-secondary-container p-5 text-on-secondary-container">
        <h2 className="display text-xl font-medium">This needs an Amble server</h2>
        <p className="mt-2">
          Claude and ChatGPT reach Amble from their own computers on the internet, so they need an address that's always there. A
          phone or a browser tab can't be that.
        </p>
        <p className="mt-2">
          Amble's server runs as one Docker container on a computer you keep on, like a home server. It joins your household's sync
          as one more copy, and gives you the address to connect. Amble's docs walk through setting it up.
        </p>
      </section>
    </>
  );
}

export function ConnectionsPage() {
  if (onDevice) return <NeedsServer />;
  return <ServerConnections />;
}

function ServerConnections() {
  const queryClient = useQueryClient();
  const snack = useSnackbar();
  const { data } = useQuery({ queryKey: ['connections'], queryFn: () => api<Connections>('/connections') });
  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/connections/${id}`, { method: 'DELETE' }),
    onError: (e: Error) => snack({ message: e.message }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['connections'] }),
  });
  const [assistant, setAssistant] = useState<Assistant>('claude');

  return (
    <>
      <SubpageHeader title="Connect an assistant" />
      <p className="px-1 text-on-surface-variant">
        Ask Claude or ChatGPT to add tasks, plan your week, hand something to someone, or put milk on the grocery list. Whichever you
        connect acts as you, and only you.
      </p>

      <SectionTitle>Set it up</SectionTitle>
      <ButtonGroup value={assistant} options={ASSISTANTS} onChange={setAssistant} label="Assistant" />
      <section aria-label={`Connect ${assistant === 'claude' ? 'Claude' : 'ChatGPT'}`} className="mt-3 rounded-[2rem] bg-secondary-container p-5 text-on-secondary-container">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={assistant}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={expressive.fastSpatial}
          >
            <Steps assistant={assistant} url={data?.mcpUrl} />
          </motion.div>
        </AnimatePresence>
      </section>

      <SectionTitle>Connected</SectionTitle>
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
              <div className="grid size-11 shrink-0 place-items-center rounded-full bg-tertiary-container text-on-tertiary-container">
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
