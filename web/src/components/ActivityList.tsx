import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import type { ActivityEntry, HouseholdMember } from '../lib/api.ts';
import { dayLabel, firstName, timeLabel } from '../lib/dates.ts';
import { Avatar } from './Avatar.tsx';

interface Context {
  meId: string;
  members: HouseholdMember[];
  today: string;
  /** On a task's own page, where "this" reads better than its title. */
  inTask?: boolean;
}

// What a single-field edit says; anything else is just "edited".
const editPhrases: Record<string, [string, string?]> = {
  title: ['renamed'],
  notes: ['updated the notes on'],
  dueDate: ['changed when', 'is due'],
  plannedDate: ['rescheduled'],
  timeOfDay: ['changed the time of day for'],
  groupId: ['moved', 'to another group'],
  mustDo: ['changed the priority of'],
  estimateMinutes: ['changed how long', 'takes'],
  addSubtasks: ['updated the steps on'],
  checkSubtasks: ['ticked off a step on'],
  uncheckSubtasks: ['updated the steps on'],
  removeSubtasks: ['updated the steps on'],
  addLinks: ['added a link to'],
  removeLinks: ['updated the links on'],
  repeat: ['changed how often', 'repeats'],
  pausedUntil: ['paused'],
};

const kindWord = (d: Record<string, unknown>) => (d.kind === 'list' ? 'list' : 'group');

/** "Milk", "Milk and Eggs", "Milk, Eggs and Bread", "Milk, Eggs and 3 more". */
function items(d: Record<string, unknown>) {
  const all = (d.items as string[] | undefined) ?? (typeof d.item === 'string' ? [d.item] : []);
  if (all.length <= 1) return all[0] ?? 'something';
  if (all.length <= 3) return `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
  return `${all.slice(0, 2).join(', ')} and ${all.length - 2} more`;
}

/** "receipt.jpg", or "receipt.jpg and 2 more" for files added together. */
function files(d: Record<string, unknown>) {
  const names = (d.names as string[] | undefined) ?? (typeof d.name === 'string' ? [d.name] : []);
  if (names.length <= 1) return names[0] ?? 'a file';
  return names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} more`;
}

/** The words after someone's name: "finished Buy stamps", "handed Taxes to Alex". */
function describe(e: ActivityEntry, ctx: Context): { text: ReactNode; note?: string } {
  const d = e.detail ?? {};
  const name = (id: unknown) =>
    id === ctx.meId ? 'you' : firstName(ctx.members.find((m) => m.id === id)?.name ?? 'someone');
  const task = ctx.inTask ? (
    'this'
  ) : e.taskId ? (
    <Link to="/task/$taskId" params={{ taskId: e.taskId }} className="font-medium text-primary">
      {e.taskTitle ?? 'a task'}
    </Link>
  ) : (
    'a task'
  );
  const s = (...parts: ReactNode[]) => (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? ' ' : ''}
          {p}
        </span>
      ))}
    </>
  );

  switch (e.action) {
    case 'task.created':
      return { text: s('added', task) };
    case 'task.updated': {
      const fields = (d.fields as string[] | undefined) ?? [];
      const phrase = fields.length === 1 ? editPhrases[fields[0]!] : undefined;
      return { text: phrase ? s(phrase[0], task, ...(phrase[1] ? [phrase[1]] : [])) : s('edited', task) };
    }
    case 'task.completed': {
      // A repeating task says when the next one is.
      const next = d.next as { date?: string } | undefined;
      return { text: next?.date ? s('finished', task, `(next one ${dayLabel(next.date, ctx.today, true)})`) : s('finished', task) };
    }
    case 'task.skipped':
      return { text: d.to ? s('skipped', task, `to ${dayLabel(d.to as string, ctx.today, true)}`) : s('skipped', task) };
    case 'task.reopened':
      return { text: s('reopened', task) };
    case 'task.moved':
      return {
        text: d.to ? s('planned', task, `for ${dayLabel(d.to as string, ctx.today, true)}`) : s('moved', task, 'to the backlog'),
      };
    case 'task.assigned': {
      const note = typeof d.note === 'string' && d.note ? d.note : undefined;
      if (d.to == null) return { text: s('left', task, 'for anyone'), note };
      if (d.to === e.memberId) return { text: s('took', task), note };
      return { text: s('handed', task, `to ${name(d.to)}`), note };
    }
    case 'task.archived':
      return { text: s('removed', task) };
    case 'task.restored':
      return { text: s('restored', task) };
    case 'task.file_added':
      return { text: s(`added ${files(d)} to`, task) };
    case 'task.file_removed':
      return { text: s(`removed ${files(d)} from`, task) };
    case 'task.file_restored':
      return { text: s(`brought back ${files(d)} on`, task) };
    case 'group.created':
      return { text: s(`made the ${d.name} ${kindWord(d)}`) };
    case 'group.renamed':
      return { text: s(`renamed ${d.from} to ${d.name}`) };
    case 'group.archived':
      return { text: s(`archived the ${d.name} ${kindWord(d)}`) };
    case 'group.restored':
      return { text: s(`brought back the ${d.name} ${kindWord(d)}`) };
    case 'list.item_added':
      return { text: d.outcome === 'back on the list' ? s(`put ${items(d)} back on ${d.list}`) : s(`added ${items(d)} to ${d.list}`) };
    case 'list.items_checked':
      return { text: s(`got ${items(d)} from ${d.list}`) };
    case 'list.items_unchecked':
      return { text: s(`put ${items(d)} back on ${d.list}`) };
    case 'list.item_updated':
      return { text: s(`changed ${items(d)} on ${d.list}`) };
    case 'list.reset':
      return { text: s(`reset ${d.list} for next time`) };
    default:
      return { text: e.action };
  }
}

export function ActivityRow({ entry, ctx, showTime = true }: { entry: ActivityEntry; ctx: Context; showTime?: boolean }) {
  const member = ctx.members.find((m) => m.id === entry.memberId);
  const who = entry.memberId === ctx.meId ? 'You' : firstName(member?.name ?? entry.memberName ?? 'Someone');
  const { text, note } = describe(entry, ctx);
  const day = new Date(entry.at);
  return (
    <li className="flex gap-3 py-2.5">
      <Avatar member={member ?? { name: entry.memberName ?? '?', color: 'teal', avatarUrl: null }} size={32} />
      <div className="min-w-0 flex-1">
        <p className="leading-snug">
          <span className="font-medium">{who}</span> {text}
        </p>
        {note && <p className="mt-1.5 rounded-xl bg-surface-high px-3 py-1.5 text-sm text-on-surface-variant">"{note}"</p>}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-on-surface-variant">
          {showTime ? timeLabel(day) : day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          {entry.count > 1 && <span>{entry.count} changes</span>}
          {entry.via === 'claude' && (
            <span className="flex items-center gap-1 text-primary">
              <Sparkle className="size-3.5" aria-hidden />
              via Claude
            </span>
          )}
        </p>
      </div>
    </li>
  );
}
