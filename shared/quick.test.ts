import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseQuick, quickTitle, type QuickField } from './quick.ts';

// Thursday, October 15, 2026, at 10am.
const TODAY = '2026-10-15';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 15, 10, 0));
});
afterEach(() => vi.useRealTimers());

const ALL: QuickField[] = ['plannedDate', 'dueDate', 'timeOfDay', 'remindAt', 'mustDo', 'repeat', 'group', 'person'];
const read = (text: string) => {
  const p = parseQuick(text, TODAY);
  const { spans: _, ...fields } = p;
  return { title: quickTitle(text, p, ALL), ...fields };
};

describe('quick add without AI', () => {
  it('reads days', () => {
    expect(read('call mom tomorrow')).toEqual({ title: 'call mom', plannedDate: '2026-10-16' });
    expect(read('dinner with the Lees tonight')).toEqual({ title: 'dinner with the Lees', plannedDate: TODAY, timeOfDay: 'evening' });
    expect(read('pick up the cake on Saturday')).toMatchObject({ title: 'pick up the cake', plannedDate: '2026-10-17' });
    expect(read('fri: return library books')).toMatchObject({ title: 'return library books', plannedDate: '2026-10-16' });
    expect(read('thursday standup notes')).toMatchObject({ plannedDate: TODAY });
    expect(read('book flights next week')).toMatchObject({ title: 'book flights', plannedDate: '2026-10-19' });
    expect(read('next friday car wash')).toMatchObject({ title: 'car wash', plannedDate: '2026-10-23' });
    expect(read('clean the garage this weekend')).toMatchObject({ title: 'clean the garage', plannedDate: '2026-10-17' });
    expect(read('taxes in 2 weeks')).toMatchObject({ title: 'taxes', plannedDate: '2026-10-29' });
    expect(read('vet oct 20')).toMatchObject({ title: 'vet', plannedDate: '2026-10-20' });
    expect(read('renew passport on the 3rd of March')).toMatchObject({ title: 'renew passport', plannedDate: '2027-03-03' });
    expect(read('pay rent on the 1st')).toMatchObject({ title: 'pay rent', plannedDate: '2026-11-01' });
    expect(read('dentist 10/22')).toMatchObject({ title: 'dentist', plannedDate: '2026-10-22' });
  });

  it('leaves alone words it is unsure of', () => {
    expect(read('sat down with the budget')).toEqual({ title: 'sat down with the budget' });
    expect(read('buy sun screen')).toEqual({ title: 'buy sun screen' });
    expect(read('read 3 chapters')).toEqual({ title: 'read 3 chapters' });
    expect(read('nov 31 party')).toEqual({ title: 'nov 31 party' });
    expect(read('2/30 thing')).toEqual({ title: '2/30 thing' });
  });

  it('keeps a clock time in the title and files it under the time of day', () => {
    expect(read('dentist thursday at 3')).toEqual({ title: 'dentist at 3', plannedDate: TODAY, timeOfDay: 'afternoon' });
    expect(read('standup at 9:30')).toEqual({ title: 'standup at 9:30', timeOfDay: 'morning' });
    expect(read('call the plumber tomorrow morning')).toEqual({ title: 'call the plumber', plannedDate: '2026-10-16', timeOfDay: 'morning' });
    expect(read('pizza night 7pm friday')).toMatchObject({ title: 'pizza night 7pm', timeOfDay: 'evening', plannedDate: '2026-10-16' });
  });

  it('reads deadlines', () => {
    expect(read('groceries by saturday')).toEqual({ title: 'groceries', dueDate: '2026-10-17' });
    expect(read('insurance form due oct 30')).toEqual({ title: 'insurance form', dueDate: '2026-10-30' });
  });

  it('reads reminders said first or at the end', () => {
    expect(read('remind me to call mom at 5')).toEqual({
      title: 'call mom',
      plannedDate: TODAY,
      remindAt: { date: TODAY, minutes: 17 * 60 },
      timeOfDay: 'evening',
    });
    expect(read('remind me to pay rent friday at 9am')).toEqual({
      title: 'pay rent',
      plannedDate: '2026-10-16',
      remindAt: { date: '2026-10-16', minutes: 9 * 60 },
      timeOfDay: 'morning',
    });
    expect(read('pay rent friday, remind me thursday at 6')).toEqual({
      title: 'pay rent',
      plannedDate: '2026-10-16',
      remindAt: { date: TODAY, minutes: 18 * 60 },
    });
    expect(read('water the lawn, remind me tomorrow')).toEqual({
      title: 'water the lawn',
      plannedDate: '2026-10-16',
      remindAt: { date: '2026-10-16', minutes: 9 * 60 },
      timeOfDay: 'morning',
    });
    // 8am has gone by at 10, so tomorrow.
    expect(read('remind me to take the pills at 8am')).toMatchObject({ title: 'take the pills', remindAt: { date: '2026-10-16', minutes: 8 * 60 } });
    expect(read('remind me to stretch today at 9')).toMatchObject({ plannedDate: '2026-10-16', remindAt: { date: '2026-10-16', minutes: 9 * 60 } });
  });

  it("moves a reminder that's gone by after midnight to the next one", () => {
    // 12:30am on Friday, still Thursday's planning day until 4am.
    vi.setSystemTime(new Date(2026, 9, 16, 0, 30));
    const p = parseQuick('pay rent friday, remind me thursday at 6', TODAY);
    expect(p.plannedDate).toBe('2026-10-16');
    expect(p.remindAt).toEqual({ date: '2026-10-22', minutes: 18 * 60 });
  });

  it('reads must-do, a group and a person', () => {
    expect(read('pay the water bill!')).toEqual({ title: 'pay the water bill', mustDo: true });
    expect(read('urgent: call the bank')).toEqual({ title: 'call the bank', mustDo: true });
    expect(read('fix the gate #home @alex')).toEqual({ title: 'fix the gate', group: 'home', person: 'alex' });
  });

  it('reads repeats', () => {
    expect(read('water the ferns every sunday')).toEqual({
      title: 'water the ferns',
      repeat: { mode: 'schedule', every: 1, unit: 'week', weekdays: [7] },
      plannedDate: '2026-10-18',
    });
    expect(read('take out the bins every monday and thursday')).toMatchObject({
      title: 'take out the bins',
      repeat: { unit: 'week', weekdays: [1, 4] },
      plannedDate: TODAY,
    });
    expect(read('vitamins daily')).toEqual({ title: 'vitamins', repeat: { mode: 'schedule', every: 1, unit: 'day' } });
    expect(read('change the furnace filter every other month')).toMatchObject({ title: 'change the furnace filter', repeat: { every: 2, unit: 'month' } });
  });

  it('gives back the words of a part the person sets themselves', () => {
    const text = 'sunday school supplies tomorrow';
    const p = parseQuick(text, TODAY);
    expect(p.plannedDate).toBe('2026-10-18');
    expect(quickTitle(text, p, ['timeOfDay'])).toBe(text);
  });
});
