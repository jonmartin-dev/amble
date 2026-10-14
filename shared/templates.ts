// List templates: premade kinds of list with their own look, fields and behavior. Picking one when
// making a list gives a list that already works the way that kind should. Adding a template here
// (and its icon in web/src/components/icons.tsx) is all a new one takes.

export interface ListTemplate {
  id: string;
  name: string;
  /** One line for the picker. */
  description: string;
  icon: string;
  color: string;
  /** Items are sorted into these, in this order. Smart add files new items into them. */
  sections?: string[];
  /** Extra fields each item can have. Every list has a name and a note. */
  fields: { quantity?: boolean; url?: boolean; price?: boolean };
  /** "Uncheck everything" for reusable lists, like packing for the next trip. */
  resettable?: boolean;
  /** Items a new list starts with. */
  starter?: { name: string; section?: string; quantity?: string }[];
  /** A hint for smart add about how this kind of list is used. */
  hint?: string;
}

export const LIST_TEMPLATES: ListTemplate[] = [
  {
    id: 'default',
    name: 'Checklist',
    description: 'A plain list. Checked items hide and can come back from history.',
    icon: 'checklist',
    color: 'green',
    fields: { quantity: true },
  },
  {
    id: 'groceries',
    name: 'Groceries',
    description: 'Sorted by aisle, with quantities, so the shop goes in one pass.',
    icon: 'shopping-cart',
    color: 'lime',
    sections: ['Produce', 'Bakery', 'Dairy & eggs', 'Meat & seafood', 'Pantry', 'Frozen', 'Drinks', 'Household', 'Personal care'],
    fields: { quantity: true },
    hint: 'Food and household supplies bought at a grocery store.',
  },
  {
    id: 'shopping',
    name: 'Shopping',
    description: 'Things to buy, with a link and price for each.',
    icon: 'shopping-bag',
    color: 'orange',
    fields: { url: true, price: true },
    hint: 'One-off purchases that are not groceries: gear, clothes, gifts, things for the house.',
  },
  {
    id: 'packing',
    name: 'Packing',
    description: 'Reusable: uncheck everything for the next trip.',
    icon: 'luggage',
    color: 'blue',
    sections: ['Clothes', 'Toiletries', 'Tech', 'Documents', 'Other'],
    fields: { quantity: true },
    resettable: true,
    starter: [
      { name: 'Phone charger', section: 'Tech' },
      { name: 'Toothbrush', section: 'Toiletries' },
      { name: 'Toothpaste', section: 'Toiletries' },
      { name: 'ID', section: 'Documents' },
      { name: 'Socks', section: 'Clothes' },
      { name: 'Underwear', section: 'Clothes' },
    ],
    hint: 'What to bring on a trip.',
  },
];

export function listTemplate(id: string | null | undefined): ListTemplate {
  return LIST_TEMPLATES.find((t) => t.id === id) ?? LIST_TEMPLATES[0]!;
}
