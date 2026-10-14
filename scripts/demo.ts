// Fills a fresh database with a small, realistic household for screenshots and manual testing.
// Usage: node scripts/demo.ts <data-dir> <email> [name] [partner-email] [partner-name]
// Then run the app against it: ALMANAC_DATA_DIR=<data-dir> pnpm dev
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.ts';
import { openDatabase } from '../server/db/index.ts';
import { activity, members, tasks } from '../server/db/schema.ts';
import { seedStarterGroups } from '../server/db/seed.ts';
import { resolveGroup, type Actor } from '../server/domain/household.ts';
import { addListItems, checkListItems } from '../server/domain/lists.ts';
import { assignTask, completeTasks, createTasks, type NewTask } from '../server/domain/tasks.ts';
import { inviteMember } from '../server/auth/members.ts';
import { addDays, planningDate } from '../server/lib/dates.ts';

const [dir, email, name = 'Sam Rivera', partnerEmail, partnerName = 'Alex Kim'] = process.argv.slice(2);
if (!dir || !email) {
  console.error('Usage: node scripts/demo.ts <data-dir> <email> [name] [partner-email] [partner-name]');
  process.exit(1);
}
const file = path.join(path.resolve(dir), 'almanac.db');
if (fs.existsSync(file)) {
  console.error(`${file} already exists. Use an empty folder.`);
  process.exit(1);
}

const db = openDatabase(file);
seedStarterGroups(db);
const me = inviteMember(db, { ...config, adminEmails: [email.toLowerCase()] }, { email, name });
db.update(members).set({ lastLoginAt: new Date() }).run();
const partner = partnerEmail ? inviteMember(db, config, { email: partnerEmail, name: partnerName }) : null;

const asMe: Actor = { member: me, via: 'app' };
const asPartner: Actor | null = partner ? { member: partner, via: 'app' } : null;
const today = planningDate(me);
const g = (n: string) => resolveGroup(db, me, n).id;

const mine: NewTask[] = [
  { title: 'Call the dentist about the crown', groupId: g('Calls'), plannedDate: today, timeOfDay: 'morning', estimateMinutes: 10 },
  { title: 'Pick up the dry cleaning', groupId: g('Errands'), plannedDate: today, timeOfDay: 'afternoon', estimateMinutes: 20 },
  { title: 'Water the herbs', groupId: g('Home'), plannedDate: today, estimateMinutes: 5 },
  { title: 'Sketch the bookshelf design', groupId: g('Hobby'), plannedDate: today, timeOfDay: 'evening', estimateMinutes: 45 },
  { title: 'Email the landlord about the faucet', groupId: g('Home'), plannedDate: addDays(today, -1) },
  { title: 'Renew the car registration', groupId: g('Errands'), dueDate: today, mustDo: true, estimateMinutes: 15 },
  {
    title: 'Fix the fence gate',
    groupId: g('Home'),
    dueDate: addDays(today, 5),
    estimateMinutes: 60,
    subtasks: ['Buy new hinges', 'Replace the latch screws'],
  },
  { title: 'Return the library books', groupId: g('Errands'), dueDate: addDays(today, 3) },
  { title: 'Clean the gutters', groupId: g('Home'), plannedDate: addDays(today, 2), estimateMinutes: 90 },
  { title: 'Call Mom', groupId: g('Calls') },
  {
    title: 'Set up the raised garden beds',
    groupId: g('Projects'),
    notes: 'Cedar boards from the hardware store. Check the soil calculator first.',
    subtasks: ['Measure the yard', 'Order soil', 'Build frames'],
    links: [{ url: 'https://www.almanac.com/vegetable-garden-planner' }],
  },
  { title: 'Book flights for December', groupId: g('Projects'), dueDate: addDays(today, 12), links: [{ url: 'https://www.google.com/flights' }] },
  { title: 'Try the new watercolor set', groupId: g('Hobby') },
  { title: 'Take out the recycling', groupId: g('Home'), plannedDate: today, estimateMinutes: 5 },
];
const created = createTasks(db, asMe, mine);
completeTasks(db, asMe, [created.at(-1)!.id]);

// Ten weeks of finished chores, so Stats and Activity have a history to show.
const past = [
  ['Wipe down the kitchen', 'Home'],
  ['Vacuum the stairs', 'Home'],
  ['Call the insurance company', 'Calls'],
  ['Buy a birthday card', 'Errands'],
  ['Fold the laundry', 'Home'],
  ['Pay the water bill', 'Errands'],
  ['Prune the roses', 'Home'],
  ['Clean out the fridge', 'Home'],
  ['Return the package', 'Errands'],
  ['Oil the bike chain', 'Hobby'],
  ['Book a haircut', 'Calls'],
  ['Sort the mail', 'Home'],
] as const;
let n = 0;
for (let daysAgo = 70; daysAgo >= 1; daysAgo--) {
  const date = addDays(today, -daysAgo);
  const dow = Temporal.PlainDate.from(date).dayOfWeek;
  const count = Math.max(0, ((daysAgo * 7 + dow * 3) % 4) + (dow >= 6 ? 1 : 0) - (daysAgo > 49 ? 1 : 0));
  for (let i = 0; i < count; i++, n++) {
    const [title, group] = past[n % past.length]!;
    const who = partner && n % 3 === 1 ? partner : me;
    const hour = [8, 10, 13, 18, 20, 21][n % 6]!;
    const doneAt = new Date(Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: me.timezone, plainTime: { hour } }).epochMilliseconds);
    const addedAt = new Date(doneAt.getTime() - ((n % 9) + 1) * 86_400_000);
    const task = db
      .insert(tasks)
      .values({
        title,
        groupId: g(group),
        assigneeId: who.id,
        createdById: me.id,
        plannedDate: date,
        status: 'done',
        completedAt: doneAt,
        completedById: who.id,
        createdAt: addedAt,
        updatedAt: doneAt,
      })
      .returning()
      .get();
    db.insert(activity)
      .values([
        { memberId: me.id, via: 'app', action: 'task.created', taskId: task.id, detail: { title }, createdAt: addedAt },
        { memberId: who.id, via: n % 5 === 0 ? 'claude' : 'app', action: 'task.completed', taskId: task.id, createdAt: doneAt },
      ])
      .run();
  }
}

if (partner && asPartner) {
  createTasks(db, asMe, [{ title: 'Order printer ink', groupId: g('Errands'), assigneeId: partner.id }]);
  createTasks(db, asPartner, [
    { title: 'Schedule the vet appointment', groupId: g('Calls'), plannedDate: today, timeOfDay: 'morning' },
    { title: 'Plan the weekend hike', groupId: g('Hobby'), plannedDate: addDays(today, 3) },
  ]);
  const [handed] = createTasks(db, asPartner, [{ title: 'Change the furnace filter', groupId: g('Home') }]);
  assignTask(db, asPartner, handed!.id, me.id, 'The new filters are in the garage');
}

const groceries = resolveGroup(db, me, 'Groceries', 'list');
addListItems(db, asMe, groceries, [
  { name: 'Oat milk', quantity: '2' },
  { name: 'Eggs', quantity: '12' },
  { name: 'Spinach' },
  { name: 'Coffee beans' },
  { name: 'Lemons', quantity: '3' },
  { name: 'Bread' },
  { name: 'Butter' },
]);
checkListItems(db, asMe, groceries, ['Bread', 'Butter']);

console.log(`Demo household written to ${file}`);
