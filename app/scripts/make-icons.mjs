// Renders the whole icon set from the one source mark, public/icons/mark.svg (a currentColor glyph).
// Run `pnpm --filter @daintreehq/decisions-app icons`. `--if-missing` skips work when every output exists.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../public/icons');

/** Colours come from the app's own tokens (styles.css): dark surface and the dark-theme accent. */
export const TILE = '#0b1411';
export const MARK = '#3fbf86';
export const MARK_LIGHT_THEME = '#0f7a4a';

const source = readFileSync(resolve(dir, 'mark.svg'), 'utf8');
/** The mark's geometry, without its <svg> wrapper. */
export const markBody = source
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .trim();

/** The mark in `color`, scaled to `scale` of a 512 box and centred, optionally on a tile. */
export function iconSvg({ scale, color = MARK, tile = null, rx = 0, size = 512 }) {
  const t = (512 * (1 - scale)) / 2;
  const bg = tile ? `<rect width="512" height="512" rx="${rx}" fill="${tile}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">${bg}<g transform="translate(${t} ${t}) scale(${scale})" fill="${color}">${markBody.replace('currentColor', color)}</g></svg>`;
}

/** How large the mark sits on each surface (fraction of the canvas). */
export const SCALE = {
  tile: 0.6, // "any" icons and apple-touch-icon
  maskable: 0.6, // same mark size as the iOS tile; its farthest point sits 56 units inside the 80% safe-zone circle
  badge: 0.9, // Android status-bar silhouette: as large as the 24dp box allows
};

export const outputs = {
  'icon.svg': () =>
    // Favicon: the bare mark, coloured for the browser's own theme.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><style>path{fill:${MARK_LIGHT_THEME}}@media (prefers-color-scheme:dark){path{fill:${MARK}}}</style>${markBody.replace(/ ?fill="currentColor"/, '')}</svg>\n`,
  'icon-192.png': { svg: () => iconSvg({ scale: SCALE.tile, tile: TILE, rx: 112 }), size: 192 },
  'icon-512.png': { svg: () => iconSvg({ scale: SCALE.tile, tile: TILE, rx: 112 }), size: 512 },
  'icon-maskable-192.png': { svg: () => iconSvg({ scale: SCALE.maskable, tile: TILE }), size: 192 },
  'icon-maskable-512.png': { svg: () => iconSvg({ scale: SCALE.maskable, tile: TILE }), size: 512 },
  // iOS ignores transparency (it would fill it with black) and rounds the corners itself: full-bleed, opaque.
  'apple-touch-icon.png': {
    svg: () => iconSvg({ scale: SCALE.tile, tile: TILE }),
    size: 180,
    flatten: true,
  },
  // Android uses only the alpha channel of a notification badge: a white silhouette on transparency.
  'badge-96.png': { svg: () => iconSvg({ scale: SCALE.badge, color: '#ffffff' }), size: 96 },
};

async function main() {
  const names = Object.keys(outputs);
  if (process.argv.includes('--if-missing') && names.every((f) => existsSync(resolve(dir, f))))
    return;
  for (const [name, spec] of Object.entries(outputs)) {
    const file = resolve(dir, name);
    if (typeof spec === 'function') {
      writeFileSync(file, spec());
      continue;
    }
    let img = sharp(Buffer.from(spec.svg()), {
      density: 72 * Math.max(1, (spec.size * 2) / 512),
    }).resize(spec.size, spec.size);
    if (spec.flatten) img = img.flatten({ background: TILE });
    await img.png({ compressionLevel: 9 }).toFile(file);
  }
  console.log(`icons written to ${dir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
