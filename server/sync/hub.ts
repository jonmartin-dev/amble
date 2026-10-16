// Devices syncing straight with this server: the third way to start, for a household that runs
// Amble at home (on the home network, or through Tailscale) instead of keeping it in Google Drive.
// A device signs in once through the server's own sign-in, which sends it back with a code, and
// swaps that for a lasting token. Then each round is two calls: what the server has (if it
// changed), and what the device has, which the server merges into its own copy and answers with
// the whole household. Everything is a bearer token, never a cookie, so any address the app is
// served from may call it.
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AiUnavailable, ask, effortFor, type Ai } from '../ai/client.ts';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { createSession, deleteSession, resolveSession } from '../auth/sessions.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { members, type Member } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { html, page } from '../pages.ts';
import { pack, unpack } from './drive.ts';
import type { SyncService } from './service.ts';
import { exportState, mergeState, NewerSchema, type SyncState } from './state.ts';

/** Where the Android app asks to be sent back to after signing in. */
export const APP_RETURN = 'dev.jonmartin.amble://signed-in';
const CODE_TTL_MS = 5 * 60 * 1000;
// The whole household, gzipped, is far smaller than this.
const MAX_STATE_BYTES = 64 * 1024 * 1024;

interface Pending {
  memberId: string;
  challenge: string;
  redirectUri: string;
  expires: number;
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const bearer = (c: Context<Env>) => /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? null;

export function registerSyncHub(app: Hono<Env>, { db, config, service, schema, ai }: { db: Db; config: Config; service: SyncService; schema: string; ai: Ai }) {
  const base = config.basePath;
  const codes = new Map<string, Pending>();

  /** Where a device may ask to come back to: the Android app, this computer, or an address the app is served from. */
  function allowedReturn(uri: string) {
    if (uri === APP_RETURN) return true;
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return false;
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'http:' && !loopback) return false;
    return url.protocol === 'https:' || url.protocol === 'http:' ? loopback || config.appOrigins.includes(url.origin) : false;
  }

  /** Who a device is: its token from signing in here. */
  const deviceMember = (c: Context<Env>): Member | null => {
    const token = bearer(c);
    return token ? resolveSession(db, token) : null;
  };

  // The household as it is here, and its version: devices ask with the version they have.
  function current() {
    const state = exportState(db, service.clock, schema);
    const json = JSON.stringify(state);
    return { state, etag: `"${createHash('sha256').update(json).digest('base64url').slice(0, 32)}"` };
  }

  // Which model the server has, so a device with none of its own can use it: on every answer, so a
  // change here reaches devices with their next round.
  const aiHeader = () => {
    const setup = ai.setup();
    return setup ? encodeURIComponent(JSON.stringify({ provider: setup.provider, model: setup.model, effort: setup.effort })) : '';
  };

  async function answer(c: Context<Env>, state: SyncState, etag: string) {
    c.header('Amble-AI', aiHeader());
    c.header('ETag', etag);
    c.header('Cache-Control', 'no-store');
    c.header('Content-Type', 'application/gzip');
    return c.body((await pack(state)) as Uint8Array<ArrayBuffer>);
  }

