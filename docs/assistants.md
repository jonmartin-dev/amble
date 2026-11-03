# Claude and ChatGPT

Amble's server includes a connector (MCP) that Claude and ChatGPT can both use. They can add, plan, complete and hand off tasks, keep shopping lists, check how full each day is, suggest what to do today, draft a week's plan and set reminders you ask for, acting as whoever connected them. Activity shows which assistant made each change.

The connector needs your household's own server ([self-hosting.md](self-hosting.md)), reachable from the internet over HTTPS so the assistant can get to it. With a Tailscale address, `deploy/setup.sh --assistants yes` does that with Tailscale Funnel; your own domain behind a proxy already is. The Android app on its own has no address an assistant could reach.

## Connect

Both connect to the same address, `<AMBLE_PUBLIC_URL>/mcp`. The server's own page (`<AMBLE_PUBLIC_URL>/server`) shows it, and so does Connect an assistant in Amble's Settings, on a device that syncs with the server.

**Claude (claude.ai, the desktop and phone apps, Claude Code).** In Claude, go to Settings, Connectors, Add custom connector, paste the address, then Connect. Amble's sign-in page opens: type a code for you, made in Amble's Settings, Your server, Add a phone or computer (or sign in with the server's provider, if it has one). Then Allow.

**ChatGPT (on the web, in Developer mode).** In ChatGPT, turn on Developer mode under Settings, Apps, Advanced settings. Then choose Create in Apps, paste the address, pick OAuth, and Allow on the Amble page that opens. Developer mode is a beta: as of October 2026 ChatGPT can use every tool on Business, Enterprise and Edu plans, and only the read-only ones on Pro. ChatGPT identifies itself with its client metadata document (`https://chatgpt.com/oauth/client.json`) and comes back to `https://chatgpt.com/connector_platform_oauth_redirect`; dynamic registration works too, if it's picked in the app's OAuth settings. Nobody has connected a real ChatGPT account yet, so if you do, [say how it went](../CONTRIBUTING.md#help-wanted).

## How sign-in works

Amble is its own OAuth 2.1 server: the assistant identifies itself, you sign in on the server with a code from your phone (or the server's sign-in provider), and you can disconnect it in Settings, Your server (or on the server's page). It needs a public HTTPS URL the assistant can reach, and if Amble runs under a path prefix your proxy must also send `/.well-known/oauth-protected-resource<prefix>` and `/.well-known/oauth-authorization-server<prefix>` to it. Only apps on `AMBLE_OAUTH_CLIENT_HOSTS` (default `claude.ai,claude.com,chatgpt.com`) and local loopback apps can connect. If your `.env` sets that list from an older `.env.example`, add `chatgpt.com` to it.

## On the same machine as the server

ChatGPT only connects to remote servers, but Claude can also run Amble locally. `server/mcp-stdio.ts` talks to Claude over stdio and opens the server's database file directly, with no sign-in and nothing exposed to the network. It acts as the person named by `AMBLE_MEMBER`, their email or, for someone who got in with a code, their name as People shows it. They must have got in once:

```sh
claude mcp add amble --scope user -e AMBLE_MEMBER=you@example.com -- node /path/to/amble/server/mcp-stdio.ts
```

For the Claude desktop app, add the same command under `mcpServers` in its config (Settings, Developer, Edit Config) and restart it. Set `AMBLE_DATA_DIR` if the database isn't in the repository's `data/` folder.

## The Amble skill

`skill/amble/` teaches Claude how to use the connector the calm way: what goes in the backlog versus on a day, keeping days light, lists versus tasks, and short replies. Zip that folder and upload it in Claude under Customize, Skills, or copy it into a local skills folder with `node scripts/sync-skill.ts <skills-dir>`. To tell Claude about your own household (who's who, your time zone, what you'd rather not hear about), write it under a `## Household notes` heading in `skill/household.md`. Git ignores that file, and `sync-skill.ts` adds it to the end of the skill it copies.

A reminder set through Claude reaches the Android app through its background check of the household, about every 15 minutes. The server itself sends no notifications.
