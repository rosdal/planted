# Planted — Design Doc

Oct 21, 2026 · @Mark

**In one line:** a free, Figma-style multiplayer board for Siege that understands loadouts, walls and patches, built as Yjs over one Fastify WebSocket relay so it stays cheap enough to never shut down. The first gate is a one-week spike proving 10 users at 60 fps.

## Overview

Planted is a free, browser-based Rainbow Six Siege strat planner where a whole team edits the same map in real time, the way people use Figma or Excalidraw. Built on React 19 + Vite on the client, Fastify on the server, Yjs CRDTs over WebSocket for sync, and Postgres + Drizzle for persistence.

**Goals**
- Five or more people drawing on one map with under 100 ms perceived latency, no conflicts, no lost strokes.
- R6-native tools: operators, gadgets, reinforcements, rotates, breaches, drones, per-floor layers. Not a generic whiteboard with map images pasted in.
- A team stratbook that survives patches and map reworks.
- A live "execution" view that teammates follow on a second monitor or phone during scrims.
- Free to use, cheap to run: one small VPS should carry a few hundred concurrent rooms.

**Non-goals (v1)**
- Native desktop app. Desktop presence comes through Breached instead.
- In-game overlay or reading game memory.
- Voice chat. Teams already sit in Discord.
- 3D map views. Top-down blueprints only.

## Landscape

Nobody combines fast, true multi-cursor drawing with R6-aware objects and a stratbook that is free. That gap is the product.

