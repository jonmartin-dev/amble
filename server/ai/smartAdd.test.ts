import { beforeEach, describe, expect, it } from 'vitest';
import type { Proposal } from '../../shared/proposals.ts';
import { openDatabase, type Db } from '../db/index.ts';
import { members, type Member } from '../db/schema.ts';
import { seedStarterGroups } from '../db/seed.ts';
import { createGroup, resolveGroup, type Actor } from '../domain/household.ts';
import { addListItems, checkListItems, getListItems } from '../domain/lists.ts';
import { createTasks, getTask, listTasks } from '../domain/tasks.ts';
import { addDays, planningDate } from '../lib/dates.ts';
import { applyProposals } from './apply.ts';
import { createAi, monthSpendUsd, recordUsage, requireAi, AiUnavailable } from './client.ts';
import { buildContext, toProposals, type SmartAddOutput } from './smartAdd.ts';
import { config } from '../config.ts';

let db: Db;
let jon: Member;
let alex: Member;
let asJon: Actor;
let today: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  const add = (email: string, name: string) => db.insert(members).values({ email, name, timezone: 'America/Chicago' }).returning().get();
  jon = add('jon@example.com', 'Jon Martin');
  alex = add('alex@example.com', 'Alex Martin');
  asJon = { member: jon, via: 'app' };
  today = planningDate(jon);
});

const none = { mode: 'none' as const, every: 0, unit: 'week' as const, weekdays: [] as number[], day: 0, nth: 0, weekday: 0, month: 0, months: [] as number[] };
const task = (fields: Partial<Extract<SmartAddOutput['items'][number], { kind: 'add_task' }>['task']>) => ({
  kind: 'add_task' as const,
  task: {
    title: 'Task',
    notes: '',
    group: '',
    for: '',
    planned: '',
    due: '',
    time_of_day: '' as const,
    must_do: false,
    estimate_minutes: 15,
    steps: [],
    links: [],
    repeat: { ...none, weekdays: [], months: [] },
    remind: '',
    ...fields,
  },
});

