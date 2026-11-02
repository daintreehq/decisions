#!/usr/bin/env node
/**
 * Composes the README images from real captures of the running app.
 *
 *   pnpm build
 *   SCREENSHOTS_DIR=/tmp/decisions-shots pnpm --filter @daintreehq/decisions-e2e test screenshots
 *   node e2e/scripts/readme-images.mjs /tmp/decisions-shots
 *
 * Every phone and browser screen is an unedited capture from `tests/screenshots.test.ts`, which drives the
 * real PWA against a real relay. Only the frames, the lock screen and the terminal around them are drawn
 * here, and the terminal's answer block is produced by the client's own `formatAnswerNotice`.
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
const shot = (name) => png(join(SHOTS, `${name}.png`));
const icon = png(join(repo, 'app/public/icons/icon-192.png'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── shared pieces ──────────────────────────────────────────────────────────────────────────────

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; }
  body { font-family: -apple-system, 'SF Pro Text', system-ui, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; }
  .canvas {
    position: relative; overflow: hidden; border-radius: 28px;
    background:
      radial-gradient(900px 520px at 78% 18%, rgba(63,191,134,.20), transparent 60%),
      radial-gradient(700px 500px at 8% 100%, rgba(63,191,134,.10), transparent 60%),
      linear-gradient(160deg, #0f1d17 0%, #0a1310 55%, #08100d 100%);
  }
  .canvas::after {
    content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: inherit;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
    background-image: radial-gradient(rgba(255,255,255,.035) 1px, transparent 1px);
    background-size: 22px 22px;
  }
  .phone {
    position: relative; flex: none; padding: 10px;
    background: linear-gradient(145deg, #2a3530, #0b0f0d 40%, #1b2420);
    box-shadow:
      0 0 0 1px rgba(255,255,255,.10),
      inset 0 0 0 2px rgba(0,0,0,.6),
      0 50px 90px -30px rgba(0,0,0,.85),
      0 20px 40px -20px rgba(0,0,0,.6);
  }
  .phone .screen { position: relative; overflow: hidden; background: #f4f8f5; aspect-ratio: 390 / 844; }
  .phone .screen > img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .phone .screen::after {
    content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
    background: linear-gradient(125deg, rgba(255,255,255,.10), transparent 30%);
  }
  .label { color: #e6f1ea; }
  .step { font: 600 13px/1 -apple-system, system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #3fbf86; }
  .caption { font: 600 19px/1.3 -apple-system, system-ui, sans-serif; color: #e6f1ea; letter-spacing: -.01em; }
  .sub { font: 400 14.5px/1.45 -apple-system, system-ui, sans-serif; color: #93a79b; }
  .notif {
    display: flex; gap: 12px; align-items: center; padding: 13px 16px 13px 13px; border-radius: 22px;
    background: rgba(245, 248, 246, .80); backdrop-filter: blur(24px) saturate(1.6);
    box-shadow: 0 18px 40px -12px rgba(0,0,0,.55), 0 0 0 .5px rgba(255,255,255,.4);
    color: #0b1411;
  }
  .notif img { width: 38px; height: 38px; border-radius: 9px; }
  .notif .t { font: 600 15px/1.25 -apple-system, system-ui, sans-serif; display: flex; justify-content: space-between; gap: 18px; }
  .notif .t span { font-weight: 400; color: #5d6b63; font-size: 13.5px; }
  .notif .b { font: 400 15px/1.3 -apple-system, system-ui, sans-serif; }
  .notif.sm { gap: 9px; padding: 10px 11px 10px 10px; border-radius: 17px; }
  .notif.sm img { width: 30px; height: 30px; border-radius: 7px; }
  .notif.sm .t { font-size: 12.5px; white-space: nowrap; gap: 8px; }
  .notif.sm .t span { font-size: 11px; }
  .notif.sm .b { font-size: 12.5px; }
  .lock-btn { width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,.14); backdrop-filter: blur(12px);
    display: grid; place-items: center; color: #f4f8f5; font: 600 16px/1 -apple-system, system-ui; }
`;

/** Corner radii scale with the device, like a real phone's (about 14% of the screen width). */
const radii = (width) => {
  const screen = Math.round((width - 20) * 0.14);
  return { frame: `border-radius:${screen + 10}px`, screen: `border-radius:${screen}px` };
};
const phone = (src, width, extra = '') => {
  const r = radii(width);
  return `<div class="phone" style="width:${width}px;${r.frame};${extra}"><div class="screen" style="${r.screen}"><img src="${src}"></div></div>`;
};

const notification = (text = 'A question needs your input', when = 'now', cls = '') => `
  <div class="notif ${cls}">
    <img src="${icon}">
    <div style="flex:1;min-width:0">
      <div class="t">Daintree Decisions <span>${when}</span></div>
      <div class="b">${text}</div>
    </div>
  </div>`;

