import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { guessAisle } from '../../shared/aisles.ts';
import { listSections, listTemplate, tripTitle } from '../../shared/templates.ts';
import { activity, groups, listItems, tasks, type Group, type ListItem } from '../db/schema.ts';
import { DomainError, logActivity, visibleGroups, type Actor } from './household.ts';
import { createTasks, moveTasks } from './tasks.ts';

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
  store?: string | null;
  /** A meal's ingredients. */
  parts?: string[] | null;
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
    ...(item.store !== undefined && { store: item.store?.trim() || null }),
    ...(item.parts !== undefined && { parts: cleanParts(item.parts) }),
  };
}

function cleanParts(parts: string[] | null) {
  const clean = [...new Set((parts ?? []).map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 50);
  return clean.length ? clean : null;
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
        // Nobody said where it goes: a guess from its name. (One that was here before keeps its own.)
        if (item.section === undefined) details.section = guessAisle(name, listSections(group));
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

/**
 * Sets a list's sections, in order. A renamed one takes its items with it; items in one that was
 * removed go to no section.
 */
export function setListSections(db: Db, actor: Actor, group: Group, sections: string[], renames: { from: string; to: string }[] = []) {
  const clean = [...new Map(sections.map((s) => s.trim()).filter(Boolean).map((s) => [s.toLowerCase(), s])).values()];
  if (clean.length > 40) throw new DomainError('A list can have at most 40 sections.');
  return db.transaction(() => {
    for (const { from, to } of renames) {
      if (!to.trim() || from === to) continue;
      db.update(listItems)
        .set({ section: to.trim() })
        .where(and(eq(listItems.groupId, group.id), sql`lower(${listItems.section}) = ${from.toLowerCase()}`))
        .run();
    }
    const kept = new Set(clean.map((s) => s.toLowerCase()));
    const items = db.select({ id: listItems.id, section: listItems.section }).from(listItems).where(eq(listItems.groupId, group.id)).all();
    const orphans = items.filter((i) => i.section && !kept.has(i.section.toLowerCase())).map((i) => i.id);
    if (orphans.length) db.update(listItems).set({ section: null }).where(inArray(listItems.id, orphans)).run();
    const updated = db.update(groups).set({ sections: clean }).where(eq(groups.id, group.id)).returning().get();
    logActivity(db, actor, 'list.sections_changed', null, { groupId: group.id, list: group.name });
    return updated;
  });
}

/** The open task that's a trip for this list, if there is one: the soonest planned. */
export function openTrip(db: Db, group: Group) {
  return (
    db
      .select({ id: tasks.id, title: tasks.title, plannedDate: tasks.plannedDate })
      .from(tasks)
      .where(and(eq(tasks.listId, group.id), eq(tasks.status, 'open')))
      .orderBy(sql`${tasks.plannedDate} IS NULL`, asc(tasks.plannedDate))
      .get() ?? null
  );
}

/**
 * Plans a list's trip, like a grocery run, as one task on a day (or in the backlog). A trip
 * that's already planned moves instead of a second one being made.
 */
export function planTrip(db: Db, actor: Actor, group: Group, plannedDate: string | null) {
  const title = tripTitle(group);
  if (!title) throw new DomainError(`${group.name} isn't a list that plans as a trip.`);
  const open = openTrip(db, group);
  if (open) return { task: moveTasks(db, actor, [open.id], plannedDate)[0]!, created: false };
  // Errands is where trips go, when the household has a group by that name.
  const errands = visibleGroups(db, actor.member.id).find((g) => g.kind === 'tasks' && g.name.toLowerCase() === 'errands');
  const [task] = createTasks(db, actor, [
    { title, listId: group.id, groupId: errands?.id ?? null, plannedDate, estimateMinutes: listTemplate(group.template).trip!.minutes },
  ]);
  return { task: task!, created: true };
}
