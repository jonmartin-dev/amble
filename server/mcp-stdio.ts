// Local Claude connector. Claude Code or the Claude desktop app starts this over stdio on the
// machine that holds the database, so there's no sign-in: it acts as the member named by
// AMBLE_MEMBER (an email). Stdout carries the protocol, so log only to stderr.
//
//   claude mcp add amble --scope user -e AMBLE_MEMBER=you@example.com -- node <repo>/server/mcp-stdio.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { eq } from 'drizzle-orm';
import { openDatabase } from './db/index.ts';
import { members } from './db/schema.ts';
import { seedStarterGroups } from './db/seed.ts';
import { createMcpServer } from './mcp/server.ts';

// The client starts us from its own working directory, so default to the repo's data folder.
const dataDir = process.env.AMBLE_DATA_DIR
  ? path.resolve(process.env.AMBLE_DATA_DIR)
  : fileURLToPath(new URL('../data', import.meta.url));
const db = openDatabase(path.join(dataDir, 'almanac.db'));
seedStarterGroups(db);

const email = process.env.AMBLE_MEMBER?.trim().toLowerCase();
const all = db.select().from(members).all();
const member = email ? all.find((m) => m.email === email) : all.length === 1 ? all[0] : undefined;
if (!member) {
  console.error(
    email
      ? `Amble: no member with the email ${email}. Sign in to Amble once with that account first.`
      : 'Amble: set AMBLE_MEMBER to the email of the member Claude should act for.',
  );
  process.exit(1);
}

// Look the member up again per connection so name or timezone changes apply.
serveStdio(() => createMcpServer({ db, member: db.select().from(members).where(eq(members.id, member.id)).get() ?? member }), {
  onerror: (err) => console.error('Amble MCP:', err.message),
});
console.error(`Amble connector ready for ${member.email} (${path.join(dataDir, 'almanac.db')})`);
