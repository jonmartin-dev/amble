// The server's own pages, beside the app it serves: signing in (for the connector, devices
// syncing here, and this page), and one page for what only the server has: Claude and ChatGPT,
// its Google Drive sync, and its AI model.
import type { Context, Hono } from 'hono';
import { aiProvider } from '../shared/ai.ts';
import { modelName, monthSpendUsd, type Ai } from './ai/client.ts';
import type { Oidc } from './auth/oidc.ts';
import { allowedEmails } from './auth/members.ts';
import type { Config } from './config.ts';
import type { Connector } from './connector.ts';
import type { Db } from './db/index.ts';
import type { Member } from './db/schema.ts';
import type { Env } from './env.ts';
import { html, page, type Html } from './pages.ts';
import type { ServerSync } from './sync/server.ts';
import { SyncSetupError } from './sync/service.ts';

const SIGN_IN_ERRORS: Record<string, string> = {
  'not-allowed': "That account isn't on this household's list. Ask whoever runs Amble to add it.",
  expired: 'That sign-in took too long. Try again.',
  failed: "Sign-in didn't go through. Try again.",
  unavailable: "Amble couldn't reach the sign-in provider. Try again in a moment.",
  unverified: "Your sign-in provider says this email address isn't verified. Whoever runs Amble can mark it verified there.",
  'no-email': "Your sign-in provider didn't share an email address. Whoever runs Amble needs to let it share one.",
  declined: 'Nothing changed: Google said no, or the window was closed.',
  off: 'Only an admin can connect Google Drive, and the server needs a Google sign-in client.',
};

/** Only same-app relative paths as places to come back to. */
export function safeReturnTo(value: string | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/server';
  return value;
}

