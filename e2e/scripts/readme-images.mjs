#!/usr/bin/env node
/**
 * Composes the README images from real captures of the running app.
 *
 *   pnpm build
 *   SCREENSHOTS_DIR=/tmp/decisions-shots pnpm --filter @daintreehq/decisions-e2e test screenshots
 *   node e2e/scripts/readme-images.mjs /tmp/decisions-shots
 *
 * Every phone and browser screen is an unedited capture from `tests/screenshots.test.ts`, which drives the
 * real PWA against a real relay. Only the frames, the lock screen and the agent's terminal panel around them
 * are drawn here, and the terminal's answer block is produced by the client's own `formatAnswerNotice`.
 *
 * The look is daintree.org's, because Decisions is Daintree's sister app: its surface ladder, DM Sans and
 * IBM Plex Mono, hairline panels on a flat field, and the trunk-and-branch rail as the only drawn motif. The
 * field is flat on purpose. No glows, no grain, no glare on the glass: depth comes from the panels.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { batchNotices, formatAnswerNotice } from '@daintreehq/decisions-client';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const SHOTS = process.argv[2] ?? process.env.SCREENSHOTS_DIR;
const OUT = resolve(process.argv[3] ?? join(repo, 'docs/readme'));
const OUT_WIDTH = 1760;
if (!SHOTS || !existsSync(SHOTS)) {
  console.error('usage: node e2e/scripts/readme-images.mjs <screenshots dir> [out dir]');
  process.exit(1);
}

function findChromium() {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
  for (const dir of [
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
  ]) {
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir)
      .filter((n) => /^chromium-\d+$/.test(n))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const n of names) {
      for (const p of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) {
        const full = join(dir, n, p);
        if (existsSync(full) && statSync(full).isFile()) return full;
      }
    }
  }
  return null;
}

const png = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
const shot = (name) => {
  const path = join(SHOTS, `${name}.png`);
  if (!existsSync(path)) throw new Error(`missing capture ${name}.png in ${SHOTS}`);
  return png(path);
};
const icon = png(join(repo, 'app/public/icons/icon-192.png'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const woff2 = (file) =>
  `url(data:font/woff2;base64,${readFileSync(join(here, 'fonts', file)).toString('base64')}) format('woff2')`;

// ── the Daintree visual language ───────────────────────────────────────────────────────────────

/**
 * daintree.org's surface ladder (its src/app.css, copied there verbatim from the Daintree app's theme): one warm
 * hue family from the grid to the elevated plane, a cool text ramp, one accent. Shadows are the site's
 * green-black ink, never pure black, so they read as air rather than as an outline.
 */
const C = {
  grid: '#110d0b',
  sidebar: '#151211',
  bg: '#1a1918',
  card: '#201f1f',
  elevated: '#2b2b2a',
  border: '#292828',
  subtle: 'rgba(255,255,255,.08)',
  divider: 'rgba(255,255,255,.06)',
  rail: '#3a3937',
  text: '#e4e4e7',
  secondary: '#a1a1aa',
  tertiary: '#8a8a93',
  muted: '#585853',
  accent: '#36ce94',
  claude: '#cc785c',
  ink: '5,10,7',
};
const SANS = `'DM Sans', system-ui, -apple-system, sans-serif`;
const MONO = `'IBM Plex Mono', ui-monospace, monospace`;

