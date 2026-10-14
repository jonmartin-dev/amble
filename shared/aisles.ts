// Guesses a grocery item's aisle from its name, for when the list's history doesn't know it and
// smart add isn't there (or the phone is offline). A good guess is enough: once someone moves an
// item, the list's history remembers where it goes.

const AISLES: Record<string, string[]> = {
  Produce: [
    'apple', 'banana', 'orange', 'lemon', 'lime', 'grape', 'berry', 'strawberry', 'blueberry', 'raspberry', 'blackberry',
    'avocado', 'tomato', 'potato', 'sweet potato', 'yam', 'onion', 'red onion', 'garlic', 'ginger', 'carrot', 'celery',
    'lettuce', 'romaine', 'spinach', 'kale', 'arugula', 'cabbage', 'broccoli', 'cauliflower', 'cucumber', 'zucchini',
    'squash', 'bell pepper', 'peppers', 'jalapeno', 'jalapeño', 'mushroom', 'pear', 'peach', 'plum', 'cherry', 'mango', 'pineapple',
    'melon', 'watermelon', 'cantaloupe', 'kiwi', 'cilantro', 'parsley', 'basil', 'mint', 'dill', 'rosemary', 'thyme',
    'scallion', 'green onion', 'leek', 'shallot', 'asparagus', 'beet', 'radish', 'salad', 'salad mix', 'sprouts',
    'green beans', 'corn on the cob', 'fruit', 'veggies', 'vegetables', 'clementine', 'grapefruit', 'nectarine', 'fig',
    'pomegranate', 'eggplant', 'brussels sprouts', 'bok choy', 'herbs',
  ],
  Bakery: [
    'bread', 'sourdough', 'bagel', 'baguette', 'bun', 'roll', 'croissant', 'muffin', 'english muffin', 'pita', 'naan',
    'cake', 'pie', 'donut', 'doughnut', 'loaf', 'brioche', 'ciabatta', 'tortilla',
  ],
  Deli: ['deli meat', 'lunch meat', 'sliced turkey', 'deli turkey', 'salami', 'prosciutto', 'pepperoni', 'hummus', 'rotisserie chicken', 'olives'],
  'Meat & seafood': [
    'chicken', 'beef', 'ground beef', 'pork', 'steak', 'turkey', 'ground turkey', 'bacon', 'sausage', 'ham', 'lamb',
    'fish', 'salmon', 'shrimp', 'cod', 'tilapia', 'crab', 'lobster', 'scallops', 'meatballs', 'ribs', 'brisket',
    'pork chops', 'hot dogs', 'chorizo',
  ],
  'Dairy & eggs': [
    'milk', 'cheese', 'cheddar', 'mozzarella', 'parmesan', 'feta', 'brie', 'yogurt', 'yoghurt', 'butter', 'cream',
    'heavy cream', 'whipping cream', 'sour cream', 'cream cheese', 'half and half', 'egg', 'creamer', 'cottage cheese',
    'kefir', 'ricotta', 'string cheese',
  ],
  Pantry: [
    'rice', 'pasta', 'spaghetti', 'penne', 'noodles', 'ramen', 'flour', 'sugar', 'brown sugar', 'salt', 'black pepper',
    'pepper', 'oil', 'olive oil', 'vegetable oil', 'vinegar', 'sauce', 'pasta sauce', 'marinara', 'soy sauce', 'hot sauce',
    'ketchup', 'mustard', 'mayo', 'mayonnaise', 'honey', 'syrup', 'maple syrup', 'jam', 'jelly', 'peanut butter',
    'almond butter', 'nutella', 'cereal', 'oats', 'oatmeal', 'granola', 'beans', 'black beans', 'chickpeas', 'lentils',
    'broth', 'stock', 'soup', 'coconut milk', 'canned tomatoes', 'tomato paste', 'coffee', 'coffee beans', 'tea',
    'spices', 'cinnamon', 'cumin', 'paprika', 'oregano', 'chili powder', 'baking soda', 'baking powder', 'yeast',
    'vanilla', 'salsa', 'tuna', 'quinoa', 'couscous', 'breadcrumbs', 'taco shells', 'mac and cheese', 'pancake mix',
    'chocolate chips', 'cornstarch', 'dressing', 'salad dressing', 'bbq sauce', 'pickles', 'croutons', 'tortilla chips',
  ],
  Snacks: [
    'chips', 'potato chips', 'crackers', 'cookies', 'pretzels', 'popcorn', 'nuts', 'almonds', 'cashews', 'peanuts',
    'walnuts', 'granola bars', 'protein bars', 'chocolate', 'candy', 'trail mix', 'fruit snacks', 'goldfish', 'gum',
  ],
  Frozen: [
    'frozen', 'ice cream', 'pizza', 'frozen pizza', 'waffles', 'frozen waffles', 'popsicles', 'ice', 'frozen peas',
    'frozen vegetables', 'frozen fruit', 'frozen berries', 'tater tots', 'fries', 'french fries', 'dumplings', 'gelato',
  ],
  Drinks: [
    'water', 'sparkling water', 'seltzer', 'soda', 'juice', 'orange juice', 'apple juice', 'lemonade', 'beer', 'wine',
    'kombucha', 'coconut water', 'sports drink', 'gatorade', 'energy drink', 'cold brew', 'la croix', 'coke', 'sprite',
  ],
  Household: [
    'paper towels', 'toilet paper', 'dish soap', 'soap', 'detergent', 'laundry detergent', 'trash bags', 'garbage bags',
    'sponge', 'sponges', 'bleach', 'aluminum foil', 'foil', 'plastic wrap', 'zip bags', 'ziploc', 'ziploc bags', 'napkins',
    'batteries', 'light bulbs', 'cleaner', 'all-purpose cleaner', 'disinfecting wipes', 'dryer sheets', 'dishwasher pods',
    'dishwasher detergent', 'fabric softener', 'parchment paper', 'paper plates', 'candles', 'matches',
  ],
  'Personal care': [
    'shampoo', 'conditioner', 'toothpaste', 'toothbrush', 'floss', 'mouthwash', 'deodorant', 'hand soap', 'body wash',
    'lotion', 'sunscreen', 'razor', 'razors', 'shaving cream', 'tampons', 'pads', 'vitamins', 'medicine', 'ibuprofen',
    'tylenol', 'advil', 'band-aids', 'bandaids', 'tissues', 'kleenex', 'cotton swabs', 'q-tips', 'diapers', 'baby wipes',
    'wipes', 'contact solution', 'lip balm', 'chapstick', 'face wash', 'hair ties',
  ],
  Pets: ['dog food', 'cat food', 'cat litter', 'litter', 'dog treats', 'cat treats', 'pet food', 'poop bags', 'flea treatment'],
};

