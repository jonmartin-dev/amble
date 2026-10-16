import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import CalendarMonth from '~icons/material-symbols/calendar-month-outline-rounded';
import Warning from '~icons/material-symbols/warning-outline-rounded';
import { ListGroup, SectionTitle, SubpageHeader, Switch } from '../components/ui.tsx';
import { api, type Calendars } from '../lib/api.ts';
import { allowCalendar, calendarAllowed, readPhoneCalendars } from '../lib/calendar.ts';
import { native } from '../lib/native.ts';
import { useCalendars } from '../lib/queries.ts';
import { useSnackbar } from '../lib/snackbar.tsx';

const DAY_VIEWS = ['load', 'events', 'today', 'briefing', 'gaps', 'capacity'];

const button = 'rounded-full bg-primary px-5 py-3 font-medium text-on-primary transition-opacity disabled:opacity-40';
const quiet = 'rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high disabled:opacity-40';

/** Settings → Calendars: the phone's own calendars, and which of them count toward how full a day is. */
export function CalendarsPage() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const { data } = useCalendars();
  const [busy, setBusy] = useState(false);
  // Android can take the permission back from its own settings.
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    void calendarAllowed().then(setAllowed, () => setAllowed(false));
  }, []);

  const refreshDays = () => {
    for (const key of DAY_VIEWS) void qc.invalidateQueries({ queryKey: [key] });
  };

  const start = async () => {
    setBusy(true);
    try {
      if (!(await allowCalendar())) {
        snack({ message: "Android didn't allow it. You can allow it in the phone's settings, under Apps, Amble, Permissions." });
        return;
      }
      setAllowed(true);
      if (!(await readPhoneCalendars(qc, { start: true }))) snack({ message: "Amble couldn't read this phone's calendars. Try again." });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['calendars'] });
    }
  };

  const setCounts = async (id: string, counts: boolean) => {
    const before = qc.getQueryData<Calendars>(['calendars']);
    qc.setQueryData<Calendars>(['calendars'], (d) => d && { ...d, calendars: d.calendars.map((c) => (c.id === id ? { ...c, counts } : c)) });
    try {
      await api(`/calendars/${id}`, { method: 'PATCH', body: JSON.stringify({ counts }) });
      // A calendar that counts now gets its events read.
      if (counts) await readPhoneCalendars(qc, { force: true });
      refreshDays();
    } catch (e) {
      qc.setQueryData(['calendars'], before);
      snack({ message: (e as Error).message });
    }
    void qc.invalidateQueries({ queryKey: ['calendars'] });
  };

  const stop = async () => {
    if (!confirm("Stop using this phone's calendars? Their events leave Amble, and days count as free again.")) return;
    setBusy(true);
    try {
      await api('/calendars/phone', { method: 'DELETE' });
      refreshDays();
    } catch (e) {
      snack({ message: (e as Error).message });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['calendars'] });
    }
  };

  // Grouped by the account each belongs to, as the phone's calendar app shows them.
  const accounts = new Map<string, Calendars['calendars']>();
  for (const c of data?.calendars ?? []) accounts.set(c.account ?? 'This phone', [...(accounts.get(c.account ?? 'This phone') ?? []), c]);

  return (
    <>
      <SubpageHeader title="Calendars" />

      <section className="mt-4 rounded-[2rem] bg-secondary-container p-5 text-on-secondary-container">
        <div className="flex items-center gap-3">
          <CalendarMonth className="size-6" aria-hidden />
          <h2 className="display text-xl font-medium">Plan around your calendar</h2>
        </div>
        <p className="mt-2">
          {native
            ? "Amble reads the calendars on this phone, so a day with more on it than usual has less room for tasks and suggestions steer around it. It only reads, and your events stay on this phone. Everyone else just sees that a day is busier."
            : 'A day with more on your calendar than usual has less room for tasks. The Amble app on your phone reads your calendars and shares how busy each day is, never what the events are.'}
        </p>
      </section>

      {!native ? (
        <p className="mt-6 px-1 text-on-surface-variant">
          {data?.sharedDays
            ? `Your phone has shared how busy your days are, so ${data.sharedDays === 1 ? 'a busy day coming up counts' : `${data.sharedDays} busy days coming up count`} here too.`
            : "Turn on Calendars in the Amble app on your Android phone. Once it syncs, how busy each day is counts here too."}
        </p>
      ) : !data?.on ? (
        <div className="mt-6 flex flex-col items-start gap-3">
          <button type="button" disabled={busy || !data} onClick={() => void start()} className={button}>
            Use this phone's calendars
          </button>
          <p className="px-1 text-sm text-on-surface-variant">Android asks once whether Amble can see your calendars.</p>
        </div>
      ) : (
        <>
          {allowed === false && (
            <div className="mt-6 flex flex-col items-start gap-3 rounded-3xl bg-warm-container p-5 text-on-warm-container">
              <p className="flex gap-3">
                <Warning className="size-6 shrink-0" aria-hidden />
                Android stopped letting Amble see your calendars, so these aren't up to date.
              </p>
              <button type="button" disabled={busy} onClick={() => void start()} className={button}>
                Allow again
              </button>
            </div>
          )}
          {[...accounts].map(([account, list]) => (
            <section key={account}>
              <SectionTitle>{account}</SectionTitle>
              <ListGroup
                label={`Calendars in ${account}`}
                rows={list.map((c) => ({
                  icon: <span className="size-4 rounded-full" style={{ background: c.color ?? 'var(--color-primary)' }} />,
                  title: c.name,
                  subtitle: c.counts ? 'Counts toward your days' : "Doesn't count",
                  trailing: <Switch checked={c.counts} onChange={(v) => void setCounts(c.id, v)} label={`Count ${c.name}`} />,
                }))}
              />
            </section>
          ))}
          {data.calendars.length === 0 && <p className="mt-6 px-1 text-on-surface-variant">This phone has no calendars yet.</p>}
          <p className="mt-3 px-1 text-sm text-on-surface-variant">Amble reads them again whenever it opens.</p>
          <SectionTitle>Stop</SectionTitle>
          <button type="button" disabled={busy} onClick={() => void stop()} className={quiet}>
            Stop using this phone's calendars
          </button>
        </>
      )}
    </>
  );
}