describe('smart add context', () => {
  it('describes the household with short refs and keeps private groups private', () => {
    createGroup(db, { member: alex, via: 'app' }, { name: 'Alex secret', private: true });
    createTasks(db, asJon, [{ title: 'Fix the fence gate', groupId: resolveGroup(db, jon, 'Home').id, estimateMinutes: 60 }]);
    const groceries = resolveGroup(db, jon, 'Groceries', 'list');
    addListItems(db, asJon, groceries, [{ name: 'Oat milk' }, { name: 'Bananas', quantity: '6' }]);
    checkListItems(db, asJon, groceries, ['Oat milk']);
    const { text, refs } = buildContext(db, jon, { plannedDate: today });
    expect(text).toContain(`m1 Jon Martin (typing)`);
    expect(text).toMatch(/g1 Home: Fix the fence gate/);
    expect(text).toMatch(/On it now: i1 Bananas \(6\)/);
    expect(text).toMatch(/Bought or packed before: Oat milk/);
    expect(text).toMatch(/Fix the fence gate: 60 min/);
    expect(text).toMatch(/opened the add sheet from today's list/);
    expect(text).not.toContain('Alex secret');
    expect(refs.tasks.size).toBe(1);
  });
});

describe('turning answers into proposals', () => {
  it('maps refs to ids and drops what does not check out', () => {
    const [fence] = createTasks(db, asJon, [{ title: 'Fix the fence gate' }]);
    const groceries = resolveGroup(db, jon, 'Groceries', 'list');
    addListItems(db, asJon, groceries, [{ name: 'Bananas' }]);
    const { refs } = buildContext(db, jon);
    const proposals = toProposals(
      {
        items: [
          task({ title: 'call mom.', group: 'g3', for: 'm2', planned: addDays(today, 1), time_of_day: 'evening', estimate_minutes: 12, links: ['https://example.com', 'javascript:alert(1)'] }),
          task({ title: 'Yesterday thing', planned: addDays(today, -1), group: 'g99', repeat: { ...none, mode: 'schedule', every: 1, unit: 'week', weekdays: [7], months: [] } }),
          { kind: 'add_to_list', list: 'l1', name: 'chicken thighs', quantity: '2 lbs', section: 'meat & seafood', note: '' },
          { kind: 'add_to_list', list: 'l9', name: 'Nowhere', quantity: '', section: '', note: '' },
          { kind: 'update_task', task: 't1', title: '', notes: '', group: '', for: '', planned: 'none', due: '', time_of_day: '', must_do: 'yes', estimate_minutes: 0, add_steps: [], repeat: none, remind: '' },
          { kind: 'update_task', task: 't99', title: 'Ghost', notes: '', group: '', for: '', planned: '', due: '', time_of_day: '', must_do: '', estimate_minutes: 0, add_steps: [], repeat: none, remind: '' },
          { kind: 'complete_task', task: 't1' },
          { kind: 'check_off', list: 'l1', item: 'i1' },
        ],
        unclear: '',
      },
      refs,
      jon,
      today,
    );
    expect(proposals).toEqual<Proposal[]>([
      {
        kind: 'task',
        task: expect.objectContaining({
          title: 'Call mom',
          groupId: resolveGroup(db, jon, 'Calls').id,
          assigneeId: alex.id,
          plannedDate: addDays(today, 1),
          timeOfDay: 'evening',
          estimateMinutes: 10,
          estimateSource: 'ai',
          links: ['https://example.com'],
          repeat: null,
        }),
      },
      { kind: 'task', task: expect.objectContaining({ title: 'Yesterday thing', plannedDate: null, groupId: null, assigneeId: jon.id, repeat: { mode: 'schedule', every: 1, unit: 'week', weekdays: [7] } }) },
      { kind: 'list_item', listId: groceries.id, name: 'Chicken thighs', quantity: '2 lbs', section: 'Meat & seafood', note: null },
      { kind: 'update', taskId: fence!.id, title: 'Fix the fence gate', changes: { plannedDate: null, mustDo: true } },
      { kind: 'complete', taskId: fence!.id, title: 'Fix the fence gate' },
      { kind: 'check', listId: groceries.id, itemId: expect.any(String), name: 'Bananas' },
    ]);
  });
});

describe('reminders in smart add', () => {
  it('turns a local time into a reminder, and drops times that have passed or make no sense', () => {
    const [fence] = createTasks(db, asJon, [{ title: 'Fix the fence gate' }]);
    const { refs } = buildContext(db, jon);
    const tomorrow = addDays(today, 1);
    const proposals = toProposals(
      {
        items: [
          task({ title: 'Call mom', planned: tomorrow, remind: `${tomorrow}T18:00` }),
          task({ title: 'Old', remind: '2020-01-01T09:00' }),
          task({ title: 'Nonsense', remind: 'soon' }),
          { kind: 'update_task', task: 't1', title: '', notes: '', group: '', for: '', planned: '', due: '', time_of_day: '', must_do: '', estimate_minutes: 0, add_steps: [], repeat: none, remind: 'none' },
        ],
        unclear: '',
      },
      refs,
      jon,
      today,
    );
    const sixPm = Temporal.PlainDateTime.from(`${tomorrow}T18:00`).toZonedDateTime('America/Chicago').toInstant().toString({ smallestUnit: 'millisecond' });
    expect(proposals.map((p) => (p.kind === 'task' ? p.task.remindAt : p.kind === 'update' ? p.changes : null))).toEqual([sixPm, null, null, { remindAt: null }]);

    applyProposals(db, asJon, [proposals[0]!]);
    const call = listTasks(db, jon).find((t) => t.title === 'Call mom')!;
    expect(call.reminder?.at.toISOString()).toBe(sixPm);
    expect(fence).toBeTruthy();
  });

  it('tells Haiku the time now, so "in an hour" works', () => {
    expect(buildContext(db, jon).text).toMatch(/and it's \d{4}-\d{2}-\d{2}T\d{2}:\d{2} now/);
  });
});

describe('applying proposals', () => {
  it('saves everything in one go as the person who accepted it', () => {
    const [fence] = createTasks(db, asJon, [{ title: 'Fix the fence gate' }]);
    const groceries = resolveGroup(db, jon, 'Groceries', 'list');
    const result = applyProposals(db, asJon, [
      {
        kind: 'task',
        task: {
          title: 'Water the plants',
          notes: null,
          groupId: resolveGroup(db, jon, 'Home').id,
          assigneeId: null,
          plannedDate: null,
          dueDate: null,
          timeOfDay: null,
          mustDo: false,
          estimateMinutes: 10,
          estimateSource: 'ai',
          subtasks: [],
          links: [],
          repeat: { mode: 'schedule', every: 1, unit: 'week', weekdays: [7] },
        },
      },
      { kind: 'list_item', listId: groceries.id, name: 'Eggs', quantity: '12', section: 'Dairy & eggs', note: null },
      { kind: 'update', taskId: fence!.id, title: 'Fix the fence gate', changes: { assigneeId: alex.id, plannedDate: addDays(today, 2) } },
    ]);
    expect(result).toMatchObject({ added: 1, updated: 1, listed: 1 });
    const [plants] = listTasks(db, jon, { query: 'plants' });
    expect(plants).toMatchObject({ assigneeId: null, estimateSource: 'ai', repeat: { weekdays: [7] } });
    expect(Temporal.PlainDate.from(plants!.plannedDate!).dayOfWeek).toBe(7);
    expect(getTask(db, jon, fence!.id)).toMatchObject({ assigneeId: alex.id, plannedDate: addDays(today, 2) });
    expect(getListItems(db, groceries).open).toMatchObject([{ name: 'Eggs', quantity: '12', section: 'Dairy & eggs' }]);
  });
});

describe('AI budget', () => {
  it('refuses without a key and once the month is spent', () => {
    expect(() => requireAi(createAi({ ...config, ai: { ...config.ai, apiKey: '' } }), db, 'America/Chicago')).toThrow(AiUnavailable);
    const ai = createAi({ ...config, ai: { ...config.ai, apiKey: 'test-key', monthlyCapUsd: 0.01 } });
    expect(requireAi(ai, db, 'America/Chicago')).toBeTruthy();
    recordUsage(db, { memberId: jon.id, feature: 'smart_add', model: 'claude-haiku-5-5', effort: 'medium', usage: { input_tokens: 60_000, output_tokens: 10_000 }, durationMs: 1, ok: true });
    expect(monthSpendUsd(db, 'America/Chicago')).toBeCloseTo(0.011, 5);
    expect(() => requireAi(ai, db, 'America/Chicago')).toThrow(/budget/);
  });
});
