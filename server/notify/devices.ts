// What reminders are sent through, whatever does the sending: web push from a server
// (./push.ts), or the app showing them itself on a device (./local-push.ts).
import type { Member } from '../db/schema.ts';

export interface PushMessage {
  title: string;
  body?: string;
  /** A newer notification with the same tag replaces the older one. */
  tag?: string;
  /** The app page to open when it's tapped. */
  url?: string;
  /** Buttons on the notification, handled by the service worker. */
  actions?: { action: string; title: string }[];
  /** For the service worker: which reminder, task and person it's about. */
  data?: Record<string, unknown>;
}

export interface PushResult {
  devices: number;
  sent: number;
  /** Devices the push service no longer knows (notifications turned off, app removed); forgotten. */
  gone: number;
  failed: number;
}

export interface NewSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushDevice {
  id: string;
  endpoint: string;
  device: string | null;
  createdAt: Date;
  lastSentAt: Date | null;
}

export interface Push {
  /** The key browsers subscribe with; empty when notifications don't go through a push service. */
  publicKey: string;
  /** Turns notifications on for a device, or moves the device to whoever is signed in on it now. */
  subscribe(member: Member, sub: NewSubscription, userAgent?: string): void;
  unsubscribe(member: Member, endpoint: string): void;
  removeDevice(member: Member, id: string): void;
  devices(member: Member): PushDevice[];
  /** Sends one notification to each of a person's devices. */
  sendTo(memberId: string, message: PushMessage): Promise<PushResult>;
}

/** "Chrome on Android" from a user agent, near enough to tell someone's devices apart. */
export function deviceName(userAgent: string | undefined | null): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung Internet'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /iPad/.test(ua)
        ? 'iPad'
        : /CrOS/.test(ua)
          ? 'ChromeOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'Mac'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os;
}

