# @planted/content

Planted's maps, icons and game catalogues, built into versioned files on a CDN. Maps are drawn as layered SVGs; a script turns the layers into `map.json`, so nobody types coordinates by hand.

## Ground rules

These keep the project clear of anyone else's IP. Every contributor follows them.

- **Never commit anything taken from the game, Ubisoft's site or press kits.** No ripped textures, icons, blueprint images or screenshots, not even as a temporary reference.
- **Maps are your own vector drawings of the layout**, in Planted's style. Use your own gameplay and custom-game walkthroughs as reference, and keep your notes and screenshots outside the repo. Don't trace official blueprint images.
- **Icons are original designs** (see [icons/STYLE.md](icons/STYLE.md)). Operators appear as generated badges, never portraits.
- **Operator, map and gadget names are plain text labels only.** The app footer says the project isn't affiliated with Ubisoft.
- Before any paid tier, this gets reviewed by a lawyer or with Ubisoft (an open question in [docs/design.md](../../docs/design.md)).

The three maps in `maps/` today are fictional practice layouts (`practice-annex`, `practice-depot`, `practice-lighthouse`) that exist to exercise the pipeline end to end. Real maps replace them as they are drawn.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm content:extract [mapId…]` | Floor SVGs + `meta.json` → `map.json`, `art/<floor>.svg`, and `src/maps.gen.ts` |
| `pnpm content:check` | Everything CI checks; see below |
| `pnpm content:build [--out dir]` | Builds `dist/<version>/` and `dist/latest.json` |
| `pnpm content:serve` | Serves `dist/` on http://localhost:5174 like the CDN (set `VITE_CONTENT_URL` to it) |
| `pnpm content:release` | Uploads a build to R2; CI runs it on a `content-v*` tag |

Run them from the repo root with `pnpm --filter @planted/content <command>`, or from this folder.

## Drawing a map

Each map lives in `maps/<mapId>/`:

```
meta.json            name, season tag, floor labels and order, site names (hand-written)
src/<floorId>.svg    one SVG per floor, drawn by hand
migrations/<rev>.json  wall and hatch ids removed or renamed since the last release
map.json, art/       written by content:extract; never edit them
```

Start each floor from [templates/floor.svg](templates/floor.svg). It has every layer, a legend and the style colours. The canvas is `viewBox="0 0 4096 4096"`; map space is that divided by 4096. Align floors so stairs and hatches line up when stacked.

| Layer (group id) | Contains | Element id |
| --- | --- | --- |
| `art` | Everything visual: floor fill, walls, stairs, a few props | anything |
| `rooms` | One closed `path`, `polygon` or `rect` per room | `room:<slug>` with `data-callout="Gym"` |
| `walls` | One `line` per wall segment that can change state | `wall:<floor>:<slug>` with `data-kind` |
| `hatches` | One `circle` per hatch | `hatch:<floor>:<slug>` |
| `openings` | One `line` per door, window or vault | `door:<floor>:<slug>`, `window:…`, `vault:…` |
| `sites` | One `circle` per objective | `obj:<site>:A` or `obj:<site>:B`, with `data-room="<room slug>"` |
| `spawns` | One `circle` per spawn | `spawn:attack:<slug>` or `spawn:defence:<slug>`, optional `data-name` |

- `data-kind` is `soft`, `reinforceable`, `hard` or `outer`.
- Wall slugs come from room names (`wall:2f:gym-north`) and **must not change between seasons**: stamps and wall states point at them. Removing or renaming one needs an entry in `migrations/<rev>.json`, `{ "wall:2f:gym-north": null }` or `{ "<old>": "<new>" }`, or `content:check` fails.
- Room slugs only need to be unique per floor; in `map.json` they become `room:<floor>:<slug>`.
- Callouts use the in-game name where one exists and the community name otherwise.
- The art layer is drawn in white only, using opacity for hierarchy. The board tints it with the theme's text colour, and thumbnails render it on a dark background. Outer walls are 40 units wide, inner walls 16, details 4–8. No textures, no transforms on the `art` group.
- Group transforms in the data layers are fine; the extractor applies them. Curves are sampled at about one unit.
- Don't put `<` or `>` inside XML comments: the SVG parser fails on them with an unhelpful error.

**Editors.** Inkscape keeps `id` and `data-*` attributes as they are: set ids in the XML editor (Ctrl+Shift+X), and use layers named exactly as above (the layer's `id` is what counts, not its label). Figma drops `data-*` attributes on export, so draw the data layers in Inkscape or a text editor even if the art comes from Figma; export art with "Include id attribute" on.

When a floor is done:

```sh
pnpm content:extract <mapId> && pnpm content:check
```

Then open it in Planted with the overlay on (`L`) to check callouts, wall kinds, and that hatches and stairs line up across floors. Have a teammate who mains the map check callouts and wall kinds, and log your hours in [LOG.md](LOG.md).

## What `content:check` checks

- every map extracts, and the committed `map.json`, `art/` and `src/maps.gen.ts` match what the extractor writes now
- every `map.json` is schema-valid; ids are unique per map; room outlines don't cross themselves; every objective's room exists on its floor
- wall and hatch ids are stable against the last release (`--baseline <url or dir>` or `CONTENT_BASELINE_URL`; skipped with a notice when neither is set)
- the catalogues are valid and every `gadgetId` and `iconId` resolves
- every icon follows the style spec

## Releases

The content version is the season tag plus a build number, `y11s3.1`, set in `content.json` and independent of app versions. Rooms pin the version they were created with; a new version only applies to new rooms until 0.9 adds migrations.

To release, bump `build` (or `season`) in `content.json`, merge, then:

```sh
git tag content-vy11s3.2 && git push --tags
```

The `content-release` workflow checks, builds, and uploads to the `planted-content` R2 bucket: hashed files and the manifest with `Cache-Control: public, max-age=31536000, immutable`, then `latest.json` with `max-age=60`, last. Old versions are never deleted.

**One-time bucket setup:** create the `planted-content` bucket, attach the custom domain `content.<your domain>`, create an R2 API token with Object Read & Write on the bucket, and add `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as repository secrets. Set CORS once with an admin token: `pnpm content:release --cors https://<web origin>` (it also needs a built `dist/`), or in the dashboard. Set the repository variable `CONTENT_URL` to the public domain so CI checks wall ids against the live release.
