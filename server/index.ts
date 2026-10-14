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
import { startJobs } from './jobs.ts';

const db = openDatabase();
seedStarterGroups(db);

const ai = createAi(config);
const calendar = createCalendarSync({ db, config, google: createGoogle(config) });
const app = createApp({ db, config, oidc: createOidc(config), ai, calendar });

const estimator = createEstimator(db, ai, config.timezone);
const briefings = createBriefings(db, ai, config.timezone);

startJobs([
  { name: 'calendar sync', run: () => calendar.syncDue() },
  { name: 'estimates', run: () => estimator.run() },
  // After the calendar and estimates, so the morning's suggestions see both.
  { name: 'briefings', run: () => briefings.run() },
]);

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Almanac listening on ${info.address}:${info.port}, public URL ${config.publicUrl}`);
  if (config.devLogin) console.log('Dev sign-in is on. Do not use this in production.');
});
