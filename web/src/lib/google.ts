// Google sign-in for Drive sync, in the page: Google hands the app a short-lived access token
// (about an hour), and the Picker lets someone choose a household file shared with them. A browser
// can't renew the token without a tap, so when it runs out the app asks.
import { DRIVE_SCOPES, HOUSEHOLD_MIME } from '../../../server/sync/drive.ts';
import { basePath } from './api.ts';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined;
const APP_ID = import.meta.env.VITE_GOOGLE_APP_ID as string | undefined;

/** This build was given a Google client to sign in with. */
export const googleConfigured = Boolean(CLIENT_ID);

const TOKEN_KEY = 'almanac-google-token';
// Renew a little early, so a sync doesn't start with a token that runs out halfway.
const MARGIN_MS = 5 * 60 * 1000;

interface Token {
  token: string;
  expiresAt: number;
  email?: string;
}

type GoogleGlobal = any;
declare global {
  interface Window {
    google?: GoogleGlobal;
    gapi?: GoogleGlobal;
  }
}

const scripts = new Map<string, Promise<void>>();
function load(src: string) {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        scripts.delete(src);
        reject(new Error("Couldn't reach Google. Check the connection and try again."));
      };
      document.head.append(el);
    });
    scripts.set(src, p);
  }
  return p;
}

function saved(): Token | null {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') as Token | null;
    return t && t.expiresAt - MARGIN_MS > Date.now() ? t : null;
  } catch {
    return null;
  }
}

/** A token that's still good, without asking Google. */
export const currentToken = () => saved()?.token ?? null;

export function forgetToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage off: nothing was kept.
  }
}

const PENDING_KEY = 'almanac-google-pending';

interface Pending {
  state: string;
  action: string;
  path: string;
}

/**
 * Where Google sends the page back to, which has to be registered with the Google client. (Google's
 * console won't keep an address that's only the site with a slash, so it has a path.)
 */
export const googleReturnUrl = () => new URL(`${basePath}/google-return`, location.origin).href;

/**
 * Goes to Google to sign in and allow Drive, and comes back to this page to carry on with
 * `action`. A whole-page trip rather than a pop-up: an installed app on a phone handles that
 * better. Only call it from a tap.
 */
export function signInWithGoogle(action: string, hint?: string): Promise<never> {
  if (!CLIENT_ID) throw new Error("This copy of Almanac isn't set up to sign in with Google.");
  const state = crypto.randomUUID();
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, action, path: location.pathname + location.search } satisfies Pending));
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: googleReturnUrl(),
    response_type: 'token',
    scope: DRIVE_SCOPES.join(' '),
    include_granted_scopes: 'true',
    state,
    ...(hint && { login_hint: hint }),
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  // The page is leaving.
  return new Promise<never>(() => {});
}

let returned: { action: string; error: string | null } | null = null;

/**
 * Run once as the app loads: if Google just sent the page back, keeps the token, puts the address
 * back to the page that asked (without the token in it), and remembers what to carry on with.
 */
export function takeGoogleReturn() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const landed = location.pathname === `${basePath}/google-return`;
  if (!hash.has('state') || !(hash.has('access_token') || hash.has('error'))) {
    // Here some other way (a reload, an old tab): nothing to carry on with.
    if (landed) history.replaceState(null, '', `${basePath}/`);
    return;
  }
  let pending: Pending | null = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as Pending | null;
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage off: nothing to carry on with.
  }
  history.replaceState(null, '', pending?.path ?? `${basePath}/`);
  if (!pending || pending.state !== hash.get('state')) return;
  const granted = (hash.get('scope') ?? '').split(' ');
  const token = hash.get('access_token');
  const error = hash.get('error')
    ? hash.get('error') === 'access_denied'
      ? 'Google sign-in was cancelled.'
      : "Google didn't sign you in. Try again."
    : !DRIVE_SCOPES.every((s) => granted.includes(s))
      ? 'Almanac needs both Drive permissions to sync. Try again and leave them ticked.'
      : null;
  if (token && !error) {
    try {
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiresAt: Date.now() + Number(hash.get('expires_in') ?? 3600) * 1000 } satisfies Token));
    } catch {
      // Without storage the token can't outlive this page; the action below still uses it.
    }
  }
  returned = { action: pending.action, error };
}

/** If the page just came back from Google for `action`: carry on (or say what went wrong). Once only. */
export function resumeAfterGoogle(action: string): { error: string | null } | null {
  if (returned?.action !== action) return null;
  const r = returned;
  returned = null;
  return { error: r.error };
}

/** A token now, or a trip to Google for one that comes back to carry on with `action`. */
export async function tokenFromTap(action: string, hint?: string): Promise<string> {
  return currentToken() ?? signInWithGoogle(action, hint);
}

/** Google's picker, for choosing the household file someone shared. Resolves with its id, or null. */
export async function pickHouseholdFile(token: string): Promise<string | null> {
  if (!API_KEY || !APP_ID) throw new Error("This copy of Almanac isn't set up to pick files from Google Drive.");
  await load('https://apis.google.com/js/api.js');
  await new Promise<void>((resolve) => window.gapi.load('picker', () => resolve()));
  const picker = window.google.picker;
  return new Promise<string | null>((resolve) => {
    // Household files are gzipped (Drive goes by what's inside, whatever type Almanac gives them), with
    // Almanac in the name; this keeps documents and photos out of the list.
    const view = (mine: boolean) =>
      new picker.DocsView(picker.ViewId.DOCS)
        .setOwnedByMe(mine)
        .setMode(picker.DocsViewMode.LIST)
        .setMimeTypes(`${HOUSEHOLD_MIME},application/x-gzip,application/gzip`)
        .setQuery('Almanac');
    const shared = view(false);
    const mine = view(true);
    new picker.PickerBuilder()
      .setTitle('Pick the Almanac household file shared with you')
      .addView(shared)
      .addView(mine)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .setAppId(APP_ID)
      .setCallback((data: { action: string; docs?: { id: string }[] }) => {
        if (data.action === picker.Action.PICKED) resolve(data.docs?.[0]?.id ?? null);
        else if (data.action === picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