const when = (d: Date | null | undefined) => (d ? d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

export function registerSite(app: Hono<Env>, { db, config, oidc, sync, ai, connector }: { db: Db; config: Config; oidc: Oidc; sync: ServerSync; ai: Ai; connector: Connector }) {
  const base = config.basePath;
  const url = (p: string) => `${base}${p}`;
  const show = (c: Context<Env>, title: string, body: Html, status: 200 | 400 | 404 = 200) => c.html(page(title, body, { base }), status);

  // The old address of the sign-in page, in the server's app.
  app.get('/signin', (c) => c.redirect(url(`/auth/signin${new URL(c.req.url).search}`)));

  app.get('/auth/signin', (c) => {
    const error = c.req.query('error');
    const returnTo = safeReturnTo(c.req.query('return'));
    const back = `return=${encodeURIComponent(returnTo)}`;
    const dev = config.devLogin ? allowedEmails(db, config) : [];
    return show(
      c,
      'Sign in',
      html`<h1>Sign in to this server</h1>
<p class="muted">It keeps your household in step for your devices, and lets Claude or ChatGPT help.</p>
${error && SIGN_IN_ERRORS[error] ? html`<p class="warn" role="alert">${SIGN_IN_ERRORS[error]}</p>` : ''}
<div class="actions">
${oidc.enabled ? html`<a class="button primary" href="${url(`/auth/login?${back}&direct=1`)}">Continue with ${config.oidc.providerName}</a>` : ''}
${dev.map((email) => html`<a class="button quiet" href="${url(`/auth/dev?email=${encodeURIComponent(email)}&${back}`)}">Dev sign-in as ${email}</a>`)}
</div>
${!oidc.enabled && dev.length === 0 ? html`<p class="muted">Sign-in isn't set up yet. The admin needs to add OIDC settings.</p>` : ''}`,
    );
  });

  const signedIn = (c: Context<Env>) => c.get('member');

  /** Back to the server's page, saying how it went. */
  const done = (c: Context<Env>, message: string, error = false) => c.redirect(url(`/server?${error ? 'error' : 'done'}=${encodeURIComponent(message)}`));

  app.get('/server', async (c) => {
    const me = signedIn(c);
    if (!me) return c.redirect(url(`/auth/signin?return=${encodeURIComponent('/server')}`));
    const admin = me.role === 'admin';
    const notice = c.req.query('done');
    const problem = c.req.query('error');
    const connections = connector.connections(me.id);

    // Google Drive: what the server syncs with, and how to change it.
    let drive: Html | string = '';
    if (admin && sync.enabled) {
      const status = sync.service.status();
      const google = sync.account();
      if (status.on) {
        drive = html`<div class="card"><p><strong>${status.target?.name ?? 'Google Drive'}</strong></p>
<p class="muted">As ${google?.email ?? 'Google'} · last synced ${status.syncedAt ? when(new Date(status.syncedAt)) : 'not yet'}</p>
${status.error ? html`<p class="warn">${status.error}</p>` : ''}</div>
<div class="actions">
<form method="post" action="${url('/server/drive/run')}"><button class="quiet">Sync now</button></form>
<form method="post" action="${url('/server/drive/stop')}" onsubmit="return confirm('Stop syncing this server with Google Drive? Its data stays, and so does the file in Drive.')"><button class="quiet">Stop syncing</button></form>
</div>`;
      } else if (!google) {
        drive = html`<p>Keep this server in step with a household that keeps Amble in Google Drive, so Claude and ChatGPT see the same tasks as everyone's phones.</p>
<div class="actions"><a class="button primary" href="${url('/auth/drive')}">Connect Google Drive</a></div>`;
      } else {
        let households: { id: string; name: string; owners?: { displayName?: string; emailAddress?: string }[] }[] = [];
        try {
          households = await sync.households();
        } catch (err) {
          drive = html`<p class="warn">${err instanceof Error ? err.message : "Couldn't reach Google Drive."}</p>`;
        }
        drive = html`${drive}<p>Connected as ${google.email}. Join the household's file, or make one from what's on this server.</p>
<ul>${households.map(
          (h) => html`<li class="card row"><span>${h.name}<br><span class="muted">${h.owners?.[0]?.displayName ?? h.owners?.[0]?.emailAddress ?? ''}</span></span>
<form method="post" action="${url('/server/drive/join')}"><input type="hidden" name="fileId" value="${h.id}"><button class="quiet">Join</button></form></li>`,
        )}</ul>
${households.length === 0 ? html`<p class="muted">No household files ${google.email} can open yet.</p>` : ''}
<div class="actions"><form method="post" action="${url('/server/drive/create')}"><button class="primary">Make a household from this server</button></form></div>`;
      }
    }

    const setup = ai.setup();
    const spent = monthSpendUsd(db, config.timezone);

    return show(
      c,
      'This server',
      html`<h1>This Amble server</h1>
<div class="row"><p class="muted">Signed in as ${me.name} (${me.email})</p>
<form method="post" action="${url('/auth/logout')}"><button class="quiet">Sign out</button></form></div>
${notice ? html`<p class="card" role="status">${notice}</p>` : ''}
${problem ? html`<p class="warn" role="alert">${SIGN_IN_ERRORS[problem] ?? problem}</p>` : ''}

<h2>Amble</h2>
<p>Amble runs on each phone and computer, and keeps in step with this server.</p>
<div class="actions"><a class="button primary" href="${url('/')}">Open Amble</a></div>
<p class="muted">In the Android app, choose <em>Use my own server</em> and enter <code>${config.publicUrl}</code>.</p>

<h2>Claude and ChatGPT</h2>
<p>Add Amble as a custom connector in Claude or ChatGPT with this address, then sign in here when it asks:</p>
<p><code>${connector.mcpUrl}</code></p>
${
  connections.length
    ? html`<ul>${connections.map(
        (g) => html`<li class="card row"><span>${g.clientName}<br><span class="muted">Connected ${when(g.createdAt)} · last used ${when(g.lastUsedAt)}</span></span>
<form method="post" action="${url(`/server/connections/${g.id}/remove`)}"><button class="quiet">Disconnect</button></form></li>`,
      )}</ul>`
    : html`<p class="muted">Nothing connected yet.</p>`
}

${admin && sync.enabled ? html`<h2>Google Drive</h2>${drive}` : ''}

<h2>AI</h2>
${
  setup
    ? html`<p>${modelName(setup)}, from ${aiProvider(setup.provider)?.name ?? setup.provider}. Phones with no model of their own use it.</p>
<p class="muted">${setup.prices ? `$${spent.toFixed(2)} of the $${setup.monthlyCapUsd} cap this month.` : 'Spending isn’t counted for this model.'}</p>`
    : html`<p class="muted">No AI model is set up here. An admin sets one in the server's settings file (AMBLE_AI_PROVIDER and AMBLE_AI_API_KEY).</p>`
}

<p class="muted" style="margin-top:2.5rem"><a href="${url('/privacy')}">Privacy</a></p>`,
    );
  });

  app.post('/server/connections/:id/remove', (c) => {
    const me = signedIn(c);
    if (!me) return c.redirect(url('/auth/signin'));
    return connector.disconnect(c.req.param('id'), me.id) ? done(c, 'Disconnected.') : done(c, 'That connection is already gone.', true);
  });

  // An admin's Google Drive sync, from the page above.
  const drive = (fn: (form: Record<string, string>, me: Member) => Promise<string>) => async (c: Context<Env>) => {
    const me = signedIn(c);
    if (!me) return c.redirect(url('/auth/signin'));
    if (me.role !== 'admin') return done(c, 'Only an admin can change sync.', true);
    try {
      const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
      return done(c, await fn(form, me));
    } catch (err) {
      if (err instanceof SyncSetupError) return done(c, err.message, true);
      throw err;
    }
  };

  app.post(
    '/server/drive/join',
    drive(async (form) => {
      await sync.connect({ mode: 'join', fileId: form.fileId ?? '' });
      return 'Joined the household. This server keeps in step with it from now on.';
    }),
  );
  app.post(
    '/server/drive/create',
    drive(async (_form, me) => {
      await sync.connect({ mode: 'create', name: `${me.name.split(/\s+/)[0]}'s Amble household` });
      return 'Made a household file in Google Drive. Share it from Amble on a device, and everyone joins it there.';
    }),
  );
  app.post(
    '/server/drive/run',
    drive(async () => {
      const result = await sync.run();
      if (result.error) throw new SyncSetupError(result.error);
      return 'Synced.';
    }),
  );
  app.post(
    '/server/drive/stop',
    drive(async () => {
      await sync.off();
      return 'Stopped syncing with Google Drive.';
    }),
  );
}
