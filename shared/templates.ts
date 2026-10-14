// List templates: premade kinds of list with their own look, fields and behavior. Picking one when
// making a list gives a list that already works the way that kind should. Adding a template here
// (and its icon in GROUP_ICONS and web/src/components/icons.tsx) is all a new one takes.

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
  /** "Uncheck everything" for reusable lists, like packing for the next trip. */
  resettable?: boolean;
  /** The whole list plans as one task, like a grocery run. */
  trip?: { title: string; minutes: number };
  /** New lists of this kind start out visible only to the person who made them. */
  private?: boolean;
  /** Ready-made items to start from. The first is picked unless someone picks another or none. */
  kits?: { name: string; items: StarterItem[] }[];
  /** A hint for smart add about how this kind of list is used. */
  hint?: string;
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const GROCERY_AISLES = [
  'Produce',
  'Bakery',
  'Deli',
  'Meat & seafood',
  'Dairy & eggs',
  'Pantry',
  'Snacks',
  'Frozen',
  'Drinks',
  'Household',
  'Personal care',
  'Pets',
];

const kit = (section: string, names: string[]): StarterItem[] => names.map((name) => ({ name, section }));

export const LIST_TEMPLATES: ListTemplate[] = [
  {
    id: 'default',
    name: 'Checklist',
    description: 'A plain list. Checked items hide and can come back from history.',
    icon: 'checklist',
    color: 'green',
    placeholder: 'Add an item',
    sections: { label: 'Section' },
    fields: { quantity: true },
    checked: 'Done',
  },
  {
    id: 'groceries',
    name: 'Groceries',
    description: 'Sorted by aisle as you type, with quantities and stores, so the shop goes in one pass.',
    icon: 'shopping-cart',
    color: 'lime',
    placeholder: 'Add groceries',
    sections: { label: 'Aisle', options: GROCERY_AISLES },
    fields: { quantity: true, store: true },
    checked: 'Recently got',
    trip: { title: 'Grocery run', minutes: 45 },
    hint: 'Food and household supplies bought at a grocery store.',
  },
  {
    id: 'shopping',
    name: 'Shopping',
    description: 'Things to buy, with a link, price and store for each.',
    icon: 'shopping-bag',
    color: 'orange',
    placeholder: 'Add something to buy',
    fields: { url: true, price: true, store: true },
    checked: 'Bought',
    hint: 'One-off purchases that are not groceries: gear, clothes, things for the house.',
  },
  {
    id: 'packing',
    name: 'Packing',
    description: 'Reusable: uncheck everything for the next trip. Starts from a kit.',
    icon: 'luggage',
    color: 'blue',
    placeholder: 'Add something to pack',
    sections: { label: 'Section', options: ['Clothes', 'Toiletries', 'Tech', 'Documents', 'Kids', 'Gear'] },
    fields: { quantity: true },
    checked: 'Packed',
    resettable: true,
    kits: [
      {
        name: 'Weekend away',
        items: [
          ...kit('Clothes', ['Socks', 'Underwear', 'Pajamas', 'Shirts', 'Pants']),
          ...kit('Toiletries', ['Toothbrush', 'Toothpaste', 'Deodorant', 'Medications']),
          ...kit('Tech', ['Phone charger', 'Headphones']),
          ...kit('Documents', ['ID', 'Wallet']),
        ],
      },
      {
        name: 'Beach',
        items: [
          ...kit('Clothes', ['Swimsuit', 'Cover-up', 'Sandals', 'Sun hat', 'Sunglasses']),
          ...kit('Toiletries', ['Sunscreen', 'After-sun lotion', 'Toothbrush']),
          ...kit('Gear', ['Beach towels', 'Beach bag', 'Water bottles', 'Book']),
          ...kit('Tech', ['Phone charger']),
        ],
      },
      {
        name: 'Camping',
        items: [
          ...kit('Gear', ['Tent', 'Sleeping bags', 'Sleeping pads', 'Headlamps', 'Camp stove', 'Fuel', 'Lighter', 'Cooler', 'First aid kit', 'Water filter']),
          ...kit('Clothes', ['Rain jacket', 'Warm layer', 'Hiking boots', 'Wool socks']),
          ...kit('Toiletries', ['Bug spray', 'Sunscreen', 'Toilet paper']),
        ],
      },
      {
        name: 'Flying',
        items: [
          ...kit('Documents', ['Passport', 'Boarding passes', 'ID']),
          ...kit('Tech', ['Phone charger', 'Headphones', 'Power bank', 'Travel adapter']),
          ...kit('Toiletries', ['Travel-size liquids', 'Toothbrush', 'Medications']),
          ...['Neck pillow', 'Snacks', 'Empty water bottle'].map((name) => ({ name })),
        ],
      },
      {
        name: 'Little ones',
        items: kit('Kids', ['Diapers', 'Wipes', 'Bottles', 'Snacks', 'Change of clothes', 'Favorite toy', 'Stroller', 'Car seat']),
      },
    ],
    hint: 'What to bring on a trip.',
  },
  {
    id: 'gifts',
    name: 'Gift ideas',
    description: 'Ideas by who they’re for, with links and prices. Private, so nobody sees their own.',
    icon: 'redeem',
    color: 'rose',
    placeholder: 'Add a gift idea',
    sections: { label: 'For', none: 'Not sure who yet', free: true },
    fields: { url: true, price: true },
    checked: 'Given',
    private: true,
    hint: 'Gift ideas for people, each under who it is for.',
  },
  {
    id: 'errands',
    name: 'Errand run',
    description: 'Stops grouped by place, and the whole run plans as one task.',
    icon: 'location-on',
    color: 'teal',
    placeholder: 'Add an errand',
    sections: { label: 'Place', none: 'Anywhere', free: true },
    fields: { quantity: true },
    checked: 'Done',
    trip: { title: 'Errand run', minutes: 60 },
    hint: 'Quick stops while out: returns, pickups, drop-offs, each under the place it happens.',
  },
  {
    id: 'meals',
    name: 'Meal plan',
    description: 'Dinners for the next seven days, and their ingredients to Groceries in one tap.',
    icon: 'dinner-dining',
    color: 'orange',
    placeholder: 'Add a meal',
    sections: { label: 'Day', options: WEEKDAYS, none: 'Any day', days: true },
    fields: { parts: true },
    checked: 'Cooked',
    hint: 'Meals planned for days of the week, each with its ingredients.',
  },
  {
    id: 'hardware',
    name: 'Hardware store',
    description: 'Sorted by department, and the trip plans as one task.',
    icon: 'hardware',
    color: 'violet',
    placeholder: 'Add something to get',
    sections: {
      label: 'Department',
      options: ['Lumber & building', 'Paint', 'Plumbing', 'Electrical', 'Tools', 'Fasteners', 'Garden', 'Cleaning & storage'],
    },
    fields: { quantity: true, price: true },
    checked: 'Got',
    trip: { title: 'Hardware store run', minutes: 45 },
    hint: 'Supplies for projects and repairs around the house.',
  },
  {
    id: 'watch',
    name: 'Watch & read',
    description: 'Movies, shows, books and more that someone recommended.',
    icon: 'movie',
    color: 'blue',
    placeholder: 'Add a movie, show or book',
    sections: { label: 'Kind', options: ['Movies', 'Shows', 'Books', 'Podcasts', 'Games'] },
    fields: { url: true },
    checked: 'Finished',
    hint: 'Movies, shows, books, podcasts and games to get to.',
  },
  {
    id: 'places',
    name: 'Places to try',
    description: 'Restaurants, day trips and things to do, for when you can’t think of one.',
    icon: 'map',
    color: 'green',
    placeholder: 'Add a place',
    sections: { label: 'Kind', options: ['Restaurants', 'Coffee & treats', 'Day trips', 'Things to do'] },
    fields: { url: true },
    checked: 'Been there',
    hint: 'Restaurants, cafes, day trips and outings to try someday.',
  },
  {
    id: 'routine',
    name: 'Routine',
    description: 'A checklist you run through again and again. Starts over when you’re done.',
    icon: 'repeat',
    color: 'teal',
    placeholder: 'Add a step',
    fields: {},
    checked: 'Done',
    resettable: true,
    kits: [
      {
        name: 'Before a trip',
        items: ['Take out the trash', 'Run the dishwasher', 'Water the plants', 'Set the thermostat', 'Unplug small appliances', 'Lock the windows', 'Hold the mail'].map(
          (name) => ({ name }),
        ),
      },
      {
        name: 'Weekly reset',
        items: ['Laundry', 'Change the sheets', 'Wipe the counters', 'Vacuum', 'Take out the recycling', 'Plan the week’s meals'].map((name) => ({ name })),
      },
      {
        name: 'Night',
        items: ['Lock the doors', 'Start the dishwasher', 'Set out tomorrow’s things', 'Charge phones', 'Lights off'].map((name) => ({ name })),
      },
    ],
    hint: 'Steps run through the same way each time.',
  },
];

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
  if (!template.trip) return null;
  return group.name.trim().toLowerCase() === template.name.toLowerCase() ? template.trip.title : `${group.name} run`;
}
