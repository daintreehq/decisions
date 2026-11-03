# The mark

Decisions wears Daintree's own mark: the canopy, trunk and roots from Daintree's `DaintreeIcon`. It is Daintree's sister app, and on a home screen, a dock or a notification shade the two should read as one product rather than two that happen to look alike. Earlier versions used a separate mark of their own (a rounded decision diamond with a question mark cut out of it); it was retired so the family has one face.

The mark is one colour by construction, so the same geometry works as an app icon, an alpha-only notification badge and a `currentColor` glyph.

## Source

[`app/public/icons/mark.svg`](../../app/public/icons/mark.svg) is the only source in this repository. Its four paths are Daintree's `DaintreeIcon` paths unchanged, on their native 177.31 × 132.85 grid, fitted to the full width of a 512 box and optically centred. It fills with `currentColor`, which makes it the monochrome variant too: inline it, or load it as a mask, and it takes the surrounding text colour. The header's inline glyph (`Mark` in `app/src/components/Shell.tsx`) uses the same paths. If Daintree's mark ever changes, copy its paths into both.

Everything else is generated from it by [`app/scripts/make-icons.mjs`](../../app/scripts/make-icons.mjs) (`pnpm --filter @daintreehq/decisions-app icons`):

| File                                             | Use                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `icon.svg`                                       | Favicon. Bondi's deep-water `#004e6b` on light browser chrome, Daintree mint `#36ce94` on dark (`prefers-color-scheme` inside the SVG).     |
| `icon-192.png`, `icon-512.png`                   | Manifest `any`: the mark at 70% of the tile's width on the dark rounded tile, exactly as Daintree's app icon. Also the notification `icon`. |
| `icon-maskable-192.png`, `icon-maskable-512.png` | Manifest `maskable`: full-bleed opaque tile, mark at 60% width so its corners stay inside the 80% safe-zone circle.                         |
| `apple-touch-icon.png`                           | 180×180, opaque, square: iOS applies its own corners.                                                                                       |
| `badge-96.png`                                   | Notification `badge`: white silhouette on transparency, since Android draws only the alpha channel.                                         |

## Colours

The icon is Daintree's app tile: mark `#36ce94` (Daintree's accent) on tile `#151616` (the tile in Daintree's `build/icon-design.svg`).

Inside the app every colour comes from Daintree's theme engine (the Daintree and Bondi themes, generated into `app/src/styles/theme.generated.css` by `pnpm --filter @daintreehq/decisions-app theme`); see [the redesign guide](../design/redesign.md#2-visual-system).

## Previews

[`previews/`](previews) shows the set at real sizes: favicon tabs and pixel zooms, light and dark home screens on iOS and Android, every launcher mask, the notification badge and shade, and the glyph in a Daintree-like UI. Regenerate them with:

```bash
pnpm --filter @daintreehq/decisions-app icons
DESIGN_CAPTURE_DIR=/tmp/decisions-icons node app/scripts/icon-previews.mjs
```
