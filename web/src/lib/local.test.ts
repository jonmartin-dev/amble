import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DayLoad, Group, ListItem, Session, Task, Today } from './api.ts';
import { addDays, todayIso } from './dates.ts';
import { addListItem, checkListItem, editTask, findTask, newTask, putTask, resetListItems } from './local.ts';

const ME = 'me-1';
const ALEX = 'alex-1';
// The planning day as this device sees it, so the tests hold at any hour.
const TODAY = todayIso();

let qc: QueryClient;

function task(fields: Partial<Task> & { id: string }): Task {
  return newTask(qc, { title: fields.id, ...fields });
}

function load(date: string, fields: Partial<DayLoad> = {}): DayLoad {
  return { date, weekday: 'Wed', tasks: 0, mustDo: 0, plannedMinutes: 0, guessed: 0, capacityMinutes: 60, baseCapacityMinutes: 60, eventMinutes: 0, events: 0, usualEventMinutes: 0, level: 'light', ...fields };
}

const today = (who = 'me') => qc.getQueryData<Today>(['today', who])!;
const titles = (list: Task[]) => list.map((t) => t.id);

beforeEach(() => {
  qc = new QueryClient();
  qc.setQueryData<Session>(['session'], {
    member: { id: ME, email: 'me@example.com', name: 'Me Person', avatarUrl: null, color: 'green', role: 'admin', theme: null, capacity: null, showStreaks: true, smartAdd: true },
    auth: { provider: 'Google', oidc: true, devEmails: [], privacyContact: '' },
  });
  qc.setQueryData<{ groups: Group[] }>(['groups'], {
    groups: [{ id: 'home', name: 'Home', icon: 'home', color: 'green', kind: 'tasks', template: null, sections: null, privateTo: null, open: 1 }],
  });
  const carried = task({ id: 'carried', plannedDate: addDays(TODAY, -1), groupId: 'home', estimateMinutes: 45 });
  qc.setQueryData<Today>(['today', 'me'], { today: TODAY, planned: [], carriedOver: [carried], due: [], done: [], load: load(TODAY) });
  qc.setQueryData<Today>(['today', ALEX], { today: TODAY, planned: [], carriedOver: [], due: [], done: [], load: load(TODAY) });
  qc.setQueryData<{ tasks: Task[] }>(['tasks', {}], { tasks: [carried] });
  qc.setQueryData<{ tasks: Task[] }>(['tasks', { unplanned: '1' }], { tasks: [] });
  qc.setQueryData<{ days: DayLoad[] }>(['load', TODAY, addDays(TODAY, 1), 'me'], { days: [load(TODAY), load(addDays(TODAY, 1))] });
});

describe('changes show in every view at once', () => {
  it('moves a task from carried over onto today, with its share of the load', () => {
    editTask(qc, 'carried', () => ({ plannedDate: TODAY }));
    expect(titles(today().carriedOver)).toEqual([]);
    expect(titles(today().planned)).toEqual(['carried']);
    expect(today().load).toMatchObject({ tasks: 1, plannedMinutes: 45, level: 'moderate' });
    expect(qc.getQueryData<{ days: DayLoad[] }>(['load', TODAY, addDays(TODAY, 1), 'me'])!.days[0]).toMatchObject({ tasks: 1, plannedMinutes: 45 });
  });

  it('finishing takes it out of the open lists and into done, freeing the day', () => {
    editTask(qc, 'carried', () => ({ plannedDate: TODAY }));
    editTask(qc, 'carried', () => ({ status: 'done', completedAt: new Date().toISOString() }));
    expect(titles(today().planned)).toEqual([]);
    expect(titles(today().done)).toEqual(['carried']);
    expect(today().load).toMatchObject({ tasks: 0, plannedMinutes: 0, level: 'light' });
    expect(qc.getQueryData<{ tasks: Task[] }>(['tasks', {}])!.tasks).toEqual([]);
    expect(qc.getQueryData<{ groups: Group[] }>(['groups'])!.groups[0]!.open).toBe(0);
    expect(findTask(qc, 'carried')?.status).toBe('done');
  });

  it("puts a new task where the server would, and not on someone else's day", () => {
    const fresh = task({ id: 'fresh', plannedDate: TODAY, mustDo: true });
    putTask(qc, null, fresh);
    expect(titles(today().planned)).toEqual(['fresh']);
    expect(titles(today(ALEX).planned)).toEqual([]);
    // Must-do first in the backlog.
    expect(titles(qc.getQueryData<{ tasks: Task[] }>(['tasks', {}])!.tasks)).toEqual(['fresh', 'carried']);
    // It has a day, so it isn't in the unplanned list.
    expect(qc.getQueryData<{ tasks: Task[] }>(['tasks', { unplanned: '1' }])!.tasks).toEqual([]);
    expect(fresh).toMatchObject({ assigneeId: ME, assigneeName: 'Me Person', createdByName: 'Me Person', status: 'open' });
  });

  it('a shared task shows on everyone\'s day, and handing it over moves it', () => {
    putTask(qc, null, task({ id: 'shared', plannedDate: TODAY, assigneeId: null }));
    expect(titles(today().planned)).toEqual(['shared']);
    expect(titles(today(ALEX).planned)).toEqual(['shared']);
    editTask(qc, 'shared', () => ({ assigneeId: ALEX }));
    expect(titles(today().planned)).toEqual([]);
    expect(titles(today(ALEX).planned)).toEqual(['shared']);
  });

  it('a task due today and planned later shows as due, not planned', () => {
    putTask(qc, null, task({ id: 'due', dueDate: TODAY, plannedDate: addDays(TODAY, 6) }));
    expect(titles(today().due)).toEqual(['due']);
    expect(titles(today().planned)).toEqual([]);
  });
});

