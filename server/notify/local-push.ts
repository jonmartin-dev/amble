// Reminders on a device with no server: the app's worker hands each one to the page, which shows
// it as a notification. That works while Almanac is open (or, in the Android app, through the
// phone's own scheduled notifications). Devices are kept in the same table as web push ones, with
// an address that only means "this browser".
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { pushSubscriptions } from '../db/schema.ts';
import { deviceName, type Push, type PushMessage } from './devices.ts';

export const DEVICE_ENDPOINT_PREFIX = 'device:';

export function createLocalPush(db: Db, show: (message: PushMessage) => Promise<boolean>): Push {
  const mine = (memberId: string) => db.select().from(pushSubscriptions).where(eq(pushSubscriptions.memberId, memberId)).all();
  return {
    publicKey: '',

    subscribe(member, sub, userAgent) {
      const values = { memberId: member.id, p256dh: '-', auth: '-', device: deviceName(userAgent) };
      db.insert(pushSubscriptions)
        .values({ endpoint: sub.endpoint, ...values })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values })
        .run();
    },

    unsubscribe(member, endpoint) {
      db.delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.memberId, member.id), eq(pushSubscriptions.endpoint, endpoint)))
        .run();
    },

    removeDevice(member, id) {
      db.delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.memberId, member.id), eq(pushSubscriptions.id, id)))
        .run();
    },

    devices(member) {
      return mine(member.id).map(({ id, endpoint, device, createdAt, lastSentAt }) => ({ id, endpoint, device, createdAt, lastSentAt }));
    },

    async sendTo(memberId, message) {
      const subs = mine(memberId);
      const result = { devices: subs.length, sent: 0, gone: 0, failed: 0 };
      if (subs.length === 0) return result;
      if (await show(message)) {
        db.update(pushSubscriptions).set({ lastSentAt: new Date() }).where(eq(pushSubscriptions.memberId, memberId)).run();
        result.sent = 1;
      } else result.failed = 1;
      return result;
    },
  };
}
