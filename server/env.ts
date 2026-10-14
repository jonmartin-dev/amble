import type { Member } from './db/schema.ts';

/** Hono context shared by every route: the signed-in member, if any. */
export type Env = { Variables: { member: Member | null } };