describe('lists change at once too', () => {
  const item = (fields: Partial<ListItem> & { id: string; name: string }): ListItem => ({
    groupId: 'groceries', quantity: null, note: null, section: null, url: null, price: null, store: null, parts: null, checkedAt: null, ...fields,
  });

  beforeEach(() => {
    qc.setQueryData(['list', 'groceries'], {
      group: { id: 'groceries', name: 'Groceries', icon: 'shopping-cart', color: 'green', kind: 'list', template: 'groceries', sections: null, privateTo: null, open: 1 },
      open: [item({ id: 'milk', name: 'Milk' })],
      checked: [item({ id: 'eggs', name: 'Eggs', checkedAt: '2026-10-10T12:00:00Z' })],
    });
    qc.setQueryData<{ groups: Group[] }>(['groups'], (d) => ({
      groups: [...d!.groups, { id: 'groceries', name: 'Groceries', icon: 'shopping-cart', color: 'green', kind: 'list', template: 'groceries', sections: null, privateTo: null, open: 1 }],
    }));
  });

  const list = () => qc.getQueryData<{ open: ListItem[]; checked: ListItem[] }>(['list', 'groceries'])!;
  const count = () => qc.getQueryData<{ groups: Group[] }>(['groups'])!.groups.find((g) => g.id === 'groceries')!.open;

  it('adds like the server: new, already there, or back again', () => {
    expect(addListItem(qc, 'groceries', { id: 'n1', name: 'Bread' })).toBe('added');
    expect(addListItem(qc, 'groceries', { id: 'n2', name: 'milk', quantity: '2' })).toBe('already on the list');
    expect(addListItem(qc, 'groceries', { id: 'n3', name: 'Eggs' })).toBe('back on the list');
    expect(list().open.map((i) => `${i.name}${i.quantity ? ` x${i.quantity}` : ''}`)).toEqual(['Milk x2', 'Bread', 'Eggs']);
    expect(list().checked).toEqual([]);
    expect(count()).toBe(3);
  });

  it("keeps a new item's store and section, with no ingredients until it has some", () => {
    addListItem(qc, 'groceries', { id: 'n4', name: 'Rice', section: 'Pantry', store: 'Costco' });
    expect(list().open.find((i) => i.name === 'Rice')).toMatchObject({ section: 'Pantry', store: 'Costco', parts: null, checkedAt: null });
  });

  it('checks off, puts back and resets', () => {
    checkListItem(qc, 'groceries', 'milk', true);
    expect(list().open).toEqual([]);
    expect(list().checked.map((i) => i.name)).toEqual(['Milk', 'Eggs']);
    expect(count()).toBe(0);
    expect(resetListItems(qc, 'groceries')).toBe(2);
    expect(list().open.map((i) => i.name)).toEqual(['Milk', 'Eggs']);
    expect(count()).toBe(2);
  });
});
