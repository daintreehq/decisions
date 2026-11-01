// Opt-in preview sheets for the icon set: how the mark reads at real sizes, on light and dark home screens,
// inside iOS and Android masks, as a notification badge and as a currentColor glyph.
// Usage: DESIGN_CAPTURE_DIR=/abs/out node app/scripts/icon-previews.mjs   (run `pnpm icons` first)
// Never runs in CI and writes nothing into the repository.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { MARK, MARK_LIGHT_THEME, TILE, markBody, outputs } from './make-icons.mjs';

const out = process.env.DESIGN_CAPTURE_DIR;
if (!out) throw new Error('Set DESIGN_CAPTURE_DIR to an absolute directory outside the repo.');
mkdirSync(out, { recursive: true });
const icons = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');
for (const name of Object.keys(outputs)) {
  if (!existsSync(resolve(icons, name)))
    throw new Error(`missing ${name}: run the icons script first`);
}
const file = (n) => readFileSync(resolve(icons, n));
const FONT = `font-family="-apple-system, Helvetica, Arial, sans-serif"`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();
const at = async (buf, size, kernel = 'lanczos3') =>
  sharp(buf).resize(size, size, { kernel }).png().toBuffer();
const svgAt = (svgText, size) =>
  sharp(Buffer.from(svgText), { density: Math.max(72, (72 * size * 2) / 512) })
    .resize(size, size)
    .png()
    .toBuffer();
const glyph = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="${color}">${markBody.replace('currentColor', color)}</svg>`;
/** Mask a square PNG with an SVG shape (white = keep). */
async function masked(buf, size, shape) {
  const mask = await png(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${shape(size)}</svg>`,
  );
  return sharp(await at(buf, size))
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}
const squircle = (s) => {
  // Superellipse-ish iOS continuous corner approximation (n≈5).
  const pts = [];
  for (let i = 0; i < 360; i++) {
    const t = (i / 360) * 2 * Math.PI,
      c = Math.cos(t),
      si = Math.sin(t);
    const x = Math.sign(c) * Math.abs(c) ** (2 / 5),
      y = Math.sign(si) * Math.abs(si) ** (2 / 5);
    pts.push(`${((x + 1) * s) / 2},${((y + 1) * s) / 2}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="#fff"/>`;
};
const shapes = {
  'iOS (continuous corners)': squircle,
  'Android circle': (s) => `<circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}" fill="#fff"/>`,
  'Android rounded square': (s) =>
    `<rect width="${s}" height="${s}" rx="${s * 0.18}" fill="#fff"/>`,
  'Android teardrop': (s) =>
    `<path d="M${s / 2} 0H${s}V${s / 2}A${s / 2} ${s / 2} 0 1 1 ${s / 2} 0Z" fill="#fff"/>`,
};

async function sheet(name, w, h, bg, comps, texts) {
  const base = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${bg}"/>${texts
    .map(
      ([x, y, t, color = '#55675d', size = 15, weight = 400]) =>
        `<text x="${x}" y="${y}" ${FONT} font-size="${size}" font-weight="${weight}" fill="${color}">${esc(t)}</text>`,
    )
    .join('')}</svg>`;
  await sharp(Buffer.from(base)).composite(comps).png().toFile(resolve(out, name));
}

// 1. Favicon ladder: real-size tabs (light and dark browser chrome) and 8x pixel zooms of 16 and 32.
{
  const comps = [],
    texts = [];
  const favLight = glyph(MARK_LIGHT_THEME),
    favDark = glyph(MARK);
  const rows = [
    ['Light browser chrome', '#e8ecea', '#1f2421', favLight],
    ['Dark browser chrome', '#202124', '#e8eaed', favDark],
  ];
  for (const [r, [label, chrome, fg, svg]] of rows.entries()) {
    const y = 40 + r * 330;
    texts.push([24, y - 12, label, '#11221a', 16, 600]);
    // a tab strip with three tabs; ours is the middle one
    const tabs = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="44"><rect width="720" height="44" fill="${chrome}"/>${[
      0, 1, 2,
    ]
      .map(
        (i) =>
          `<rect x="${8 + i * 236}" y="6" width="228" height="34" rx="9" fill="${i === 1 ? (r ? '#35363a' : '#ffffff') : 'none'}"/><text x="${44 + i * 236}" y="28" ${FONT} font-size="13" fill="${fg}">${['Pull requests', 'Decisions', 'Deploy · Cloudflare'][i]}</text>${i !== 1 ? `<rect x="${20 + i * 236}" y="15" width="16" height="16" rx="3" fill="${r ? '#5f6368' : '#9aa0a6'}"/>` : ''}`,
      )
      .join('')}</svg>`;
    comps.push({ input: await png(tabs), left: 24, top: y });
    comps.push({ input: await svgAt(svg, 16), left: 24 + 8 + 236 + 12, top: y + 15 });
    // size ladder at 1x
    let x = 24;
    for (const s of [16, 20, 24, 32, 48]) {
      comps.push({ input: await svgAt(svg, s), left: x, top: y + 70 });
      texts.push([x, y + 140, `${s}px`]);
      x += s + 40;
    }
    // zooms
    comps.push({ input: await at(await svgAt(svg, 16), 128, 'nearest'), left: 380, top: y + 64 });
    texts.push([380, y + 210, '16px at 8x']);
    comps.push({ input: await at(await svgAt(svg, 32), 128, 'nearest'), left: 540, top: y + 64 });
    texts.push([540, y + 210, '32px at 4x']);
  }
  await sheet('01-favicon.png', 768, 660, '#f4f8f5', comps, texts);
}