| Tool                                                                                                               | Real-time co-editing   | R6-native objects | Stratbook   | Cost          | Gap                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------------- | ----------- | ------------- | ---------------------------------------------------- |
| [R6 Stratbook](https://www.r6stratbook.com/)                                                                       | Live follow sessions   | Yes               | Yes         | Free          | Closest competitor; check how true its co-editing is |
| [Siege Codex](https://siegecodex.com/)                                                                             | Coach pushes briefings | Partial           | Strat vault | Free          | Briefing tool, not a whiteboard                      |
| [R6Calls](https://siege.gg/news/3236-r6calls-introduces-strat-tool-allowing-r6-siege-players-to-share-map-insight) | No, export/import      | Yes               | No          | Free          | Single-player only                                   |
| [R6 Battle Planner](https://steamcommunity.com/app/359550/discussions/0/2798319091580590310)                       | Yes, rooms             | Partial           | Saved plans | Was free      | Faded out on server costs                            |
| [Guild Order](https://guildorder.com/games/r6)                                                                     | No                     | No                | Wiki        | From $3.99/mo | Team site, not a planner                             |

Battle Planner is the warning: rooms were loved, hosting cost killed it. The architecture below is built to stay cheap.

## Differentiators

&#91;embedded content: differentiators · 4 pillars\]

Each competitor wins one pillar. R6Calls knows Siege but is single-player; Battle Planner was multiplayer but died on cost; Stratbook has the playbook; how deep its Siege rules go is still to be checked. Winning all four at once is the pitch.

## Feature scope

The MVP is a shareable room link where up to 10 people draw on one map together. Everything else builds on that.

**MVP: collaborative board**
- Room by link, no account needed to join (guest name + colour).
- Map picker (ranked pool first), site picker, floor tabs incl. roof and basement.
- Tools: pen, arrow, line, text, eraser, select/move, undo/redo per user.
- Stamps: 5 attack + 5 defence operator slots, their gadgets, reinforcements, rotates, hatches, barricades, castle walls, drones.
- Live cursors with names, per-user colours, "follow" a user's viewport.
- Export to PNG.

**v1: teams and stratbook**
- Accounts, teams, roles (owner, editor, viewer).
- Stratbook: strats organised by map > site > side, each with ordered phases ("setup", "prep", "execute", "post-plant").
- Utility counter that knows each operator's loadout and warns when you place a 4th Kapkan trap.
- Bans and backups per strat, player assignments ("Mark = entry, Thermite").
- Version history with restore, and patch tags.

**Later**
- Live session mode for scrims (see below).
- Public strat library with ratings and forks.
- Breached integration: drop a replay round onto the board.
- Timeline playback: animate operator paths per phase.
- Discord bot that posts the strat for the next map in a channel.

## Editor UX

&#91;embedded content: editor layout · top bar, tools, canvas, phase bar, side panel\]

The canvas gets every pixel it can; Siege context (lineup, utility budget, lint issues) lives in one right panel that collapses with Tab. Phases sit under the map because they change what the map shows.

**Keyboard map**

| Key                   | Action                                                       |
| --------------------- | ------------------------------------------------------------ |
| V / P / A / T / S / E | Select, pen, arrow, text, stamp, eraser                      |
| 1–5                   | Switch floor                                                 |
| Shift + 1–5           | Stamp for lineup slot 1–5                                    |
| \[ / \]               | Previous / next phase                                        |
| R                     | Cycle wall state on hovered wall (reinforce, rotate, breach) |
| G                     | Ping the map for everyone (2 s)                              |
| F                     | Follow / stop following presenter                            |
| Ctrl+K                | Command palette                                              |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo your own edits                                   |

**Command palette (Ctrl+K)**
- Fuzzy over maps, sites, callouts, operators and strats: "clubhouse cctv" jumps to that room on the right floor.
- Actions: "duplicate strat to other site", "mirror to attack view", "export PNG of all phases".

**Stamping flow**
- Pick a lineup slot, press S: the stamp palette shows only that operator's gadgets with remaining counts.
- Placing snaps to walls, windows and hatches from the map data; free placement with Alt.
- Every stamp carries its slot colour, so one glance shows who does what.

## System architecture

&#91;embedded content: system architecture · 2 clients, 1 server process, 2 stores\]

Only board edits and presence go over the WebSocket; clients load map art straight from R2 through the CDN. The relay is the core of the system, everything else is ordinary CRUD.

## Real-time collaboration

Use Yjs as the source of truth for board state and a thin WebSocket relay on the server. Do not hand-roll an op protocol: CRDTs give conflict-free merges, offline edits and undo for free.

**Why Yjs over custom ops or Socket.IO events**
- Concurrent moves of the same stamp, or two people erasing the same stroke, merge deterministically.
- `Y.UndoManager` scoped to the local client origin gives per-user undo, which a whiteboard needs.
- Binary updates are tiny; a pen stroke is a few hundred bytes.
- Reconnects send only the state vector diff, so a flaky connection heals itself.

**Transport**
- One WebSocket per client per room, `wss://api.<domain>/rooms/:roomId`.
- Server side: `@fastify/websocket` + the `y-protocols` sync and awareness messages. Hocuspocus is the off-the-shelf option if you'd rather not write the relay; evaluate it, but a custom relay keeps it inside your Fastify app.
- Message types: `sync-step-1`, `sync-step-2`, `update`, `awareness`, plus app messages (`follow`, `ping`, `phase-change`) on a separate channel prefix.
- Auth: short-lived room token (JWT, 5 min) fetched over HTTP, passed as the first WS message, not in the URL.

**Presence (awareness, not persisted)**
- `{ userId, name, colour, cursor: {x, y, floor}, tool, viewport, followTarget }`.
- Cursor updates throttled to 30 Hz on the client, interpolated on receivers so they look smooth at 60 fps.

**Live strokes**
- While drawing, stream points via awareness (ephemeral) so others see the stroke grow.
- On pointer-up, commit the simplified stroke (Ramer–Douglas–Peucker) into the Y.Doc once. Keeps document history small.

**Server responsibilities**
- Hold the room's Y.Doc in memory while anyone is connected.
- Debounced persistence: write the encoded state to Postgres 2 s after the last change and on last disconnect.
- Unload idle rooms after 60 s with no clients.
- Enforce role: drop `update` messages from viewers before applying them.
- Rate limit per socket (messages/s and bytes/s) to stop someone flooding a public room.

## Visual design

Clean, sleek and professional, in the spirit of Vercel: a monochrome interface where type, spacing and hairline borders do the work, and colour appears only when it means something on the board.

**Principles**
- Monochrome chrome. Every panel, button and menu is built from the neutral scale; no tinted backgrounds, no gradients.
- Colour is information. Attack, defence, lineup slots, users and lint states are the only colours on screen, so a glance at the board tells you who does what.
- Hairlines over shadows. 1 px borders separate surfaces; shadows only on floating layers (popovers, dialogs, command palette).
- Quiet density. Compact controls and small type, but generous gaps between groups, so the canvas always dominates.
- Keyboard first. Every action shows its shortcut in tooltips and the command palette, rendered as mono `kbd` chips.

&#91;embedded content: palette · dark and light neutrals, board colours, lineup slots\]

**Colour tokens** (Tailwind v4 `@theme`, as CSS variables; dark is the default, light follows `prefers-color-scheme` and a manual toggle)
- Neutrals as above. Primary buttons are inverted (text colour as the fill, background colour as the label); secondary buttons are bordered; ghost buttons have no border until hover.
- Focus ring: 2 px in the text colour with a 2 px background-coloured offset. No blue focus colour, which keeps the chrome fully monochrome.
- Board colours are tuned to read on both the dark and light canvas. Attack and defence are reserved for sides; slot colours are deliberately different hues from both. Planted green is the brand accent and the "live" dot, and nothing else.
- User cursor colours: 8 more hues kept away from the slot set, so a cursor is never mistaken for a lineup slot.

**Type**
- Geist Sans for everything, Geist Mono for ids, versions, keyboard chips and numbers in the utility sheet (`font-variant-numeric: tabular-nums`)
- Scale: 12 / 13 / 14 / 16 / 20 / 24 / 32 px; UI body is 14 px, panels 13 px, captions 12 px
- Weights 400, 500 and 600 only; headings get `letter-spacing: -0.02em`
- Wordmark: "planted" in lowercase Geist, weight 600, with a small green dot as the mark

**Shape and motion**
- 4 px spacing grid; radii 6 px for controls, 8 px for panels and cards, 12 px for dialogs
- Control heights: 28 px compact (toolbars), 32 px default, 40 px for the landing page
- Motion: 150 ms ease-out for hovers and panels, 200 ms for dialogs, no bounce or spring; everything respects `prefers-reduced-motion`

**Components**
- UI primitives on Detent (your component library) or Radix, styled with the tokens above; keep one `ui/` folder so the look stays consistent
- Chrome icons from Lucide at 16 px with a 1.5 px stroke; game icons are the original set from the content package
- Toasts bottom-right, one line, auto-dismiss; empty states are one sentence plus one button
- Command palette, menus and tooltips share one surface style: `surface-2`, hairline border, small shadow

**Canvas**
- Map art in monochrome line work: walls in the text colour at 70%, floors as a barely lighter fill than the background, grid almost invisible
- Inherited phase objects at 40%, inherited wall states at 60%, so the current phase stays crisp
- Selection and hover outlines in the text colour, not a brand colour
- In light mode the canvas flips with the UI: white floor, dark line work, same board colours

## Join and sync flow

&#91;embedded content: join sequence · 1 HTTP call, 6 socket frames\]

A warm room skips the Postgres step, so joining costs one HTTP round trip plus one socket round trip. The client paints the map from the CDN in parallel, so the board is visible before sync finishes.

## Wire protocol

One binary WebSocket per client, every frame starts with a 1-byte channel and a 1-byte type. Yjs payloads pass through untouched; app messages are CBOR so the Rust side (Breached) decodes them as easily as TypeScript.

```
[u8 channel][u8 type][u32 seq?][payload...]
channel 0 = control   channel 1 = yjs sync   channel 2 = awareness   channel 3 = app
```

| Channel   | Type                     | Direction | Payload                                        | Notes                                                 |
| --------- | ------------------------ | --------- | ---------------------------------------------- | ----------------------------------------------------- |
| control   | hello                    | C→S       | { protocol: 1, token, clientId, stateVector? } | First frame; server closes with 4401 if token invalid |
| control   | welcome                  | S→C       | { role, serverTime, roomEpoch, limits }        | roomEpoch bumps when the doc is restored from history |
| control   | error                    | S→C       | { code, message, fatal }                       | 4401 auth, 4403 role, 4409 epoch, 4429 rate limit     |
| control   | ping / pong              | both      | { t }                                          | Every 15 s; 2 missed = reconnect                      |
| yjs       | sync-1 / sync-2 / update | both      | y-protocols bytes                              | Unchanged from y-protocols                            |
| awareness | update                   | both      | y-protocols awareness                          | Cursors, tool, viewport, live stroke points           |
| app       | follow                   | C→S→C     | { target \| null }                             | Presenter follow in live mode                         |
| app       | phase                    | C→S→C     | { phaseId }                                    | Presenter only                                        |
| app       | ping-map                 | C→S→C     | { at, floor, kind }                            | Short-lived map ping, never stored                    |
| app       | kick / lock              | S→C       | { userId } / { locked }                        | Owner moderation                                      |
- Versioning: `protocol` in hello; server supports current and previous version, refuses older with `error` + `upgrade` hint.
- Backpressure: if a socket's `bufferedAmount` passes 1 MB, the server drops its awareness frames first, then closes it with 4429; Yjs updates are never dropped.
- Reconnect: exponential backoff 250 ms → 10 s with jitter; resend hello with the local state vector so only the diff comes back.
- Epoch: a restore from history changes `roomEpoch`; clients on an old epoch discard local state and resync instead of merging stale edits back in.
- Message size cap 256 KB per frame; image uploads go over HTTP to R2, never through the socket.

## Data model

Postgres holds who owns what; the Y.Doc holds what is drawn. The board itself is stored as one binary blob per strat, never as rows per stroke.

**Postgres (Drizzle)**

| Table                           | Key columns                                                               | Notes                                                       |
| ------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| users                           | id, name, avatar                                                          | better-auth tables alongside                                |
| teams                           | id, name, slug, owner\_id                                                 |                                                             |
| team\_members                   | team\_id, user\_id, role                                                  | owner / editor / viewer                                     |
| stratbooks                      | id, team\_id, name                                                        | A team can have several (main roster, academy)              |
| strats                          | id, stratbook\_id, map\_id, site\_id, side, name, patch\_tag, updated\_at | Metadata for listing and search                             |
| strat\_docs                     | strat\_id, ydoc bytea, version                                            | Current encoded Y.Doc state                                 |
| strat\_snapshots                | id, strat\_id, ydoc bytea, created\_by, created\_at, label                | Version history, taken every 10 min of activity + on demand |
| rooms                           | id, strat\_id null, created\_by, expires\_at                              | Guest rooms without a strat expire after 30 days idle       |
| maps, sites, operators, gadgets | id, slug, season\_added, season\_removed                                  | Seeded from the asset pipeline                              |

**Y.Doc shape**

```ts
doc.getMap('meta'); // { mapId, siteId, side, patchTag }
doc.getArray('phases'); // Y.Map<{ id, name, order }>
doc.getMap('objects'); // id -> Y.Map<BoardObject>
doc.getMap('lineup'); // slot 1..5 -> { operatorId, playerName, role }

type BoardObject =
  | {
      kind: 'stroke';
      floor: FloorId;
      phase: PhaseId;
      points: Float32Array;
      colour: string;
      width: number;
      by: UserId;
    }
  | { kind: 'arrow' | 'line'; floor; phase; from: Vec2; to: Vec2; colour }
  | { kind: 'text'; floor; phase; at: Vec2; text: Y.Text; size: number }
  | {
      kind: 'stamp';
      floor;
      phase;
      at: Vec2;
      rotation: number;
      stampId: string;
      slot?: 1 | 2 | 3 | 4 | 5;
    }
  | {
      kind: 'wall';
      floor;
      phase;
      wallId: string;
      state: 'reinforced' | 'rotate' | 'breached' | 'hatch-open';
    };
```

Coordinates are in map units (normalised 0..1 per floor), not pixels, so strats survive higher-resolution map art. Walls reference stable `wallId`s from the map data rather than free positions, so the utility counter and patch diffing can reason about them.

## Strat rules engine

Planted understands Siege rules, so a strat can be checked like code. A pure function `lint(doc, content) → Issue[]` runs on every change in a Web Worker and shows issues inline, like ESLint for strats.

| Rule                                   | Severity | Example message                                            |
| -------------------------------------- | -------- | ---------------------------------------------------------- |
| Gadget count over loadout              | Error    | "Kapkan has 5 traps, 6 placed"                             |
| Team reinforcement budget              | Error    | "12 reinforcements placed, team has 10"                    |
| Operator banned for this strat         | Error    | "Thatcher is in your ban list"                             |
| Duplicate operator in lineup           | Error    | "Two Thermites in slot 2 and 4"                            |
| Gadget not available on this side      | Error    | "Hard breach charge on defence"                            |
| Utility not assigned to a slot         | Warning  | "3 Kapkan traps but nobody plays Kapkan"                   |
| Hard breach wall with no hard breacher | Warning  | "Kitchen wall reinforced target, no hard breach in lineup" |
| Reinforced wall also marked rotate     | Warning  | "Bar wall is both reinforced and open"                     |
| Object on a removed wall after patch   | Warning  | "Wall removed in Y11S3 rework"                             |
| Phase with no objects                  | Info     | "Post-plant phase is empty"                                |
- Rules are plain TypeScript modules in `packages/rules`, each with id, severity, `check()`, and unit tests against fixture strats.
- The same package runs server side to score public strats and to flag stale ones after a patch.
- Users can mute a rule per strat ("we know, it's a bait reinforcement").
- Derived panel: a live utility sheet per side (gadgets placed / available, reinforcements left, breaches per wall) that teams currently keep in spreadsheets.

## Canvas and rendering

Render with PixiJS (WebGL) inside a React shell; React owns the toolbars and panels, never the per-frame drawing. React state re-rendering on every pointer move is what makes whiteboards feel slow.

**Layer stack per floor, bottom to top**
1. Map blueprint (tiled texture, mipmapped for zoom)
2. Map data overlay: room names, wall outlines, hatches, windows (vector, toggleable)
3. Wall states (reinforced, rotate, breach marks)
4. Strokes, arrows, lines
5. Stamps (operators, gadgets, drones)
6. Text
7. Remote cursors, live in-progress strokes, selection boxes

**Floors**
- Tabs for each floor, plus a "stack" view showing the floor above and below at 25% opacity for vertical play.
- Hotkeys follow the keyboard map under Editor UX (floors on 1–5, tools on single letters).

**Binding Yjs to Pixi**
- A small store observes `objects` with `observeDeep` and keeps a `Map<id, DisplayObject>`; only changed ids are touched.
- Selection and drag write to the Y.Doc at most every frame, wrapped in `doc.transact` so one drag = one undo step.

**Performance budget**
- 60 fps with 2,000 objects and 10 cursors on a mid laptop.
- Strokes simplified on commit and cached as `Graphics` geometry; re-tessellate only on change.
- Culling: off-screen and other-floor objects are not rendered.

**UI shell**
- React 19, Vite, TanStack Router, Tailwind; a clean, Vercel-like look with Geist, matching Breached.
- Zustand for local UI state (active tool, colour, panel layout).

## Assets, patches and IP

Map and operator data live in a separate, versioned content package, so a new season is a data release, not a code deploy.

**Content package (`@planted/content`)**
- `maps/<slug>/<season>/map.json`: floors, sites, rooms with callout names, walls with stable `wallId`s, hatches, windows, spawns.
- `maps/<slug>/<season>/floor-<n>.webp`: blueprint art, 4096 px, plus 1024 px thumbnails.
- `operators.json`: side, gadgets with counts, secondary gadget options, season added.
- Served from a CDN (Cloudflare R2), cache forever, keyed by content hash.

**Patch versioning**
- Every strat stores the `patchTag` it was made on.
- When a map rework changes walls, a migration maps old `wallId`s to new ones; unmapped objects are flagged "needs review" rather than deleted.
- Strat list shows a badge on strats made before the current patch, and when an operator's gadget count changed.

**IP**
- Map blueprints, operator icons and names are Ubisoft's. Keep the product free and non-commercial at first, and read Ubisoft's fan content terms before shipping.
- Safer default: redraw blueprints yourself as vector line art from in-game reference, and use your own operator glyphs (initials or silhouettes). Vector maps also scale better and theme cleanly in dark mode.
- A paid tier would change the IP picture; decide that before taking money.

## Auth, teams and permissions

better-auth with Discord OAuth as the main login, since every Siege team already lives on Discord; email magic link as fallback. Guests can join a room by link without an account.

| Role   | Scope         | Can                                                            |
| ------ | ------------- | -------------------------------------------------------------- |
| Owner  | Team          | Everything, incl. delete team, transfer ownership              |
| Editor | Team or strat | Create and edit strats, run live sessions                      |
| Viewer | Team or strat | Open strats, follow live sessions, export PNG                  |
| Guest  | Room link     | Edit or view, set by the link (`?mode=edit` tokens are signed) |
- Share links are signed tokens with role + expiry, revocable from the strat settings.
- The WS server re-checks role on connect and on every `update` message; the client never decides.
- Discord guild link (later): auto-add guild members with a chosen role to the team.

## Security and abuse

The risky surface is the WebSocket: anyone with a link can send bytes into a shared document. Every threat below is handled on the server, never trusted to the client.

| Threat                        | Vector                            | Control                                                                                      |
| ----------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| Opponent scouting your strats | Leaked or guessed link            | 128-bit room ids, signed expiring share tokens, private by default, revoke all links button  |
| Viewer writing to the doc     | Forged `update` frames            | Server drops yjs updates from viewer sockets before applying                                 |
| Doc bombing                   | Huge or endless updates           | 256 KB frame cap, per-socket bytes/s limit, max objects per doc (20k), max doc size (5 MB)   |
| Malformed CRDT data           | Crafted update that crashes peers | Apply on server first in a try/catch; reject and disconnect on failure, so it never fans out |
| Schema abuse                  | Valid Yjs, invalid BoardObject    | Server-side Zod validation of changed objects after apply; revert transaction if invalid     |
| XSS via text objects          | Script in labels or team names    | Text rendered by Pixi, never as HTML; React escapes the rest; strict CSP                     |
| Account takeover              | Stolen session                    | better-auth sessions, httpOnly SameSite cookies, short WS tokens (5 min)                     |
| Griefing in public rooms      | Mass erase                        | Per-user undo is not enough: owner can restore any snapshot, kick, and lock edits            |
| Cost attack                   | Thousands of empty rooms          | Rate-limit room creation per IP and account, unload idle rooms, expire guest rooms           |

GDPR: store the minimum (Discord id, display name, avatar URL). Account deletion removes the user's teams they solely own and anonymises their `by` fields in docs.

## Live session mode

During a scrim, the IGL or coach drives and four players follow on a second monitor or phone. One click turns any strat into a session; it is the same room with a "presenter" role.
- Presenter controls map, floor, phase and viewport; followers' views snap to it (they can break out and re-sync with `F`).
- Phase stepper: "Setup → Prep → Execute → Post-plant", shown big at the top. Changing phase fades objects in and out per phase.
- Per-player view: each follower sees their own slot highlighted, with their operator, loadout and one-line job ("drone Rotate from Bar, then hold Kitchen").
- Laser pointer: presenter's cursor leaves a short-lived trail, not a stroke.
- Round notes: quick buttons for "won / lost / why" per round, saved to the strat for the review afterwards.
- Mobile layout: read-only, landscape-first, large touch targets, screen wake lock on.

## Infra, deployment and scaling

Start on one VPS with Docker Compose; the design scales out later without a rewrite. Rough target: well under €20/month until there is real traffic.

**Monorepo (pnpm + Turborepo)**
- `apps/web`: React client.
- `apps/server`: Fastify HTTP API + WebSocket relay in one process.
- `packages/schema`: shared Zod types for BoardObject, WS app messages, API.
- `packages/content`: map and operator data.
- `packages/db`: Drizzle schema and migrations.

**Deploy**
- Caddy in front for TLS and WebSocket upgrade; static web build served from Cloudflare Pages or the same Caddy.
- Postgres in a container with nightly `pg_dump` to R2.
- Room assets and exports on R2 (no egress fees).
- Could run on your homelab first for beta testing, behind a Cloudflare Tunnel.

**Scaling out**
- A room must live on exactly one server process. Route by `roomId` with consistent hashing at the proxy, or keep a `room -> node` lease in Redis.
- Redis pub/sub only if you want rooms spread across nodes; avoid it until one box is full.
- Memory estimate: a busy strat doc is tens of KB, so thousands of loaded rooms fit in 1 GB.

**Observability**
- pino logs, Prometheus metrics: open sockets, loaded rooms, messages/s, persist latency.
- Sentry on client and server.

## Testing and quality

Collaboration bugs only show up with many clients and bad networks, so the test suite simulates both from day one.
- **Convergence fuzzing**: property tests (fast-check) spin up 2–8 in-memory Y.Docs, apply random edits, shuffle and delay delivery, then assert every doc ends identical and passes the BoardObject schema.
- **Bot load test**: a Node script opens N headless clients per room that draw, move stamps and stream cursors at real rates. Target: 500 rooms × 6 clients on one 4 vCPU box, p95 update fan-out under 50 ms.
- **Chaos network**: run the bot test through toxiproxy with 150 ms latency, 2% loss and random disconnects; no lost committed strokes allowed.
- **Rules engine**: unit tests per rule against fixture strats.
- **Rendering**: Playwright screenshots of fixture strats per map and floor, diffed per PR; catches broken map data after content updates.
- **E2E**: Playwright with two browser contexts in one room: draw in A, assert visible in B; undo in A does not undo B's work.

| Budget                                | Target       |
| ------------------------------------- | ------------ |
| First board paint (cold, 4G)          | < 2.5 s      |
| JS on first load (gzip)               | < 300 KB     |
| Local stroke latency                  | 1 frame      |
| Remote edit visible (EU, same region) | < 100 ms p95 |
| Frame rate, 2k objects + 10 cursors   | 60 fps       |
| Reconnect to synced                   | < 1 s        |

## Integration with Breached

Planted and Breached share the same map coordinate system, so a replay round can become a strat and a strat can be checked against what actually happened.
- Shared content package: Breached's renderer and Planted read the same `map.json` (rooms, walls, callouts).
- Replay → board: Breached exports a round from a `.rec` file (via the replay-analyzer parser) as a set of BoardObjects: operator paths as strokes, plant spot, kill locations as stamps. Paste into a strat as a new phase "Replay R7".
- Board → Breached: Breached opens a strat in a side panel during review, overlaid on the replay.
- Auth: Breached signs in with the same account through a device-code flow and calls the same API.
- Keep the export format a versioned JSON schema in `packages/schema` so neither side breaks the other.

## Success metrics

The one number that matters is weekly active teams: teams with 3+ members editing or following a strat in the same week. Everything else explains it.

| Metric                 | Definition                                         | Target 3 months after MVP |
| ---------------------- | -------------------------------------------------- | ------------------------- |
| Weekly active teams    | 3+ members active on one team's strats in a week   | 100                       |
| Multiplayer rate       | Share of sessions with 2+ concurrent users         | > 40%                     |
| Room → account         | Guests who sign up within 7 days of joining a room | > 15%                     |
| Strats per active team | Strats created or edited per week                  | ≥ 3                       |
| Live sessions per week | Presenter sessions with 4+ followers               | 50                        |
| Sync errors            | Sessions with a forced resync or lost edit         | < 0.1%                    |
| Cost per active team   | Monthly infra cost / weekly active teams           | < €0.10                   |

Privacy-friendly analytics only (self-hosted Plausible or Umami), no third-party trackers.

## Milestones

&#91;embedded content: roadmap · 4 phases, 3 gates\]

The spike is the riskiest part: if Yjs over the Fastify relay can't hold 10 users at 60 fps, change the approach before building anything else. No dates yet; set them once the spike is done.

Step-by-step versions from an empty folder: [Roadmap](roadmap.md)

## Open questions and risks

| Risk                                        | Impact                       | Mitigation                                                                   |
| ------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| Ubisoft IP on map art and icons             | Takedown                     | Own vector redraws, own glyphs, stay non-commercial until cleared            |
| Map data upkeep every season                | Strats go stale, users leave | Content package with per-season data; community PRs to an open data repo     |
| Hosting cost growth (Battle Planner's fate) | Shutdown                     | One-process rooms, R2 for assets, unload idle rooms, optional supporter tier |
| Yjs doc bloat from long sessions            | Slow loads                   | Commit simplified strokes only, periodic snapshot + GC, cap history length   |
| Griefing in public rooms                    | Bad first impressions        | Signed edit links, rate limits, owner can kick and lock room                 |
- [x] Product name decided: Planted (repo planted, packages @planted/\*).
- [ ] Build the relay on Fastify or on Sworn once it supports WebSockets?
- [ ] Hocuspocus vs custom relay: spike both for a day.
- [ ] Redraw maps by hand, or trace from blueprints with a vector tool pipeline?
- [ ] Check how true R6 Stratbook's co-editing is before committing to the same pitch.

## Sources

- [R6 Stratbook](https://www.r6stratbook.com/)
- [Siege Codex](https://siegecodex.com/)
- [R6Calls strat tool (SiegeGG)](https://siege.gg/news/3236-r6calls-introduces-strat-tool-allowing-r6-siege-players-to-share-map-insight)
- [R6 Battle Planner thread (Steam)](https://steamcommunity.com/app/359550/discussions/0/2798319091580590310)
- [Guild Order](https://guildorder.com/games/r6)
