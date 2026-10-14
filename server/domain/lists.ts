import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { activity, listItems, type Group, type ListItem } from '../db/schema.ts';
import { DomainError, logActivity, type Actor } from './household.ts';

const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

export function getListItems(db: Db, group: Group, includeChecked = false) {
  const open = db
    .select()
    .from(listItems)
    .where(and(eq(listItems.groupId, group.id), isNull(listItems.checkedAt)))
    .orderBy(asc(listItems.sortOrder), asc(listItems.createdAt))
    .all();
  const checked = includeChecked
    ? db
        .select()
        .from(listItems)
        .where(
          and(
            eq(listItems.groupId, group.id),
            isNotNull(listItems.checkedAt),
            gte(listItems.checkedAt, new Date(Date.now() - RECENT_MS)),
          ),
        )
        .orderBy(desc(listItems.checkedAt))
        .all()
    : [];
  return { open, checked };
}

export interface NewListItem {
  /** Chosen by the app, so an item added offline keeps one id once it syncs. */
  id?: string;
  name: string;
  quantity?: string | null;
  note?: string | null;
  section?: string | null;
  url?: string | null;
  price?: string | null;
}

function cleanUrl(url: string | null | undefined) {
  if (url == null || !url.trim()) return null;
  if (!URL.canParse(url.trim()) || !/^https?:$/.test(new URL(url.trim()).protocol)) throw new DomainError(`"${url}" isn't a web link.`);
  return new URL(url.trim()).toString();
}

function itemDetails(item: Omit<NewListItem, 'name'>) {
  return {
    ...(item.quantity !== undefined && { quantity: item.quantity?.trim() || null }),
    ...(item.note !== undefined && { note: item.note?.trim() || null }),
    ...(item.section !== undefined && { section: item.section?.trim() || null }),
    ...(item.url !== undefined && { url: cleanUrl(item.url) }),
    ...(item.price !== undefined && { price: item.price?.trim() || null }),
  };
}

export type AddOutcome = 'added' | 'already on the list' | 'back on the list' | 'changed since';

/**
 * Items on a list someone changed after a late change was made (the app was offline), by name.
 * The later change wins, so the late one leaves those items alone.
 */
function listChangesSince(db: Db, actor: Actor, group: Group) {
  const names = new Set<string>();
  let reset = false;
  if (actor.at) {
    const rows = db
      .select({ action: activity.action, detail: activity.detail })
      .from(activity)
      .where(and(like(activity.action, 'list.%'), gt(activity.createdAt, actor.at)))
      .all();
    for (const { action, detail } of rows) {
      const d = detail as { groupId?: string; item?: string; items?: string[] } | null;
      if (d?.groupId !== group.id) continue;
      if (action === 'list.reset') reset = true;
      for (const name of [d.item, ...(d.items ?? [])]) if (name) names.add(name.toLowerCase());
    }
  }
  return { reset, has: (name: string) => names.has(name.toLowerCase()) };
}

/**
 * Adds items to a list. An item already on it is updated instead of duplicated, and one that
 * was checked off before comes back, so the list doubles as purchase history.
 */
export function addListItems(db: Db, actor: Actor, group: Group, items: NewListItem[]) {
  if (group.kind !== 'list') throw new DomainError(`${group.name} is a task group, not a list.`);
  const later = listChangesSince(db, actor, group);
  return db.transaction(() =>
    items.map((item) => {
      const name = item.name.trim();
      if (!name) throw new DomainError('List items need a name.');
      const existing = db
        .select()
        .from(listItems)
        .where(and(eq(listItems.groupId, group.id), sql`lower(${listItems.name}) = ${name.toLowerCase()}`))
        .orderBy(sql`${listItems.checkedAt} IS NOT NULL`, desc(listItems.createdAt))
        .get();
      const details = itemDetails(item);
      let row: ListItem;
      let outcome: AddOutcome;
      if (existing && later.has(name)) return { item: existing, outcome: 'changed since' as const };
      if (existing) {
        outcome = existing.checkedAt ? 'back on the list' : 'already on the list';
        row = db
          .update(listItems)
          .set({ ...details, checkedAt: null, checkedById: null, addedById: actor.member.id })
          .where(eq(listItems.id, existing.id))
          .returning()
          .get();
      } else {
        outcome = 'added';
        const [last] = db
          .select({ max: sql<number>`coalesce(max(${listItems.sortOrder}), -1)` })
          .from(listItems)
          .where(eq(listItems.groupId, group.id))
          .all();
        row = db
          .insert(listItems)
          .values({
            ...(item.id && { id: item.id }),
            groupId: group.id,
            name,
            addedById: actor.member.id,
            sortOrder: (last?.max ?? -1) + 1,
            ...details,
            ...(actor.at && { createdAt: actor.at }),
          })
          .returning()
          .get();
      }
      logActivity(db, actor, 'list.item_added', null, { groupId: group.id, list: group.name, item: name, outcome });
      return { item: row, outcome };
    }),
  );
}

