// List templates: premade kinds of list with their own look, fields, actions and starter kits.
// Picking one when making a list gives a list that already works the way that kind should. Each is
// a file in templates/, in an open format anyone can read or write (templates/README.md), so adding
// one is a JSON file and a line here.
import checklist from '../templates/default.json' with { type: 'json' };
import errands from '../templates/errands.json' with { type: 'json' };
import gifts from '../templates/gifts.json' with { type: 'json' };
import groceries from '../templates/groceries.json' with { type: 'json' };
import hardware from '../templates/hardware.json' with { type: 'json' };
import meals from '../templates/meals.json' with { type: 'json' };
import packing from '../templates/packing.json' with { type: 'json' };
import places from '../templates/places.json' with { type: 'json' };
import routine from '../templates/routine.json' with { type: 'json' };
import shopping from '../templates/shopping.json' with { type: 'json' };
import watch from '../templates/watch.json' with { type: 'json' };

export interface StarterItem {
  name: string;
  section?: string;
  quantity?: string;
}

export interface ListTemplate {
  id: string;
  name: string;
  /** One line for the picker. */
  description: string;
  icon: string;
  color: string;
  /** What the add field says. */
  placeholder: string;
  /**
   * How items are sorted into sections. With `options`, a new list starts with those, in that
   * order; without, sections are whatever people type, like who a gift is for. Each list can
   * change its own.
   */
  sections?: {
    /** What one is called: "Aisle", "For", "Place". */
    label: string;
    options?: string[];
    /** People name their own as they add, like who a gift is for. */
    free?: boolean;
    /** The heading for items in no section. */
    none?: string;
    /** The sections are weekdays, shown from today on (a meal plan). */
    days?: boolean;
  };
  /** Extra fields each item can have. Every list has a name and a note. */
  fields: { quantity?: boolean; url?: boolean; price?: boolean; store?: boolean; parts?: boolean };
  /** What checked items are called, where they wait to be added again. */
  checked: string;
  /** What the list itself can do, shown as chips above it. */
  actions?: {
    /** The whole list plans as one task, like a grocery run. */
    trip?: { title: string; minutes: number };
    /** "Start over" unchecks everything, for a list used again and again, like packing. */
    reset?: boolean;
    /** Each item's parts go to the household's list of this template in one tap: a meal's ingredients to Groceries. */
    sendParts?: string;
  };
  /** New lists of this kind start out visible only to the person who made them. */
  private?: boolean;
  /** Ready-made items to start from. The first is picked unless someone picks another or none. */
  kits?: { name: string; items: StarterItem[] }[];
  /** A hint for smart add about how this kind of list is used. */
  hint?: string;
}

/** The built-in templates, in the order the picker shows them. */
export const LIST_TEMPLATES: ListTemplate[] = [checklist, groceries, shopping, packing, gifts, errands, meals, hardware, watch, places, routine];

export const WEEKDAYS = meals.sections.options;
export const GROCERY_AISLES = groceries.sections.options;

export function listTemplate(id: string | null | undefined): ListTemplate {
  return LIST_TEMPLATES.find((t) => t.id === id) ?? LIST_TEMPLATES[0]!;
}

/**
 * A list's sections in order: its own if someone changed them, else its template's, then any
 * others its items use (free-form ones like people and places), in the order given.
 */
export function listSections(group: { template: string | null; sections?: string[] | null }, used: (string | null)[] = []): string[] {
  const base = group.sections ?? listTemplate(group.template).sections?.options ?? [];
  const seen = new Set(base.map((s) => s.toLowerCase()));
  const extra: string[] = [];
  for (const s of used) {
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      extra.push(s);
    }
  }
  return [...base, ...extra];
}

/** The weekdays starting from `today`'s (an ISO weekday, 1 is Monday), for a meal plan. */
export function weekFrom(isoWeekday: number) {
  return [...WEEKDAYS.slice(isoWeekday - 1), ...WEEKDAYS.slice(0, isoWeekday - 1)];
}

/** The task that plans a list's trip: "Grocery run", or "Costco run" for a list with its own name. */
export function tripTitle(group: { name: string; template: string | null }) {
  const template = listTemplate(group.template);
  if (!template.actions?.trip) return null;
  return group.name.trim().toLowerCase() === template.name.toLowerCase() ? template.actions.trip.title : `${group.name} run`;
}
