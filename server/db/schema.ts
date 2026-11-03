import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { Repeat } from '../../shared/repeat.ts';

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
  // What they said a usual weekday has for chores and errands, when they started. Capacity starts
  // there (weekends an hour more) instead of the default, and is learned from it.
  startMinutes: integer('start_minutes'),
  // How full they like their days: where a day reads as Full, and how far "plan my week" fills one.
  dayFill: text('day_fill', { enum: ['roomy', 'balanced', 'packed'] }).notNull().default('balanced'),
  showStreaks: integer('show_streaks', { mode: 'boolean' }).notNull().default(true),
  // Quick add sends what's typed to the AI model for review, when one is set up.
  smartAdd: integer('smart_add', { mode: 'boolean' }).notNull().default(true),
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

// Codes that let a phone, a computer or a browser into a server without a sign-in provider: shown on
// a device that's already in, or by the setup script for the first admin. A code for someone signs
// in as them; an invite brings in someone new (or anyone the household already has, on a household
// moving from Google Drive). Kept as hashes, like sessions.
export const pairCodes = sqliteTable('pair_codes', {
  id: id(),
  codeHash: text('code_hash').notNull().unique(),
  kind: text('kind', { enum: ['person', 'invite'] }).notNull(),
  // For a person code, who it signs in as; for an invite, who made it (none from the setup script).
  memberId: text('member_id').references(() => members.id, { onDelete: 'cascade' }),
  // What an invite makes someone new.
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  // How many more times it works; null for as often as it's used until it runs out.
  usesLeft: integer('uses_left'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: createdAt(),
});

export const groups = sqliteTable('groups', {
  id: id(),
  name: text('name').notNull(),
  icon: text('icon').notNull().default('folder'),
  color: text('color').notNull().default('green'),
  kind: text('kind', { enum: ['tasks', 'list'] }).notNull().default('tasks'),
  template: text('template'),
  // A list's own sections, in order, when someone changed its template's.
  sections: text('sections', { mode: 'json' }).$type<string[]>(),
  privateTo: text('private_to').references(() => members.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull().default(0),
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
  createdAt: createdAt(),
});

// A repeating task's rule. Only one open task per series exists at a time; finishing it makes the next.
export const series = sqliteTable('series', {
  id: id(),
  rule: text('rule', { mode: 'json' }).$type<Repeat>().notNull(),
  // The first date, which intervals ("every 2 weeks") count from.
  anchor: text('anchor').notNull(),
  pausedUntil: text('paused_until'),
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
    // The model's guess, kept after someone changes the estimate, so Stats can say how good the guesses are.
    aiEstimateMinutes: integer('ai_estimate_minutes'),
    status: text('status', { enum: ['open', 'done', 'archived'] }).notNull().default('open'),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    completedById: text('completed_by_id').references(() => members.id, { onDelete: 'set null' }),
    handedBackNote: text('handed_back_note'),
    seriesId: text('series_id').references(() => series.id, { onDelete: 'set null' }),
    // A trip for a list, like a grocery run: the task opens the list and counts what's left on it.
    listId: text('list_id').references(() => groups.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('tasks_status_planned_idx').on(t.status, t.plannedDate),
    index('tasks_group_idx').on(t.groupId),
    index('tasks_assignee_idx').on(t.assigneeId),
    index('tasks_series_idx').on(t.seriesId),
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
    // Where the change came from: the app, an assistant through the connector (one Amble can
    // name, or `assistant`), or Amble itself.
    via: text('via', { enum: ['app', 'claude', 'chatgpt', 'assistant', 'system'] }).notNull().default('app'),
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
    // Where it goes on lists with sections: an aisle for groceries, a category for packing.
    section: text('section'),
    url: text('url'),
    price: text('price'),
    // Where to buy it, on lists with stores.
    store: text('store'),
    // A meal's ingredients, on a meal plan.
    parts: text('parts', { mode: 'json' }).$type<string[]>(),
    addedById: text('added_by_id').references(() => members.id, { onDelete: 'set null' }),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
    checkedById: text('checked_by_id').references(() => members.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('list_items_group_idx').on(t.groupId, t.checkedAt)],
);

// Every AI call, for the monthly cap and the usage readout in Settings.
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: id(),
    memberId: text('member_id').references(() => members.id, { onDelete: 'set null' }),
    feature: text('feature').notNull(),
    model: text('model').notNull(),
    effort: text('effort'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    // Millionths of a dollar.
    costMicros: integer('cost_micros').notNull().default(0),
    durationMs: integer('duration_ms'),
    ok: integer('ok', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('ai_usage_created_idx').on(t.createdAt)],
);

// Writes the app queued while offline carry a key, so a retry after a lost response isn't applied
// twice: the first answer is kept and sent again.
export const appliedRequests = sqliteTable(
  'applied_requests',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    // Null while the first attempt is still running.
    status: integer('status'),
    body: text('body'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.key] }), index('applied_requests_created_idx').on(t.createdAt)],
);

// A calendar on this phone (Android's calendars: Google accounts, Samsung's, Outlook and the rest).
// Only the ones that count are read; their events show in Amble and take up room in the day.
export const calendars = sqliteTable(
  'calendars',
  {
    id: id(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    // The phone's own id for it.
    calendarId: text('calendar_id').notNull(),
    // The account it belongs to, to group them by.
    account: text('account'),
    name: text('name').notNull(),
    color: text('color'),
    primary: integer('primary', { mode: 'boolean' }).notNull().default(false),
    counts: integer('counts', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('calendars_member_calendar_idx').on(t.memberId, t.calendarId)],
);

// Events copied from the calendars that count. Timed events keep their exact times; all-day ones
// keep their dates too (the end date is the day after the last).
export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    id: id(),
    calendarId: text('calendar_id')
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    // The same meeting on two calendars shares this, so it shows and counts once.
    uid: text('uid'),
    title: text('title'),
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
    startAt: integer('start_at', { mode: 'timestamp_ms' }).notNull(),
    endAt: integer('end_at', { mode: 'timestamp_ms' }).notNull(),
    startDate: text('start_date'),
    endDate: text('end_date'),
    // Shown as busy, and not declined.
    busy: integer('busy', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [uniqueIndex('calendar_events_calendar_event_idx').on(t.calendarId, t.eventId), index('calendar_events_member_start_idx').on(t.memberId, t.startAt)],
);

// How much of each day someone's calendar takes up, worked out on the phone that reads it and
// synced to the household: how full their days are, with no titles or times.
export const busyDays = sqliteTable(
  'busy_days',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    // Busy minutes between 7am and 10pm, overlaps counted once, and how many busy events.
    minutes: integer('minutes').notNull(),
    events: integer('events').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.date] })],
);

