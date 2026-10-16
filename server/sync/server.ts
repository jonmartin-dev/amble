// A self-hosted server as one more copy of a household that syncs through Google Drive. An admin
// connects the server to their Google account once (Settings → Sync); it keeps a refresh token,
// sealed like calendar tokens, and syncs every minute and soon after each change, whoever made it:
// the app, Claude or ChatGPT through the connector, or a background job.
import { eq } from 'drizzle-orm';
import type { GoogleApi } from '../lib/google.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/open.ts';
import { serverSettings } from '../db/schema.ts';
import type { GoogleGrant } from '../auth/oidc.ts';
import { seal, unseal } from '../lib/seal.ts';
import { DRIVE_SCOPES } from './drive.ts';
import { createSyncService, foldDuplicateGroups, SyncSetupError } from './service.ts';

const KEY = 'sync-google';
const PURPOSE = 'drive refresh tokens';
const SOON_MS = 5000;
// An access token is renewed this long before it runs out.
const MARGIN_MS = 5 * 60 * 1000;

interface Stored {
  email: string;
  memberId: string;
  refreshToken: string;
}

export function createServerSync({ db, config, google, schema, fetchImpl = fetch }: { db: Db; config: Config; google: GoogleApi; schema: string; fetchImpl?: typeof fetch }) {
  const secret = config.oidc.clientSecret;
  // Joining a household the server's own groups might already be in by name: they fold into it.
  // Devices can sync with the server directly too (server/sync/hub.ts), so it always records changes.
  const service = createSyncService({ db, schema, fetchImpl, hub: true, adopt: (_account, localGroups, remote) => remote && foldDuplicateGroups(db, localGroups) });
  let access: { token: string; expiresAt: number } | null = null;
  let soon: ReturnType<typeof setTimeout> | undefined;

  const stored = () => (db.select().from(serverSettings).where(eq(serverSettings.key, KEY)).get()?.value as Stored | undefined) ?? null;

  async function token(): Promise<string> {
    if (access && access.expiresAt - MARGIN_MS > Date.now()) return access.token;
    const grant = stored();
    const refresh = grant && unseal(secret, PURPOSE, grant.refreshToken);
    if (!refresh) throw new SyncSetupError('Connect Google Drive again from Settings, Sync.');
    const fresh = await google.refresh(refresh);
    access = { token: fresh.accessToken, expiresAt: fresh.expiresAt };
    return access.token;
  }

  const server = {
    service,
    enabled: Boolean(config.google.clientId && config.google.clientSecret),

    /** The Google account the server syncs as, once an admin connected one. */
    account: () => {
      const grant = stored();
      return grant ? { email: grant.email, memberId: grant.memberId } : null;
    },

    /** Keeps what Google gave after an admin said yes. */
    saveGrant(grant: GoogleGrant) {
      const scopes = grant.scope.split(/\s+/);
      if (!DRIVE_SCOPES.every((s) => scopes.includes(s))) throw new SyncSetupError("Google didn't share Drive access. Try again and leave it ticked.");
      if (!grant.refreshToken) throw new SyncSetupError("Google didn't give lasting access. Try connecting again.");
      const value: Stored = { email: grant.email.toLowerCase(), memberId: grant.memberId, refreshToken: seal(secret, PURPOSE, grant.refreshToken) };
      db.insert(serverSettings).values({ key: KEY, value }).onConflictDoUpdate({ target: serverSettings.key, set: { value } }).run();
      access = grant.expiresIn ? { token: grant.accessToken, expiresAt: Date.now() + grant.expiresIn * 1000 } : null;
    },

    households: async () => service.households(await token()),

    connect: async (how: Parameters<typeof service.connect>[1]) => service.connect(await token(), how),

    /** A round now, if sync is on. Errors are kept for Settings to show. */
    async run() {
      if (!service.status().on) return { merged: 0, uploaded: false, error: null };
      try {
        return await service.run(await token());
      } catch (err) {
        return { merged: 0, uploaded: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    /** After a change, a round a few seconds later; changes close together share one. */
    soon() {
      service.stamp();
      if (!service.status().on) return;
      clearTimeout(soon);
      soon = setTimeout(() => void server.run(), SOON_MS);
      (soon as { unref?: () => void }).unref?.();
    },

    /** Stops syncing and forgets the Google access. */
    async off() {
      await service.off();
      db.delete(serverSettings).where(eq(serverSettings.key, KEY)).run();
      access = null;
    },
  };
  return server;
}

export type ServerSync = ReturnType<typeof createServerSync>;
