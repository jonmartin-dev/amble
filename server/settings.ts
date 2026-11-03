// The server's own settings, for Settings, Your server in the app on a device that syncs here: codes
// to add a phone or computer, who's connected through Claude or ChatGPT, the household's AI model,
// and bringing a household over from Google Drive. Asked with the device's sign-in to this server (server/sync/hub.ts), so nobody has
// to find the server's page. What needs Google in a browser (connecting Drive) stays on that page.
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { aiSettingsInput, aiView, saveAiSettings } from './ai/settings.ts';
import type { Ai } from './ai/client.ts';
import { endHouseholdCodes, makeCode } from './auth/pairing.ts';
import { resolveSession } from './auth/sessions.ts';
import type { Config } from './config.ts';
import type { Connector } from './connector.ts';
import type { Db } from './db/index.ts';
import type { Member } from './db/schema.ts';
import { DomainError } from './domain/household.ts';
import type { Env } from './env.ts';
import type { ServerSync } from './sync/server.ts';
import { joinLink } from '../shared/qr.ts';

export function registerServerSettings(app: Hono<Env>, { db, config, ai, sync, connector }: { db: Db; config: Config; ai: Ai; sync: ServerSync; connector: Connector }) {
  /** Who's asking: the device's sign-in here. */
  const who = (c: Context<Env>): Member | null => {
    const token = /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    return token ? resolveSession(db, token) : null;
  };
  const signedOut = (c: Context<Env>) => c.json({ error: 'Sign in again.' }, 401);
  const adminsOnly = (c: Context<Env>) => c.json({ error: 'Only an admin can change that.' }, 403);

  /** Bringing a household over from Drive: where it stands, for an admin. */
  const drive = () => {
    if (!sync.enabled) return null;
    const status = sync.service.status();
    return { account: sync.account()?.email ?? null, on: status.on, name: status.target?.name ?? null, syncedAt: status.syncedAt, error: status.error };
  };

  app.get('/sync/server', (c) => {
    const me = who(c);
    if (!me) return signedOut(c);
    const admin = me.role === 'admin';
    return c.json({
      url: config.publicUrl,
      me: { name: me.name, email: me.email, role: me.role },
      mcpUrl: connector.mcpUrl,
      connections: connector.connections(me.id).map((g) => ({ id: g.id, clientName: g.clientName, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt })),
      ai: aiView(ai, db, config, me),
      drive: admin ? drive() : null,
    });
  });

  // A code for another phone or computer: this person's own, someone new (an admin's to make), or the
  // whole household moving over from Google Drive, which a phone puts on the household file.
  app.post('/sync/server/codes', async (c) => {
    const me = who(c);
    if (!me) return signedOut(c);
    const parsed = z.object({ for: z.enum(['me', 'someone', 'household']) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "That request doesn't look right." }, 400);
    const whom = parsed.data.for;
    if (whom !== 'me' && me.role !== 'admin') return c.json({ error: 'Only an admin can add someone new.' }, 403);
    const { code, expiresAt } = makeCode(
      db,
      whom === 'me' ? { kind: 'person', memberId: me.id } : { kind: 'invite', role: 'member', by: me.id, household: whom === 'household' },
    );
    return c.json({ code, link: joinLink(config.publicUrl, code), expiresAt });
  });

  // The household's invite runs out early once everyone has moved from Drive.
  app.delete('/sync/server/codes/household', (c) => {
    const me = who(c);
    if (!me) return signedOut(c);
    if (me.role !== 'admin') return adminsOnly(c);
    endHouseholdCodes(db);
    return c.body(null, 204);
  });

  app.delete('/sync/server/connections/:id', (c) => {
    const me = who(c);
    if (!me) return signedOut(c);
    return connector.disconnect(c.req.param('id'), me.id) ? c.body(null, 204) : c.json({ error: 'That connection is already gone.' }, 404);
  });

  app.put('/sync/server/ai', async (c) => {
    const me = who(c);
    if (!me) return signedOut(c);
    if (me.role !== 'admin') return adminsOnly(c);
    const parsed = aiSettingsInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: `That request doesn't look right: ${z.prettifyError(parsed.error).split('\n')[0]}` }, 400);
    try {
      return c.json(await saveAiSettings(ai, parsed.data));
    } catch (err) {
      if (err instanceof DomainError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // Back to whatever the server's environment sets, which may be nothing.
  app.delete('/sync/server/ai', (c) => {
    const me = who(c);
    if (!me) return signedOut(c);
    if (me.role !== 'admin') return adminsOnly(c);
    ai.save(null);
    return c.body(null, 204);
  });

  app.post('/sync/server/drive/:action{run|stop}', async (c) => {
    const me = who(c);
    if (!me) return signedOut(c);
    if (me.role !== 'admin') return adminsOnly(c);
    if (c.req.param('action') === 'stop') await sync.off();
    else {
      const result = await sync.run();
      if (result.error) return c.json({ error: result.error }, 400);
    }
    return c.json({ drive: drive() });
  });
}
