import { describe, expect, it } from 'vitest';
import { GROUP_ICONS } from '../server/domain/household.ts';
import { listSections, LIST_TEMPLATES, tripTitle, weekFrom } from './templates.ts';

describe('list templates', () => {
  it('each has an icon groups can use, and kits only use its own sections', () => {
    expect(new Set(LIST_TEMPLATES.map((t) => t.id)).size).toBe(LIST_TEMPLATES.length);
    for (const t of LIST_TEMPLATES) {
      expect(GROUP_ICONS, t.id).toContain(t.icon);
      for (const kit of t.kits ?? []) {
        for (const item of kit.items) if (item.section) expect(t.sections?.options, `${t.id} ${kit.name}`).toContain(item.section);
      }
    }
  });

  it("orders a list's sections: its own or the template's, then any its items use", () => {
    expect(listSections({ template: 'packing' }, ['Snacks', 'tech', null])).toEqual(['Clothes', 'Toiletries', 'Tech', 'Documents', 'Kids', 'Gear', 'Snacks']);
    expect(listSections({ template: 'gifts', sections: null }, ['Mom', 'Dad', 'mom'])).toEqual(['Mom', 'Dad']);
    expect(listSections({ template: 'groceries', sections: ['Fridge', 'Shelves'] })).toEqual(['Fridge', 'Shelves']);
  });

  it('names trips after the list, and starts a meal plan on today', () => {
    expect(tripTitle({ name: 'Groceries', template: 'groceries' })).toBe('Grocery run');
    expect(tripTitle({ name: 'Target', template: 'groceries' })).toBe('Target run');
    expect(tripTitle({ name: 'Packing', template: 'packing' })).toBeNull();
    expect(weekFrom(3)).toEqual(['Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday']);
  });
});
