import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GROUP_ICONS } from '../server/domain/household.ts';
import { templateFile, templateSchema } from '../server/domain/templateFormat.ts';
import { listSections, LIST_TEMPLATES, tripTitle, weekFrom, WEEKDAYS } from './templates.ts';

const dir = new URL('../templates/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'schema.json');

describe('list templates', () => {
  it('are each a file in the open format, named by its id, and all in the picker', () => {
    for (const f of files) {
      const parsed = templateFile.safeParse(JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')));
      expect(parsed.error?.issues, f).toBeUndefined();
      expect(`${parsed.data?.id}.json`).toBe(f);
    }
    expect(LIST_TEMPLATES.map((t) => `${t.id}.json`).sort()).toEqual(files.sort());
  });

  it('keeps templates/schema.json in step with the format', () => {
    const published = JSON.parse(fs.readFileSync(new URL('schema.json', dir), 'utf8'));
    expect(published, 'run node scripts/template-schema.ts').toEqual(templateSchema());
  });

  it('each has an icon Amble draws, kits only use its own sections, and its actions make sense', () => {
    for (const t of LIST_TEMPLATES) {
      expect(GROUP_ICONS, t.id).toContain(t.icon);
      for (const kit of t.kits ?? []) {
        for (const item of kit.items) if (item.section && !t.sections?.free) expect(t.sections?.options, `${t.id} ${kit.name}`).toContain(item.section);
      }
      if (t.sections?.days) expect(t.sections.options, t.id).toEqual(WEEKDAYS);
      if (t.actions?.sendParts) {
        expect(t.fields.parts, `${t.id} sends parts it doesn't have`).toBe(true);
        expect(LIST_TEMPLATES.map((o) => o.id), t.id).toContain(t.actions.sendParts);
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