const BASE_CSS = `
  @font-face { font-family: 'DM Sans'; font-weight: 100 1000; font-style: normal; src: ${woff2('dm-sans-latin-wght-normal.woff2')}; }
  @font-face { font-family: 'IBM Plex Mono'; font-weight: 400; font-style: normal; src: ${woff2('ibm-plex-mono-latin-400-normal.woff2')}; }
  @font-face { font-family: 'IBM Plex Mono'; font-weight: 500; font-style: normal; src: ${woff2('ibm-plex-mono-latin-500-normal.woff2')}; }
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; }
  body { font-family: ${SANS}; color: ${C.text}; -webkit-font-smoothing: antialiased; }

  /* The field: flat, one plane, a hairline edge so it holds its shape on GitHub's light theme too. */
  .canvas { position: relative; overflow: hidden; border-radius: 24px; background: ${C.bg};
    box-shadow: inset 0 0 0 1px ${C.subtle}; }

  /* A bento card, as on daintree.org's homepage: the card plane, a hairline, a label, then the evidence. */
  .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-template-rows: auto auto;
    column-gap: 16px; padding: 32px; }
  /* Subgrid, so a two-line label pushes every card's evidence down together and the phones stay level. */
  .card { position: relative; display: grid; grid-row: span 2; grid-template-rows: subgrid; row-gap: 18px;
    background: ${C.card}; border: 1px solid ${C.border}; border-radius: 16px; padding: 20px; }
  .card .head { display: flex; flex-direction: column; gap: 7px; }
  .title { font: 600 18px/1.22 ${SANS}; letter-spacing: -.02em; color: ${C.text}; text-wrap: balance; }
  .card .stage { position: relative; display: flex; justify-content: center; }
  .split { display: grid; grid-template-areas: 'a t' 'b t';
    gap: 16px; padding: 32px; }
  .card.detail { display: flex; flex-direction: column; gap: 18px; }
  .card.detail .stage { flex: 1; align-items: center; }
  .crop { position: relative; overflow: hidden; border-radius: 12px; background: ${C.bg}; box-shadow: 0 0 0 1px ${C.border}; }
  .crop > img { position: absolute; display: block; max-width: none; }

  /* A phone: a plain dark body and a hairline, nothing on the glass. */
  .phone { position: relative; flex: none; padding: 7px; background: #0c0a09;
    box-shadow: 0 0 0 1px rgba(255,255,255,.09), 0 24px 48px -16px rgba(${C.ink},.55); }
  .phone .screen { position: relative; overflow: hidden; background: ${C.bg}; aspect-ratio: 390 / 844; }
  .phone .screen > img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }

  .notif { display: flex; gap: 10px; align-items: center; padding: 10px 12px 10px 10px; border-radius: 18px;
    background: rgba(43,43,42,.94); box-shadow: 0 0 0 1px ${C.subtle}, 0 12px 28px -12px rgba(${C.ink},.7); }
  .rail-chip { position: absolute; transform: translate(-50%, -50%); white-space: nowrap; padding: 5px 10px;
    border-radius: 999px; background: ${C.bg}; box-shadow: 0 0 0 1px ${C.border};
    font: 500 12.5px/1 ${MONO}; color: ${C.secondary}; }
  .notif img { width: 30px; height: 30px; border-radius: 7px; flex: none; }
  .notif .t { display: flex; justify-content: space-between; gap: 8px; font: 600 12.5px/1.25 ${SANS}; white-space: nowrap; }
  .notif .t span { font-weight: 400; color: ${C.tertiary}; font-size: 11px; }
  .notif .b { font: 400 12.5px/1.3 ${SANS}; color: ${C.secondary}; }
  /* An older notification steps down the text ramp and the surface ladder; it is never faded with alpha. */
  .notif.older { background: rgba(32,31,31,.94); }
  .notif.older .t { color: ${C.secondary}; } .notif.older .b { color: ${C.tertiary}; }
`;

/** Corner radii scale with the device, like a real phone's (about 14% of the screen width). */
const radii = (width) => {
  const screen = Math.round((width - 14) * 0.14);
  return { frame: `border-radius:${screen + 7}px`, screen: `border-radius:${screen}px` };
};
const phone = (src, width, extra = '', anchors = '') => {
  const r = radii(width);
  return `<div class="phone" style="width:${width}px;${r.frame};${extra}"><div class="screen" style="${r.screen}"><img src="${src}">${anchors}</div></div>`;
};

const notification = (text = 'A question needs your input', when = 'now', cls = '') => `
  <div class="notif ${cls}">
    <img src="${icon}">
    <div style="flex:1;min-width:0">
      <div class="t">Daintree Decisions <span>${when}</span></div>
      <div class="b">${text}</div>
    </div>
  </div>`;

// ── the agent's terminal, as a Daintree panel ──────────────────────────────────────────────────

