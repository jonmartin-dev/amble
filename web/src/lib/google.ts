// Google sign-in for Drive sync, in the page: Google hands the app an access token that lasts about
// an hour, and the Picker lets someone choose a household file shared with them. A browser keeps it
// going without asking in one of two ways. With a token endpoint (the /google/token of the Amble
// server that serves the app, VITE_GOOGLE_TOKEN_URL, or the worker in deploy/google-token-worker),
// signing in brings back a refresh token too, and the app refreshes in place. Without one, it takes
// a quick trip to Google that shows nothing (prompt=none) while nobody's using the page. Only
// someone signed out of Google, or who took Amble's access away, is asked to tap. The Android app
// signs in through Google Play services instead (android/.../GoogleDrivePlugin.java), which renews
// it.
import { registerPlugin } from '@capacitor/core';
import { DRIVE_SCOPES, HOUSEHOLD_MIME } from '../../../server/sync/drive.ts';
import { basePath } from './api.ts';
import { native } from './native.ts';

// From the Amble server that serves the app, which knows its own Google client; or built in.
const served = window.__AMBLE__?.google;
const CLIENT_ID = served?.clientId || (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined);
const API_KEY = served?.apiKey || (import.meta.env.VITE_GOOGLE_API_KEY as string | undefined);
const APP_ID = served?.appId || (import.meta.env.VITE_GOOGLE_APP_ID as string | undefined);
const TOKEN_URL = served?.tokenUrl || (import.meta.env.VITE_GOOGLE_TOKEN_URL as string | undefined);

interface GoogleDrivePlugin {
  authorize(options: { interactive?: boolean; email?: string }): Promise<{ accessToken: string; scopes: string[] }>;
  pick(options: { mimeTypes?: string; email?: string }): Promise<{ fileId: string | null }>;
  clearToken(options: { token: string }): Promise<void>;
  revoke(options: { email: string }): Promise<void>;
}
const GoogleDrive = registerPlugin<GoogleDrivePlugin>('GoogleDrive');

/** This build was given a Google client to sign in with (the Android app has its own). */
export const googleConfigured = native || Boolean(CLIENT_ID);

/** Where a browser renews its Drive access through, if this build has a token endpoint: its host, for the privacy page. */
export const tokenEndpointHost = !native && TOKEN_URL ? new URL(TOKEN_URL, document.baseURI).host : null;

// The Android app's latest token, to hand back if Google turns it down.
let nativeToken: string | null = null;

/** A Drive token from Android: silently, or (from a tap) showing Google's screens if they're needed. */
async function fromAndroid(interactive: boolean, email?: string): Promise<string | null> {
  try {
    nativeToken = (await GoogleDrive.authorize({ interactive, email })).accessToken;
    return nativeToken;
  } catch (err) {
    if (!interactive && (err as { code?: string }).code === 'NEEDS_SIGN_IN') return null;
    throw err;
  }
}

const TOKEN_KEY = 'almanac-google-token';
// The refresh token outlives the tab, so it's in localStorage; the hour's token stays per tab.
const REFRESH_KEY = 'amble-google-refresh';
// When a quiet trip to Google last came back wanting the person: it doesn't keep trying.
const QUIET_FAILED_KEY = 'amble-google-quiet-failed';
const QUIET_RETRY_MS = 6 * 60 * 60 * 1000;
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
  if (native) {
    if (nativeToken) void GoogleDrive.clearToken({ token: nativeToken }).catch(() => {});
    nativeToken = null;
    return;
  }
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage off: nothing was kept.
  }
}

/** Stops this browser using its refresh token. It isn't revoked: Google would take the whole grant, an Amble server's included. */
export function forgetRefreshToken() {
  try {
    localStorage.removeItem(REFRESH_KEY);
  } catch {
    // Storage off: nothing was kept.
  }
}

function storedRefresh() {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

interface TokenAnswer {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

/** Keeps what Google gave: the hour's token for this tab, and a refresh token if there was one. */
function keep(t: TokenAnswer) {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: t.access_token!, expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000 } satisfies Token));
    if (t.refresh_token) localStorage.setItem(REFRESH_KEY, t.refresh_token);
    localStorage.removeItem(QUIET_FAILED_KEY);
  } catch {
    // Storage off: the token can't outlive this page.
  }
}

