// Renders the PNG app icons from web/public/icon.svg. Run with: node scripts/icons.ts
import fs from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const svg = fs.readFileSync('web/public/icon.svg', 'utf8');
// Maskable icons need the art inside the inner 80% safe zone, on a full-bleed background.
const maskable = svg
  .replace('rx="160"', 'rx="0"')
  .replace('<circle', '<g transform="translate(51.2 51.2) scale(0.8)"><circle')
  .replace('</svg>', '</g></svg>');

const outputs: [string, string, number][] = [
  ['icon-192.png', svg, 192],
  ['icon-512.png', svg, 512],
  ['icon-maskable-512.png', maskable, 512],
  ['apple-touch-icon.png', maskable, 180],
];

for (const [file, source, size] of outputs) {
  const png = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(`web/public/${file}`, png);
  console.log(`web/public/${file}`);
}