  app.use(
    '/sync/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'PUT', 'POST', 'DELETE'],
      allowHeaders: ['authorization', 'content-type', 'if-none-match'],
      exposeHeaders: ['etag', 'amble-ai'],
      maxAge: 600,
    }),
  );

  // For a device checking that an address is an Amble server before it sends someone to sign in.
  app.get('/sync/hello', (c) => c.json({ amble: 1, url: config.publicUrl, schema }));

  app.get('/sync/state', async (c) => {
    if (!deviceMember(c)) return c.json({ error: 'Sign in again.' }, 401);
    const { state, etag } = current();
    if (c.req.header('if-none-match') === etag) {
      c.header('Amble-AI', aiHeader());
      c.header('ETag', etag);
      return c.body(null, 304);
    }
    return answer(c, state, etag);
  });

  app.put('/sync/state', bodyLimit({ maxSize: MAX_STATE_BYTES, onError: (c) => c.json({ error: 'That is too much to sync at once.' }, 413) }), async (c) => {
    if (!deviceMember(c)) return c.json({ error: 'Sign in again.' }, 401);
    let remote: SyncState;
    try {
      remote = await unpack<SyncState>(new Uint8Array(await c.req.arrayBuffer()));
    } catch {
      return c.json({ error: "That isn't Amble's sync data." }, 400);
    }
    try {
      mergeState(db, service.clock, remote, schema);
    } catch (err) {
      if (err instanceof NewerSchema) return c.json({ error: 'Your server runs an older Amble than this device. Update the server to keep syncing.' }, 409);
      throw err;
    }
    const { state, etag } = current();
    return answer(c, state, etag);
  });

  // A device with no model of its own asks the server's: the server keeps the key, meters the call
  // against its monthly cap, and hands back the answer for the device to check.
  app.post('/sync/ai', async (c) => {
    const member = deviceMember(c);
    if (!member) return c.json({ error: 'Sign in again.' }, 401);
    const parsed = z
      .object({
        feature: z.string().max(40),
        system: z.string().max(40_000),
        content: z.string().max(400_000),
        schema: z.record(z.string(), z.unknown()),
        effort: z.enum(['low', 'medium', 'high']).nullable(),
        maxTokens: z.number().int().min(1).max(32_000),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "That request doesn't look right." }, 400);
    const setup = ai.setup();
    if (!setup) return c.json({ error: 'No AI model is set up on the server.' }, 503);
    const req = parsed.data;
    try {
      const { output, usage } = await ask(db, ai, {
        system: req.system,
        content: req.content,
        schema: z.unknown(),
        jsonSchema: req.schema,
        effort: req.effort ? effortFor(setup, req.effort) : null,
        maxTokens: req.maxTokens,
        feature: req.feature,
        memberId: member.id,
        timezone: config.timezone,
      });
      return c.json({ output, usage });
    } catch (err) {
      if (err instanceof AiUnavailable) return c.json({ error: err.message }, 503);
      throw err;
    }
  });

  // The device swaps the code it came back with for its lasting sign-in.
  app.post('/sync/token', async (c) => {
    const parsed = z.object({ code: z.string().max(200), code_verifier: z.string().min(43).max(128), redirect_uri: z.string().max(2000) }).safeParse(await c.req.json().catch(() => null));
    const pending = parsed.success ? codes.get(parsed.data.code) : undefined;
    if (parsed.success) codes.delete(parsed.data.code);
    if (!parsed.success || !pending || pending.expires < Date.now() || pending.redirectUri !== parsed.data.redirect_uri || pending.challenge !== s256(parsed.data.code_verifier)) {
      return c.json({ error: 'That sign-in expired or was already used. Try again.' }, 400);
    }
    const member = db.select().from(members).where(eq(members.id, pending.memberId)).get();
    if (!member) return c.json({ error: 'That account is gone from this server.' }, 400);
    const token = createSession(db, member.id, `Amble app (${new URL(pending.redirectUri).host || 'phone'})`);
    return c.json({ token, member: { id: member.id, email: member.email, name: member.name }, name: new URL(config.publicUrl).host });
  });

  // Stopping sync on a device signs it out here.
  app.delete('/sync/token', (c) => {
    const token = bearer(c);
    if (token) deleteSession(db, token);
    return c.body(null, 204);
  });

  // ---- signing a device in ------------------------------------------------------------------

  const appUrl = (p: string) => `${base}${p}`;
  const where = (uri: string) => (uri === APP_RETURN ? 'The Amble app on your phone' : `Amble at ${new URL(uri).host}`);
  const problem = (c: Context<Env>, message: string) =>
    c.html(page("Can't sign in", html`<h1>Can't sign in</h1><p>${message}</p><p class="muted">Start again from Amble on your device.</p>`, { base }), 400);

  app.get('/auth/app', (c) => {
    const q = c.req.query();
    if (!q.redirect_uri || !allowedReturn(q.redirect_uri)) return problem(c, "That device asked to go back somewhere this server doesn't know.");
    if (!q.code_challenge || q.code_challenge_method !== 'S256' || !q.state) return problem(c, 'The request is missing a part. Update Amble and try again.');
    const member = c.get('member');
    if (!member) return c.redirect(appUrl(`/auth/login?return=${encodeURIComponent(`/auth/app?${new URLSearchParams(q)}`)}`));
    return c.html(
      page(
        'Sign in',
        html`<h1>Use Amble on this device?</h1>
<p>${where(q.redirect_uri)} will keep your household in step with this server, as ${member.name} (${member.email}).</p>
<p class="muted">It can see and change what you can in Amble. Stopping sync on that device signs it out.</p>
<form method="post" action="${appUrl('/auth/app')}" class="actions">
<input type="hidden" name="redirect_uri" value="${q.redirect_uri}">
<input type="hidden" name="state" value="${q.state}">
<input type="hidden" name="code_challenge" value="${q.code_challenge}">
<button class="primary" name="allow" value="1">Continue</button>
<button class="quiet" name="allow" value="0">Not now</button>
</form>`,
        { base },
      ),
    );
  });

  app.post('/auth/app', async (c) => {
    const form = await c.req.parseBody();
    const redirectUri = String(form.redirect_uri ?? '');
    const state = String(form.state ?? '');
    const challenge = String(form.code_challenge ?? '');
    const member = c.get('member');
    if (!allowedReturn(redirectUri) || !challenge) return problem(c, 'The request is missing a part. Start again.');
    if (!member) return c.redirect(appUrl('/auth/signin?error=expired'));
    const back = new URL(redirectUri);
    back.searchParams.set('state', state);
    if (form.allow !== '1') {
      back.searchParams.set('error', 'access_denied');
      return c.redirect(back.href);
    }
    const now = Date.now();
    for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
    const code = randomBytes(24).toString('base64url');
    codes.set(code, { memberId: member.id, challenge, redirectUri, expires: now + CODE_TTL_MS });
    back.searchParams.set('code', code);
    return c.redirect(back.href);
  });
}
