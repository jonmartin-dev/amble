// Devices syncing straight with this server: the third way to start, for a household that runs
// Amble at home (on the home network, or through Tailscale) instead of keeping it in Google Drive.
// A device gets in once, with a code from a device that's already in (server/auth/pairing.ts) or
// through the server's sign-in provider, which sends it back with a code, and swaps that for a
// lasting token. Then each round is two calls: what the server has (if it
// changed), and what the device has, which the server merges into its own copy and answers with
// the whole household. Files on tasks come and go here too, since Drive can't share them.
// Everything is a bearer token, never a cookie, so any address the app is served from may call it.
import { createHash, randomBytes } from 'node:crypto';
import { eq, or } from 'drizzle-orm';
import { adoptHouseholdAi, AiUnavailable, ask, effortFor, type Ai } from '../ai/client.ts';
import { linesResponse } from '../../shared/lines.ts';
import type { Context, Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { guessLimit, NeedsName, redeemCode } from '../auth/pairing.ts';
import { createSession, deleteSession, resolveSession } from '../auth/sessions.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { attachments, members, type Member } from '../db/schema.ts';
import { FileTooBig, tooBigMessage, type FileStore } from '../domain/files.ts';
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
const SHA256 = /^[0-9a-f]{64}$/;

interface Pending {
  memberId: string;
  challenge: string;
  redirectUri: string;
  expires: number;
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/**
 * Where a request came from, for turning away a run of wrong codes: the address the proxy in front
 * saw, which it adds last to X-Forwarded-For (anything before it is what the caller claimed, so a
 * caller could make up a new one for every guess), or the connection's own without a proxy.
 */
export function requestFrom(c: Context<Env>) {
  const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || c.req.header('x-real-ip');
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? 'direct';
  } catch {
    // Not from a socket (the tests ask the app directly).
    return 'direct';
  }
}

/** Wrong codes from one place, and from everywhere together, before they're turned away for a while. */
export function codeGuesses() {
  const one = guessLimit({ max: 10 });
  const all = guessLimit({ max: 200 });
  return {
    blocked: (from: string) => one.blocked(from) || all.blocked('*'),
    missed(from: string) {
      one.missed(from);
      all.missed('*');
    },
  };
}

type Person = { pk: string; id: string; role: Member['role']; email: string };
const people = (db: Db) => db.$client.prepare(`SELECT json_array(id) AS pk, id, role, email FROM members`).all() as Person[];

/**
 * Takes out of a round from someone else's device what it may not do to the household's people:
 * remove someone the server has, fold them into someone else, or change their email, the address
 * they sign in with. Returns who was here, and the fields to put right on that device afterwards.
 */
function sparePeople(db: Db, remote: SyncState) {
  const before = new Map(people(db).map((p) => [p.pk, p]));
  const redo: [pk: string, col: string][] = [];
  // Two rows that really are one person (the same email) still fold, from the rows themselves.
  remote.aliases = remote.aliases?.filter(([tbl, from]) => tbl !== 'members' || !before.has(from));
  const t = remote.tables.members;
  if (!t) return { before, redo };
  for (const [pk] of t.dead) if (before.has(pk)) redo.push([pk, 'id']);
  t.dead = t.dead.filter(([pk]) => !before.has(pk));
  const at = t.cols.indexOf('email');
  for (const [pk, values] of t.rows) {
    const was = before.get(pk);
    if (!was || at < 0 || values[at] === was.email) continue;
    values[at] = was.email;
    redo.push([pk, 'email']);
  }
  return { before, redo };
}

/**
 * After that round: who's an admin goes back (someone new is a member, and someone folded into
 * another row keeps their role there), and the fields sparePeople kept are timed again. Both are
 * changes here, so the server's are the later ones and win on every device, the one that sent it
 * included.
 */
function keepPeople(db: Db, { before, redo }: ReturnType<typeof sparePeople>) {
  const folded = db.$client.prepare(`SELECT from_pk, to_pk FROM sync_aliases WHERE tbl = 'members'`).all() as { from_pk: string; to_pk: string }[];
  const now = people(db);
  for (const p of now) {
    const role = before.get(p.pk)?.role ?? (folded.some((a) => a.to_pk === p.pk && before.get(a.from_pk)?.role === 'admin') ? 'admin' : 'member');
    if (p.role !== role) db.update(members).set({ role }).where(eq(members.id, p.id)).run();
  }
  const here = new Set(now.map((p) => p.pk));
  const retime = db.$client.prepare(`INSERT INTO sync_cells (tbl, pk, col, hlc) VALUES ('members', ?, ?, NULL) ON CONFLICT(tbl, pk, col) DO UPDATE SET hlc = NULL`);
  for (const [pk, col] of redo) if (here.has(pk)) retime.run(pk, col);
}

export const WRONG_CODE = "That code doesn't work. Codes work once and last 10 minutes, so make a new one and try again.";
export const TOO_MANY_CODES = 'Too many codes that didn’t work. Wait a few minutes and try again.';
const bearer = (c: Context<Env>) => /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? null;

export function registerSyncHub(
  app: Hono<Env>,
  { db, config, service, schema, ai, files }: { db: Db; config: Config; service: SyncService; schema: string; ai: Ai; files: FileStore },
) {
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

  // For a device checking that an address is an Amble server before it lets someone in: whether it
  // takes codes, and the sign-in provider it has, if any (dev sign-in counts, for the scripts).
  const signIn = config.oidc.clientId && config.oidc.clientSecret ? config.oidc.providerName : config.devLogin ? 'a test account' : null;
  app.get('/sync/hello', (c) => c.json({ amble: 1, url: config.publicUrl, schema, pairing: true, signIn }));

  // A device getting in with a code: as the person it's for, or for an invite, as the device's own
  // person (the household's row for them if it has one) or someone new by the name they gave.
  const guesses = codeGuesses();
  app.post('/sync/pair', async (c) => {
    const from = requestFrom(c);
    if (guesses.blocked(from)) return c.json({ error: TOO_MANY_CODES }, 429);
    const parsed = z
      .object({
        code: z.string().max(40),
        person: z.object({ id: z.string().max(100), name: z.string().max(80), email: z.string().max(320) }).nullable().optional(),
        name: z.string().trim().max(80).optional(),
        device: z.string().trim().max(60).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "That request doesn't look right." }, 400);
    const { code, person, name, device } = parsed.data;
    let member: Member | null;
    try {
      member = redeemCode(db, config, code, { ...person, name: person?.name || name });
    } catch (err) {
      if (err instanceof NeedsName) return c.json({ error: err.message, needName: true }, 400);
      throw err;
    }
    if (!member) {
      guesses.missed(from);
      return c.json({ error: WRONG_CODE }, 400);
    }
    const token = createSession(db, member.id, `Amble app (${device || 'by code'})`);
    return c.json({ token, member: { id: member.id, email: member.email, name: member.name }, name: new URL(config.publicUrl).host });
  });

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
    const member = deviceMember(c);
    if (!member) return c.json({ error: 'Sign in again.' }, 401);
    let remote: SyncState;
    try {
      remote = await unpack<SyncState>(new Uint8Array(await c.req.arrayBuffer()));
    } catch {
      return c.json({ error: "That isn't Amble's sync data." }, 400);
    }
    // Anyone in the household may change what it shares, but only an admin's device who's in it,
    // who's an admin, and how each person signs in.
    const spared = member.role === 'admin' ? null : sparePeople(db, remote);
    try {
      mergeState(db, service.clock, remote, schema);
    } catch (err) {
      if (err instanceof NewerSchema) return c.json({ error: 'Your server runs an older Amble than this device. Update the server to keep syncing.' }, 409);
      throw err;
    }
    if (spared) keepPeople(db, spared);
    // A model the household set while it was on Google Drive becomes the server's own.
    if (adoptHouseholdAi(ai)) service.stamp();
    const { state, etag } = current();
    return answer(c, state, etag);
  });

  // ---- files on tasks ------------------------------------------------------------------------
  // Drive can't share them (drive.file only opens what Amble made or someone picked), so a household
  // with a server keeps them here. A device sends the bytes of files added on it, named by their
  // SHA-256, and fetches the ones it lacks when someone opens them. Only bytes a file on a task
  // points at are taken or given out, so this never becomes storage for anything else.

  const onATask = (sha256: string) =>
    SHA256.test(sha256) &&
    db.select({ id: attachments.id }).from(attachments).where(or(eq(attachments.sha256, sha256), eq(attachments.previewSha256, sha256))).get() != null;

  // Which of the files a device has the server needs, and which it has already.
  app.post('/sync/files/check', async (c) => {
    if (!deviceMember(c)) return c.json({ error: 'Sign in again.' }, 401);
    const parsed = z.object({ have: z.array(z.string().regex(SHA256)).max(10_000) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "That request doesn't look right." }, 400);
    const need: string[] = [];
    const stored: string[] = [];
    for (const sha256 of new Set(parsed.data.have)) {
      if (!onATask(sha256)) continue;
      ((await files.get(sha256)) ? stored : need).push(sha256);
    }
    return c.json({ need, stored });
  });

  app.put('/sync/files/:sha256', async (c) => {
    if (!deviceMember(c)) return c.json({ error: 'Sign in again.' }, 401);
    const sha256 = c.req.param('sha256');
    if (!onATask(sha256)) return c.json({ error: 'No file on a task has those bytes.' }, 404);
    if (await files.get(sha256)) return c.body(null, 204);
    if (Number(c.req.header('content-length')) > config.maxFileBytes) return c.json({ error: tooBigMessage(config.maxFileBytes) }, 413);
    try {
      // Bytes that turn out to be something else are kept under their own hash, which no file points
      // at, so the daily sweep takes them away.
      const saved = await files.save(c.req.raw.body, config.maxFileBytes);
      if (saved.sha256 !== sha256) return c.json({ error: "Those bytes aren't the file they were sent as." }, 400);
    } catch (err) {
      if (err instanceof FileTooBig) return c.json({ error: tooBigMessage(config.maxFileBytes) }, 413);
      throw err;
    }
    return c.body(null, 204);
  });

  app.get('/sync/files/:sha256', async (c) => {
    if (!deviceMember(c)) return c.json({ error: 'Sign in again.' }, 401);
    const sha256 = c.req.param('sha256');
    const file = onATask(sha256) ? await files.get(sha256) : null;
    if (!file) return c.json({ error: "The server doesn't have that file." }, 404);
    return c.body(file.stream(), 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.size),
      // The bytes for a hash never change.
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  // A device with no model of its own asks the server's: the server keeps the key, meters the call
  // against its monthly cap, and hands back the answer for the device to check. Asked to stream, it
  // sends the model's words a line at a time as they're written, then the answer.
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
        stream: z.boolean().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "That request doesn't look right." }, 400);
    const setup = ai.setup();
    if (!setup) return c.json({ error: 'No AI model is set up on the server.' }, 503);
    const req = parsed.data;
    const call = (onText?: (piece: string) => void) =>
      ask(db, ai, {
        system: req.system,
        content: req.content,
        schema: z.unknown(),
        jsonSchema: req.schema,
        effort: req.effort ? effortFor(setup, req.effort) : null,
        maxTokens: req.maxTokens,
        feature: req.feature,
        memberId: member.id,
        timezone: config.timezone,
        onText,
      });
    // The device falls back quietly, so this log is where the reason shows.
    const failed = (err: AiUnavailable) => console.warn(`AI for a device (${req.feature}) failed:`, err.message);
    if (req.stream) {
      return linesResponse(async (write) => {
        try {
          const { output, usage } = await call((text) => write({ text }));
          write({ output, usage });
        } catch (err) {
          if (!(err instanceof AiUnavailable)) console.error(`AI for a device (${req.feature}) broke:`, err);
          else failed(err);
          write({ error: err instanceof AiUnavailable ? err.message : 'Something went wrong on the server.' });
        }
      });
    }
    try {
      const { output, usage } = await call();
      return c.json({ output, usage });
    } catch (err) {
      if (!(err instanceof AiUnavailable)) throw err;
      failed(err);
      return c.json({ error: err.message }, 503);
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
