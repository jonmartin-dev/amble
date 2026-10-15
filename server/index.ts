import { serve } from '@hono/node-server';
import { createAi } from './ai/client.ts';
import { createEstimator } from './ai/estimate.ts';
import { createBriefings } from './ai/plan.ts';
import { createApp } from './app.ts';
import { createOidc } from './auth/oidc.ts';
import { createGoogle } from './calendar/google.ts';
import { createCalendarSync } from './calendar/sync.ts';
import { config } from './config.ts';
import { openDatabase } from './db/index.ts';
import { seedStarterGroups } from './db/seed.ts';
import { sweepFiles } from './domain/files.ts';
import { createFileStore } from './lib/disk-files.ts';
import { every, startJobs } from './jobs.ts';
import { createPush } from './notify/push.ts';
import { createReminderSender } from './notify/reminders.ts';

const db = openDatabase();
seedStarterGroups(db);

const ai = createAi(config, db);
const calendar = createCalendarSync({ db, config, google: createGoogle(config) });
const push = createPush(db, config);
const files = createFileStore(config.dataDir);
const app = createApp({ db, config, oidc: createOidc(config), ai, calendar, push, files });

const estimator = createEstimator(db, ai, config.timezone);
const briefings = createBriefings(db, ai, config.timezone);
const reminders = createReminderSender(db, push, config.basePath);

startJobs([
  // First, so a slow Google doesn't make a reminder late.
  { name: 'reminders', run: () => reminders.run() },
  { name: 'calendar sync', run: () => calendar.syncDue() },
  { name: 'estimates', run: () => estimator.run() },
  // After the calendar and estimates, so the morning's suggestions see both.
  { name: 'briefings', run: () => briefings.run() },
  { name: 'file cleanup', run: every(24 * 60 * 60 * 1000, () => sweepFiles(db, files)) },
]);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Almanac listening on ${info.address}:${info.port}, public URL ${config.publicUrl}`);
  if (config.devLogin) console.log('Dev sign-in is on. Do not use this in production.');
});
// Node drops an idle connection after 5 seconds, which a client reusing it can hit mid-request.
// A proxy in front keeps its connections longer, so the app should outlast it.
if ('keepAliveTimeout' in server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}