// Settings Amble makes for itself on first start, like its web push keys.
export const serverSettings = sqliteTable('server_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  createdAt: createdAt(),
});

// What a household sets once for everyone, synced with it: its AI model ('ai'), which an admin sets
// on a household that syncs through Google Drive. A server keeps its own model, sealed, instead.
export const householdSettings = sqliteTable('household_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  createdAt: createdAt(),
});

// What each device spent with the household's model in a month ("2026-11"), so every copy counts the
// household's month against one cap. Each device writes only its own row, so no two ever clash.
export const householdAiSpend = sqliteTable(
  'household_ai_spend',
  {
    site: text('site').notNull(),
    month: text('month').notNull(),
    // Millionths of a dollar.
    micros: integer('micros').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.site, t.month] })],
);

// A device where someone turned on notifications. Their reminders go to every one of them.
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: id(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    // "Chrome on Android", to tell devices apart in Settings.
    device: text('device'),
    createdAt: createdAt(),
    lastSentAt: integer('last_sent_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('push_subscriptions_member_idx').on(t.memberId)],
);

// A reminder someone asked for: one notification at the time they chose. One per person per task.
export const reminders = sqliteTable(
  'reminders',
  {
    id: id(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    fireAt: integer('fire_at', { mode: 'timestamp_ms' }).notNull(),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    // How it went once its time came: shown on a device, no device to show it on, or not sent
    // because the task was done or removed by then.
    outcome: text('outcome', { enum: ['sent', 'no-device', 'skipped', 'failed'] }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('reminders_task_member_idx').on(t.taskId, t.memberId), index('reminders_due_idx').on(t.sentAt, t.fireAt)],
);

// A file on a task. The bytes live on the data volume under files/, named by their SHA-256, so the
// same file on two tasks (a repeating task's next one) is stored once.
export const attachments = sqliteTable(
  'attachments',
  {
    id: id(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    addedById: text('added_by_id').references(() => members.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    // A smaller copy of a photo, made by the app when it was added: for the task page and assistants.
    previewSha256: text('preview_sha256'),
    // Removed files can be brought back for a week, then they're deleted for good.
    removedAt: integer('removed_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_task_idx').on(t.taskId), index('attachments_sha_idx').on(t.sha256)],
);

export interface StoredSuggestion {
  taskId: string;
  reason: string;
}

// One per person per planning day: the morning briefing, its suggestions and which were put off.
export const dayRecords = sqliteTable(
  'day_records',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    briefingSeenAt: integer('briefing_seen_at', { mode: 'timestamp_ms' }),
    suggestions: text('suggestions', { mode: 'json' }).$type<StoredSuggestion[]>(),
    // Who wrote the reasons: the built-in wording, or the model.
    reasonsBy: text('reasons_by', { enum: ['template', 'ai'] }),
    // Tasks they said "Later" to today.
    dismissed: text('dismissed', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    // How they said the day was looking, which gives it less room or more. None is a normal day.
    outlook: text('outlook', { enum: ['lighter', 'rough'] }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.date] })],
);

// Apps allowed to act for a member through the remote connector (OAuth 2.1).
// `metadata` clients are identified by a Client ID Metadata Document URL, which is how Claude and
// ChatGPT connect; `registered` ones came through dynamic client registration.
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

// Sync between devices (server/sync/). For every field of a synced row, when it last changed, as a
// hybrid logical clock reading; null until the app stamps the change it came from. Triggers write
// these as rows change, once sync is on.
export const syncCells = sqliteTable(
  'sync_cells',
  {
    tbl: text('tbl').notNull(),
    // The row's primary key as a JSON array.
    pk: text('pk').notNull(),
    col: text('col').notNull(),
    hlc: text('hlc'),
  },
  (t) => [primaryKey({ columns: [t.tbl, t.pk, t.col] }), index('sync_cells_hlc_idx').on(t.hlc)],
);

// Synced rows that were removed, and when, so the removal reaches other devices too.
export const syncTombstones = sqliteTable(
  'sync_tombstones',
  {
    tbl: text('tbl').notNull(),
    pk: text('pk').notNull(),
    hlc: text('hlc'),
  },
  (t) => [primaryKey({ columns: [t.tbl, t.pk] })],
);

// Two rows that turned out to be the same thing (one person invited twice, say): the one that
// went, and the one that stays. References to the first move to the second, wherever they turn up.
export const syncAliases = sqliteTable(
  'sync_aliases',
  {
    tbl: text('tbl').notNull(),
    // Primary keys as JSON arrays, like sync_cells.
    fromPk: text('from_pk').notNull(),
    toPk: text('to_pk').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tbl, t.fromPk] })],
);

// One row: whether triggers record changes right now. Off while another device's changes are merged in.
export const syncCapture = sqliteTable('sync_capture', {
  id: integer('id').primaryKey(),
  on: integer('on', { mode: 'boolean' }).notNull().default(true),
});

export type Member = typeof members.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type ListItem = typeof listItems.$inferSelect;
export type Series = typeof series.$inferSelect;

export type OAuthClient = typeof oauthClients.$inferSelect;
export type PhoneCalendarRow = typeof calendars.$inferSelect;
export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type DayRecord = typeof dayRecords.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
