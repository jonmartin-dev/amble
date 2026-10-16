// The phone's own calendars, in the Android app: when Amble opens or comes back to the front, it
// reads them (android/.../PhoneCalendarPlugin.java) and hands them to the device's database, which
// shares how busy each day is with the household. Elsewhere there's nothing to read; busy days
// come from the person's phone through sync.
import { registerPlugin } from '@capacitor/core';
import type { QueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import { native } from './native.ts';

export interface PhoneCalendar {
  id: string;
  account: string | null;
  name: string;
  color: string | null;
  primary: boolean;
  writable: boolean;
  visible: boolean;
}

interface PhoneCalendarPlugin {
  checkPermissions(): Promise<{ calendar: PermissionState | 'prompt-with-rationale' }>;
  requestPermissions(options: { permissions: ['calendar'] }): Promise<{ calendar: PermissionState | 'prompt-with-rationale' }>;
  calendars(): Promise<{ calendars: PhoneCalendar[] }>;
  events(options: { from: number; to: number; calendars: string[] }): Promise<{ events: unknown[] }>;
}
const PhoneCalendar = registerPlugin<PhoneCalendarPlugin>('PhoneCalendar');

const AT_MOST_EVERY_MS = 2 * 60 * 1000;
const DAY_VIEWS = ['load', 'events', 'today', 'briefing', 'gaps', 'calendars', 'capacity'];

let last = 0;
let reading: Promise<boolean> | null = null;

/** Whether Amble may read this phone's calendars. */
export async function calendarAllowed() {
  return native && (await PhoneCalendar.checkPermissions()).calendar === 'granted';
}

/** Asks Android for the calendar permission; true once it's given. */
export async function allowCalendar() {
  return (await PhoneCalendar.requestPermissions({ permissions: ['calendar'] })).calendar === 'granted';
}

/**
 * Reads the phone's calendars and the events of the ones that count. True if it read them. With
 * `start` it reads even before someone turned it on: that's how they turn it on.
 */
export function readPhoneCalendars(qc: QueryClient, { force = false, start = false } = {}): Promise<boolean> {
  if (!native) return Promise.resolve(false);
  if (reading) return reading;
  if (!force && !start && Date.now() - last < AT_MOST_EVERY_MS) return Promise.resolve(false);
  reading = (async () => {
    try {
      // Off until someone turns it on in Settings, Calendars; and Android may have taken the permission back.
      if (!start && !(await api<{ on: boolean }>('/calendars')).on) return false;
      if (!(await calendarAllowed())) return false;
      last = Date.now();
      const { calendars } = await PhoneCalendar.calendars();
      const { counting, window } = await api<{ counting: string[]; window: { from: number; to: number } }>('/calendars/phone', {
        method: 'PUT',
        body: JSON.stringify({ calendars }),
      });
      const { events } = counting.length ? await PhoneCalendar.events({ ...window, calendars: counting }) : { events: [] };
      await api('/calendars/phone/events', { method: 'PUT', body: JSON.stringify({ events }) });
      for (const key of DAY_VIEWS) void qc.invalidateQueries({ queryKey: [key] });
      return true;
    } catch (err) {
      console.warn("Couldn't read the phone's calendars:", err);
      return false;
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/** Reads now and whenever the app comes back to the front. Returns a cleanup. */
export function readCalendarsWhileOpen(qc: QueryClient) {
  if (!native) return () => {};
  void readPhoneCalendars(qc);
  const onVisible = () => document.visibilityState === 'visible' && void readPhoneCalendars(qc);
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}
