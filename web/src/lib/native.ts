// Amble as the Android app: Capacitor around the device build. The phone itself shows each
// reminder at its time, even with Amble closed, so the app hands it the coming ones whenever they
// may have changed. For reminders set elsewhere while Amble is closed (through Claude, say), the
// phone checks the household in the background (ReminderCheck.java). Done and Snooze on a
// notification work as they do for web push.
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { loadRatio, loadWord } from '../components/ui.tsx';
import { api, type Task, type Today, type UpcomingReminder } from './api.ts';
import { acceptServerReturn } from './server-sync.ts';
import { applyTheme, loadLocalTheme, setPhoneColors, themeVariables, type PhoneColors } from './theme.ts';

/** Running inside the Android app. */
export const native = Capacitor.isNativePlatform();

const CHANNEL = 'reminders';
const ACTIONS = 'reminder';
// As in server/notify/reminders.ts.
const SNOOZE_MINUTES = 60;
// Android keeps a limited number of alarms for an app; the next hundred reminders are plenty.
const AHEAD = 100;
// The reminders handed to the phone, by id, with when it shows each: what it has shown already
// doesn't need showing again when the app catches up.
const HANDED_KEY = 'almanac-phone-reminders';
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

interface ReminderCheckPlugin {
  start(options: { fileId?: string; email?: string | null; server?: string; token?: string; memberId: string }): Promise<void>;
  stop(): Promise<void>;
  handOver(options: { reminders: Record<string, number> }): Promise<void>;
  shown(): Promise<{ reminders: Record<string, number> }>;
}
const ReminderCheck = registerPlugin<ReminderCheckPlugin>('ReminderCheck');

const SystemColors = registerPlugin<{ palettes(): Promise<{ palettes: PhoneColors | null }> }>('SystemColors');
const CodeScanner = registerPlugin<{ scan(): Promise<{ value: string | null }> }>('CodeScanner');

/**
 * Scans a QR code with Google's scanner (CodeScannerPlugin.java), which needs no camera permission:
 * what it says, or null when the person backs out. Throws when the phone can't scan.
 */
export async function scanCode(): Promise<string | null> {
  return (await CodeScanner.scan()).value;
}

/** Reads the phone's Material You colors again (they change with the wallpaper); true if they did. */
async function refreshPhoneColors() {
  return setPhoneColors((await SystemColors.palettes()).palettes);
}

/** Android wants a 32-bit number for each notification. */
function notificationId(reminderId: string) {
  let h = 0;
  for (const ch of reminderId) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0;
  return h & 0x7fffffff;
}

function handed(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(HANDED_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

let channel: Promise<void> | null = null;
function setUp() {
  channel ??= (async () => {
    await LocalNotifications.createChannel({ id: CHANNEL, name: 'Reminders', description: 'The reminders you set on tasks', importance: 4, visibility: 1 });
    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: ACTIONS,
          actions: [
            { id: 'done', title: 'Done' },
            { id: 'snooze', title: 'Snooze 1 hour' },
          ],
        },
      ],
    });
  })().catch((err: unknown) => {
    channel = null;
    throw err;
  });
  return channel;
}

export async function phoneNotifyPermission(): Promise<'granted' | 'denied' | 'prompt'> {
  const { display } = await LocalNotifications.checkPermissions();
  return display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'prompt';
}

export async function askPhoneNotifyPermission(): Promise<'granted' | 'denied' | 'prompt'> {
  const { display } = await LocalNotifications.requestPermissions();
  return display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'prompt';
}

/**
 * Whether Android lets Amble show reminders on the minute ("Alarms and reminders" in its
 * settings). Without it they still show, sometimes a few minutes late while the phone is idle.
 */
