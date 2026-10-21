// The open list template format (templates/README.md) as a schema: every file in templates/ is held
// to it by the tests, and templates/schema.json, for anyone else reading or writing templates, is
// made from it by scripts/template-schema.ts.
import { z } from 'zod';
import { GROUP_COLORS } from './household.ts';

export const TEMPLATE_FORMAT = 1;
export const SCHEMA_URL = 'https://raw.githubusercontent.com/jonmartin-dev/amble/main/templates/schema.json';

const text = (description: string) => z.string().trim().min(1).describe(description);
const id = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

const starterItem = z.strictObject({
  name: text('What the item is called.'),
  section: z.string().optional().describe('Which of the sections it goes in.'),
  quantity: z.string().optional().describe('How many or how much, as people write it: "2", "1 lb".'),
});

export const templateFile = z
  .strictObject({
    $schema: z.string().optional(),
    format: z.literal(TEMPLATE_FORMAT).describe('The version of this format. A reader skips a template whose format is newer than it knows.'),
    id: id.describe('Lowercase words joined by hyphens, unique, and the same for good: lists remember their template by it.'),
    name: text('What the picker calls it, and a new list’s name until someone changes it.'),
    description: text('One line for the picker: what this kind of list is for and what it does.'),
    icon: id.describe('A Material Symbols icon, by its name in lowercase with hyphens: "shopping-cart".'),
    color: z.enum(GROUP_COLORS).describe('One of seven tones; each app draws its own shade of it.'),
    placeholder: text('What the add field says while it is empty.'),
    sections: z
      .strictObject({
        label: text('What one section is called: "Aisle", "For", "Day".'),
        options: z.array(text('A section.')).min(1).optional().describe('The sections a new list starts with, in order. Each list can change its own.'),
        free: z.boolean().optional().describe('People name sections as they add, like who a gift is for.'),
        none: z.string().optional().describe('The heading for items in no section. "Other" when left out.'),
        days: z.boolean().optional().describe('The options are the weekdays Monday to Sunday, shown from today on, like a meal plan.'),
      })
      .optional()
      .describe('How items are sorted under headings. Left out, a list is one plain run of items.'),
    fields: z
      .strictObject({
        quantity: z.boolean().optional().describe('How many or how much.'),
        url: z.boolean().optional().describe('A link.'),
        price: z.boolean().optional().describe('A price.'),
        store: z.boolean().optional().describe('Which store, to filter by on the way round.'),
        parts: z.boolean().optional().describe('A list of parts, like a meal’s ingredients.'),
      })
      .describe('Extra fields each item can have. Every item has a name and a note.'),
    checked: text('What checked items are called, where they wait to be added again: "Recently got", "Packed".'),
    actions: z
      .strictObject({
        trip: z
          .strictObject({
            title: text('The task’s title: "Grocery run". A list with a name of its own uses that instead: "Costco run".'),
            minutes: z.int().min(5).max(480).describe('How long the trip takes, for planning the day around it.'),
          })
          .optional()
          .describe('The whole list plans as one task on a day, like a grocery run.'),
        reset: z.boolean().optional().describe('"Start over" unchecks everything, for a list used again and again.'),
        sendParts: id
          .optional()
          .describe('The id of a template: each item’s parts go to the household’s list of that kind in one tap, like a meal’s ingredients to Groceries.'),
      })
      .optional()
      .describe('What the list itself can do, beyond adding and checking off.'),
    private: z.boolean().optional().describe('A new list of this kind starts out seen only by the person who made it, like gift ideas.'),
    kits: z
      .array(
        z.strictObject({
          name: text('What the kit is called in the picker: "Camping".'),
          items: z.array(starterItem).min(1),
        }),
      )
      .min(1)
      .optional()
      .describe('Ready-made items a new list can start with. The first is picked unless someone picks another or none.'),
    hint: z.string().optional().describe('A line for an AI that sorts what people type into lists: how this kind of list is used.'),
  })
  .meta({
    title: 'List template',
    description: 'A kind of list, with its sections, item fields, actions and starter kits. See templates/README.md in the Amble repository.',
  });

export type TemplateFile = z.infer<typeof templateFile>;

/**
 * The JSON Schema for the format. Names starting with "x-" are left for apps to add their own
 * fields under; anything else unknown is a mistake.
 */
export function templateSchema() {
  const schema = z.toJSONSchema(templateFile, { target: 'draft-2020-12' }) as Record<string, unknown>;
  return { $schema: schema.$schema, $id: SCHEMA_URL, ...schema, patternProperties: { '^x-': {} } };
}
