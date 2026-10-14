// Starts the real stdio connector the way Claude Code does and drives it with the MCP client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/index.ts';
import { members } from '../db/schema.ts';

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almanac-mcp-'));
  const db = openDatabase(path.join(dataDir, 'almanac.db'));
  db.insert(members).values({ email: 'jon@example.com', name: 'Jon Martin', timezone: 'America/Chicago', role: 'admin' }).run();
  db.insert(members).values({ email: 'alex@example.com', name: 'Alex B', timezone: 'America/Chicago' }).run();
  db.$client.close();

  client = new Client({ name: 'almanac-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ALMANAC_DATA_DIR: dataDir, ALMANAC_MEMBER: 'jon@example.com', PATH: process.env.PATH ?? '' },
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
      'plan_week',
      'search_tasks',
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
    expect((await call('get_list')).items).toEqual([expect.objectContaining({ name: 'Oat milk', quantity: '2' })]);

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
