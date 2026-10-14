import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { listItems, type Group, type ListItem } from '../db/schema.ts';
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
  name: string;
  quantity?: string | null;
  note?: string | null;
}

export type AddOutcome = 'added' | 'already on the list' | 'back on the list';

/**
 * Adds items to a list. An item already on it is updated instead of duplicated, and one that
 * was checked off before comes back, so the list doubles as purchase history.
 */
export function addListItems(db: Db, actor: Actor, group: Group, items: NewListItem[]) {
  if (group.kind !== 'list') throw new DomainError(`${group.name} is a task group, not a list.`);
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
      const details = {
        ...(item.quantity !== undefined && { quantity: item.quantity?.trim() || null }),
        ...(item.note !== undefined && { note: item.note?.trim() || null }),
      };
      let row: ListItem;
      let outcome: AddOutcome;
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
          .values({ groupId: group.id, name, addedById: actor.member.id, sortOrder: (last?.max ?? -1) + 1, ...details })
          .returning()
          .get();
      }
      logActivity(db, actor, 'list.item_added', null, { groupId: group.id, list: group.name, item: name, outcome });
      return { item: row, outcome };
    }),
  );
}

/** Finds items by id, unique id prefix or name (case-insensitive) on one list. */
function resolveItems(db: Db, group: Group, refs: string[]) {
  const all = db.select().from(listItems).where(eq(listItems.groupId, group.id)).all();
  return refs.map((ref) => {
    const q = ref.trim().toLowerCase();
    const byId = all.filter((i) => i.id === ref || (q.length >= 6 && i.id.startsWith(q)));
    if (byId.length === 1) return byId[0]!;
    const byName = all.filter((i) => i.name.toLowerCase() === q);
    // Prefer the one still on the list when a name matches history too.
    const hit = byName.find((i) => !i.checkedAt) ?? byName[0];
    if (!hit) throw new DomainError(`${group.name} has no item "${ref}".`);
    return hit;
  });
}

/** Checks items off (bought, packed), or puts them back with `checked: false`. */
export function checkListItems(db: Db, actor: Actor, group: Group, refs: string[], checked = true) {
  const items = resolveItems(db, group, refs);
  db.transaction(() => {
    db.update(listItems)
      .set(checked ? { checkedAt: new Date(), checkedById: actor.member.id } : { checkedAt: null, checkedById: null })
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
