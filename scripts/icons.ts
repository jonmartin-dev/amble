// Renders the PNG app icons from web/public/icon.svg, and the notification badge from badge.svg: the
// web app's, and the launcher icons Android 7 shows (8 and up draw the vector layers in android/).
// Run with: node scripts/icons.ts
import fs from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const svg = fs.readFileSync('web/public/icon.svg', 'utf8');
if (!svg.includes('rx="160"')) throw new Error('icon.svg should round its corners with a rect rx="160" clip.');
// The art is full-bleed with the sun inside the safe zone, so a maskable icon only squares the corners.
const square = svg.replace('rx="160"', 'rx="0"');
const round = svg.replace('rx="160"', 'rx="256"');

const outputs: [string, string, number][] = [
  ['web/public/icon-192.png', svg, 192],
  ['web/public/icon-512.png', svg, 512],
  ['web/public/icon-maskable-512.png', square, 512],
  ['web/public/apple-touch-icon.png', square, 180],
  // Android draws a notification's small icon from its alpha alone, so it's white on clear.
  ['web/public/badge-96.png', fs.readFileSync('web/public/badge.svg', 'utf8'), 96],
];
for (const [density, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]] as const) {
  outputs.push([`android/app/src/main/res/mipmap-${density}/ic_launcher.png`, svg, size]);
  outputs.push([`android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`, round, size]);
}

for (const [file, source, size] of outputs) {
  const png = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(file, png);
  console.log(file);
}
