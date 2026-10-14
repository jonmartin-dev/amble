// Runs smart add against real household phrasing at each effort level and scores the proposals.
// Usage: node --env-file=.env scripts/eval-smart-add.ts [efforts=medium,high] [rounds=1] [case-filter]
// Needs ANTHROPIC_API_KEY. Each case is one Haiku call per effort per round (a fraction of a cent).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Proposal, ProposedTask } from '../shared/proposals.ts';
import { createAi, type Effort } from '../server/ai/client.ts';
import { smartAdd } from '../server/ai/smartAdd.ts';
import { config } from '../server/config.ts';
import { openDatabase } from '../server/db/index.ts';
import { members, type Member } from '../server/db/schema.ts';
import { seedStarterGroups } from '../server/db/seed.ts';
import { createGroup, resolveGroup, type Actor } from '../server/domain/household.ts';
import { addListItems, checkListItems } from '../server/domain/lists.ts';
import { createTasks } from '../server/domain/tasks.ts';
import { addDays, planningDate } from '../server/lib/dates.ts';

const [effortArg = 'medium,high', roundsArg = '1', filter = ''] = process.argv.slice(2);
const efforts = effortArg.split(',') as Effort[];
const rounds = Number(roundsArg) || 1;

// ---- a household with known contents --------------------------------------------------------

const db = openDatabase(':memory:');
seedStarterGroups(db);
const add = (email: string, name: string) =>
  db.insert(members).values({ email, name, timezone: 'America/Chicago', role: 'member', lastLoginAt: new Date() }).returning().get();
const jon = add('jon@example.com', 'Jon Martin');
const alex = add('alex@example.com', 'Alex Martin');
const asJon: Actor = { member: jon, via: 'app' };
const today = planningDate(jon);
const g = (name: string) => resolveGroup(db, jon, name).id;
const shopping = createGroup(db, asJon, { name: 'Shopping', kind: 'list', template: 'shopping' });
const groceries = resolveGroup(db, jon, 'Groceries', 'list');

const [dentist, plumber] = createTasks(db, asJon, [
  { title: 'Dentist appointment', groupId: g('Calls'), plannedDate: addDays(today, 1), estimateMinutes: 60 },
  { title: 'Call the plumber about the water heater', groupId: g('Calls'), estimateMinutes: 10 },
  { title: 'Fix the fence gate', groupId: g('Home'), estimateMinutes: 60 },
  { title: 'Return the library books', groupId: g('Errands'), estimateMinutes: 20 },
  { title: 'Clean out the garage', groupId: g('Home'), estimateMinutes: 120 },
  { title: 'Book flights for December', groupId: g('Projects'), estimateMinutes: 30 },
  { title: 'Practice guitar', groupId: g('Hobby'), estimateMinutes: 30 },
  { title: 'Wipe down the kitchen', groupId: g('Home'), estimateMinutes: 15 },
]);
addListItems(db, asJon, groceries, [{ name: 'Oat milk' }, { name: 'Eggs' }, { name: 'Chicken thighs' }, { name: 'Greek yogurt' }, { name: 'Sourdough bread' }]);
checkListItems(db, asJon, groceries, ['Oat milk', 'Eggs', 'Chicken thighs', 'Greek yogurt', 'Sourdough bread']);
addListItems(db, asJon, groceries, [{ name: 'Bananas', quantity: '6' }, { name: 'Coffee beans' }]);

// ---- cases ----------------------------------------------------------------------------------

type Check = [label: string, ok: boolean];
interface Case {
  name: string;
  text: string;
  hints?: Parameters<typeof smartAdd>[3]['hints'];
  as?: Member;
  check: (p: Proposal[]) => Check[];
}

const tasksOf = (p: Proposal[]) => p.flatMap((x) => (x.kind === 'task' ? [x.task] : []));
const itemsOf = (p: Proposal[]) => p.flatMap((x) => (x.kind === 'list_item' ? [x] : []));
const only = (p: Proposal[], kind: Proposal['kind']) => p.length > 0 && p.every((x) => x.kind === kind);
const dow = (d: string | null) => (d ? Temporal.PlainDate.from(d).dayOfWeek : 0);
const nextDow = (n: number) => {
  for (let i = 0; i < 7; i++) if (dow(addDays(today, i)) === n) return addDays(today, i);
  return today;
};
const startOfNextWeek = addDays(today, 8 - dow(today));
const title = (t: ProposedTask | undefined, re: RegExp) => !!t && re.test(t.title);
const noDates = (t: ProposedTask | undefined) => !!t && !t.plannedDate && !t.dueDate;

