import { count } from 'drizzle-orm';
import type { Db } from './index.ts';
import { groups } from './schema.ts';

const starterGroups = [
  { name: 'Home', icon: 'home', color: 'green' },
  { name: 'Errands', icon: 'directions-car', color: 'teal' },
  { name: 'Groceries', icon: 'shopping-cart', color: 'lime', kind: 'list', template: 'groceries' },
  { name: 'Calls', icon: 'call', color: 'blue' },
  { name: 'Projects', icon: 'rocket-launch', color: 'violet' },
  { name: 'Hobby', icon: 'palette', color: 'orange' },
] as const;

export function seedStarterGroups(db: Db) {
  const [row] = db.select({ n: count() }).from(groups).all();
  if (row && row.n > 0) return;
  db.insert(groups)
    .values(starterGroups.map((g, i) => ({ ...g, sortOrder: i })))
    .run();
}
