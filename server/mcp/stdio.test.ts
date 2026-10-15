// Starts the real stdio connector the way Claude Code does and drives it with the MCP client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/index.ts';
import { attachments, members, serverSettings, tasks } from '../db/schema.ts';
import { createFileStore } from '../lib/disk-files.ts';

const entry = fileURLToPath(new URL('../mcp-stdio.ts', import.meta.url));
let dataDir: string;
let client: Client;

type Result = { content: { type: string; text?: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as Result;
  const text = result.content[0]?.text ?? '';
  if (result.isError) return { error: text };
  return JSON.parse(text);
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amble-mcp-'));
  const db = openDatabase(path.join(dataDir, 'almanac.db'));
  db.insert(members).values({ email: 'jon@example.com', name: 'Jon Martin', timezone: 'America/Chicago', role: 'admin' }).run();
  db.insert(members).values({ email: 'alex@example.com', name: 'Alex B', timezone: 'America/Chicago' }).run();
  db.$client.close();

  client = new Client({ name: 'amble-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { AMBLE_DATA_DIR: dataDir, AMBLE_MEMBER: 'jon@example.com', PATH: process.env.PATH ?? '' },
      stderr: 'pipe',
    }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('local connector over stdio', () => {
  it('lists every tool with instructions naming the household', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_tasks',
      'add_to_list',
      'archive_tasks',
      'assign_task',
      'check_off_list_items',
      'complete_tasks',
      'create_group',
      'find_gap',
      'get_household',
      'get_backlog',
      'get_list',
      'get_load',
      'get_task',
      'get_today',
      'move_tasks',
      'plan_list_trip',
      'plan_week',
      'read_file',
      'search_tasks',
      'set_reminder',
      'suggest_day',
      'update_task',
    ].sort());
    const addTasks = tools.find((t) => t.name === 'add_tasks')!;
    expect(JSON.stringify(addTasks.inputSchema)).toContain('planned');
    expect(client.getInstructions()).toMatch(/acting for Jon Martin, who shares it with Alex B/);
  });

  it('runs a day through Claude: add, plan, complete, hand off, shop', async () => {
    const household = await call('get_household');
    expect(household.groups.map((g: { name: string }) => g.name)).toContain('Groceries');

    const added = await call('add_tasks', {
      tasks: [
        { title: 'Call the dentist', group: 'calls', planned: 'today', estimate_minutes: 10 },
        { title: 'Fix the fence', group: 'Home', due: 'tomorrow', subtasks: ['Buy screws'] },
      ],
    });
    expect(added).toMatchObject([
      { title: 'Call the dentist', group: 'Calls', for: 'me', estimateMinutes: 10 },
      { title: 'Fix the fence', group: 'Home', subtasks: ['[ ] Buy screws'] },
    ]);
    const [dentist, fence] = added as { id: string }[];
    expect(dentist!.id).toHaveLength(8);

    const today = await call('get_today');
    expect(today.planned.map((t: { title: string }) => t.title)).toEqual(['Call the dentist']);

    await call('complete_tasks', { ids: [dentist!.id] });
    expect((await call('get_today')).doneToday).toEqual(['Call the dentist']);

    expect(await call('assign_task', { id: fence!.id, to: 'Alex', note: 'You have the drill' })).toMatchObject({
      for: 'Alex',
      handedBackNote: 'You have the drill',
    });
    expect(await call('update_task', { id: fence!.id, check_subtasks: ['Buy screws'], planned: null })).toMatchObject({
      subtasks: ['[x] Buy screws'],
    });

    const listed = await call('add_to_list', { items: [{ name: 'Oat milk', quantity: '2' }, { name: 'Coffee' }] });
    expect(listed.list).toBe('Groceries');
    await call('check_off_list_items', { items: ['coffee'] });
    expect((await call('get_list')).items).toEqual([expect.objectContaining({ name: 'Oat milk', quantity: '2', section: 'Dairy & eggs' })]);

    await call('create_group', { name: 'Meal plan', kind: 'list', template: 'meals' });
    const meal = await call('add_to_list', { list: 'Meal plan', items: [{ name: 'Tacos', section: 'Friday', ingredients: ['Tortillas', 'Salsa'] }] });
    expect(meal.items).toEqual([expect.objectContaining({ name: 'Tacos', section: 'Friday', ingredients: ['Tortillas', 'Salsa'], outcome: 'added' })]);
    const trip = await call('plan_list_trip', { day: 'tomorrow' });
    expect(trip).toMatchObject({ title: 'Grocery run', tripFor: 'Groceries', outcome: 'planned' });
    expect((await call('get_list')).trip).toMatchObject({ title: 'Grocery run' });
    expect(await call('plan_list_trip', { list: 'Meal plan', day: 'today' })).toMatchObject({ error: expect.stringMatching(/plans as a trip/) });

    const gap = await call('find_gap', { due: 'tomorrow', estimate_minutes: 45 });
    expect(gap.fits).toBe(true);

    await call('add_tasks', { tasks: [{ title: 'Renew the car registration', due: 'today', estimate_minutes: 20 }] });
    const suggested = await call('suggest_day');
    expect(suggested.suggestions).toEqual([expect.objectContaining({ title: 'Renew the car registration', reason: "It's due today. It fits in the time today has left." })]);
    expect((await call('get_today')).load).toMatchObject({ plannedMinutes: 0 });

    const week = await call('plan_week');
    expect(week.days).toHaveLength(7);
    expect(week.plan.map((p: { title: string }) => p.title)).toContain('Renew the car registration');
  });

  it('sets reminders only for the person, and opens photos and notes on a task', async () => {
    const tomorrow = Temporal.Now.plainDateISO('America/Chicago').add({ days: 1 }).toString();
    const [vet] = (await call('add_tasks', { tasks: [{ title: 'Call the vet', remind_at: `${tomorrow}T18:00` }] })) as { id: string; remindMe: string }[];
    expect(vet!.remindMe).toBe(`${tomorrow}T18:00`);
    // Nobody has turned notifications on here, so Claude hears it can't reach them yet.
    expect(await call('set_reminder', { id: vet!.id, at: `${tomorrow}T09:30` })).toMatchObject({
      remindMe: `${tomorrow}T09:30`,
      note: expect.stringContaining('Notifications'),
    });
    // Once the server syncs with a household's devices, the reminder reaches Jon's phone that way.
    const synced = openDatabase(path.join(dataDir, 'almanac.db'));
    synced.insert(serverSettings).values({ key: 'sync', value: { target: { kind: 'household', fileId: 'f1', name: 'Home' } } }).run();
    synced.$client.close();
    const reminded = await call('set_reminder', { id: vet!.id, at: `${tomorrow}T10:00` });
    expect(reminded.remindMe).toBe(`${tomorrow}T10:00`);
    expect(reminded.note).toBeUndefined();
    expect((await call('set_reminder', { id: vet!.id, at: null })).remindMe).toBeUndefined();
    expect((await call('set_reminder', { id: vet!.id, at: 'tomorrow at 6' })).error).toMatch(/needs a date and a time/);

    // A photo, a note and a PDF on the task, stored the way the app stores them.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const store = createFileStore(dataDir);
    const save = (bytes: Buffer | string) => store.save(new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)]).stream(), 1_000_000);
    const db = openDatabase(path.join(dataDir, 'almanac.db'));
    const taskId = db.select().from(tasks).where(eq(tasks.title, 'Call the vet')).get()!.id;
    db.insert(attachments)
      .values([
        { taskId, name: 'card.png', mime: 'image/png', ...(await save(png)) },
        { taskId, name: 'vet.txt', mime: 'text/plain', ...(await save('Dr. Ruiz, 555-0100')) },
        { taskId, name: 'records.pdf', mime: 'application/pdf', ...(await save('%PDF-1.4')) },
      ])
      .run();
    db.$client.close();

    const detail = await call('get_task', { id: vet!.id });
    expect(detail.files).toEqual([
      expect.stringMatching(/^card\.png \(image\/png, 1 KB, id [0-9a-f]{8}\)$/),
      expect.stringMatching(/^vet\.txt/),
      expect.stringMatching(/^records\.pdf/),
    ]);
    const ids = (detail.files as string[]).map((f) => f.match(/id ([0-9a-f]{8})/)![1]!);
    const open = (id: string) => client.callTool({ name: 'read_file', arguments: { id } }) as Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }>;
    expect((await open(ids[0]!)).content[1]).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    expect((await open(ids[1]!)).content[0]!.text).toBe('vet.txt:\n\nDr. Ruiz, 555-0100');
    expect(await open(ids[2]!)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("can't be opened") }] });
  });

  it('returns readable errors Claude can act on', async () => {
    expect(await call('add_tasks', { tasks: [{ title: 'x', group: 'Garden' }] })).toEqual({
      error: expect.stringContaining('No group called "Garden"'),
    });
    expect(await call('move_tasks', { ids: ['deadbeef'], to: 'someday' })).toEqual({
      error: expect.stringContaining("isn't a date"),
    });
    expect((await call('get_task', { id: 'deadbeef' })).error).toBe('No task with id deadbeef.');
  });
});
