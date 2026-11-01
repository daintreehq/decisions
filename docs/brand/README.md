# The Decisions mark

A flowchart decision node holding the question your agent is asking: a rounded diamond with a question mark cut out of it. The diamond says "decision", the question mark says "waiting on you", which is the one thing the app ever asks of its user. It is one colour by construction (the question mark is a hole in a single `evenodd` path), so the same geometry works as an app icon, an alpha-only notification badge and a `currentColor` glyph.

A check was tried first and dropped: it reads as "approved" or "done", the state after the interaction. A fork cut into the diamond read as a back arrow at small sizes.

## Source

[`app/public/icons/mark.svg`](../../app/public/icons/mark.svg) is the only source. It is hand-authored path data on a 512 grid and fills with `currentColor`, which makes it the monochrome variant too: inline it, or load it as a mask, and it takes the surrounding text colour. Daintree uses it as-is in its Settings tab and on the pane chip.

Everything else is generated from it by [`app/scripts/make-icons.mjs`](../../app/scripts/make-icons.mjs) (`pnpm --filter @daintreehq/decisions-app icons`):

| File | Use |
| --- | --- |
| `icon.svg` | Favicon. `#0f7a4a` on light browser chrome, `#3fbf86` on dark (`prefers-color-scheme` inside the SVG). |
| `icon-192.png`, `icon-512.png` | Manifest `any`: the mark on the dark rounded tile. Also the notification `icon`. |
| `icon-maskable-192.png`, `icon-maskable-512.png` | Manifest `maskable`: full-bleed opaque tile, mark well inside the 80% safe-zone circle. |
| `apple-touch-icon.png` | 180×180, opaque, square: iOS applies its own corners. |
| `badge-96.png` | Notification `badge`: white silhouette on transparency, since Android draws only the alpha channel. |

## Colours

From the app's tokens: tile `#0b1411` (dark surface), mark `#3fbf86` (dark-theme accent), `#0f7a4a` (light-theme accent). The mark sits beside Daintree's own mint-on-near-black icon as a sibling; it relates through colour, weight and simplicity and does not borrow Daintree's canopy, trunk or roots.

## Previews

[`previews/`](previews) shows the set at real sizes: favicon tabs and pixel zooms, light and dark home screens on iOS and Android, every launcher mask, the notification badge and shade, and the glyph in a Daintree-like UI. Regenerate them with:

```bash
pnpm --filter @daintreehq/decisions-app icons
DESIGN_CAPTURE_DIR=/tmp/decisions-icons node app/scripts/icon-previews.mjs
```