const index = new Map<string, string>();
for (const [aisle, words] of Object.entries(AISLES)) for (const w of words) index.set(w, aisle);

/** Singular-ish forms of a word, to look up "lemons", "tomatoes" and "berries". */
function forms(word: string) {
  const out = [word];
  if (word.endsWith('ies')) out.push(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) out.push(word.slice(0, -2));
  if (word.endsWith('s')) out.push(word.slice(0, -1));
  return out;
}

function lookup(phrase: string) {
  for (const f of [phrase, ...forms(phrase).slice(1)]) {
    const hit = index.get(f);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The aisle a grocery item most likely goes in, among `aisles` (a list's own sections), or null.
 * The whole name is tried first ("peanut butter"), then its endings ("oat milk" is milk), then
 * each word from the last, since in English the last word usually says what the thing is.
 */
export function guessAisle(name: string, aisles: string[]): string | null {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'&-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  const allowed = (aisle: string | undefined) => (aisle ? (aisles.find((a) => a.toLowerCase() === aisle.toLowerCase()) ?? null) : null);
  if (words[0] === 'frozen' && allowed('Frozen')) return allowed('Frozen');
  for (let start = 0; start < words.length; start++) {
    const hit = allowed(lookup(words.slice(start).join(' ')));
    if (hit) return hit;
  }
  for (let i = words.length - 1; i >= 0; i--) {
    const hit = allowed(lookup(words[i]!));
    if (hit) return hit;
  }
  return null;
}