const cases: Case[] = [
  {
    name: 'single call with time',
    text: 'call mom tomorrow evening',
    check: (p) => {
      const [t] = tasksOf(p);
      return [
        ['one task', only(p, 'task') && p.length === 1],
        ['title is "Call Mom"', title(t, /^call mom$/i)],
        ['planned tomorrow', t?.plannedDate === addDays(today, 1)],
        ['evening', t?.timeOfDay === 'evening'],
        ['Calls group', t?.groupId === g('Calls')],
        ['estimate under 30', !!t?.estimateMinutes && t.estimateMinutes <= 30],
      ];
    },
  },
  {
    name: 'groceries with history spelling and quantity',
    text: "we're out of milk and eggs, also need 2 lbs chicken thighs",
    check: (p) => {
      const items = itemsOf(p);
      const chicken = items.find((i) => /chicken/i.test(i.name));
      return [
        ['three grocery items, no tasks', only(p, 'list_item') && items.length === 3 && items.every((i) => i.listId === groceries.id)],
        ['milk matches "Oat milk"', items.some((i) => i.name === 'Oat milk')],
        ['chicken quantity separate', chicken?.name === 'Chicken thighs' && /2\s*lbs?/i.test(chicken.quantity ?? '')],
        ['sections set', items.every((i) => i.section)],
      ];
    },
  },
  {
    name: 'brain dump',
    text: 'renew car registration by the 30th, fix the leaky faucet, email the landlord about the lease, pick up dry cleaning',
    check: (p) => {
      const ts = tasksOf(p);
      const reg = ts.find((t) => /registration/i.test(t.title));
      const due30 = (() => {
        const d = Temporal.PlainDate.from(today);
        const thisMonth = d.with({ day: Math.min(30, d.daysInMonth) });
        return Temporal.PlainDate.compare(thisMonth, d) >= 0 ? thisMonth.toString() : d.add({ months: 1 }).with({ day: 30 }).toString();
      })();
      return [
        ['four tasks', only(p, 'task') && ts.length === 4],
        ['registration due the 30th', reg?.dueDate === due30 && !reg.plannedDate],
        ['others undated', ts.filter((t) => t !== reg).every(noDates)],
        ['faucet in Home', ts.find((t) => /faucet/i.test(t.title))?.groupId === g('Home')],
        ['dry cleaning in Errands', ts.find((t) => /dry clean/i.test(t.title))?.groupId === g('Errands')],
      ];
    },
  },
  {
    name: 'for Alex, next week',
    text: 'Alex should take the car in for an oil change next week',
    check: (p) => {
      const [t] = tasksOf(p);
      return [
        ['one task', p.length === 1 && !!t],
        ['for Alex', t?.assigneeId === alex.id],
        ['planned next week', !!t?.plannedDate && t.plannedDate >= startOfNextWeek && t.plannedDate <= addDays(startOfNextWeek, 6)],
        ['no Alex in title', !!t && !/alex/i.test(t.title)],
        ['Errands', t?.groupId === g('Errands')],
      ];
    },
  },
  {
    name: 'weekly repeat',
    text: 'water the plants every sunday',
    check: (p) => {
      const [t] = tasksOf(p);
      return [
        ['one task', p.length === 1 && !!t],
        ['weekly on Sunday', t?.repeat?.mode === 'schedule' && t.repeat.unit === 'week' && t.repeat.every === 1 && t.repeat.weekdays?.join() === '7'],
        ['Home', t?.groupId === g('Home')],
      ];
    },
  },
  {
    name: 'after-done repeat',
    text: 'change the furnace filter every 3 months',
    check: (p) => {
      const [t] = tasksOf(p);
      return [
        ['one task', p.length === 1 && !!t],
        ['3 months after done', t?.repeat?.mode === 'after' && t.repeat.every === 3 && t.repeat.unit === 'month'],
      ];
    },
  },
  {
    name: 'seasonal repeat',
    text: 'mow the lawn every saturday from april to october',
    check: (p) => {
      const [t] = tasksOf(p);
      return [
        ['weekly Saturday', t?.repeat?.unit === 'week' && t.repeat.weekdays?.join() === '6'],
        ['April to October', t?.repeat?.months?.join() === '4,5,6,7,8,9,10'],
        ['title has no months', !!t && !/april|october/i.test(t.title)],
      ];
    },
  },
  {
    name: 'monthly must-do',
    text: 'pay rent on the 1st of every month, must do',
    check: (p) => {
      const [t] = tasksOf(p);
      return [
        ['monthly on the 1st', t?.repeat?.unit === 'month' && t.repeat.day === 1 && t.repeat.mode === 'schedule'],
        ['must do', t?.mustDo === true],
      ];
    },
  },
  {
    name: 'update existing',
    text: 'the dentist is actually on friday',
    check: (p) => {
      const [u] = p;
      return [
        ['one update, no new task', p.length === 1 && u?.kind === 'update'],
        ['the dentist task', u?.kind === 'update' && u.taskId === dentist!.id],
        ['moved to Friday', u?.kind === 'update' && u.changes.plannedDate === nextDow(5)],
      ];
    },
  },
  {
    name: 'complete existing',
    text: 'called the plumber',
    check: (p) => [['completes the plumber task', p.length === 1 && p[0]?.kind === 'complete' && p[0].taskId === plumber!.id]],
  },
  {
    name: 'check off list item',
    text: 'got the bananas',
    check: (p) => [['checks off bananas', p.length === 1 && p[0]?.kind === 'check' && p[0].name === 'Bananas']],
  },
  {
    name: 'steps and due date',
    text: 'taxes: W-2, 1099-INT, mortgage interest form. due april 15',
    check: (p) => {
      const [t] = tasksOf(p);
      const april = Temporal.PlainDate.from(today).with({ month: 4, day: 15 });
      const due = (Temporal.PlainDate.compare(april, Temporal.PlainDate.from(today)) >= 0 ? april : april.add({ years: 1 })).toString();
      return [
        ['one task', p.length === 1 && !!t],
        ['three steps', t?.subtasks.length === 3],
        ['due April 15', t?.dueDate === due],
        ['not planned', !t?.plannedDate],
      ];
    },
  },
  {
    name: 'this weekend',
    text: 'pick up a birthday gift for Sam this weekend',
    check: (p) => {
      const [t] = tasksOf(p);
      const sat = nextDow(6);
      return [
        ['one task', p.length === 1 && !!t],
        ['planned this weekend', t?.plannedDate === sat || t?.plannedDate === addDays(sat, 1) || (dow(today) === 7 && t?.plannedDate === today)],
        ['keeps Sam', title(t, /sam/i)],
      ];
    },
  },
  {
    name: 'link and day',
    text: 'make this lasagna sunday https://example.com/recipes/lasagna',
    check: (p) => {
      const [t] = tasksOf(p);
      return [
        ['link kept', t?.links.join() === 'https://example.com/recipes/lasagna'],
        ['planned Sunday', t?.plannedDate === nextDow(7)],
        ['no URL in title', !!t && !/https?:/.test(t.title)],
      ];
    },
  },
  {
    name: 'explicit group chip',
    text: 'clean gutters',
    hints: { groupId: g('Projects'), explicit: ['groupId'] },
    check: (p) => {
      const [t] = tasksOf(p);
      return [
        ['one task', p.length === 1 && !!t],
        ['uses the picked group', t?.groupId === g('Projects')],
      ];
    },
  },
  {
    name: 'from Today, one thing',
    text: 'vacuum the living room',
    hints: { plannedDate: today },
    check: (p) => {
      const [t] = tasksOf(p);
      return [['planned today', t?.plannedDate === today]];
    },
  },
  {
    name: 'from Today, long list',
    text: 'vacuum today, also at some point: research new couches, sell the old bike, frame the wedding photos',
    hints: { plannedDate: today },
    check: (p) => {
      const ts = tasksOf(p);
      return [
        ['four tasks', ts.length === 4],
        ['vacuum today', ts.find((t) => /vacuum/i.test(t.title))?.plannedDate === today],
        ['rest unplanned', ts.filter((t) => !/vacuum/i.test(t.title)).every((t) => !t.plannedDate)],
      ];
    },
  },
  {
    name: 'non-grocery purchase',
    text: 'buy new running shoes',
    check: (p) => {
      const items = itemsOf(p);
      return [['on the Shopping list', p.length === 1 && items[0]?.listId === shopping.id]];
    },
  },
  {
    name: 'appointment with time',
    text: 'dentist appt for alex oct 28 at 2pm',
    check: (p) => {
      const ts = tasksOf(p);
      const t = ts[0];
      const oct28 = Temporal.PlainDate.from(today).with({ month: 10, day: 28 });
      const date = (Temporal.PlainDate.compare(oct28, Temporal.PlainDate.from(today)) >= 0 ? oct28 : oct28.add({ years: 1 })).toString();
      return [
        ['new task, not the existing dentist', ts.length === 1 && p.length === 1],
        ['for Alex', t?.assigneeId === alex.id],
        ['planned Oct 28', t?.plannedDate === date],
        ['afternoon', t?.timeOfDay === 'afternoon'],
        ['2pm kept somewhere', !!t && /2\s*pm|14:00/i.test(`${t.title} ${t.notes ?? ''}`)],
      ];
    },
  },
];

