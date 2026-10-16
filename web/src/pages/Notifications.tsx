import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import Alarm from '~icons/material-symbols/alarm-outline-rounded';
import Close from '~icons/material-symbols/close-rounded';
import Devices from '~icons/material-symbols/devices-outline-rounded';
import Bell from '~icons/material-symbols/notifications-active-outline-rounded';
import Phone from '~icons/material-symbols/phone-android-outline-rounded';
import { pushHint } from '../components/ReminderSheet.tsx';
import { ListGroup, SectionTitle, segment, SubpageHeader, Switch } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { allowExactReminders, exactReminders, native } from '../lib/native.ts';
import { reminderLabel, shortDate, isoDate } from '../lib/dates.ts';
import { disablePush, enablePush, usePushState, type PushState } from '../lib/push.ts';
import { usePushDevices, useReminders } from '../lib/queries.ts';
import { useSnackbar } from '../lib/snackbar.tsx';

export function notificationSummary(state: PushState | null) {
  switch (state) {
    case 'on':
      return 'Reminders come to this device';
    case 'off':
      return 'Off on this device';
    case 'blocked':
      return native ? "Off in Android's settings" : 'Blocked in this browser';
    case 'needs-install':
      return 'Add Amble to your home screen first';
    case 'unsupported':
      return "This browser can't show them";
    default:
      return undefined;
  }
}

/** Settings → Notifications: reminders on this device, your other devices, and what's coming up. */
export function Notifications() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const push = usePushState();
  const { data } = usePushDevices();
  const { data: upcoming } = useReminders();
  const [busy, setBusy] = useState(false);
  const others = data?.devices.filter((d) => d.endpoint !== push.endpoint) ?? [];
  // In the Android app: whether reminders can show on the minute, checked again on coming back from Android's settings.
  const [exact, setExact] = useState<boolean | null>(null);
  const checkExact = useCallback(() => (native ? void exactReminders().then(setExact, () => setExact(null)) : undefined), []);
  useEffect(() => {
    checkExact();
    const onVisible = () => document.visibilityState === 'visible' && checkExact();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [checkExact]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        const state = await enablePush();
        if (state === 'blocked')
          snack({
            message: native
              ? 'Notifications are off for Amble. Turn them on in Android’s settings for Amble, then try again.'
              : 'Notifications are blocked for Amble. Allow them in the browser’s site settings, then try again.',
          });
      } else await disablePush();
    } catch (e) {
      snack({ message: (e as Error).message });
    } finally {
      setBusy(false);
      await push.check();
      void qc.invalidateQueries({ queryKey: ['push'] });
    }
  };

  const test = async () => {
    try {
      const result = await api<{ sent: number; devices: number }>('/push/test', { method: 'POST', body: '{}' });
      snack({ message: result.sent ? `Sent to ${result.sent === 1 ? 'one device' : `${result.sent} devices`}.` : "It didn't reach any device. Turn notifications off and on again here." });
    } catch (e) {
      snack({ message: (e as Error).message });
    }
    void qc.invalidateQueries({ queryKey: ['push'] });
  };

  const forget = async (id: string) => {
    try {
      await api(`/push/devices/${id}`, { method: 'DELETE' });
    } catch (e) {
      snack({ message: (e as Error).message });
    }
    void qc.invalidateQueries({ queryKey: ['push'] });
  };

  const unavailable = push.state !== null && push.state !== 'on' && push.state !== 'off';

  return (
    <>
      <SubpageHeader title="Notifications" />

      <section className="mt-4 rounded-[2rem] bg-secondary-container p-5 text-on-secondary-container">
        <div className="flex items-center gap-3">
          <Bell className="size-6" aria-hidden />
          <h2 className="display text-xl font-medium">Reminders, and nothing else</h2>
        </div>
        <p className="mt-2">
          Amble only notifies you about reminders you set on a task: one notification at the time you picked, with Done and Snooze
          right on it. Nothing else ever pings you, not even tasks someone hands you.
        </p>
      </section>

      <SectionTitle>This device</SectionTitle>
      <ListGroup
        rows={[
          {
            icon: <Phone className="size-6" />,
            title: 'Reminders on this device',
            subtitle: unavailable ? pushHint(push.state) : notificationSummary(push.state),
            trailing: unavailable ? undefined : (
              <Switch checked={push.state === 'on'} onChange={(v) => !busy && void toggle(v)} label="Reminders on this device" />
            ),
          },
        ]}
      />
      {native && push.state === 'on' && exact === false && (
        <div className="mt-3">
          <ListGroup
            rows={[
              {
                icon: <Alarm className="size-6" />,
                title: 'On the minute',
                subtitle: 'Android can hold reminders back a few minutes while the phone is idle. Allow Alarms and reminders for Amble to have them on time.',
                trailing: (
                  <button type="button" onClick={() => void allowExactReminders().then(checkExact)} className="rounded-full bg-secondary-container px-4 py-2 text-sm font-medium text-on-secondary-container">
                    Allow
                  </button>
                ),
              },
            ]}
          />
        </div>
      )}
      {push.state === 'on' && (
        <button type="button" onClick={() => void test()} className="mt-3 rounded-full px-4 py-2 text-sm font-medium text-primary hover:bg-surface-high">
          Send a test notification
        </button>
      )}
      <p className="mt-2 px-1 text-sm text-on-surface-variant">
        {native
          ? 'Your phone shows each reminder at its time, even with Amble closed.'
          : 'In a browser, a reminder shows while Amble is open. Keep it open in a tab, or install it, to be reminded.'}
      </p>

      {others.length > 0 && (
        <>
          <SectionTitle>Your other devices</SectionTitle>
          <ListGroup
            rows={others.map((d) => ({
              icon: <Devices className="size-6" />,
              title: d.device ?? 'A device',
              subtitle: d.lastSentAt ? `Last reminded ${shortDate(isoDate(new Date(d.lastSentAt)))}` : `Added ${shortDate(isoDate(new Date(d.createdAt)))}`,
              trailing: (
                <button type="button" onClick={() => void forget(d.id)} aria-label={`Stop reminders on ${d.device ?? 'this device'}`} className="grid size-10 place-items-center rounded-full text-on-surface-variant hover:bg-surface-high">
                  <Close className="size-5" aria-hidden />
                </button>
              ),
            }))}
          />
        </>
      )}

      <SectionTitle>Coming up</SectionTitle>
      {upcoming?.length ? (
        <ul className="flex flex-col gap-0.5">
          {upcoming.map((r, i) => (
            <li key={r.id}>
              <Link
                to="/task/$taskId"
                params={{ taskId: r.taskId }}
                className={`flex items-center gap-3 bg-surface-low px-4 py-3 transition-colors hover:bg-surface-container ${segment(i, upcoming.length)}`}
              >
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
                <span className="shrink-0 text-sm text-on-surface-variant">{reminderLabel(r.at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1 text-on-surface-variant">No reminders set. Open a task and pick a time under Remind me.</p>
      )}
    </>
  );
}