// 2 & 3. Home screens: iOS (apple-touch-icon in continuous-corner mask) and Android (maskable in a circle).
for (const [file_, wallpaper, labelColor, title] of [
  ['02-home-light.png', ['#dfe9f3', '#f6efe4'], '#1d1d1f', 'Light home screen'],
  ['03-home-dark.png', ['#1b2333', '#0b0f14'], '#f5f5f7', 'Dark home screen'],
]) {
  const comps = [],
    texts = [];
  const neighbours = ['#ff9f0a', '#0a84ff', '#5e5ce6', '#30d158', '#ff375f', '#64d2ff', '#bf5af2'];
  const names = ['Mail', 'Calendar', 'GitHub', 'Decisions', 'Slack', 'Weather', 'Notes', 'Maps'];
  const S = 180,
    gap = 64;
  for (const [platform, ox] of [
    ['iOS', 40],
    ['Android', 40 + 4 * (S + gap) + 80],
  ]) {
    texts.push([ox, 34, `${title} · ${platform}`, labelColor, 18, 600]);
    for (let i = 0; i < 8; i++) {
      const col = i % 4,
        row = Math.floor(i / 4);
      const x = ox + col * (S + gap),
        y = 60 + row * (S + 90);
      let tile;
      if (names[i] === 'Decisions') {
        tile =
          platform === 'iOS'
            ? await masked(file('apple-touch-icon.png'), S, squircle)
            : await masked(file('icon-maskable-512.png'), S, shapes['Android circle']);
      } else {
        const c = neighbours[i % neighbours.length];
        const shape =
          platform === 'iOS'
            ? squircle(S)
            : `<circle cx="${S / 2}" cy="${S / 2}" r="${S / 2}" fill="#fff"/>`;
        tile = await png(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity=".78"/></linearGradient></defs><g fill="url(#g)">${shape.replace('fill="#fff"', '')}</g><rect x="${S * 0.32}" y="${S * 0.32}" width="${S * 0.36}" height="${S * 0.36}" rx="${S * 0.08}" fill="#fff" opacity=".9"/></svg>`,
        );
      }
      comps.push({ input: tile, left: x, top: y });
      texts.push([x + S / 2 - names[i].length * 6.4, y + S + 34, names[i], labelColor, 22]);
    }
  }
  const W = 40 + 8 * (S + gap) + 80,
    H = 60 + 2 * (S + 90) + 20;
  const bg = await png(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${wallpaper[0]}"/><stop offset="1" stop-color="${wallpaper[1]}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#w)"/></svg>`,
  );
  const base = await sharp(bg).png().toBuffer();
  const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${texts.map(([x, y, t, c, s, w = 400]) => `<text x="${x}" y="${y}" ${FONT} font-size="${s}" font-weight="${w}" fill="${c}">${esc(t)}</text>`).join('')}</svg>`;
  await sharp(base)
    .composite([...comps, { input: Buffer.from(textSvg) }])
    .png()
    .toFile(resolve(out, file_));
}

// 4. Masks: the maskable icon under every launcher shape, plus the raw maskable with the 80% safe-zone circle.
{
  const comps = [],
    texts = [];
  const S = 220;
  const raw = await at(file('icon-maskable-512.png'), S);
  const zone = await png(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><circle cx="${S / 2}" cy="${S / 2}" r="${S * 0.4}" fill="none" stroke="#ff375f" stroke-width="2" stroke-dasharray="6 5"/></svg>`,
  );
  comps.push({ input: raw, left: 30, top: 50 }, { input: zone, left: 30, top: 50 });
  texts.push([30, 36, 'Maskable, 80% safe zone', '#11221a', 15, 600]);
  let x = 30 + S + 40;
  for (const [label, shape] of Object.entries(shapes)) {
    const src = label.startsWith('iOS')
      ? file('apple-touch-icon.png')
      : file('icon-maskable-512.png');
    comps.push({ input: await masked(src, S, shape), left: x, top: 50 });
    texts.push([x, 36, label, '#11221a', 15, 600]);
    x += S + 40;
  }
  // "any" icons as a desktop install / app switcher would show them
  texts.push([
    30,
    340,
    'purpose "any" (desktop install, app switcher): 512 and 192 at 64px and 32px',
    '#11221a',
    15,
    600,
  ]);
  comps.push({ input: await at(file('icon-512.png'), 128), left: 30, top: 360 });
  comps.push({ input: await at(file('icon-192.png'), 64), left: 190, top: 392 });
  comps.push({ input: await at(file('icon-192.png'), 32), left: 290, top: 408 });
  await sheet('04-masks.png', x, 520, '#f4f8f5', comps, texts);
}

// 5. Notification: Android status bar badge (24dp at 3x = 72px) on dark and light bars, the shade card, and a zoom.
{
  const comps = [],
    texts = [];
  const badge = file('badge-96.png');
  const tint = async (color, size) => {
    const a = await sharp(badge).resize(size, size).extractChannel('alpha').toBuffer();
    return sharp({ create: { width: size, height: size, channels: 3, background: color } })
      .joinChannel(a)
      .png()
      .toBuffer();
  };
  for (const [r, [bar, fg]] of [
    ['#000000', '#ffffff'],
    ['#f1f3f4', '#1f1f1f'],
  ].entries()) {
    const y = 30 + r * 110;
    comps.push({
      input: await png(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="84"><rect width="1080" height="84" fill="${bar}"/><text x="36" y="56" ${FONT} font-size="40" font-weight="500" fill="${fg}">9:41</text><circle cx="1000" cy="42" r="14" fill="${fg}"/><rect x="930" y="28" width="40" height="28" rx="5" fill="${fg}"/></svg>`,
      ),
      left: 20,
      top: y,
    });
    // our badge plus two neighbour silhouettes (mail, chat) to judge weight against
    comps.push({ input: await tint(fg, 72), left: 180, top: y + 6 });
    comps.push({
      input: await png(
        `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="${fg}" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>`,
      ),
      left: 270,
      top: y + 6,
    });
    comps.push({
      input: await png(
        `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 24 24" fill="${fg}"><path d="M4 4h16v12H8l-4 4z"/></svg>`,
      ),
      left: 360,
      top: y + 6,
    });
  }
  // shade card
  const cy = 260;
  comps.push({
    input: await png(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="250"><rect width="1080" height="250" rx="36" fill="#2b2f33"/><text x="170" y="70" ${FONT} font-size="30" fill="#c4c7c5">Daintree Decisions · now</text><text x="170" y="122" ${FONT} font-size="38" font-weight="600" fill="#e3e3e3">Daintree Decisions</text><text x="170" y="172" ${FONT} font-size="32" fill="#c4c7c5">A question needs your input</text></svg>`,
    ),
    left: 20,
    top: cy,
  });
  comps.push({ input: await tint('#a8c7fa', 48), left: 60, top: cy + 34 });
  comps.push({ input: await at(file('icon-192.png'), 96), left: 960, top: cy + 30 });
  // zoom of 24px badge
  comps.push({ input: await at(await tint('#ffffff', 24), 192, 'nearest'), left: 1140, top: 30 });
  texts.push([1140, 250, 'badge at 24px, 8x', '#11221a', 15, 600]);
  await sheet('05-notification.png', 1360, 540, '#5d6b63', comps, texts);
}

// 6. Monochrome currentColor glyph, as Daintree's Settings tab and pane chip would use it.
{
  const comps = [],
    texts = [];
  const rows = [
    ['Daintree dark (#151616, mint)', '#151616', '#36ce94', '#e6e6e6'],
    ['Daintree dark, muted', '#151616', '#8b8f8d', '#8b8f8d'],
    ['Light UI, ink', '#ffffff', '#11221a', '#11221a'],
  ];
  for (const [r, [label, bg, fg, text]] of rows.entries()) {
    const y = 20 + r * 92;
    comps.push({
      input: await png(
        `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="76"><rect width="760" height="76" rx="12" fill="${bg}"/><text x="88" y="45" ${FONT} font-size="17" fill="${text}">Decisions</text><rect x="260" y="20" width="148" height="36" rx="18" fill="none" stroke="${fg}" stroke-opacity=".4"/><text x="300" y="44" ${FONT} font-size="14" fill="${text}">asking you</text><text x="460" y="45" ${FONT} font-size="13" fill="#888">${esc(label)}</text></svg>`,
      ),
      left: 20,
      top: y,
    });
    comps.push({ input: await svgAt(glyph(fg), 20), left: 20 + 56, top: y + 28 });
    comps.push({ input: await svgAt(glyph(fg), 24), left: 20 + 16, top: y + 26 });
    comps.push({ input: await svgAt(glyph(fg), 16), left: 20 + 272, top: y + 30 });
  }
  await sheet('06-mono.png', 800, 300, '#f4f8f5', comps, texts);
}

const written = readdirSync(out).filter((f) => /^0\d-.*\.png$/.test(f));
if (written.length !== 6) throw new Error(`expected 6 preview sheets, found ${written.length}`);
console.log(`PREVIEWS ${written.length} -> ${out}`);