const CLAUDE = `<svg viewBox="0 0 1200 1200" width="13" height="13" fill="${C.claude}" aria-hidden="true"><path d="M233.96 800.21L468.64 668.54l3.95-11.44-3.95-6.36h-11.44l-39.22-2.42-134.09-3.62-116.3-4.83-112.67-6.04-28.35-6.04-26.58-35.03 2.74-17.48 23.84-16.03 34.15 2.98 75.46 5.15 113.24 7.81 82.15 4.83 121.69 12.64h19.33l2.74-7.81-6.6-4.83-5.16-4.83-117.18-79.41-126.85-83.92-66.44-48.32-35.92-24.48-18.12-22.95-7.81-50.09 32.62-35.92h43.81l11.2 2.98 44.37 34.13 94.79 73.37 123.79 91.17 18.12 15.06 7.25-5.15.89-3.62-8.13-13.62-67.27-121.69-71.84-123.79-32.03-51.3-8.46-30.77c-2.98-12.64-5.15-23.27-5.15-36.24l37.13-50.42h20.54l49.54 6.6 20.86 18.12 30.77 70.39 49.85 110.82 77.32 150.68 22.63 44.7 12.08 41.4 4.51 12.64h7.81v-7.25l6.36-84.89 11.76-104.21 11.44-134.09 3.95-37.77 18.68-45.26 37.13-24.48 28.99 13.85 23.84 34.15-3.3 22.07-14.17 92.13-27.79 144.32-18.12 96.64h10.55l12.08-12.08 48.89-64.91 82.15-102.68 36.24-40.75 42.28-45.02 27.14-21.42h51.3l37.77 56.13-16.91 57.99-52.83 66.99-43.81 56.78-62.82 84.56-39.22 67.65 3.62 5.4 9.35-.89 141.91-30.2 76.67-13.85 91.49-15.7 41.4 19.33 4.51 19.65-16.27 40.19-97.85 24.16-114.77 22.95-170.89 40.43-2.09 1.53 2.42 2.98 76.99 7.25 32.94 1.77h80.62l150.12 11.2 39.22 25.93 23.52 31.73-3.95 24.16-60.4 30.77-81.5-19.33-190.23-45.26-65.24-16.27h-9.02v5.4l54.36 53.15 99.62 89.96 124.75 115.97 6.36 28.67-16.03 22.63h-16.91l-109.61-82.47-42.28-37.13-95.76-80.62h-6.36v8.46l22.07 32.29 116.54 175.17 6.04 53.72-8.46 17.48-30.2 10.55-33.18-6.04-68.21-95.76-70.39-107.84-56.78-96.64-6.93 3.95-33.5 360.89-15.7 18.44-36.24 13.85-30.2-22.95-16.03-37.13 16.03-73.37 19.33-95.76 15.7-76.11 14.17-94.55 8.46-31.41-.56-2.09-6.93.89-71.27 97.85-108.4 146.5-85.77 91.81-20.54 8.13-35.6-18.44 3.3-32.94 19.89-29.32 118.71-150.99 71.6-93.58 46.23-53.95-.32-7.81-2.74-.01L205.29 929.4l-56.13 7.25-24.16-22.63 2.98-37.13 11.44-12.08 94.79-64.91-.32.32z"/></svg>`;

const answerText = batchNotices([
  formatAnswerNotice({
    kind: 'answer',
    questionId: '01JCB7Q2N8XK4V3M9TZR6WHDPE',
    alias: 12,
    revision: 1,
    source: 'human',
    choices: [{ id: 'approve', label: 'Approve' }],
    comment: 'Ship it. Keep the tooltips on every icon.',
    injectionId: 'inj_7f3a9c',
  }),
])[0];

