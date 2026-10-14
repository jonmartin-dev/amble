// Saves the smart add proposals someone accepted, all at once, as their own changes.
import type { Proposal } from '../../shared/proposals.ts';
import type { Db } from '../db/index.ts';
import { DomainError, resolveGroup, resolveMember, type Actor } from '../domain/household.ts';
import { addListItems, checkListItems } from '../domain/lists.ts';
import { assignTask, completeTasks, createTasks, getTask, updateTask } from '../domain/tasks.ts';

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
        })),
      );
      result.added = created.length;
      result.taskIds = created.map((t) => t.id);
    }
    for (const p of proposals) {
      if (p.kind === 'update') {
        const { assigneeId, ...changes } = p.changes;
        updateTask(db, actor, p.taskId, { ...changes, groupId: group(changes.groupId) });
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
        addListItems(db, actor, list, [{ name: p.name, quantity: p.quantity, section: p.section, note: p.note }]);
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
