// Copies the Amble skill from this repo (the source of truth) into a skills folder that Claude
// clients read, then shows what changed. Notes about your own household (who's who, time zone,
// preferences) go in skill/household.md, which git ignores; they're added to the end of SKILL.md.
// Usage: node scripts/sync-skill.ts [skills-dir]
//   skills-dir defaults to $AMBLE_SKILLS_DIR, then ~/.claude/skills. The skill lands in <skills-dir>/amble.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../skill/amble', import.meta.url));
const household = fileURLToPath(new URL('../skill/household.md', import.meta.url));
const skillsDir = process.argv[2] ?? process.env.AMBLE_SKILLS_DIR ?? path.join(os.homedir(), '.claude', 'skills');
const target = path.join(skillsDir, 'amble');

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// A symlinked target already is the source; copying onto it would be a no-op at best, and would
// leave out the household notes.
if (fs.existsSync(target) && fs.realpathSync(target) === fs.realpathSync(source)) {
  console.log(`${target} links to the repo already; nothing to copy.`);
  process.exit(0);
}

fs.mkdirSync(target, { recursive: true });
let changed = 0;
for (const file of files(source)) {
  const rel = path.relative(source, file);
  const dest = path.join(target, rel);
  let next = fs.readFileSync(file);
  if (rel === 'SKILL.md' && fs.existsSync(household)) next = Buffer.concat([next, Buffer.from('\n'), fs.readFileSync(household)]);
  if (fs.existsSync(dest) && fs.readFileSync(dest).equals(next)) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, next);
  console.log(`updated ${rel}`);
  changed++;
}
for (const file of files(target)) {
  const rel = path.relative(target, file);
  if (!fs.existsSync(path.join(source, rel))) {
    fs.rmSync(file);
    console.log(`removed ${rel}`);
    changed++;
  }
}
console.log(changed ? `${changed} file(s) synced to ${target}` : `${target} is up to date`);