const TERMINAL_CSS = `
  .term { border-radius: 12px; overflow: hidden; background: ${C.grid};
    box-shadow: 0 0 0 1px ${C.border}, 0 28px 60px -24px rgba(${C.ink},.6); }
  .term .bar { display: flex; align-items: center; gap: 9px; height: 40px; padding: 0 14px;
    background: ${C.sidebar}; border-bottom: 1px solid ${C.divider}; }
  .term .bar .name { font: 500 14px/1 ${SANS}; color: ${C.text}; }
  .term .bar .chip { font: 500 12.5px/1 ${MONO}; color: ${C.secondary}; background: ${C.elevated};
    padding: 4px 7px; border-radius: 4px; }
  .term .bar .where { margin-left: auto; font: 400 13px/1 ${MONO}; color: ${C.tertiary}; }
  .term .body { padding: 16px 20px 18px; font: 400 14px/1.6 ${MONO}; color: ${C.secondary}; }
  .term .l { white-space: pre-wrap; padding-left: 2ch; text-indent: -2ch; min-height: 1.62em; }
  .term .l.sub { padding-left: 4ch; text-indent: -4ch; }
  .term .gap { height: .8em; }
  .u { color: ${C.text}; } .dim { color: ${C.tertiary}; } .tool { color: ${C.text}; font-weight: 500; }
  .term .sep { display: flex; align-items: center; gap: 12px; margin: 6px 0 10px; color: ${C.tertiary}; font-size: 12px; }
  .term .sep::before, .term .sep::after { content: ''; flex: 1; height: 1px; background: ${C.border}; }
  /* The injected answer: a recessed well with a square rule, and the accent only on its delimiters. */
  .term .ans { margin: 0 -20px; padding: 10px 20px 11px 18px; background: ${C.sidebar};
    border-left: 2px solid ${C.accent}; }
  .term .ans .l { padding-left: 0; text-indent: 0; }
  .term .ans .cut { color: ${C.tertiary}; letter-spacing: .1em; }
  .term .ans .blk { color: ${C.accent}; } .term .ans .key { color: ${C.tertiary}; } .term .ans .val { color: ${C.secondary}; }
  .term .ans .val.human { color: ${C.text}; font-size: 16px; font-weight: 500; }
`;

const line = (html, attrs = '') => `<div class="l"${attrs}>${html}</div>`;
const sub = (html) => `<div class="l sub">${html}</div>`;
const bullet = (html, attrs = '') => line(`<span class="dim">⏺</span> ${html}`, attrs);

function answerBlock() {
  return esc(answerText)
    .split('\n')
    .map((l) => {
      if (l.startsWith('[')) return line(`<span class="blk">${l}</span>`);
      const m = l.match(/^([a-z_]+): (.*)$/);
      return line(
        m
          ? `<span class="key">${m[1]}:</span> <span class="val">${m[2]}</span>`
          : `<span class="dim">${l}</span>`,
      );
    })
    .join('');
}

const termBar = (branch) =>
  `<div class="bar">${CLAUDE}<span class="name">Claude Code</span><span class="chip">${branch}</span><span class="where">daintree</span></div>`;

/** Fields a reader needs at README size: which question, what was chosen, and the human's words. */
const SHOWN = new Set(['question_id', 'choice_label', 'comment']);
/** The human's part of the answer, set to win the block's hierarchy over its identifiers. */
const HUMAN = new Set(['choice_label', 'comment']);

/**
 * The injected answer exactly as the client formats it. The preamble and the transport bookkeeping (revision,
 * injection id, source, choice id) are real but are not the point here, so each run of them folds into one
 * marked cut rather than disappearing.
 */
function answerExcerpt() {
  const out = [];
  const cut = () => {
    if (!out.at(-1)?.includes('class="cut"')) out.push(line(`<span class="cut">⋯</span>`));
  };
  for (const l of esc(answerText).split('\n')) {
    const m = l.match(/^([a-z_]+): (.*)$/);
    if (l.startsWith('[')) out.push(line(`<span class="blk">${l}</span>`));
    else if (m && SHOWN.has(m[1]))
      out.push(
        line(
          `<span class="key">${m[1]}:</span> <span class="val${HUMAN.has(m[1]) ? ' human' : ''}">${m[2]}</span>`,
        ),
      );
    else cut();
  }
  return out.join('');
}