/** A call to the token endpoint, which adds the client secret on its way to Google. */
async function tokenCall(body: Record<string, string>): Promise<{ ok: boolean; answer: TokenAnswer }> {
  const res = await fetch(new URL(TOKEN_URL!, document.baseURI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, answer: (await res.json().catch(() => ({}))) as TokenAnswer };
}

let refreshing: Promise<string | null> | null = null;

/** A new hour's token from the refresh token, without leaving the page; null if there's no way. */
function refreshed(): Promise<string | null> {
  const refresh = storedRefresh();
  if (!TOKEN_URL || !refresh) return Promise.resolve(null);
  refreshing ??= (async () => {
    try {
      const { ok, answer } = await tokenCall({ grant: 'refresh', refresh_token: refresh });
      if (ok && answer.access_token) {
        keep(answer);
        return answer.access_token;
      }
      // Google let it go (access taken away, or unused for months): signing in again brings a new one.
      if (answer.error === 'invalid_grant') forgetRefreshToken();
    } catch {
      // Offline, or the endpoint is down: the next round tries again.
    }
    return null;
  })().finally(() => (refreshing = null));
  return refreshing;
}

/** Whether a quiet trip to Google is worth taking: there's a client, and the last one didn't need the person. */
export function canRenewQuietly() {
  if (native || !CLIENT_ID) return false;
  try {
    return Date.now() - Number(localStorage.getItem(QUIET_FAILED_KEY) ?? 0) > QUIET_RETRY_MS;
  } catch {
    return true;
  }
}

/**
 * A new token by a trip to Google that shows nothing while `email` is signed in to Google and has
 * allowed Amble (prompt=none). The page reloads, so only when nobody's in the middle of something.
 */
export const renewQuietly = (email: string) => goToGoogle('sync', { hint: email, quiet: true });

/**
 * A token for a round of sync, or null when it has to wait. With `tap`, a browser goes to Google (and
 * the page leaves); the Android app shows Google's screens over it.
 */
export async function syncToken(tap: boolean, email?: string): Promise<string | null> {
  if (native) return fromAndroid(tap, email);
  await exchanging?.catch(() => {});
  return currentToken() ?? (await refreshed()) ?? (tap ? signInWithGoogle('sync', email) : null);
}

const PENDING_KEY = 'almanac-google-pending';

interface Pending {
  state: string;
  action: string;
  path: string;
  /** The code flow's secret half, for trading the code (PKCE). */
  verifier?: string;
  /** A trip that showed nothing: there's no action to carry on with. */
  quiet?: boolean;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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
export const signInWithGoogle = (action: string, hint?: string) => goToGoogle(action, { hint });

async function goToGoogle(action: string, { hint, quiet = false }: { hint?: string; quiet?: boolean }): Promise<never> {
  if (!CLIENT_ID) throw new Error("This copy of Amble isn't set up to sign in with Google.");
  const state = crypto.randomUUID();
  // With a token endpoint, signing in brings back a code to trade for a refresh token too. Google
  // hands one out only from its consent screen, so a quiet trip gets just the hour's token.
  const verifier = TOKEN_URL && !quiet ? base64url(crypto.getRandomValues(new Uint8Array(48))) : undefined;
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, action, path: location.pathname + location.search, verifier, quiet } satisfies Pending));
  const challenge = verifier && base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: googleReturnUrl(),
    scope: DRIVE_SCOPES.join(' '),
    include_granted_scopes: 'true',
    state,
    ...(challenge
      ? { response_type: 'code', access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256' }
      : { response_type: 'token' }),
    ...(quiet && { prompt: 'none' }),
    ...(hint && { login_hint: hint }),
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  // The page is leaving.
  return new Promise<never>(() => {});
}

let returned: { action: string; error: string | null } | null = null;
// Trading the code Google came back with, under way: whoever needs the token waits for it.
let exchanging: Promise<void> | null = null;

