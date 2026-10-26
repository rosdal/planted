# Icon style

Icons are drawn for a top-down board at small sizes, not for a HUD: bold, simple silhouettes that still read at 20 px over a map. Every icon is an original design.

## Grid

- 24 × 24 viewBox, 2 px padding: shapes stay between 2 and 22.
- 1.75 px stroke, round caps and joins, set once on the root:

  ```svg
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">…</svg>
  ```

- `currentColor` only. No fills in other colours, no gradients, text, images, ids or inline styles. `content:check` enforces all of this.
- Prefer one closed outline plus two or three inner strokes. If it needs a fourth detail to be recognisable, it won't survive 20 px.

## On the board

Every icon sits in a 28 px chip: a circle filled with the slot colour, the icon in white at 20 px, and a 1 px dark ring so it reads on any map.

Operators get generated badges instead of drawn icons: a circle in the slot colour with the two-letter `badge` code from `operators.json`. Unique gadgets use the one `unique` glyph in v1, labelled with the operator's badge; distinct glyphs for the 20 most-played operators come later.

## Adding an icon

1. Draw it in `src/<iconId>.svg` from an existing icon's root element.
2. Reference it by `iconId` from `gadgets.json` or `weapon-classes.json`.
3. `pnpm content:check`, then look at it on `/dev/icons` at 16, 20 and 28 px, on light and dark.

The build runs svgo, then produces one SVG sprite (`<symbol id="icon-<iconId>">`) for the React UI and two Pixi atlases (64 px and 128 px) for the board.

## Set (v1)

| Group | Icons |
| --- | --- |
| Weapon classes | `weapon-ar`, `weapon-smg`, `weapon-shotgun`, `weapon-dmr`, `weapon-lmg`, `weapon-mp`, `weapon-handgun`, `weapon-shield` |
| Board basics | `reinforcement`, `rotate`, `breach-mark`, `hatch-open`, `barricade`, `drone`, `camera`, `objective`, `spawn` |
| Attack secondaries | `breach-charge`, `claymore`, `frag`, `smoke`, `stun`, `impact-emp`, `hard-breach` |
| Defence secondaries | `barbed-wire`, `deployable-shield`, `nitro-cell`, `impact-grenade`, `bulletproof-camera`, `proximity-alarm`, `observation-blocker` |
| Unique gadgets | `unique` |
