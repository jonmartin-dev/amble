import { serve } from '@hono/node-server';
import { createAi } from './ai/client.ts';
import { createEstimator } from './ai/estimate.ts';
import { createBriefings } from './ai/plan.ts';
import { createApp } from './app.ts';
import { createOidc } from './auth/oidc.ts';
import { createGoogle } from './lib/google.ts';
import { config } from './config.ts';
import { openDatabase, SCHEMA } from './db/index.ts';
import { seedStarterGroups } from './db/seed.ts';
import { sweepFiles } from './domain/files.ts';
import { createFileStore } from './lib/disk-files.ts';
import { every, startJobs } from './jobs.ts';
import { createServerSync } from './sync/server.ts';

const db = openDatabase();
seedStarterGroups(db);

const ai = createAi(config, db);
const google = createGoogle(config);
const sync = createServerSync({ db, config, google, schema: SCHEMA, ai });
// Bytes of files on tasks, which devices syncing here send so everyone has them; assistants read them too.
const files = createFileStore(config.dataDir);
const app = createApp({ db, config, oidc: createOidc(config), ai, sync, files });

const estimator = createEstimator(db, ai, config.timezone);
const briefings = createBriefings(db, ai, config.timezone);

startJobs([
  { name: 'estimates', run: () => estimator.run() },
  // After the estimates, so the morning's suggestions see them.
  { name: 'briefings', run: () => briefings.run() },
  { name: 'file cleanup', run: every(24 * 60 * 60 * 1000, () => sweepFiles(db, files)) },
  // Last, so what the jobs above changed goes out in the same round.
  { name: 'drive sync', run: () => sync.run() },
]);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Amble listening on ${info.address}:${info.port}, public URL ${config.publicUrl}`);
  if (config.devLogin) console.log('Dev sign-in is on. Do not use this in production.');
});
// Node drops an idle connection after 5 seconds, which a client reusing it can hit mid-request.
// A proxy in front keeps its connections longer, so the app should outlast it.
if ('keepAliveTimeout' in server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}
