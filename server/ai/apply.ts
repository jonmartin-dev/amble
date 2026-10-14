// Saves the smart add proposals someone accepted, all at once, as their own changes.
import type { Proposal } from '../../shared/proposals.ts';
import type { Db } from '../db/index.ts';
import { DomainError, resolveGroup, resolveMember, type Actor } from '../domain/household.ts';
import { addListItems, checkListItems } from '../domain/lists.ts';
import { archiveTasks, assignTask, completeTasks, createTasks, getTask, updateTask } from '../domain/tasks.ts';
import type { OrganizeSuggestion } from './plan.ts';

export interface Applied {
  added: number;
  updated: number;
  completed: number;
  listed: number;
  checked: number;
  /** New task ids, for Undo. */
  taskIds: string[];
}

export function applyProposals(db: Db, actor: Actor, proposals: Proposal[]): Applied {
  const me = actor.member;
  const group = (id: string | null | undefined) => (id == null ? id : resolveGroup(db, me, id, 'tasks').id);
  const person = (id: string | null | undefined) => (id == null ? id : (resolveMember(db, me, id)?.id ?? null));
  const result: Applied = { added: 0, updated: 0, completed: 0, listed: 0, checked: 0, taskIds: [] };
  db.transaction(() => {
    const newTasks = proposals.flatMap((p) => (p.kind === 'task' ? [p.task] : []));
    if (newTasks.length) {
      const created = createTasks(
        db,
        actor,
        newTasks.map((t) => ({
          ...t,
          groupId: group(t.groupId),
          assigneeId: person(t.assigneeId) ?? null,
          links: t.links.map((url) => ({ url })),
          remindAt: t.remindAt ? new Date(t.remindAt) : null,
        })),
      );
      result.added = created.length;
      result.taskIds = created.map((t) => t.id);
    }
    for (const p of proposals) {
      if (p.kind === 'update') {
        const { assigneeId, remindAt, ...changes } = p.changes;
        updateTask(db, actor, p.taskId, {
          ...changes,
          groupId: group(changes.groupId),
          remindAt: remindAt === undefined ? undefined : remindAt ? new Date(remindAt) : null,
        });
        // Handing it over goes through the same path as the app's Assign, so it's logged as one.
        if (assigneeId !== undefined && getTask(db, me, p.taskId).assigneeId !== (person(assigneeId) ?? null)) {
          assignTask(db, actor, p.taskId, person(assigneeId) ?? null);
        }
        result.updated++;
      } else if (p.kind === 'complete') {
        completeTasks(db, actor, [p.taskId]);
        result.completed++;
      } else if (p.kind === 'list_item') {
        const list = resolveGroup(db, me, p.listId, 'list');
        // No section picked: where it went before, or a guess from its name.
        addListItems(db, actor, list, [{ name: p.name, quantity: p.quantity, section: p.section ?? undefined, note: p.note, store: p.store }]);
        result.listed++;
      } else if (p.kind === 'check') {
        const list = resolveGroup(db, me, p.listId, 'list');
        checkListItems(db, actor, list, [p.itemId]);
        result.checked++;
      }
    }
    if (!proposals.length) throw new DomainError('Nothing to add.');
  });
  return result;
}

/**
 * Applies one accepted backlog tidy-up. Merging keeps the first task under the new title, with the
 * others' notes and open steps folded in, the earliest deadline and must-do if any had it, and
 * archives the rest. Splitting makes the new tasks with the original's group, person and dates,
 * and archives the original. Archived tasks can be restored, so nothing is lost.
 */
export function applyOrganize(db: Db, actor: Actor, s: OrganizeSuggestion): { taskIds: string[]; archived: string[] } {
  const me = actor.member;
  return db.transaction(() => {
    if (s.kind === 'regroup') {
      updateTask(db, actor, s.taskId, { groupId: resolveGroup(db, me, s.groupId, 'tasks').id });
      return { taskIds: [s.taskId], archived: [] };
    }
    if (s.kind === 'merge') {
      const [keep, ...rest] = s.taskIds.map((id) => getTask(db, me, id));
      if (!keep || rest.length === 0) throw new DomainError('Merging needs two or more tasks.');
      const all = [keep, ...rest];
      const dues = all.map((t) => t.dueDate).filter((d): d is string => !!d).sort();
      const notes = [...new Set(all.map((t) => t.notes?.trim()).filter((n): n is string => !!n))];
      const steps = rest.flatMap((t) => t.subtasks.filter((st) => !st.done).map((st) => st.title));
      updateTask(db, actor, keep.id, {
        title: s.title.trim() || keep.title,
        ...(dues[0] && dues[0] !== keep.dueDate && { dueDate: dues[0] }),
        ...(all.some((t) => t.mustDo) && !keep.mustDo && { mustDo: true }),
        ...(notes.length > 1 && { notes: notes.join('\n\n') }),
        ...(notes.length === 1 && !keep.notes && { notes: notes[0] }),
        ...(steps.length && { addSubtasks: steps }),
      });
      archiveTasks(db, actor, rest.map((t) => t.id));
      return { taskIds: [keep.id], archived: rest.map((t) => t.id) };
    }
    const original = getTask(db, me, s.taskId);
    const created = createTasks(
      db,
      actor,
      s.into.map((title) => ({
        title,
        groupId: original.groupId,
        assigneeId: original.assigneeId,
        dueDate: original.dueDate,
        plannedDate: original.plannedDate,
        timeOfDay: original.timeOfDay,
        mustDo: original.mustDo,
      })),
    );
    archiveTasks(db, actor, [original.id]);
    return { taskIds: created.map((t) => t.id), archived: [original.id] };
  });
}