export async function exactReminders() {
  return (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === 'granted';
}

/** Opens Android's setting for reminders on the minute; when it's back, they're handed over again. */
export async function allowExactReminders() {
  await LocalNotifications.changeExactNotificationSetting();
  await schedulePhoneReminders();
}

let scheduling: Promise<void> | null = null;
let again = false;

/** Hands the phone this person's coming reminders, in place of what it had. */
export function schedulePhoneReminders(): Promise<void> {
  if (scheduling) {
    again = true;
    return scheduling;
  }
  scheduling = (async () => {
    try {
      do {
        again = false;
        await reschedule();
      } while (again);
    } finally {
      scheduling = null;
    }
  })();
  return scheduling;
}

async function reschedule() {
  if ((await phoneNotifyPermission()) !== 'granted') return;
  await setUp();
  const { reminders } = await api<{ reminders: UpcomingReminder[] }>('/reminders');
  const now = Date.now();
  const coming = reminders.filter((r) => Date.parse(r.at) > now).slice(0, AHEAD);
  const { notifications: had } = await LocalNotifications.getPending();
  if (had.length) await LocalNotifications.cancel({ notifications: had.map((n) => ({ id: n.id })) });
  // Asking for an exact time that isn't allowed makes the plugin open Android's settings.
  const exact = await exactReminders();
  if (coming.length) {
    await LocalNotifications.schedule({
      notifications: coming.map((r) => ({
        id: notificationId(r.id),
        title: r.title,
        body: r.body ?? '',
        channelId: CHANNEL,
        actionTypeId: ACTIONS,
        schedule: { at: new Date(r.at), allowWhileIdle: true },
        isExactNotification: exact,
        extra: { reminderId: r.id, taskId: r.taskId },
      })),
    });
  }
  // Keeps what was handed over until well after it showed.
  const kept = Object.fromEntries(Object.entries(handed()).filter(([, at]) => at <= now && at > now - KEEP_MS));
  for (const r of coming) kept[r.id] = Date.parse(r.at);
  try {
    localStorage.setItem(HANDED_KEY, JSON.stringify(kept));
  } catch {
    // Without storage, a reminder can show twice when the app catches up; never not at all.
  }
  // The background check leaves these to the phone's own alarms.
  await ReminderCheck.handOver({ reminders: kept }).catch(() => {});
}

/**
 * While the household syncs through Drive, the phone checks its file about every 15 minutes for
 * this person's reminders set elsewhere, and shows them with Amble closed. Stops otherwise.
 */
export async function checkInBackground() {
  if (!native) return;
  const where = await api<{ fileId?: string; email?: string | null; server?: string; token?: string; memberId: string } | null>('/sync/background');
  if (where) await ReminderCheck.start(where);
  else await ReminderCheck.stop();
}

/** Takes every reminder back from the phone: notifications are off here. */
export async function cancelPhoneReminders() {
  const { notifications } = await LocalNotifications.getPending();
  if (notifications.length) await LocalNotifications.cancel({ notifications: notifications.map((n) => ({ id: n.id })) });
  localStorage.removeItem(HANDED_KEY);
  await ReminderCheck.stop().catch(() => {});
}

/**
 * The app's own reminder check found one due: the phone showed it already if it was handed over
 * for that time, or shows it now (one set for right now, say).
 */
export async function showOnPhone(message: { title: string; body?: string; tag?: string; data?: { reminderId?: string; taskId?: string; at?: number } }) {
  if ((await phoneNotifyPermission()) !== 'granted') return false;
  const id = message.data?.reminderId ?? message.tag;
  const at = id ? handed()[id] : undefined;
  if (at != null && at <= Date.now()) return true;
  // Or the background check showed it, for that time, while the app was closed.
  if (id && message.data?.at != null) {
    const { reminders } = await ReminderCheck.shown().catch(() => ({ reminders: {} as Record<string, number> }));
    if (reminders[id] === message.data.at) return true;
  }
  await setUp();
  await LocalNotifications.schedule({
    notifications: [
      {
        id: notificationId(id ?? crypto.randomUUID()),
        title: message.title,
        body: message.body ?? '',
        channelId: CHANNEL,
        actionTypeId: id ? ACTIONS : undefined,
        isExactNotification: false,
        extra: { reminderId: id, taskId: message.data?.taskId },
      },
    ],
  });
  return true;
}

interface WidgetTask {
  id: string;
  title: string;
  label: string;
  due: boolean;
  mustDo: boolean;
}

interface TodayWidgetPlugin {
  update(day: {
    validUntil: number;
    date: string;
    load: string;
    heavy: boolean;
    percent: number;
    tasks: WidgetTask[];
    colors: { light: Record<string, string>; dark: Record<string, string> };
  }): Promise<void>;
  pin(): Promise<{ asked: boolean }>;
}
const TodayWidget = registerPlugin<TodayWidgetPlugin>('TodayWidget');
// The planning day ends at 4am, as on the server.
const DAY_CUTOFF_HOUR = 4;
const WIDGET_TASKS = 30;
const TIME_OF_DAY = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' } as const;
const TIMES = Object.keys(TIME_OF_DAY);

/** The widget's colors from the app's theme, by the names TodayWidget.java uses. */
function widgetColors(dark: boolean) {
  const v = themeVariables(loadLocalTheme(), dark);
  const pick = (name: string) => v[`--md-${name}`]!;
  return {
    surface: pick('surface'),
    row: pick('surface-high'),
    onSurface: pick('on-surface'),
    onSurfaceVariant: pick('on-surface-variant'),
    primary: pick('primary'),
    primaryContainer: pick('primary-container'),
    onPrimaryContainer: pick('on-primary-container'),
    secondaryContainer: pick('secondary-container'),
    onSecondaryContainer: pick('on-secondary-container'),
    outline: pick('outline'),
    track: pick('surface-highest'),
    warm: pick('warm'),
    warmContainer: pick('warm-container'),
    onWarmContainer: pick('on-warm-container'),
  };
}

/** Hands the home-screen widget today's open tasks, for it to show until the day is over. */
export async function updateTodayWidget() {
  if (!native) return;
  const day = await api<Today>('/today');
  const due = new Set(day.due.map((t) => t.id));
  // In Today's order: the day by time of day, then what's left from before, then what's due.
  const when = (t: Task) => (t.timeOfDay ? TIMES.indexOf(t.timeOfDay) : TIMES.length);
  const planned = [...day.planned].sort((a, b) => when(a) - when(b));
  const seen = new Set<string>();
  const tasks = [...planned, ...day.carriedOver, ...day.due].filter((t) => !seen.has(t.id) && seen.add(t.id));
  const [y, m, d] = day.today.split('-').map(Number);
  const date = new Date(y!, m! - 1, d!);
  await TodayWidget.update({
    validUntil: new Date(y!, m! - 1, d! + 1, DAY_CUTOFF_HOUR).getTime(),
    date: date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
    load: loadWord(day.load),
    heavy: day.load.level === 'full' || day.load.level === 'over',
    percent: Math.round(loadRatio(day.load) * 100),
    tasks: tasks.slice(0, WIDGET_TASKS).map((t) => ({
      id: t.id,
      title: t.title,
      label: due.has(t.id) ? 'Due today' : t.timeOfDay ? TIME_OF_DAY[t.timeOfDay] : '',
      due: due.has(t.id),
      mustDo: t.mustDo,
    })),
    colors: { light: widgetColors(false), dark: widgetColors(true) },
  });
}

/** Opens quick add, from the widget's +. */
export const QUICK_ADD = 'amble:quick-add';

/** Done or Snooze on a reminder's notification; null for anything else. */
function reminderAction(action: string, taskId: string, reminderId: string | null | undefined) {
  return action === 'done'
    ? api(`/tasks/${taskId}/complete`, { method: 'POST', body: JSON.stringify({ done: true }) })
    : action === 'snooze' && reminderId
      ? api(`/reminders/${reminderId}/snooze`, { method: 'POST', body: JSON.stringify({ minutes: SNOOZE_MINUTES }) })
      : null;
}

/**
 * Where a link from the widget or the background check's notifications goes:
 * dev.jonmartin.amble://task/<id>, ://add or ://today. A notification's Done and Snooze add ?do=,
 * with the reminder and the notification. ://signed-in is the household's server sending the
 * person back after they signed in there.
 */
function followLink(url: string, open: (path: string) => void, changed: () => void) {
  let link: URL;
  try {
    link = new URL(url);
  } catch {
    return;
  }
  if (link.host === 'signed-in') return acceptServerReturn(link.searchParams);
  const id = link.pathname.replace(/^\//, '');
  const act = link.host === 'task' && id ? reminderAction(link.searchParams.get('do') ?? '', id, link.searchParams.get('reminder')) : null;
  if (act) {
    const notification = Number(link.searchParams.get('notification'));
    if (notification) void LocalNotifications.removeDeliveredNotificationsById({ ids: [notification] }).catch(() => {});
    void act.then(changed, () => {});
  } else if (link.host === 'task' && id) open(`/task/${id}`);
  else {
    open('/');
    // After the page it's on has drawn.
    if (link.host === 'add') setTimeout(() => window.dispatchEvent(new Event(QUICK_ADD)), 300);
  }
}

/** Asks the home screen to place the widget (Android shows its own prompt); false if it can't. */
export async function pinTodayWidget() {
  await updateTodayWidget().catch(() => {});
  return (await TodayWidget.pin()).asked;
}

/**
 * Starts the phone's side of the app: a tap on a reminder opens its task, its buttons finish or
 * snooze it, the back button goes back (or leaves, from the first page), the widget's links open
 * their page, and coming back to the app brings the widget up to date.
 */
export function startPhone({ open, changed, resumed }: { open: (path: string) => void; changed: () => void; resumed: () => void }) {
  if (!native) return () => {};
  // The theme and the widget follow the phone's colors when someone picked them.
  const recolor = () =>
    void refreshPhoneColors().then((changed) => {
      if (!changed) return;
      applyTheme(loadLocalTheme());
      void updateTodayWidget().catch(() => {});
    }, () => {});
  recolor();
  const listeners = [
    LocalNotifications.addListener('localNotificationActionPerformed', ({ actionId, notification }) => {
      const { reminderId, taskId } = (notification.extra ?? {}) as { reminderId?: string; taskId?: string };
      if (!taskId) return;
      const act = reminderAction(actionId, taskId, reminderId);
      if (act) void act.then(changed, () => {});
      else open(`/task/${taskId}`);
    }),
    // Back in front, maybe on a new day: the widget catches up.
    App.addListener('resume', () => {
      recolor();
      resumed();
    }),
    App.addListener('appUrlOpen', ({ url }) => followLink(url, open, changed)),
    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) history.back();
      else void App.minimizeApp();
    }),
  ];
  // Opened from the widget or a notification: the link that opened it.
  void App.getLaunchUrl().then((launch) => launch?.url && followLink(launch.url, open, changed));
  return () => {
    for (const l of listeners) void l.then((h) => h.remove());
  };
}
