# Mark assets

Locked geometry: three climbing notes, foam body on water, amber pouch, eye punched to the ground. No wing. No rotation.

| Token | Hex | Role |
|---|---|---|
| Deep teal | `#0A6E60` | light tile / water |
| Abyss | `#061423` | dark tile / OG |
| Foam | `#FBF9F2` | notes |
| Foam warm | `#F4F0E6` | page / PWA background |
| Amber | `#E7862A` | pouch on teal |
| Amber lit | `#F6A340` | pouch on abyss |

Construction (viewBox 100): margin 15, bar 17, gap 10, heights 27 / 44 / 71, tile radius 22.

## Files

| Path | Role |
|---|---|---|
| [`assets/mark.svg`](./assets/mark.svg) | canonical light mark |
| [`assets/mark-abyss.svg`](./assets/mark-abyss.svg) | dark twin |
| [`assets/mark-maskable.svg`](./assets/mark-maskable.svg) | inset for Android safe zone |
| [`assets/mark-currentColor.svg`](./assets/mark-currentColor.svg) | in-product; notes follow `currentColor` |

Shipped copies:

- `packages/site/public/favicon.svg` — same as `assets/mark.svg`
- `packages/web/public/icon.svg` — same
- `packages/web/public/icon-maskable.svg` — same as `assets/mark-maskable.svg`

`packages/site/scripts/gen-icons.ts` and `packages/web/scripts/gen-icons.ts` rasterize those SVGs at build.

GitHub org and npm avatars are set in each host's profile UI from a 1024 / 512 raster of `mark.svg`. They are not in git.