/** A drawn lock screen: the only thing a notification can ever say is generic. */
const lockScreen = (width) => `
  <div class="phone" style="width:${width}px;${radii(width).frame}">
    <div class="screen" style="${radii(width).screen};background:
        radial-gradient(120% 70% at 20% 0%, #2f6b52 0%, transparent 60%),
        radial-gradient(90% 60% at 100% 100%, #1d4a6b 0%, transparent 60%),
        linear-gradient(180deg, #13261e, #0a1512);">
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;color:#f4f8f5">
        <div style="margin-top:${width * 0.19}px;font:500 ${width * 0.055}px/1 -apple-system,system-ui;opacity:.85">Monday 2 November</div>
        <div style="font:700 ${width * 0.27}px/1.05 -apple-system,'SF Pro Rounded',system-ui;letter-spacing:-.02em">9:41</div>
        <div style="margin-top:${width * 0.14}px;width:92%">${notification(undefined, 'now', 'sm')}</div>
        <div style="margin-top:8px;width:92%;opacity:.6">${notification('A question is still waiting', '38m', 'sm')}</div>
        <div style="position:absolute;bottom:${width * 0.09}px;left:${width * 0.1}px;right:${width * 0.1}px;display:flex;justify-content:space-between">
          <div class="lock-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 2h6v5l-2 3v12h-2V10L9 7z"/></svg></div>
          <div class="lock-btn"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/></svg></div>
        </div>
      </div>
    </div>
  </div>`;

