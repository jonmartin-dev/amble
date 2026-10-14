import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);

export const members = sqliteTable('members', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  color: text('color').notNull().default('green'),
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  timezone: text('timezone').notNull(),
  dayCutoffHour: integer('day_cutoff_hour').notNull().default(4),
  // Appearance preferences (mode, seed color, scheme style, contrast); follows the member across devices.
  theme: text('theme', { mode: 'json' }).$type<Record<string, unknown>>(),
  // Minutes of task time per ISO weekday ("1" is Monday); missing days use the default.
  capacity: text('capacity', { mode: 'json' }).$type<Partial<Record<string, number>>>(),
  showStreaks: integer('show_streaks', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('sessions_member_idx').on(t.memberId)],
);

export const groups = sqliteTable('groups', {
  id: id(),
  name: text('name').notNull(),
  icon: text('icon').notNull().default('folder'),
  color: text('color').notNull().default('green'),
  kind: text('kind', { enum: ['tasks', 'list'] }).notNull().default('tasks'),
  template: text('template'),
  privateTo: text('private_to').references(() => members.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull().default(0),
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
  createdAt: createdAt(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: id(),
    title: text('title').notNull(),
    notes: text('notes'),
    groupId: text('group_id').references(() => groups.id, { onDelete: 'set null' }),
    assigneeId: text('assignee_id').references(() => members.id, { onDelete: 'set null' }),
    createdById: text('created_by_id').references(() => members.id, { onDelete: 'set null' }),
    // Calendar dates are stored as YYYY-MM-DD in the household timezone.
    dueDate: text('due_date'),
    plannedDate: text('planned_date'),
    timeOfDay: text('time_of_day', { enum: ['morning', 'afternoon', 'evening'] }),
    mustDo: integer('must_do', { mode: 'boolean' }).notNull().default(false),
    estimateMinutes: integer('estimate_minutes'),
    estimateSource: text('estimate_source', { enum: ['ai', 'user', 'learned'] }),
    status: text('status', { enum: ['open', 'done', 'archived'] }).notNull().default('open'),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    completedById: text('completed_by_id').references(() => members.id, { onDelete: 'set null' }),
    handedBackNote: text('handed_back_note'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('tasks_status_planned_idx').on(t.status, t.plannedDate),
    index('tasks_group_idx').on(t.groupId),
    index('tasks_assignee_idx').on(t.assigneeId),
  ],
);

export const subtasks = sqliteTable('subtasks', {
  id: id(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const taskLinks = sqliteTable('task_links', {
  id: id(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  title: text('title'),
  createdAt: createdAt(),
});

export const activity = sqliteTable(
  'activity',
  {
    id: id(),
    memberId: text('member_id').references(() => members.id, { onDelete: 'set null' }),
    via: text('via', { enum: ['app', 'claude', 'system'] }).notNull().default('app'),
    action: text('action').notNull(),
    taskId: text('task_id'),
    detail: text('detail', { mode: 'json' }),
    createdAt: createdAt(),
  },
  (t) => [index('activity_created_idx').on(t.createdAt)],
);

// Items on a `list` group (groceries, packing). Checked items stay as history for re-adding.
export const listItems = sqliteTable(
  'list_items',
  {
    id: id(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    quantity: text('quantity'),
    note: text('note'),
    addedById: text('added_by_id').references(() => members.id, { onDelete: 'set null' }),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
    checkedById: text('checked_by_id').references(() => members.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('list_items_group_idx').on(t.groupId, t.checkedAt)],
);

// Apps allowed to act for a member through the remote Claude connector (OAuth 2.1).
// `metadata` clients are identified by a Client ID Metadata Document URL, which is how Claude
// connects; `registered` ones came through dynamic client registration.
export const oauthClients = sqliteTable('oauth_clients', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['metadata', 'registered'] }).notNull(),
  name: text('name'),
  redirectUris: text('redirect_uris', { mode: 'json' }).$type<string[]>().notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }),
  createdAt: createdAt(),
});

// One approved connection: a member let a client act for them. Deleting it revokes every token.
export const oauthGrants = sqliteTable(
  'oauth_grants',
  {
    id: id(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    clientName: text('client_name').notNull(),
    scope: text('scope').notNull(),
    resource: text('resource').notNull(),
    createdAt: createdAt(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('oauth_grants_member_idx').on(t.memberId)],
);

export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    id: id(),
    grantId: text('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['access', 'refresh'] }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    // Set when a refresh token has been exchanged for a newer one.
    rotatedAt: integer('rotated_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => [index('oauth_tokens_grant_idx').on(t.grantId)],
);

export type Member = typeof members.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type ListItem = typeof listItems.$inferSelect;

export type OAuthClient = typeof oauthClients.$inferSelect;