/** Finds items by id, unique id prefix or name (case-insensitive) on one list. A late change skips ones that are gone. */
function resolveItems(db: Db, group: Group, refs: string[], lenient = false) {
  const all = db.select().from(listItems).where(eq(listItems.groupId, group.id)).all();
  return refs.flatMap((ref) => {
    const q = ref.trim().toLowerCase();
    const byId = all.filter((i) => i.id === ref || (q.length >= 6 && i.id.startsWith(q)));
    if (byId.length === 1) return byId[0]!;
    const byName = all.filter((i) => i.name.toLowerCase() === q);
    // Prefer the one still on the list when a name matches history too.
    const hit = byName.find((i) => !i.checkedAt) ?? byName[0];
    if (!hit && lenient) return [];
    if (!hit) throw new DomainError(`${group.name} has no item "${ref}".`);
    return [hit];
  });
}

/** Checks items off (bought, packed), or puts them back with `checked: false`. */
export function checkListItems(db: Db, actor: Actor, group: Group, refs: string[], checked = true) {
  const later = listChangesSince(db, actor, group);
  const items = resolveItems(db, group, refs, actor.at != null).filter((i) => !later.reset && !later.has(i.name));
  if (items.length === 0) return [];
  db.transaction(() => {
    db.update(listItems)
      .set(checked ? { checkedAt: actor.at ?? new Date(), checkedById: actor.member.id } : { checkedAt: null, checkedById: null })
      .where(
        inArray(
          listItems.id,
          items.map((i) => i.id),
        ),
      )
      .run();
    logActivity(db, actor, checked ? 'list.items_checked' : 'list.items_unchecked', null, {
      groupId: group.id,
      list: group.name,
      items: items.map((i) => i.name),
    });
  });
  return items.map((i) => i.name);
}

/** Everything ever on a list, most recent first, one row per name: for autocomplete when adding. */
export function listHistory(db: Db, group: Group, limit = 300) {
  return db
    .select({ name: listItems.name, quantity: listItems.quantity, section: listItems.section, checkedAt: listItems.checkedAt })
    .from(listItems)
    .where(eq(listItems.groupId, group.id))
    .orderBy(desc(sql`coalesce(${listItems.checkedAt}, ${listItems.createdAt})`))
    .limit(limit)
    .all()
    .map(({ name, quantity, section, checkedAt }) => ({ name, quantity, section, onList: checkedAt == null }));
}

export function updateListItem(db: Db, actor: Actor, group: Group, ref: string, patch: Partial<NewListItem>) {
  const [item] = resolveItems(db, group, [ref]);
  if (listChangesSince(db, actor, group).has(item!.name)) return item!;
  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) throw new DomainError('List items need a name.');
  const row = db
    .update(listItems)
    .set({ ...(name && { name }), ...itemDetails(patch) })
    .where(eq(listItems.id, item!.id))
    .returning()
    .get();
  logActivity(db, actor, 'list.item_updated', null, { groupId: group.id, list: group.name, item: row.name });
  return row;
}

/** Puts everything back on a reusable list (packing for the next trip). */
export function resetList(db: Db, actor: Actor, group: Group) {
  // A late reset only brings back what was checked off before it was made.
  const reset = db
    .update(listItems)
    .set({ checkedAt: null, checkedById: null })
    .where(and(eq(listItems.groupId, group.id), isNotNull(listItems.checkedAt), actor.at && lte(listItems.checkedAt, actor.at)))
    .returning({ name: listItems.name })
    .all();
  if (reset.length) logActivity(db, actor, 'list.reset', null, { groupId: group.id, list: group.name, count: reset.length });
  return reset.length;
}