/** The whole exchange in one pane: the ask, the turn ending, and the signed answer arriving 38 minutes later. */
function terminal() {
  const body = [
    line(
      `<span class="dim">›</span> <span class="u">Collapse the Agents sidebar to icons below 900px. Get my approval before you merge.</span>`,
    ),
    `<div class="gap"></div>`,
    bullet(
      `<span class="tool">decisions · ask_human</span> <span class="dim">(MCP)</span>`,
      ' data-anchor="ask"',
    ),
    sub(`  <span class="dim">question:</span> "Approve the compact sidebar for the Agents view?"`),
    sub(
      `  <span class="dim">⎿</span>  Asked as q-12. End your turn now; the answer will arrive in this terminal.`,
    ),
    `<div class="gap"></div>`,
    bullet(`Waiting on your decision (q-12).`),
    `<div class="sep">38 minutes later</div>`,
    `<div class="ans" data-anchor="answer">${answerExcerpt()}</div>`,
    `<div class="gap"></div>`,
    bullet(`<span class="u">Approved. Merging, with tooltips kept on every icon.</span>`),
  ].join('');
  return `<div class="term">${termBar('feature/compact-sidebar')}<div class="body">${body}</div></div>`;
}

/**
 * The rails: the trunk-and-branch connector daintree.org draws beside its panels, here carrying the question
 * out of the terminal to the phone and the answer back to the same pane. Drawn after layout between measured
 * anchors, each leg labelled with what travels on it.
 */
const RAILS_SCRIPT = `
  (() => {
    const canvas = document.querySelector('.canvas');
    const box = canvas.getBoundingClientRect();
    const y = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return r.top + r.height / 2 - box.top; };
    const tx = document.querySelector('.term').getBoundingClientRect().right - box.left;
    const px = document.querySelector('.hero-phone').getBoundingClientRect().left - box.left;
    const mid = Math.round((tx + px) / 2), r = 16;
    const legs = [
      { from: [tx, y('[data-anchor="ask"]')], to: [px, y('[data-anchor="q"]')], label: 'encrypted' },
      { from: [px, y('[data-anchor="send"]')], to: [tx, y('[data-anchor="answer"]')], label: 'signed', back: true },
    ];
    let out = '';
    for (const { from: [x1, y1], to: [x2, y2], back } of legs) {
      const dy = y2 > y1 ? 1 : -1, dx = x2 > x1 ? 1 : -1;
      const d = 'M' + x1 + ' ' + y1 + ' L' + (mid - dx * r) + ' ' + y1 + ' Q' + mid + ' ' + y1 + ' ' + mid + ' ' + (y1 + dy * r) +
        ' L' + mid + ' ' + (y2 - dy * r) + ' Q' + mid + ' ' + y2 + ' ' + (mid + dx * r) + ' ' + y2 + ' L' + x2 + ' ' + y2;
      out += '<path d="' + d + '" fill="none" stroke="' + (back ? '${C.accent}' : '${C.rail}') + '" stroke-opacity="' + (back ? '.55' : '1') + '" stroke-width="2"/>';
      out += '<circle cx="' + x1 + '" cy="' + y1 + '" r="4.5" fill="${C.bg}" stroke="${C.rail}" stroke-width="2"/>';
      // The arrival end is a chevron pointing the way the message travels: out to the phone, back to the pane.
      const tip = x2 - dx * 3;
      out += '<path d="M' + (tip - dx * 9) + ' ' + (y2 - 7) + ' L' + tip + ' ' + y2 + ' L' + (tip - dx * 9) + ' ' + (y2 + 7) +
        '" fill="none" stroke="' + (back ? '${C.accent}' : '${C.secondary}') + '" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', box.width); svg.setAttribute('height', box.height);
    svg.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    svg.innerHTML = out;
    canvas.appendChild(svg);
    // Labels as HTML chips over the trunk, so they set in the site's own mono rather than an SVG fallback.
    for (const { from: [, y1], to: [, y2], label } of legs) {
      const chip = document.createElement('div');
      chip.className = 'rail-chip';
      chip.textContent = label;
      chip.style.left = mid + 'px';
      chip.style.top = Math.round((y1 + y2) / 2) + 'px';
      canvas.appendChild(chip);
    }
  })();
`;

// ── compositions ───────────────────────────────────────────────────────────────────────────────

