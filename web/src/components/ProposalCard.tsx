// One smart add proposal under review: a summary that opens into an editor, with a checkbox to
// leave it out.
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import Cart from '~icons/material-symbols/shopping-cart-outline-rounded';
import CheckCircle from '~icons/material-symbols/check-circle-outline-rounded';
import Close from '~icons/material-symbols/close-rounded';
import Edit from '~icons/material-symbols/edit-outline-rounded';
import Flag from '~icons/material-symbols/flag-rounded';
import Bell from '~icons/material-symbols/notifications-outline-rounded';
import Repeat from '~icons/material-symbols/repeat-rounded';
import TaskIcon from '~icons/material-symbols/task-alt-rounded';
import { describeRepeat, repeatOn } from '../../../shared/repeat.ts';
import { listSections, listTemplate } from '../../../shared/templates.ts';
import type { Group, HouseholdMember, Proposal } from '../lib/api.ts';
import { dayLabel, firstName, reminderLabel, reminderPhrase } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { ChipRow, DateChip, EstimateChips, estimateLabel, GroupChips, MustDoChip, PersonChips, TimeChips, WhenChips } from './fields.tsx';
import { Checkbox, Chip } from './ui.tsx';

export interface Draft {
  key: string;
  include: boolean;
  proposal: Proposal;
}

interface Ctx {
  today: string;
  me: string;
  groups: Group[];
  members: HouseholdMember[];
}

