import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { createOidc } from './auth/oidc.ts';
import { config } from './config.ts';
import { openDatabase } from './db/index.ts';
import { seedStarterGroups } from './db/seed.ts';

const db = openDatabase();
seedStarterGroups(db);

const app = createApp({ db, config, oidc: createOidc(config) });

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Almanac listening on ${info.address}:${info.port}, public URL ${config.publicUrl}`);
  if (config.devLogin) console.log('Dev sign-in is on. Do not use this in production.');
});