/**
 * A row of bento cards, each a label over a piece of evidence. Three phones a row at most: four put ordinary
 * 16px app text under 7px in GitHub's 880px column, which is decoration, not evidence.
 */
const cards = (items, width = 1200) => `
  <div class="canvas cards" style="width:${width}px;grid-template-columns:repeat(${items.length}, minmax(0, 1fr))">
    ${items
      .map(
        ({ title, stage }) => `
      <div class="card">
        <div class="head"><div class="title">${title}</div></div>
        <div class="stage">${stage}</div>
      </div>`,
      )
      .join('')}
  </div>`;

const CARD_PHONE = 316;

/**
 * The detail layout: one complete phone, for the context, beside two enlarged windows onto the parts that
 * carry the claim. Reading order runs top-left, the phone, then bottom-left. The wells take whatever the phone
 * leaves: a wider phone means a taller column, and so taller wells for the crops beside it.
 */
const split = ({ phoneWidth, first, tall, last }) => {
  const tallCard = phoneWidth + 40;
  const phoneHeight = ((phoneWidth - 14) * 844) / 390 + 14;
  // Card padding 20+20, a 22px title and an 18px gap above the evidence; the two detail cards share the
  // phone card's height with a 16px gap between them.
  const well = {
    w: 1200 - 64 - 16 - tallCard - 40,
    h: Math.floor((80 + phoneHeight - 16) / 2 - 80),
  };
  return `
  <div class="canvas split" style="width:1200px;grid-template-columns:minmax(0, 1fr) ${tallCard}px">
    <div class="card detail" style="grid-area:a"><div class="title">${first.title}</div><div class="stage">${first.stage(well)}</div></div>
    <div class="card detail" style="grid-area:b"><div class="title">${last.title}</div><div class="stage">${last.stage(well)}</div></div>
    <div class="card detail" style="grid-area:t"><div class="title">${tall.title}</div><div class="stage">${
      tall.stage
        ? tall.stage({ w: phoneWidth, h: Math.floor(phoneHeight) })
        : phone(tall.src, phoneWidth)
    }</div></div>
  </div>`;
};

/**
 * A window onto part of a phone capture, scaled to fill its well. The region is in the capture's own CSS
 * pixels (390 wide). The pixels are the capture's, unedited; only the framing and the scale change.
 */
const crop =
  (name, { y, h, x = 0, w = 390 }) =>
  (well) => {
    const k = Math.min(well.w / w, well.h / h);
    return `<div class="crop" style="width:${Math.round(w * k)}px;height:${Math.round(h * k)}px">
    <img src="${shot(name)}" style="width:${390 * k}px;left:${-x * k}px;top:${-y * k}px"></div>`;
  };

/** The lock screen's notifications, close up: they only ever say that something is waiting. */
const lockDetail = () => (well) => `
  <div class="crop" style="width:${well.w}px;height:${well.h}px;background:linear-gradient(180deg, ${C.sidebar}, ${C.grid});
       display:flex;flex-direction:column;align-items:center;justify-content:center">
    <div style="font:500 15px/1 ${SANS};color:${C.secondary}">Monday 2 November</div>
    <div style="margin-top:4px;font:600 64px/1 ${SANS};letter-spacing:-.04em;color:${C.text}">9:41</div>
    <div style="margin-top:22px;width:330px;zoom:1.3">${notification()}</div>
    <div style="margin-top:6px;width:330px;zoom:1.3">${notification('A question is still waiting', '38m', 'older')}</div>
  </div>`;

