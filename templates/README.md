# List templates

A list template is a kind of list that already knows how to behave. Groceries sort themselves by aisle as you type. A packing list starts over for the next trip. A meal plan sends each dinner's ingredients to Groceries in one tap.

Every template Amble ships with is one JSON file in this folder, written in an open format. Amble reads them, and so can anything else: a different app, a script, a website that shares templates. The format and these files are free to use for anything ([CC0](LICENSE)), no credit needed.

## Add one to Amble

1. Copy the file closest to what you want and rename it to your template's `id`.
2. Change what's different. Your editor checks the file against [`schema.json`](schema.json) as you type.
3. Add it to `LIST_TEMPLATES` in [`shared/templates.ts`](../shared/templates.ts), where you want it to appear in the picker.
4. Run `pnpm test`. It catches a misspelled field, a kit item in a section the list doesn't have, or an icon Amble can't draw yet.

Then open a pull request. A good template is one you'd use every week: a pharmacy run, a moving checklist, a garden plan. Amble draws the icons listed in `GROUP_ICONS` in [`server/domain/household.ts`](../server/domain/household.ts). A new one goes there and in `web/src/components/icons.tsx` too.

## The format

This is version 1. Here is a whole template:

```json
{
  "$schema": "https://raw.githubusercontent.com/jonmartin-dev/amble/main/templates/schema.json",
  "format": 1,
  "id": "errands",
  "name": "Errand run",
  "description": "Stops grouped by place, and the whole run plans as one task.",
  "icon": "location-on",
  "color": "teal",
  "placeholder": "Add an errand",
  "sections": { "label": "Place", "none": "Anywhere", "free": true },
  "fields": { "quantity": true },
  "checked": "Done",
  "actions": { "trip": { "title": "Errand run", "minutes": 60 } },
  "hint": "Quick stops while out: returns, pickups, drop-offs, each under the place it happens."
}
```

| Field | | What it is |
|---|---|---|
| `format` | required | `1`. A reader skips a template whose format is newer than it knows. |
| `id` | required | Lowercase words joined by hyphens. Lists remember their template by it, so it never changes. |
| `name` | required | What the picker calls it, and a new list's name until someone renames it. |
| `description` | required | One line for the picker. |
| `icon` | required | A [Material Symbols](https://fonts.google.com/icons) name in lowercase with hyphens, like `shopping-cart`. |
| `color` | required | One of `green`, `teal`, `lime`, `blue`, `violet`, `orange`, `rose`. Each app draws its own shade. |
| `placeholder` | required | What the add field says while it's empty. |
| `fields` | required | Extra fields each item can have, each `true` or left out: `quantity`, `url`, `price`, `store`, `parts`. Every item already has a name and a note. |
| `checked` | required | What checked-off items are called while they wait to be added again: "Recently got", "Packed". |
| `sections` | | How items are grouped under headings. Leave it out for one plain list. |
| `actions` | | What the list itself can do. |
| `private` | | `true` makes a new list of this kind visible only to the person who made it, like gift ideas. |
| `kits` | | Ready-made items a new list can start with. |
| `hint` | | One line for an AI that sorts what people type into lists: how this kind of list is used. |

### Sections

| Field | What it is |
|---|---|
| `label` | What one section is called: "Aisle", "For", "Day". |
| `options` | The sections a new list starts with, in order. People can change their own list's sections afterwards. |
| `free` | `true` lets people name sections as they add, like who a gift is for. |
| `none` | The heading for items in no section. Readers show "Other" when it's left out. |
| `days` | `true` means the options are the weekdays, Monday to Sunday, shown starting from today, like a meal plan. |

### Actions

Actions are what make a template more than a checklist. Amble shows each one as a chip above the list.

| Action | What it does |
|---|---|
| `trip` | `{ "title": "Grocery run", "minutes": 45 }`. The whole list plans as one task on a day with room. A list with a name of its own uses that instead, like "Costco run". |
| `reset` | `true` adds "Start over", which unchecks everything for the next time. For packing lists and routines. |
| `sendParts` | The `id` of another template. Each item's parts go to the household's list of that kind in one tap, like a meal's ingredients to Groceries. Needs `fields.parts`. |

### Kits

A kit is a named set of starter items: `{ "name": "Camping", "items": [{ "name": "Tent", "section": "Gear" }] }`. Each item has a `name`, and can have a `section` and a `quantity` ("2", "1 lb"). An item's section has to be one of the template's `options`, unless its sections are `free`. When there are several kits, the first is picked unless someone picks another or none.

### Your own fields

A top-level field whose name starts with `x-`, like `x-myapp-sort`, is yours to add. Readers ignore fields they don't know. Any other field the format doesn't list is a mistake, and the schema rejects it.

## License

The files in this folder, this description and [`schema.json`](schema.json) are dedicated to the public domain under [CC0 1.0](LICENSE). The rest of Amble is under the AGPL.
