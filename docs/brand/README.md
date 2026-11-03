# The Decisions mark

A flowchart decision node holding the question your agent is asking: a rounded diamond with a question mark cut out of it. The diamond says "decision", the question mark says "waiting on you", which is the one thing the app ever asks of its user. It is one colour by construction (the question mark is a hole in a single `evenodd` path), so the same geometry works as an app icon, an alpha-only notification badge and a `currentColor` glyph.

A check was tried first and dropped: it reads as "approved" or "done", the state after the interaction. A fork cut into the diamond read as a back arrow at small sizes, and a hand-drawn question mark was never as good as a real heavy-sans glyph.

## Source

[`app/public/icons/mark.svg`](../../app/public/icons/mark.svg) is the only source. It was generated as a raster, traced to a single `evenodd` path with crisp-vector, normalised to a 512 grid, and then regularised by hand: the diamond is an exact construction (straight diagonal sides, equal 48-unit corners) and the question mark's terminals were squared off. It fills with `currentColor`, which makes it the monochrome variant too: inline it, or load it as a mask, and it takes the surrounding text colour. Daintree uses it as-is in its Settings tab and on the pane chip.

Everything else is generated from it by [`app/scripts/make-icons.mjs`](../../app/scripts/make-icons.mjs) (`pnpm --filter @daintreehq/decisions-app icons`):

| File | Use |
| --- | --- |
| `icon.svg` | Favicon. Bondi's deep-water `#004e6b` on light browser chrome, Daintree mint `#36ce94` on dark (`prefers-color-scheme` inside the SVG). |
| `icon-192.png`, `icon-512.png` | Manifest `any`: the mark on the dark rounded tile. Also the notification `icon`. |
| `icon-maskable-192.png`, `icon-maskable-512.png` | Manifest `maskable`: full-bleed opaque tile, mark well inside the 80% safe-zone circle. |
| `apple-touch-icon.png` | 180×180, opaque, square: iOS applies its own corners. |
| `badge-96.png` | Notification `badge`: white silhouette on transparency, since Android draws only the alpha channel. |

## Colours

The icon wears Daintree's own app tile: mark `#36ce94` (Daintree's accent) on tile `#151616` (the tile in Daintree's `build/icon-design.svg`), so the two apps sit side by side on a home screen or dock as one family. The mark itself stays Decisions' own: it relates through colour, weight and simplicity and does not borrow Daintree's canopy, trunk or roots.

Inside the app every colour comes from Daintree's theme engine (the Daintree and Bondi themes, generated into `app/src/styles/theme.generated.css` by `pnpm --filter @daintreehq/decisions-app theme`); see [the redesign guide](../design/redesign.md#2-visual-system).

## Previews

[`previews/`](previews) shows the set at real sizes: favicon tabs and pixel zooms, light and dark home screens on iOS and Android, every launcher mask, the notification badge and shade, and the glyph in a Daintree-like UI. Regenerate them with:

```bash
pnpm --filter @daintreehq/decisions-app icons
DESIGN_CAPTURE_DIR=/tmp/decisions-icons node app/scripts/icon-previews.mjs
```
