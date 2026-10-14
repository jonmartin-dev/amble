import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';
import Add from '~icons/material-symbols/add-rounded';
import CalendarMonth from '~icons/material-symbols/calendar-month-outline-rounded';
import Warning from '~icons/material-symbols/warning-outline-rounded';
import { ListGroup, SectionTitle, SubpageHeader, Switch } from '../components/ui.tsx';
import { api, appUrl, type CalendarAccount } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';
import { useCalendars } from '../lib/queries.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { useSyncState } from '../lib/sync.ts';

type Calendars = { enabled: boolean; accounts: CalendarAccount[] };

const ERRORS: Record<string, string> = {
  off: "Calendar sync isn't set up on this server yet.",
  declined: 'Nothing changed: Google said no, or the window was closed.',
  failed: "Google didn't finish connecting. Try again.",
};

function synced(account: CalendarAccount) {
  if (account.status === 'reconnect') return 'Google stopped sharing this calendar. Connect it again to pick up where it left off.';
  if (account.error) return account.error;
  if (!account.syncedAt) return 'Reading your calendars…';
  const minutes = Math.round((Date.now() - new Date(account.syncedAt).getTime()) / 60_000);
  if (minutes < 1) return 'Up to date';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return minutes < 60 ? `Synced ${rtf.format(-minutes, 'minute')}` : `Synced ${rtf.format(-Math.round(minutes / 60), 'hour')}`;
}

/** Settings → Calendars: connect Google accounts and choose which calendars count toward how full a day is. */
export function CalendarsPage() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const navigate = useNavigate();
  const { online } = useSyncState();
  const { data } = useCalendars();
  const search = useSearch({ strict: false }) as { connected?: string; error?: string };

  // Coming back from Google: say how it went once, then tidy the address.
  useEffect(() => {
    if (!search.connected && !search.error) return;
    snack({ message: search.connected ? 'Connected. Your events are on their way in.' : (ERRORS[search.error!] ?? search.error!) });
    void qc.invalidateQueries({ queryKey: ['calendars'] });
    void navigate({ to: '/settings/calendars', search: {}, replace: true });
  }, [search.connected, search.error, snack, qc, navigate]);

  // While a new account is still reading, check back until it's done.
  const reading = data?.accounts.some((a) => a.status === 'ok' && !a.syncedAt);
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ['calendars'] }), 2000);
    return () => clearInterval(t);
  }, [reading, qc]);

  const refreshDays = () => {
    for (const key of ['load', 'events', 'today', 'briefing', 'gaps', 'capacity']) void qc.invalidateQueries({ queryKey: [key] });
  };

  const setCounts = async (calendarId: string, counts: boolean) => {
    const before = qc.getQueryData<Calendars>(['calendars']);
    qc.setQueryData<Calendars>(['calendars'], (d) =>
      d && { ...d, accounts: d.accounts.map((a) => ({ ...a, calendars: a.calendars.map((c) => (c.id === calendarId ? { ...c, counts } : c)) })) },
    );
    try {
      const { accounts } = await api<{ accounts: CalendarAccount[] }>(`/calendars/${calendarId}`, { method: 'PATCH', body: JSON.stringify({ counts }) });
      qc.setQueryData<Calendars>(['calendars'], (d) => d && { ...d, accounts });
      refreshDays();
    } catch (e) {
      qc.setQueryData(['calendars'], before);
      snack({ message: (e as Error).message });
    }
  };

  const disconnect = async (account: CalendarAccount) => {
    if (!confirm(`Disconnect ${account.email}? Its events leave Almanac, and Google stops sharing them.`)) return;
    try {
      await api(`/calendars/accounts/${account.id}`, { method: 'DELETE' });
      snack({ message: `Disconnected ${account.email}.` });
    } catch (e) {
      snack({ message: (e as Error).message });
    }
    void qc.invalidateQueries({ queryKey: ['calendars'] });
    refreshDays();
  };

  const connect = () => window.location.assign(appUrl('/auth/calendar'));

  return (
    <>
      <SubpageHeader title="Calendars" />

      <section className="mt-4 rounded-[2rem] bg-secondary-container p-5 text-on-secondary-container">
        <div className="flex items-center gap-3">
          <CalendarMonth className="size-6" aria-hidden />
          <h2 className="display text-xl font-medium">Plan around your calendar</h2>
        </div>
        <p className="mt-2">
          Almanac reads your Google Calendar so a day with more on it than usual has less room for tasks, and suggestions steer around it.
          It only reads, and only you see your events. Everyone else just sees that a day is busier.
        </p>
      </section>

      {data && !data.enabled && (
        <p className="mt-6 flex gap-3 rounded-3xl bg-surface-low p-5 text-on-surface-variant">
          <Warning className="size-6 shrink-0" aria-hidden />
          Calendar sync isn't set up on this server. It needs a Google sign-in client with the Google Calendar API turned on.
        </p>
      )}

      <AnimatePresence initial={false}>
        {data?.accounts.map((account) => (
          <motion.section key={account.id} layout exit={{ opacity: 0, height: 0 }} transition={expressive.defaultSpatial}>
            <SectionTitle
              action={
                <button type="button" onClick={() => void disconnect(account)} className="rounded-full px-3 py-1 text-sm font-medium text-primary hover:bg-surface-high">
                  Disconnect
                </button>
              }
            >
              {account.email}
            </SectionTitle>
            <p className={`mb-3 px-1 text-sm ${account.status === 'reconnect' || account.error ? 'text-warm' : 'text-on-surface-variant'}`}>{synced(account)}</p>
            {account.status === 'reconnect' && (
              <button type="button" onClick={connect} disabled={!online} className="mb-3 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-on-primary disabled:opacity-40">
                Connect again
              </button>
            )}
            {account.calendars.length > 0 && (
              <ListGroup
                label={`Calendars in ${account.email}`}
                rows={account.calendars.map((c) => ({
                  icon: <span className="size-4 rounded-full" style={{ background: c.color ?? 'var(--color-primary)' }} />,
                  title: c.name,
                  subtitle: c.primary ? 'Your main calendar' : c.counts ? 'Counts toward your days' : "Doesn't count",
                  trailing: <Switch checked={c.counts} onChange={(v) => void setCounts(c.id, v)} label={`Count ${c.name}`} />,
                }))}
              />
            )}
          </motion.section>
        ))}
      </AnimatePresence>

      {data?.enabled && (
        <button
          type="button"
          onClick={connect}
          disabled={!online}
          className="mt-6 flex items-center gap-2 rounded-full bg-primary px-5 py-3 font-medium text-on-primary transition-opacity disabled:opacity-40"
        >
          <Add className="size-5" aria-hidden />
          {data.accounts.length ? 'Connect another Google account' : 'Connect Google Calendar'}
        </button>
      )}
      {data?.enabled && !online && <p className="mt-2 px-1 text-sm text-on-surface-variant">Connecting needs a connection.</p>}
      {data?.enabled && data.accounts.length === 0 && (
        <p className="mt-3 px-1 text-sm text-on-surface-variant">
          Google will warn that it hasn't verified Almanac. That's expected for an app you run yourself: choose Advanced, then continue.
        </p>
      )}
    </>
  );
}
