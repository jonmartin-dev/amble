// Syncing with the household's own server: finding it from an address someone typed, sending them
// to sign in there, and finishing when the server sends them back with a code (to the app's
// /server-return page in a browser, or dev.jonmartin.amble://signed-in on Android). The worker
// swaps the code for this device's sign-in and does the syncing (server/sync/service.ts).
import { Capacitor } from '@capacitor/core';
import { useEffect } from 'react';
import { api, basePath } from './api.ts';

const native = Capacitor.isNativePlatform();

const PENDING_KEY = 'amble-server-signin';
const RESULT_KEY = 'amble-server-return';
const RETURNED = 'amble:server-return';
const RETURN_PAGE = '/server-return';
// The Android app's own link (server/sync/hub.ts lets it in).
const APP_RETURN = 'dev.jonmartin.amble://signed-in';

interface Pending {
  url: string;
  verifier: string;
  state: string;
  redirectUri: string;
  /** What to carry on with, back in the app. */
  action: string;
  /** The page to go back to. */
  page: string;
}

interface Returned {
  code?: string;
  state?: string;
  error?: string;
}

const read = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
};

function random(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeOf(verifier: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The server at an address someone typed, or an error saying why there's none. */
export async function findServer(address: string) {
  return (await api<{ url: string }>('/sync/server/find', { method: 'POST', body: JSON.stringify({ address }) })).url;
}

/** Sends the person to sign in on the server. `action` says what to carry on with when they're back. */
export async function signInToServer(url: string, action: string) {
  const verifier = random(48);
  const redirectUri = native ? APP_RETURN : `${location.origin}${basePath}${RETURN_PAGE}`;
  const pending: Pending = { url, verifier, state: random(16), redirectUri, action, page: location.pathname.slice(basePath.length) || '/' };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  localStorage.removeItem(RESULT_KEY);
  const query = new URLSearchParams({ redirect_uri: redirectUri, state: pending.state, code_challenge: await challengeOf(verifier), code_challenge_method: 'S256' });
  // In the Android app this opens the phone's browser; the app stays where it is.
  window.location.assign(`${url}/auth/app?${query}`);
}

/** The server sent the person back: keep what it said for the page that's waiting. */
export function acceptServerReturn(params: URLSearchParams) {
  const result: Returned = { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined, error: params.get('error') ?? undefined };
  localStorage.setItem(RESULT_KEY, JSON.stringify(result));
  window.dispatchEvent(new Event(RETURNED));
}

/** In a browser, back on /server-return: keep the code, and go back to the page they left from. */
export function takeServerReturn() {
  if (native || location.pathname !== `${basePath}${RETURN_PAGE}`) return;
  acceptServerReturn(new URLSearchParams(location.search));
  history.replaceState(null, '', `${basePath}${read<Pending>(PENDING_KEY)?.page ?? '/'}`);
}

/**
 * Finishes signing in, if the person came back from the server for this `action`: the device
 * starts syncing with it. Resolves to an error to show, or null when there was nothing to finish.
 */
async function finish(action: string): Promise<{ ok: true } | { ok: false; error: string } | null> {
  const pending = read<Pending>(PENDING_KEY);
  const result = read<Returned>(RESULT_KEY);
  if (!pending || !result || pending.action !== action) return null;
  localStorage.removeItem(PENDING_KEY);
  localStorage.removeItem(RESULT_KEY);
  if (result.error === 'access_denied') return { ok: false, error: 'Nothing changed: you chose not now on the server.' };
  if (!result.code || result.state !== pending.state) return { ok: false, error: "The server didn't finish signing you in. Try again." };
  try {
    await api('/sync/server/connect', {
      method: 'POST',
      body: JSON.stringify({ url: pending.url, code: result.code, verifier: pending.verifier, redirectUri: pending.redirectUri }),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "That didn't work. Try again." };
  }
}

/** Runs `done` once the person is back from signing in on the server for `action`, now or later. */
export function useServerReturn(action: string, done: (outcome: { ok: true } | { ok: false; error: string }) => void) {
  useEffect(() => {
    let live = true;
    const check = () =>
      void finish(action).then((outcome) => {
        if (outcome && live) done(outcome);
      });
    check();
    window.addEventListener(RETURNED, check);
    return () => {
      live = false;
      window.removeEventListener(RETURNED, check);
    };
    // Once per page, like the Google return.
  }, [action]);
}