// ---- run ------------------------------------------------------------------------------------

const ai = createAi(config);
if (!ai.available) {
  console.error('Set ANTHROPIC_API_KEY (node --env-file=.env ...).');
  process.exit(1);
}

interface Run {
  case: string;
  effort: Effort;
  round: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  checks: Check[];
  proposals: Proposal[];
  unclear: string | null;
  error?: string;
}

const jobs = cases
  .filter((c) => !filter || c.name.includes(filter))
  .flatMap((c) => efforts.flatMap((effort) => Array.from({ length: rounds }, (_, round) => ({ c, effort, round }))));
const runs: Run[] = [];
const queue = [...jobs];
async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const { c, effort, round } = job;
    try {
      const r = await smartAdd(db, ai, c.as ?? jon, { text: c.text, hints: c.hints, effort, timezone: config.timezone });
      runs.push({ case: c.name, effort, round, ms: r.usage.ms, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, checks: c.check(r.proposals), proposals: r.proposals, unclear: r.unclear });
    } catch (err) {
      runs.push({ case: c.name, effort, round, ms: 0, inputTokens: 0, outputTokens: 0, checks: [['answered', false]], proposals: [], unclear: null, error: String(err) });
    }
    process.stdout.write('.');
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
console.log('\n');

const cost = (r: Run) => (r.inputTokens * 0.1 + r.outputTokens * 0.5) / 1e6;
for (const c of cases.filter((c) => !filter || c.name.includes(filter))) {
  const cells = efforts.map((e) => {
    const rs = runs.filter((r) => r.case === c.name && r.effort === e);
    const passed = rs.flatMap((r) => r.checks).filter(([, ok]) => ok).length;
    const total = rs.flatMap((r) => r.checks).length;
    const failed = [...new Set(rs.flatMap((r) => r.checks.filter(([, ok]) => !ok).map(([l]) => l)))];
    return `${e} ${passed}/${total}${failed.length ? ` (missed: ${failed.join('; ')})` : ''}`;
  });
  console.log(`${c.name.padEnd(42)} ${cells.join('   ')}`);
}
console.log('');
for (const e of efforts) {
  const rs = runs.filter((r) => r.effort === e);
  const checks = rs.flatMap((r) => r.checks);
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
  console.log(
    `${e.padEnd(7)} checks ${checks.filter(([, ok]) => ok).length}/${checks.length}  ` +
      `cases fully right ${rs.filter((r) => r.checks.every(([, ok]) => ok)).length}/${rs.length}  ` +
      `median ${(ms[Math.floor(ms.length / 2)]! / 1000).toFixed(1)}s  p90 ${(ms[Math.floor(ms.length * 0.9)]! / 1000).toFixed(1)}s  ` +
      `avg in ${Math.round(avg(rs.map((r) => r.inputTokens)))} out ${Math.round(avg(rs.map((r) => r.outputTokens)))} tokens  ` +
      `avg $${avg(rs.map(cost)).toFixed(5)} per add`,
  );
}
const out = path.join(os.tmpdir(), `eval-smart-add-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
fs.writeFileSync(out, JSON.stringify(runs, null, 2));
console.log(`\nFull results in ${out}`);
