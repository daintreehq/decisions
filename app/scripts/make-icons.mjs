// Renders the SVG mark to the PNG sizes the manifest and iOS need. Run `pnpm --filter @daintree/decisions-app icons`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../public/icons');
const svg = readFileSync(resolve(dir, 'icon.svg'));
const outputs = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

if (process.argv.includes('--if-missing') && outputs.every((f) => existsSync(resolve(dir, f)))) {
  process.exit(0);
}

await sharp(svg).resize(192, 192).png().toFile(resolve(dir, 'icon-192.png'));
await sharp(svg).resize(512, 512).png().toFile(resolve(dir, 'icon-512.png'));
// Maskable: full-bleed green with the mark inside the 80% safe zone.
const inner = await sharp(svg).resize(360, 360).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#0f7a4a' } })
  .composite([{ input: inner, gravity: 'centre' }])
  .png()
  .toFile(resolve(dir, 'icon-maskable-512.png'));
// iOS ignores transparency and rounds the corners itself.
const flat = await sharp(svg).resize(180, 180).flatten({ background: '#0f7a4a' }).png().toBuffer();
await sharp(flat).toFile(resolve(dir, 'apple-touch-icon.png'));
console.log('icons written to', dir);
