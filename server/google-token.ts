// What a browser running Amble with no server needs to stay signed in to Drive: Google gives a web
// page a refresh token only through the authorization code flow, and its token calls for a "Web
// application" client want the client secret, which a page can't keep. This adds the secret to
// those two calls (trading the code, and refreshing) for the app's own origins, and stores and logs
// nothing; the browser keeps its refresh token itself. The Amble server answers at /google/token, and workers/google-token runs the same
// code on Cloudflare for a web app with no server.

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
// What goes back to the page from Google's answer: the token, and why not if there isn't one.
const PASSED_ON = ['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type', 'error', 'error_description'];
const MAX_FIELD = 4096;

export interface GoogleTokenOptions {
  clientId: string;
  clientSecret: string;
  /** The web app's origins, like https://amble.example.com: only pages there may use it. */
  origins: string[];
  fetchImpl?: typeof fetch;
}

/** One of the two calls a page makes: trading the code it came back with, or refreshing. */
type Call = { grant: 'code'; code: string; code_verifier: string; redirect_uri: string } | { grant: 'refresh'; refresh_token: string };

const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD;

function parse(body: unknown, origin: string): Call | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.grant === 'code' && text(b.code) && text(b.code_verifier) && text(b.redirect_uri)) {
    // Only back to the web app's own return page, which Google also checks against the client.
    let redirect: URL;
    try {
      redirect = new URL(b.redirect_uri as string);
    } catch {
      return null;
    }
    if (redirect.origin !== origin || !redirect.pathname.endsWith('/google-return')) return null;
    return { grant: 'code', code: b.code as string, code_verifier: b.code_verifier as string, redirect_uri: b.redirect_uri as string };
  }
  if (b.grant === 'refresh' && text(b.refresh_token)) return { grant: 'refresh', refresh_token: b.refresh_token as string };
  return null;
}

export async function googleToken(req: Request, { clientId, clientSecret, origins, fetchImpl = fetch }: GoogleTokenOptions): Promise<Response> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = origins.includes(origin);
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (allowed) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
  const answer = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: { ...headers, 'Access-Control-Max-Age': '86400' } });
  if (req.method !== 'POST') return answer(405, { error: 'method_not_allowed' });
  if (!allowed) return answer(403, { error: 'origin_not_allowed', error_description: 'This page may not use this sign-in.' });
  const call = parse(await req.json().catch(() => null), origin);
  if (!call) return answer(400, { error: 'invalid_request', error_description: "That request doesn't look right." });

  const form: Record<string, string> =
    call.grant === 'code'
      ? { grant_type: 'authorization_code', code: call.code, code_verifier: call.code_verifier, redirect_uri: call.redirect_uri, client_id: clientId, client_secret: clientSecret }
      : { grant_type: 'refresh_token', refresh_token: call.refresh_token, client_id: clientId, client_secret: clientSecret };
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
  } catch {
    return answer(502, { error: 'unavailable', error_description: "Couldn't reach Google. Try again." });
  }
  const google = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return answer(res.status, Object.fromEntries(PASSED_ON.filter((k) => k in google).map((k) => [k, google[k]])));
}