const hasDriveScopes = (scope: string | null | undefined) => DRIVE_SCOPES.every((s) => (scope ?? '').split(' ').includes(s));
const NEEDS_BOTH = 'Amble needs both Drive permissions to sync. Try again and leave them ticked.';

async function exchange(code: string, verifier: string) {
  let result;
  try {
    result = await tokenCall({ grant: 'code', code, code_verifier: verifier, redirect_uri: googleReturnUrl() });
  } catch {
    throw new Error("Couldn't reach Google. Check the connection and try again.");
  }
  if (!result.ok || !result.answer.access_token) throw new Error("Google didn't sign you in. Try again.");
  if (!hasDriveScopes(result.answer.scope)) throw new Error(NEEDS_BOTH);
  keep(result.answer);
}

/**
 * Run once as the app loads: if Google just sent the page back, keeps the token (or starts trading
 * the code for one), puts the address back to the page that asked (without either in it), and
 * remembers what to carry on with.
 */
export function takeGoogleReturn() {
  const landed = location.pathname === `${basePath}/google-return`;
  // A token comes back in the fragment, a code in the query.
  const hash = new URLSearchParams(location.hash.slice(1));
  const answer = hash.has('state') || !landed ? hash : new URLSearchParams(location.search);
  if (!answer.has('state') || !(answer.has('access_token') || answer.has('code') || answer.has('error'))) {
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
  if (!pending || pending.state !== answer.get('state')) return;
  const failure = answer.get('error');
  const token = answer.get('access_token');
  const code = answer.get('code');
  const lasts = Number(answer.get('expires_in') ?? 3600);
  if (pending.quiet) {
    // Google wanted the person after all (signed out, or the access was taken away): sync asks for a tap.
    if (failure || !token || !hasDriveScopes(answer.get('scope'))) {
      try {
        localStorage.setItem(QUIET_FAILED_KEY, String(Date.now()));
      } catch {
        // Storage off: it may try again.
      }
    } else keep({ access_token: token, expires_in: lasts });
    return;
  }
  const error = failure
    ? failure === 'access_denied'
      ? 'Google sign-in was cancelled.'
      : "Google didn't sign you in. Try again."
    : token && !hasDriveScopes(answer.get('scope'))
      ? NEEDS_BOTH
      : null;
  if (!error && token) keep({ access_token: token, expires_in: lasts });
  if (!error && code && pending.verifier) {
    exchanging = exchange(code, pending.verifier);
    // Whoever carries on with the action hears how it went.
    exchanging.catch(() => {});
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
  if (native) return (await fromAndroid(true, hint))!;
  const traded = exchanging;
  exchanging = null;
  // Back from Google with a code: its token, or why there isn't one.
  if (traded) await traded;
  return currentToken() ?? (await refreshed()) ?? signInWithGoogle(action, hint);
}

// Household files are gzipped (Drive can go by what's inside, whatever type Amble gives them).
const HOUSEHOLD_TYPES = `${HOUSEHOLD_MIME},application/x-gzip,application/gzip`;

/** Google's picker, for choosing the household file someone shared. Resolves with its id, or null. */
export async function pickHouseholdFile(token: string, email?: string): Promise<string | null> {
  if (native) return (await GoogleDrive.pick({ mimeTypes: HOUSEHOLD_TYPES, email })).fileId;
  if (!API_KEY || !APP_ID) throw new Error("This copy of Amble isn't set up to pick files from Google Drive.");
  await load('https://apis.google.com/js/api.js');
  await new Promise<void>((resolve) => window.gapi.load('picker', () => resolve()));
  const picker = window.google.picker;
  return new Promise<string | null>((resolve) => {
    // "household" in the name keeps other gzipped files out of the list (files made before the app
    // was renamed say Almanac household, newer ones Amble household).
    const view = (mine: boolean) =>
      new picker.DocsView(picker.ViewId.DOCS).setOwnedByMe(mine).setMode(picker.DocsViewMode.LIST).setMimeTypes(HOUSEHOLD_TYPES).setQuery('household');
    const shared = view(false);
    const mine = view(true);
    new picker.PickerBuilder()
      .setTitle('Pick the Amble household file shared with you')
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
