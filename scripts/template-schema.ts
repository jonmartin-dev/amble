// Writes templates/schema.json from the format's schema (server/domain/templateFormat.ts).
// Usage: node scripts/template-schema.ts
import fs from 'node:fs';
import { templateSchema } from '../server/domain/templateFormat.ts';

fs.writeFileSync(new URL('../templates/schema.json', import.meta.url), JSON.stringify(templateSchema(), null, 2) + '\n');
console.log('Wrote templates/schema.json');