// ── the terminal ───────────────────────────────────────────────────────────────────────────────

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
  .term { border-radius: 16px; overflow: hidden; background: rgba(9, 15, 12, .92);
    box-shadow: 0 0 0 1px rgba(255,255,255,.09), 0 50px 100px -30px rgba(0,0,0,.9); backdrop-filter: blur(10px); }
  .term .bar { display:flex; align-items:center; gap:8px; padding: 13px 16px; background: rgba(255,255,255,.035); border-bottom: 1px solid rgba(255,255,255,.06); }
  .term .bar i { width: 12px; height: 12px; border-radius: 50%; display:inline-block; }
  .term .bar b { flex:1; text-align:center; font: 500 12.5px/1 -apple-system, system-ui; color: #7d9187; margin-right: 52px; }
  .term pre { margin: 0; padding: 18px 22px 22px; font: 12.6px/1.62 'SF Mono', ui-monospace, Menlo, monospace; color: #c9dbd1; white-space: pre-wrap; }
  .u { color: #e6f1ea; } .p { color: #6f8579; } .dot { color: #3fbf86; } .tool { color: #e6f1ea; font-weight: 600; }
  .dim { color: #6f8579; } .blk { color: #9fe7c2; } .key { color: #6fbf98; } .sep { color: #4e6358; }
  .hl { background: rgba(63,191,134,.10); border-left: 2px solid #3fbf86; display:block; margin: 0 -22px; padding: 6px 20px; }
`;

function terminal() {
  const block = esc(answerText)
    .split('\n')
    .map((l) => {
      if (l.startsWith('[')) return `<span class="blk">${l}</span>`;
      const m = l.match(/^([a-z_]+): (.*)$/);
      return m
        ? `<span class="key">${m[1]}:</span> <span class="u">${m[2]}</span>`
        : `<span class="dim">${l}</span>`;
    })
    .join('\n');
  const body = [
    `<span class="p">›</span> <span class="u">Collapse the Agents sidebar to icons below 900px. Get my sign-off on the design before you merge.</span>`,
    ``,
    `<span class="dot">⏺</span> Built the compact sidebar and captured before and after screenshots. It's a`,
    `  design change, so I'll ask for approval rather than decide it myself.`,
    ``,
    `<span class="dot">⏺</span> <span class="tool">decisions · ask_human</span> <span class="dim">(MCP)</span>`,
    `  <span class="dim">question:</span> "Approve the compact sidebar for the Agents view?"`,
    `  <span class="dim">kind:</span> approval  <span class="dim">options:</span> Approve, Reject  <span class="dim">attachments:</span> before.png, after.png`,
    `  <span class="dim">⎿</span>  Asked as q-12. End your turn now; the answer will arrive as a message in this terminal.`,
    ``,
    `<span class="dot">⏺</span> Waiting on your decision (q-12). I'll pick this up when you answer.`,
    ``,
    `<span class="sep">────────────────────────────── 38 minutes later ──────────────────────────────</span>`,
    `<span class="hl">${block}</span>`,
    `<span class="dot">⏺</span> Approved. Merging feature/compact-sidebar, with tooltips kept on every icon.`,
  ].join('\n');
  return `<div class="term"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><b>claude — daintree — feature/compact-sidebar</b></div><pre>${body}</pre></div>`;
}

// ── compositions ───────────────────────────────────────────────────────────────────────────────

const images = {
  hero: {
    size: [1280, 790],
    html: `
      <div class="canvas" style="width:1280px;height:790px">
        <div style="position:absolute;left:56px;top:96px;width:790px">${terminal()}</div>
        <div style="position:absolute;right:70px;top:52px">${phone(shot('10-detail-approval-note'), 316)}</div>
        <div style="position:absolute;left:470px;top:34px;width:340px;transform:rotate(-1.2deg)">${notification()}</div>
      </div>`,
  },

  loop: {
    size: [1280, 800],
    html: `
      <div class="canvas" style="width:1280px;height:800px;display:flex;gap:34px;justify-content:center;padding:56px 40px 0">
        ${[
          [
            '01',
            'Your phone buzzes',
            'The lock screen never shows the question. Only that one is waiting.',
            lockScreen(262),
          ],
          [
            '02',
            'One inbox, every agent',
            'Questions from every project and machine, most urgent first.',
            phone(shot('08-inbox'), 262),
          ],
          [
            '03',
            'Decide with the context',
            'Screenshots, the agent’s notes, the options it is weighing.',
            phone(shot('10-detail-approval-note'), 262),
          ],
          [
            '04',
            'Watch it land',
            'Signed on your phone, typed into the exact terminal that asked.',
            phone(shot('15-detail-answered'), 262),
          ],
        ]
          .map(
            ([n, t, s, p]) => `
          <div style="width:262px;display:flex;flex-direction:column;gap:10px">
            <div class="step">${n}</div>
            <div class="caption">${t}</div>
            <div class="sub" style="min-height:44px;margin-bottom:18px">${s}</div>
            ${p}
          </div>`,
          )
          .join('')}
      </div>`,
  },

  depth: {
    size: [1280, 800],
    html: `
      <div class="canvas" style="width:1280px;height:800px;display:flex;gap:34px;justify-content:center;padding:56px 40px 0">
        ${[
          [
            'Multiple choice',
            'Options carry the trade-offs, so you can answer in seconds.',
            phone(shot('12-detail-choice'), 262),
          ],
          [
            'Free text',
            'Type, or dictate, when the answer isn’t on the list.',
            phone(shot('13-detail-text'), 262),
          ],
          [
            'Decision model',
            'Low-stakes calls answered your way, labelled, for you to confirm or overrule.',
            phone(shot('14-detail-proxy'), 262),
          ],
          [
            'Change your mind',
            'A correction carries your reason back to the agent.',
            phone(shot('16-detail-override'), 262),
          ],
        ]
          .map(
            ([t, s, p]) => `
          <div style="width:262px;display:flex;flex-direction:column;gap:10px">
            <div class="caption">${t}</div>
            <div class="sub" style="min-height:44px;margin-bottom:18px">${s}</div>
            ${p}
          </div>`,
          )
          .join('')}
      </div>`,
  },

  everywhere: {
    size: [1280, 720],
    html: `
      <div class="canvas" style="width:1280px;height:720px">
        <div style="position:absolute;left:60px;top:52px;width:900px;border-radius:14px;overflow:hidden;
             box-shadow:0 0 0 1px rgba(255,255,255,.1),0 50px 100px -30px rgba(0,0,0,.9);background:#f4f8f5">
          <div style="display:flex;align-items:center;gap:8px;padding:11px 14px;background:#e3ebe6;border-bottom:1px solid #d3dfd7">
            <i style="width:11px;height:11px;border-radius:50%;background:#ff5f57"></i>
            <i style="width:11px;height:11px;border-radius:50%;background:#febc2e"></i>
            <i style="width:11px;height:11px;border-radius:50%;background:#28c840"></i>
            <div style="flex:1;display:flex;justify-content:center">
              <div style="width:360px;padding:5px 12px;border-radius:7px;background:#f4f8f5;font:12px/1.2 -apple-system,system-ui;color:#55675d;text-align:center">decisions.your-name.workers.dev</div>
            </div>
          </div>
          <img src="${shot('30-wide-inbox-detail')}" style="display:block;width:100%">
        </div>
        <div style="position:absolute;right:66px;top:82px">${phone(shot('26-inbox-dark'), 262)}</div>
      </div>`,
  },

  pairing: {
    size: [1280, 600],
    html: `
      <div class="canvas" style="width:1280px;height:600px;display:flex;align-items:center;justify-content:center;gap:40px">
        ${phone(shot('05-pair-invite'), 236)}
        ${phone(shot('06-pair-code'), 236)}
        ${phone(shot('22-devices'), 236)}
        ${phone(shot('23-settings'), 236)}
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
for (const [name, { size, html }] of Object.entries(images)) {
  if (only && !only.includes(name)) continue;
  const page = await browser.newPage({
    viewport: { width: size[0], height: size[1] },
    deviceScaleFactor: 2,
  });
  await page.setContent(`<!doctype html><style>${BASE_CSS}${TERMINAL_CSS}</style>${html}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(OUT, `${name}.png`), omitBackground: true });
  await page.close();
  console.log(`wrote ${join(OUT, `${name}.png`)}`);
}
await browser.close();