const images = {
  hero: {
    // Narrower than the card rows on purpose: GitHub scales every image to the same column, so a 1040px design
    // sets the terminal's 14px mono at ~12px, where a transcript is still read rather than squinted at.
    width: 1040,
    html: `
      <div class="canvas" style="width:1040px;height:672px">
        <div style="position:absolute;left:32px;top:0;bottom:0;width:584px;display:flex;align-items:center">${terminal()}</div>
        <div class="hero-phone" style="position:absolute;right:32px;top:30px">${phone(
          shot('10-detail-approval-note-dark'),
          290,
          '',
          // Where the question and the Send button sit on that capture, as fractions of the screen.
          `<i data-anchor="q" style="position:absolute;left:0;top:15%;height:1px"></i><i data-anchor="send" style="position:absolute;left:0;top:94.5%;height:1px"></i>`,
        )}</div>
      </div>`,
    script: RAILS_SCRIPT,
  },

  loop: {
    width: 1200,
    html: split({
      phoneWidth: 340,
      first: { title: 'Notification', stage: lockDetail() },
      tall: { title: 'Decision', src: shot('10-detail-approval-note-dark') },
      last: {
        title: 'Receipt',
        stage: crop('17-detail-approval-answered-dark', { y: 478, h: 228 }),
      },
    }),
  },

  depth: {
    width: 1200,
    // A wider phone than loop's: here the whole phone is itself evidence (the thread has to be read).
    html: split({
      phoneWidth: 460,
      first: { title: 'Multiple choice', stage: crop('12-detail-choice-dark', { y: 220, h: 242 }) },
      // The thread from just below the question's divider to the composer: the capture is scrolled to the
      // thread, so a whole phone would show a stray last line of the question above it.
      tall: { title: 'Follow-ups', stage: crop('16-detail-follow-up-dark', { y: 96, h: 748 }) },
      last: { title: 'Model answer', stage: crop('28-detail-proxy-dark', { y: 240, h: 306 }) },
    }),
  },

  pairing: {
    width: 816,
    html: cards(
      [
        { title: 'Compare the code', stage: phone(shot('06-pair-code-dark'), CARD_PHONE) },
        {
          title: 'Check the fingerprint',
          stage: phone(shot('75-device-details-dark'), CARD_PHONE),
        },
      ],
      816,
    ),
  },

  everywhere: {
    width: 1200,
    html: `
      <div class="canvas" style="width:1200px;padding:40px">
        <div style="border-radius:12px;overflow:hidden;background:${C.bg};
             box-shadow:0 0 0 1px ${C.border},0 28px 60px -24px rgba(${C.ink},.6)">
          <div style="display:flex;align-items:center;gap:8px;height:38px;padding:0 14px;background:${C.sidebar};border-bottom:1px solid ${C.divider}">
            <i style="width:11px;height:11px;border-radius:50%;background:${C.muted}"></i>
            <i style="width:11px;height:11px;border-radius:50%;background:${C.muted}"></i>
            <i style="width:11px;height:11px;border-radius:50%;background:${C.muted}"></i>
            <div style="flex:1;display:flex;justify-content:center;margin-right:50px">
              <div style="width:340px;padding:5px 12px;border-radius:6px;background:${C.card};box-shadow:inset 0 0 0 1px ${C.border};font:400 11.5px/1.2 ${MONO};color:${C.tertiary};text-align:center">decisions.your-name.workers.dev</div>
            </div>
          </div>
          <img src="${shot('30-wide-inbox-detail-dark')}" style="display:block;width:100%">
        </div>
      </div>`,
  },
};

const executablePath = findChromium();
if (!executablePath) {
  console.error('No Chromium found. Run `npx playwright install chromium` or set E2E_CHROMIUM.');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const only = process.env.ONLY?.split(',');
for (const [name, { width, html, script }] of Object.entries(images)) {
  if (only && !only.includes(name)) continue;
  const page = await browser.newPage({
    viewport: { width, height: 1400 },
    // Exactly 2x GitHub's ~880px README column, whatever the design width.
    deviceScaleFactor: OUT_WIDTH / width,
  });
  await page.setContent(`<!doctype html><style>${BASE_CSS}${TERMINAL_CSS}</style>${html}`);
  await page.evaluate(() => document.fonts.ready);
  if (script) await page.evaluate(script);
  await page.waitForTimeout(200);
  // The card rows size themselves to their content, so the shot is the canvas, not the viewport.
  await page
    .locator('.canvas')
    .screenshot({ path: join(OUT, `${name}.png`), omitBackground: true });
  await page.close();
  console.log(`wrote ${join(OUT, `${name}.png`)}`);
}
await browser.close();
