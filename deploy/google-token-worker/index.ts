// The Google token endpoint (server/google-token.ts) as a Cloudflare Worker, for a web app running
// Amble with no server. Deploy it with Wrangler from this folder; wrangler.toml says what to set.
import { googleToken } from '../../server/google-token.ts';

interface Env {
  GOOGLE_CLIENT_ID: string;
  /** Set with `wrangler secret put GOOGLE_CLIENT_SECRET`, never in wrangler.toml. */
  GOOGLE_CLIENT_SECRET: string;
  /** The web app's origins, comma-separated: https://amble.example.com */
  ALLOWED_ORIGINS: string;
}

export default {
  fetch(req: Request, env: Env) {
    if (new URL(req.url).pathname !== '/google/token') return new Response('Not found', { status: 404 });
    const origins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
    return googleToken(req, { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, origins });
  },
};
