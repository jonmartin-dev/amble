import { useMutation, useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import Warning from '~icons/material-symbols/warning-outline-rounded';
import { api, ApiError, appUrl } from '../lib/api.ts';
import { firstName } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useMe } from '../lib/queries.ts';

interface ConnectRequest {
  clientName: string;
  clientHost: string;
  redirectHost: string;
  loopback: boolean;
}

/** OAuth consent: shown when Claude (or another allowed app) asks to act for the signed-in member. */
export function Connect({ requestId }: { requestId: string }) {
  const me = useMe();
  const request = useQuery({
    queryKey: ['connect', requestId],
    queryFn: () => api<ConnectRequest>(`/oauth/requests/${requestId}`),
    retry: false,
    staleTime: Infinity,
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api<{ redirect: string }>(`/oauth/requests/${requestId}`, { method: 'POST', body: JSON.stringify({ approve }) }),
    onSuccess: ({ redirect }) => window.location.assign(redirect),
  });

  const expired = request.error instanceof ApiError || decide.error instanceof ApiError;
  const r = request.data;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <div className="flex items-center gap-3" aria-hidden>
        <motion.img
          src={appUrl('/icon.svg')}
          alt=""
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={expressive.slowSpatial}
          className="size-16"
        />
        <motion.div
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ ...expressive.slowSpatial, delay: 0.1 }}
          style={{ transformOrigin: 'left' }}
          className="h-1 w-10 rounded-full bg-outline-variant"
        />
        <motion.div
          initial={{ scale: 0.6, rotate: -20, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ ...expressive.slowSpatial, delay: 0.15 }}
          className="grid size-16 place-items-center rounded-[1.75rem] bg-tertiary-container text-on-tertiary-container"
        >
          <Sparkle className="size-8" />
        </motion.div>
      </div>

      {expired ? (
        <>
          <h1 className="display mt-8 text-[2.5rem] leading-tight font-medium">This link has expired</h1>
          <p className="mt-3 text-lg text-on-surface-variant">Start connecting again from Claude. Requests last 15 minutes.</p>
          <a href={appUrl('/')} className="mt-10 rounded-full bg-surface-high px-6 py-4 text-center font-medium">
            Open Almanac
          </a>
        </>
      ) : !r ? (
        <div className="mt-8 h-40" />
      ) : (
        <>
          <h1 className="display mt-8 text-[2.5rem] leading-tight font-medium">Let {r.clientName} use your Almanac?</h1>
          <p className="mt-3 text-lg text-on-surface-variant">
            {r.clientName} from <span className="font-medium text-on-surface">{r.clientHost}</span> will be able to see and change your
            tasks, lists and plans as {firstName(me?.name ?? 'you')}.
          </p>

          {r.loopback && (
            <div role="note" className="mt-6 flex gap-3 rounded-3xl bg-warm-container p-4 text-on-warm-container">
              <Warning className="mt-0.5 size-5 shrink-0" aria-hidden />
              <p>
                This hands access to an app on this computer ({r.redirectHost}). Only allow it if you just started connecting from Claude
                Code or another app you trust.
              </p>
            </div>
          )}

          <div className="mt-10 flex flex-col gap-3">
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              transition={expressive.fastSpatial}
              disabled={decide.isPending}
              onClick={() => decide.mutate(true)}
              className="rounded-full bg-primary px-6 py-4 text-lg font-medium text-on-primary disabled:opacity-60"
            >
              {decide.isPending && decide.variables ? 'Connecting…' : 'Allow'}
            </motion.button>
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              transition={expressive.fastSpatial}
              disabled={decide.isPending}
              onClick={() => decide.mutate(false)}
              className="rounded-full bg-surface-high px-6 py-4 text-lg disabled:opacity-60"
            >
              Cancel
            </motion.button>
          </div>
          <p className="mt-6 text-center text-sm text-on-surface-variant">You can disconnect it any time from Connect Claude in Almanac.</p>
        </>
      )}
    </main>
  );
}
