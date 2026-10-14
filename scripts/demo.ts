// Fills a fresh database with a small, realistic household for screenshots and manual testing.
// Usage: node scripts/demo.ts <data-dir> <email> [name] [partner-email] [partner-name]
// Then run the app against it: ALMANAC_DATA_DIR=<data-dir> pnpm dev
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.ts';
import { openDatabase } from '../server/db/index.ts';
import { activity, calendarAccounts, calendarEvents, calendarSources, members, tasks } from '../server/db/schema.ts';
import { seedStarterGroups } from '../server/db/seed.ts';
import { WEEKDAYS } from '../shared/templates.ts';
import { createGroup, resolveGroup, type Actor } from '../server/domain/household.ts';
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
  { name: 'Oat milk', quantity: '2', section: 'Dairy & eggs' },
  { name: 'Eggs', quantity: '12', section: 'Dairy & eggs' },
  { name: 'Spinach', section: 'Produce' },
  { name: 'Lemons', quantity: '3', section: 'Produce' },
  { name: 'Avocados', quantity: '2', section: 'Produce' },
  { name: 'Sourdough', section: 'Bakery' },
  { name: 'Coffee beans', section: 'Pantry', store: 'Costco' },
  { name: 'Chicken thighs', quantity: '2 lbs', section: 'Meat & seafood' },
  { name: 'Dish soap', section: 'Household', store: 'Costco' },
  { name: 'Bread', section: 'Bakery' },
  { name: 'Butter', section: 'Dairy & eggs' },
]);
checkListItems(db, asMe, groceries, ['Bread', 'Butter']);

// Gift ideas are private, so the person they're for can't see them.
const gifts = createGroup(db, asMe, { name: 'Gift ideas', kind: 'list', template: 'gifts' });
addListItems(db, asMe, gifts, [
  { name: 'Pottery class for two', section: 'Mom', price: '$85', url: 'https://example.com/pottery' },
  { name: 'Wool hiking socks', section: 'Dad', price: '$24' },
  { name: 'Trail guidebook', section: 'Dad' },
  { name: 'Botanical Lego set', section: partnerName.split(' ')[0], price: '$50', url: 'https://example.com/lego' },
  { name: 'Concert tickets', section: partnerName.split(' ')[0], note: 'Check dates in March' },
]);

const day = (offset: number) => WEEKDAYS[Temporal.PlainDate.from(addDays(today, offset)).dayOfWeek - 1]!;
const meals = createGroup(db, asMe, { name: 'Meal plan', kind: 'list', template: 'meals' });
addListItems(db, asMe, meals, [
  { name: 'Sheet-pan chicken', section: day(0), parts: ['Chicken thighs', 'Sweet potatoes', 'Red onion', 'Lemons'] },
  { name: 'Tacos', section: day(1), parts: ['Ground beef', 'Tortillas', 'Salsa', 'Cheddar', 'Lettuce'] },
  { name: 'Leftovers', section: day(2) },
  { name: 'Pasta with greens', section: day(4), parts: ['Penne', 'Marinara', 'Parmesan', 'Spinach'] },
]);

const packing = createGroup(db, asMe, { name: 'Lake weekend', kind: 'list', template: 'packing' });
addListItems(db, asMe, packing, [{ name: 'Swimsuit', section: 'Clothes' }, { name: 'Paddleboard pump', section: 'Gear' }]);
checkListItems(db, asMe, packing, ['Socks', 'Toothbrush', 'Phone charger']);

// A calendar to plan around: a standing weekday standup (usual, so it leaves room alone), and a
// dentist visit and a dinner today on top of it. It's never synced from Google; the account's last
// sync is set far ahead so the server leaves it be.
const account = db
  .insert(calendarAccounts)
  .values({ memberId: me.id, subject: 'demo', email: me.email, refreshToken: 'demo', scope: 'demo', syncedAt: new Date('2100-01-01') })
  .returning()
  .get();
const source = db
  .insert(calendarSources)
  .values({ accountId: account.id, memberId: me.id, calendarId: me.email, name: me.name, color: '#4285f4', primary: true, counts: true, fullSyncAt: new Date('2100-01-01') })
  .returning()
  .get();
const at = (date: string, time: string) => new Date(Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(me.timezone).epochMilliseconds);
const event = (id: string, title: string, date: string, from: string, to: string, busy = true) => ({
  sourceId: source.id,
  memberId: me.id,
  eventId: id,
  uid: id,
  title,
  startAt: at(date, from),
  endAt: at(date, to),
  busy,
});
const allDay = (id: string, title: string, date: string, days: number, busy: boolean) => ({
  sourceId: source.id,
  memberId: me.id,
  eventId: id,
  uid: id,
  title,
  allDay: true,
  startAt: at(date, '00:00'),
  endAt: at(addDays(date, days), '00:00'),
  startDate: date,
  endDate: addDays(date, days),
  busy,
});
const events = [];
for (let d = -56; d <= 21; d++) {
  const date = addDays(today, d);
  if (Temporal.PlainDate.from(date).dayOfWeek <= 5) events.push(event(`standup-${d}`, 'Team standup', date, '09:30', '10:00'));
}
events.push(
  event('dentist', 'Dentist', today, '15:00', '16:00'),
  event('dinner', 'Dinner with Priya', today, '18:30', '20:30'),
  allDay('birthday', "Mom's birthday", addDays(today, 1), 1, false),
  event('soccer', 'Soccer practice pickup', addDays(today, 2), '17:00', '18:00'),
  allDay('trip', 'Lake weekend', addDays(today, 5), 2, true),
);
db.insert(calendarEvents).values(events).run();

console.log(`Demo household written to ${file}`);
