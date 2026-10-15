// Web push: the keys Almanac signs with, the devices people turned notifications on for, and
// sending to them. Each message is encrypted for its device; the push service in between (Google's
// for Chrome) only passes it along.
import { and, eq } from 'drizzle-orm';
import webpush, { type PushSubscription as Subscription, type RequestOptions } from 'web-push';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { pushSubscriptions, serverSettings, type Member } from '../db/schema.ts';
import { DomainError } from '../domain/household.ts';
import { deviceName, type NewSubscription, type Push, type PushMessage, type PushResult } from './devices.ts';

export { deviceName, type NewSubscription, type Push, type PushMessage, type PushResult };

// Where browsers' push services live. A subscription has to point at one of them, so the server
// never posts to an address someone made up.
const PUSH_HOSTS = ['googleapis.com', 'mozilla.com', 'apple.com', 'windows.com'];

// A reminder that can't be delivered within a few hours (the phone was off) isn't worth showing.
const TTL_SECONDS = 4 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

type Send = (sub: Subscription, payload: string, options: RequestOptions) => Promise<unknown>;

/** The VAPID key pair, made on first start and kept in the database so backups carry it. */
function vapidKeys(db: Db): { publicKey: string; privateKey: string } {
  const read = () => db.select().from(serverSettings).where(eq(serverSettings.key, 'vapid')).get()?.value as { publicKey: string; privateKey: string } | undefined;
  const existing = read();
  if (existing) return existing;
  db.insert(serverSettings).values({ key: 'vapid', value: webpush.generateVAPIDKeys() }).onConflictDoNothing().run();
  return read()!;
}

function checkEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new DomainError("That isn't a push address.");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new DomainError("Almanac can't send notifications through that browser's push service.");
  }
}

export function createPush(db: Db, config: Config, send: Send = (sub, payload, options) => webpush.sendNotification(sub, payload, options)): Push {
  const keys = vapidKeys(db);
  // Push services want a way to reach whoever runs the server: its address, or an admin's email.
  const subject = config.publicUrl.startsWith('https://') ? config.publicUrl : `mailto:${config.adminEmails[0] ?? 'almanac@example.com'}`;

  return {
    publicKey: keys.publicKey,

    /** Turns notifications on for a device, or moves the device to whoever is signed in on it now. */
    subscribe(member: Member, sub: NewSubscription, userAgent?: string) {
      checkEndpoint(sub.endpoint);
      const values = { memberId: member.id, p256dh: sub.keys.p256dh, auth: sub.keys.auth, device: deviceName(userAgent) };
      db.insert(pushSubscriptions)
        .values({ endpoint: sub.endpoint, ...values })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values })
        .run();
    },

    unsubscribe(member: Member, endpoint: string) {
      db.delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.memberId, member.id), eq(pushSubscriptions.endpoint, endpoint)))
        .run();
    },

    removeDevice(member: Member, id: string) {
      db.delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.memberId, member.id), eq(pushSubscriptions.id, id)))
        .run();
    },

    devices(member: Member) {
      return db
        .select({
          id: pushSubscriptions.id,
          endpoint: pushSubscriptions.endpoint,
          device: pushSubscriptions.device,
          createdAt: pushSubscriptions.createdAt,
          lastSentAt: pushSubscriptions.lastSentAt,
        })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.memberId, member.id))
        .all();
    },

    /** Sends one notification to each of a person's devices. */
    async sendTo(memberId: string, message: PushMessage): Promise<PushResult> {
      const subs = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.memberId, memberId)).all();
      const result: PushResult = { devices: subs.length, sent: 0, gone: 0, failed: 0 };
      const payload = JSON.stringify(message);
      // A topic lets the push service drop an older copy still waiting for a phone that's off.
      const topic = message.tag?.replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || undefined;
      await Promise.all(
        subs.map(async (sub) => {
          try {
            await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
              TTL: TTL_SECONDS,
              urgency: 'high',
              topic,
              timeout: SEND_TIMEOUT_MS,
              vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
            });
            db.update(pushSubscriptions).set({ lastSentAt: new Date() }).where(eq(pushSubscriptions.id, sub.id)).run();
            result.sent++;
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            // Gone, or made with keys this server no longer has: the device has to turn notifications on again.
            if (status === 404 || status === 410 || status === 401 || status === 403) {
              db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).run();
              result.gone++;
            } else {
              console.warn(`Push to ${sub.device ?? 'a device'} failed:`, status ?? (err instanceof Error ? err.message : err));
              result.failed++;
            }
          }
        }),
      );
      return result;
    },
  };
}