function Meta({ children, warm }: { children: ReactNode; warm?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs ${warm ? 'bg-warm-container text-on-warm-container' : 'bg-surface-high text-on-surface-variant'}`}>
      {children}
    </span>
  );
}

const fieldInput = 'w-full rounded-xl bg-surface-high px-3 py-2.5 outline-none placeholder:text-on-surface-variant';

function summary(p: Proposal, ctx: Ctx): { icon: ReactNode; title: string; meta: ReactNode[] } {
  const group = (id: string | null | undefined) => ctx.groups.find((g) => g.id === id);
  const person = (id: string | null | undefined) =>
    id === null ? 'Anyone' : id === ctx.me ? null : firstName(ctx.members.find((m) => m.id === id)?.name ?? 'Someone');
  const day = (d: string) => dayLabel(d, ctx.today);
  if (p.kind === 'task') {
    const t = p.task;
    const who = person(t.assigneeId);
    return {
      icon: <TaskIcon className="size-5" />,
      title: t.title,
      meta: [
        group(t.groupId) && <Meta key="g">{group(t.groupId)!.name}</Meta>,
        t.plannedDate && <Meta key="p">{day(t.plannedDate)}</Meta>,
        t.timeOfDay && <Meta key="t">{t.timeOfDay}</Meta>,
        t.dueDate && <Meta key="d">Due {dayLabel(t.dueDate, ctx.today, true)}</Meta>,
        who && <Meta key="w">For {who}</Meta>,
        t.repeat && (
          <Meta key="r">
            <Repeat className="size-3.5" aria-hidden />
            {describeRepeat(t.repeat, repeatOn(t.repeat) === 'due' ? t.dueDate : t.plannedDate)}
          </Meta>
        ),
        t.remindAt && (
          <Meta key="n">
            <Bell className="size-3.5" aria-hidden />
            {reminderLabel(t.remindAt)}
          </Meta>
        ),
        t.mustDo && (
          <Meta key="m" warm>
            <Flag className="size-3.5" aria-hidden />
            Must do
          </Meta>
        ),
        t.estimateMinutes && <Meta key="e">{estimateLabel(t.estimateMinutes)}</Meta>,
        t.subtasks.length > 0 && <Meta key="s">{t.subtasks.length} steps</Meta>,
        t.links.length > 0 && <Meta key="l">{t.links.length === 1 ? 'Link' : `${t.links.length} links`}</Meta>,
      ].filter(Boolean),
    };
  }
  if (p.kind === 'list_item') {
    return {
      icon: <Cart className="size-5" />,
      title: p.quantity ? `${p.name} · ${p.quantity}` : p.name,
      meta: [
        <Meta key="l">{group(p.listId)?.name ?? 'List'}</Meta>,
        p.section && <Meta key="s">{p.section}</Meta>,
        p.store && <Meta key="t">{p.store}</Meta>,
      ].filter(Boolean),
    };
  }
  if (p.kind === 'update') {
    const c = p.changes;
    const parts: string[] = [];
    if (c.title) parts.push(`rename to "${c.title}"`);
    if (c.plannedDate !== undefined) parts.push(c.plannedDate ? `move to ${dayLabel(c.plannedDate, ctx.today, true)}` : 'back to the backlog');
    if (c.dueDate !== undefined) parts.push(c.dueDate ? `due ${dayLabel(c.dueDate, ctx.today, true)}` : 'no deadline');
    if (c.timeOfDay !== undefined) parts.push(c.timeOfDay ?? 'any time');
    if (c.assigneeId !== undefined) parts.push(`for ${person(c.assigneeId) ?? 'me'}`);
    if (c.groupId !== undefined) parts.push(c.groupId ? `into ${group(c.groupId)?.name ?? 'a group'}` : 'out of its group');
    if (c.mustDo !== undefined) parts.push(c.mustDo ? 'must do' : 'not must do');
    if (c.estimateMinutes) parts.push(estimateLabel(c.estimateMinutes));
    if (c.notes) parts.push('add a note');
    if (c.addSubtasks?.length) parts.push(`add ${c.addSubtasks.length} steps`);
    if (c.repeat) parts.push(describeRepeat(c.repeat).toLowerCase());
    if (c.remindAt !== undefined) parts.push(c.remindAt ? `remind you ${reminderPhrase(c.remindAt)}` : 'no reminder');
    return { icon: <Edit className="size-5" />, title: p.title, meta: [<Meta key="c">Change: {parts.join(', ')}</Meta>] };
  }
  if (p.kind === 'complete') return { icon: <CheckCircle className="size-5" />, title: p.title, meta: [<Meta key="d">Mark done</Meta>] };
  return { icon: <CheckCircle className="size-5" />, title: p.name, meta: [<Meta key="c">Check off {group(p.listId)?.name ?? 'the list'}</Meta>] };
}

function TaskEditor({ draft, ctx, onChange }: { draft: Draft & { proposal: { kind: 'task' } }; ctx: Ctx; onChange: (p: Proposal) => void }) {
  const t = draft.proposal.task;
  const set = (patch: Partial<typeof t>) => onChange({ kind: 'task', task: { ...t, ...patch } });
  return (
    <div className="pb-1">
      <input value={t.title} onChange={(e) => set({ title: e.target.value })} aria-label="Title" className={`${fieldInput} mt-1`} />
      <ChipRow tight label="When">
        <WhenChips value={t.plannedDate} today={ctx.today} onChange={(plannedDate) => set({ plannedDate })} />
      </ChipRow>
      <ChipRow tight label="Group">
        <GroupChips groups={ctx.groups} value={t.groupId} onChange={(groupId) => set({ groupId })} />
      </ChipRow>
      {ctx.members.length > 1 && (
        <ChipRow tight label="For">
          <PersonChips members={ctx.members} me={ctx.me} value={t.assigneeId} onChange={(assigneeId) => set({ assigneeId })} />
        </ChipRow>
      )}
      <ChipRow tight label="Time and deadline">
        <TimeChips value={t.timeOfDay} onChange={(timeOfDay) => set({ timeOfDay })} />
        <MustDoChip value={t.mustDo} onChange={(mustDo) => set({ mustDo })} />
        <DateChip value={t.dueDate} label={t.dueDate ? `Due ${dayLabel(t.dueDate, ctx.today, true)}` : 'Due date'} onPick={(dueDate) => set({ dueDate })} />
      </ChipRow>
      <ChipRow tight label="How long">
        <EstimateChips value={t.estimateMinutes} onChange={(estimateMinutes) => set({ estimateMinutes, estimateSource: 'user' })} />
      </ChipRow>
      {t.remindAt && (
        <ChipRow tight label="Reminder">
          <Chip selected onClick={() => set({ remindAt: null })} icon={<Close className="size-4" />}>
            Remind me {reminderPhrase(t.remindAt)}
          </Chip>
        </ChipRow>
      )}
      {t.repeat && (
        <ChipRow tight label="Repeats">
          <Chip selected onClick={() => set({ repeat: null })} icon={<Close className="size-4" />}>
            {describeRepeat(t.repeat, repeatOn(t.repeat) === 'due' ? t.dueDate : t.plannedDate)}
          </Chip>
        </ChipRow>
      )}
      {t.notes && <p className="mt-3 px-1 text-sm text-on-surface-variant">{t.notes}</p>}
      {t.subtasks.length > 0 && (
        <ul className="mt-2 list-disc pl-6 text-sm text-on-surface-variant">
          {t.subtasks.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ItemEditor({ draft, ctx, onChange }: { draft: Draft & { proposal: { kind: 'list_item' } }; ctx: Ctx; onChange: (p: Proposal) => void }) {
  const it = draft.proposal;
  const set = (patch: Partial<typeof it>) => onChange({ ...it, ...patch });
  const lists = ctx.groups.filter((g) => g.kind === 'list');
  const list = lists.find((l) => l.id === it.listId);
  const sections = list ? listSections(list, [it.section]) : [];
  const label = listTemplate(list?.template).sections?.label ?? 'Section';
  return (
    <div className="pb-1">
      <div className="mt-1 flex gap-2">
        <input value={it.name} onChange={(e) => set({ name: e.target.value })} aria-label="Item" className={`${fieldInput} min-w-0 flex-[3]`} />
        <input
          value={it.quantity ?? ''}
          onChange={(e) => set({ quantity: e.target.value || null })}
          placeholder="Qty"
          aria-label="Quantity"
          className={`${fieldInput} min-w-0 flex-1`}
        />
      </div>
      {lists.length > 1 && (
        <ChipRow tight label="List">
          {lists.map((l) => (
            <Chip key={l.id} selected={l.id === it.listId} onClick={() => set({ listId: l.id, section: null })}>
              {l.name}
            </Chip>
          ))}
        </ChipRow>
      )}
      {sections.length > 0 && (
        <ChipRow tight label={label}>
          {sections.map((s) => (
            <Chip key={s} selected={s === it.section} onClick={() => set({ section: s === it.section ? null : s })}>
              {s}
            </Chip>
          ))}
        </ChipRow>
      )}
    </div>
  );
}

export function ProposalCard({
  index = 0,
  draft,
  ctx,
  open,
  onToggleOpen,
  onChange,
  onInclude,
}: {
  /** Position in the list, so the cards arrive one after another. */
  index?: number;
  draft: Draft;
  ctx: Ctx;
  open: boolean;
  onToggleOpen: () => void;
  onChange: (p: Proposal) => void;
  onInclude: (v: boolean) => void;
}) {
  const s = summary(draft.proposal, ctx);
  const editable = draft.proposal.kind === 'task' || draft.proposal.kind === 'list_item';
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 18, scale: 0.94 }}
      animate={{ opacity: draft.include ? 1 : 0.5, y: 0, scale: 1 }}
      transition={{ ...expressive.defaultSpatial, delay: Math.min(index, 8) * 0.06, layout: expressive.fastSpatial, opacity: { duration: 0.2 } }}
      className="rounded-3xl bg-surface-high/60"
    >
      <div className="flex items-start gap-3 p-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-secondary-container text-on-secondary-container" aria-hidden>
          {s.icon}
        </span>
        <button
          type="button"
          onClick={editable ? onToggleOpen : undefined}
          aria-expanded={editable ? open : undefined}
          className="min-w-0 flex-1 text-left"
          disabled={!editable}
        >
          <span className={`block leading-snug ${draft.include ? '' : 'line-through'}`}>{s.title}</span>
          {s.meta.length > 0 && <span className="mt-1.5 flex flex-wrap gap-1">{s.meta}</span>}
        </button>
        <Checkbox checked={draft.include} onChange={() => onInclude(!draft.include)} label={draft.include ? `Leave out ${s.title}` : `Include ${s.title}`} size={26} />
      </div>
      <AnimatePresence initial={false}>
        {open && editable && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={expressive.fastSpatial}
            className="overflow-hidden px-3 pb-2"
          >
            {draft.proposal.kind === 'task' ? (
              <TaskEditor draft={draft as Draft & { proposal: { kind: 'task' } }} ctx={ctx} onChange={onChange} />
            ) : (
              <ItemEditor draft={draft as Draft & { proposal: { kind: 'list_item' } }} ctx={ctx} onChange={onChange} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}
