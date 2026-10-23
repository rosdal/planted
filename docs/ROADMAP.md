# Roadmap: empty folder to 1.0

Eleven versions, each ending in something you can run. Every version has an exit check; don't start the next until it passes.

&#91;embedded content: roadmap · 11 versions, 5 phases, 3 gates\]

If a gate fails, fix it inside that version rather than moving on. 0.5 (drawing the maps) can run in parallel with 0.4.

## 0.0 Repo bootstrap

From an empty folder to a monorepo where `pnpm install && pnpm check` passes locally and in CI. No product code yet.

- [ ] `git init -b main`
- [ ] Pin Node LTS with `.nvmrc`, enable Corepack, `pnpm init`, set `packageManager` in the root package.json
- [ ] `pnpm-workspace.yaml` with `apps/*` and `packages/*`; create the empty folders
- [ ] Turborepo: `turbo.json` with build, dev, lint, typecheck and test pipelines
- [ ] `tsconfig.base.json`: strict, `noUncheckedIndexedAccess`, bundler module resolution, path aliases
- [ ] Biome for lint + format (one tool, fast); `biome.json` at the root
- [ ] Lefthook pre-commit: Biome on staged files; commit-msg check for Conventional Commits
- [ ] Vitest workspace config at the root
- [ ] `.gitignore`, `.editorconfig`, `.env.example`
- [ ] README (one-paragraph pitch + dev setup), LICENSE (pick before the first push: MIT or AGPL-3.0), `docs/` with this design doc exported
- [ ] Create the GitHub repo (your account or the Rosdal org), push `main`, protect it: PRs only, CI required
- [ ] GitHub Actions `ci.yml`: install with cache, then `turbo lint typecheck test build`
- [ ] Renovate or Dependabot for dependency updates

**Exit check:** a fresh clone on WSL2 runs `pnpm install && pnpm check` with zero errors, and the first PR goes green in CI.

## 0.1 App skeletons

All four workspaces exist and talk to each other: the web app calls the server, the server reads Postgres, both share types.

- [ ] `packages/schema`: Zod schemas for `BoardObject`, room ids, API DTOs; built with tsup
- [ ] `packages/db`: Drizzle config, first migration with `users`, `rooms`, `strat_docs`; `db:migrate` and `db:studio` scripts
- [ ] `docker-compose.dev.yml`: Postgres 17 (+ Adminer optional), named volume
- [ ] `apps/server`: Fastify with typed env (`@fastify/env` or Zod), pino logger, `GET /health`, CORS, graceful shutdown
- [ ] Server route `POST /rooms` → creates a room row, returns `{ roomId }` (128-bit, base62)
- [ ] `apps/web`: Vite + React 19 + TanStack Router + Tailwind + Geist; routes `/` and `/r/$roomId`
- [ ] Typed API client in `apps/web` using the shared schemas
- [ ] Landing page button "New room" → `POST /rooms` → navigate to `/r/<id>` showing the id
- [ ] `pnpm dev` at the root starts Postgres, server and web in one command
- [ ] CI: add a Postgres service, run migrations, one server integration test (create room, read it back)

**Exit check:** click "New room" in the browser, land on `/r/<id>`, and the row is in Postgres.

## 0.2 Relay spike

Prove Yjs sync over your own Fastify WebSocket before any drawing exists. If this is shaky, try Hocuspocus now, not later.

- [ ] Add `@fastify/websocket`, `yjs`, `y-protocols`, `lib0`
- [ ] Route `GET /rooms/:id/ws`: on connect, get or create an in-memory `Room { doc, awareness, sockets }`
- [ ] Implement frame header `[channel][type]` from the wire protocol; channels 1 (yjs) and 2 (awareness) only
- [ ] Server handles sync-step-1/2 and updates, fans out to the other sockets in the room
- [ ] Client `RoomProvider` in `apps/web`: connect, sync, expose `doc` and `awareness` via React context
- [ ] Debug page: a shared `Y.Array` of strings with an input box, plus a list of connected users from awareness
- [ ] Reconnect with exponential backoff and jitter; resync from the state vector
- [ ] Unload a room 60 s after its last socket leaves
- [ ] Convergence fuzz test (fast-check): 2–8 in-memory docs, random edits, shuffled delivery, all end equal
- [ ] Bot script `scripts/bots.ts`: N headless clients per room sending updates at drawing rates

**Exit check:** two browsers and 20 bots in one room stay in sync for 10 minutes, including killing and restarting the server mid-session (state is lost on restart for now, but clients reconnect cleanly).

## 0.3 Canvas spike

A real board on top of the relay: pan, zoom, draw, see each other. This is the first gate from the design doc.

- [ ] PixiJS v8 mounted in a React component; React never re-renders per frame
- [ ] Camera: wheel zoom to cursor, drag to pan, clamp to map bounds, coordinates normalised 0..1
- [ ] Placeholder map: one hand-drawn vector floor (a simple test layout is fine)
- [ ] `objects` Y.Map bound to a Pixi scene store (`observeDeep`, only touch changed ids)
- [ ] Pen tool: live points over awareness at 30 Hz, Ramer–Douglas–Peucker on pointer-up, commit one stroke
- [ ] Remote cursors with name tags and interpolation to 60 fps
- [ ] Per-user undo with `Y.UndoManager` scoped to the local origin
- [ ] Guest name + colour prompt on first join, kept in localStorage (wrapped in try/catch)
- [ ] FPS + object-count overlay in dev builds
- [ ] Bots now draw real strokes and move cursors

**Exit check (gate 1):** 10 people (or 2 humans + 8 bots) drawing for 5 minutes on a mid laptop, 60 fps, no lost strokes, undo only undoes your own work.

## 0.4 Persistence and rooms

Boards survive restarts, and the full wire protocol is in place, so nothing after this changes the socket contract.

- [ ] Control channel: `hello` / `welcome` / `error` / `ping` with protocol version and close codes 4401, 4403, 4409, 4429
- [ ] Room tokens: `GET /rooms/:id/token` returns a 5-minute signed JWT with role; sent in `hello`, never in the URL
- [ ] Load a cold room's Y.Doc from `strat_docs`; debounced save 2 s after the last change and on last disconnect
- [ ] `roomEpoch` stored per room; mismatched clients drop local state and resync
- [ ] Signed share links: edit vs view; viewer sockets have yjs updates dropped server side
- [ ] Limits: 256 KB frame cap, per-socket bytes/s, 20k objects and 5 MB per doc, room creation rate limit per IP
- [ ] Server-side apply in try/catch + Zod check of changed objects; reject and disconnect on failure
- [ ] Guest rooms expire after 30 days idle (nightly job)
- [ ] Chaos test: bots through toxiproxy (150 ms, 2% loss, random drops)

**Exit check:** draw, restart the server, reload: everything is there. A view link cannot change the board even with a hand-crafted socket client.

## 0.5 Content package

Real maps and an original icon set, delivered as versioned data. This is the slowest version by hours of work, mostly drawing, so start it in parallel with 0.4.

- [ ] `packages/content` with Zod schemas for `map.json` (floors, sites, rooms with callouts, walls with stable `wallId`s, hatches, windows, spawns) and `operators.json`
- [ ] Vector redraw tooling: an SVG template per floor, a script that extracts rooms and walls from named SVG layers into `map.json`
- [ ] First 3 maps redrawn by hand from in-game reference (pick the 3 your team plays most)
- [ ] Original icon set v1: weapon class silhouettes, gadget glyphs, operator badges (slot colour + initials); one SVG sprite, ids match `operators.json`
- [ ] Icon pack manifest so the icon source is a swappable layer
- [ ] Build step: SVG floors → optimised SVG + WebP fallback, content-hashed filenames
- [ ] Cloudflare R2 bucket + public CDN domain; CI uploads on content release
- [ ] Client loads content by hash, caches forever; map picker on room creation
- [ ] Map data overlay layer: room names and wall outlines, toggleable

**Exit check:** create a room on any of the 3 maps, switch floors, see callout names; the content version shows in the footer.

## 0.6 Editor tools

Everything in the MVP feature list and the Editor UX layout, working together.

- [ ] Tools: select/move (with box select), arrow, line, text (`Y.Text`), eraser; all hotkeys from the keyboard map
- [ ] Drags and multi-moves wrapped in `doc.transact`: one drag = one undo step
- [ ] Lineup panel: 5 slots per side with operator, player name, role
- [ ] Stamps: pick slot, press S, palette shows that operator's gadgets; snapping to walls, windows, hatches; Alt for free placement
- [ ] Wall states with R on hover: reinforced, rotate, breached, hatch open
- [ ] Floor tabs + stack view (floor above and below at 25%)
- [ ] Phase bar: Setup / Prep / Execute / Post-plant; objects belong to a phase; \[ and \] to step
- [ ] Map ping (G) over the app channel, 2 s, never stored
- [ ] Command palette (Ctrl+K) over maps, callouts, operators, actions
- [ ] Export PNG of the current phase and of all phases
- [ ] Playwright E2E with two contexts: draw in A, see in B; undo isolation

**Exit check:** you and one friend plan a full defence setup on one site in under 10 minutes without touching the docs or asking how.

## 0.7 MVP public beta

Ship it to real teams. No accounts yet: guest rooms only, which keeps the beta friction-free.

- [ ] All maps in the ranked pool redrawn and in the content package
- [ ] Production Dockerfiles (multi-stage), `docker-compose.prod.yml` with Caddy, server, Postgres
- [ ] Deploy to a small VPS, or the homelab behind a Cloudflare Tunnel for a closed beta first
- [ ] Nightly `pg_dump` to R2, and one tested restore
- [ ] Sentry on web and server; Prometheus metrics (sockets, rooms, msgs/s, persist latency) + a Grafana board
- [ ] Self-hosted Umami or Plausible; track the success metrics from the design doc
- [ ] Strict CSP, security headers, owner kick and lock for rooms
- [ ] Visual regression screenshots per map and floor in CI
- [ ] Landing page: one GIF of 5 cursors planning, "New room" button, Discord invite for feedback
- [ ] Load test on the prod box: 500 rooms × 6 bots, p95 fan-out under 50 ms
- [ ] Tag `v0.7.0`, changelog, post in R6 subreddits and Discords

**Exit check (gate 2):** a team you don't know uses it in a real scrim and comes back the next week.

## 0.8 Accounts and teams

Guests can still jump in, but teams get a permanent home for their strats.

- [ ] better-auth with Discord OAuth; email magic link fallback; httpOnly SameSite cookies
- [ ] Migrations: `teams`, `team_members`, `stratbooks`, `strats`; link `strat_docs` to strats
- [ ] Roles owner / editor / viewer, checked by the API and by the WS server on connect and on every update
- [ ] Team invite links; transfer ownership; leave team
- [ ] Stratbook view: map → site → side, search, duplicate strat
- [ ] "Save to team" from a guest room (claims the room's doc into a strat)
- [ ] Revoke-all-links button per strat
- [ ] Account deletion per the GDPR note (anonymise `by` fields)

**Exit check:** a guest room from 0.7 becomes a team strat in two clicks, and a removed member loses access on their very next socket message.

## 0.9 Stratbook depth

Planted starts to understand Siege: it checks strats, keeps history and survives patches.

- [ ] `packages/rules` with the 10 rules from the design doc, each with fixture tests
- [ ] Lint runs in a Web Worker on every change; issues panel + inline markers; mute per strat
- [ ] Utility sheet per side: gadgets placed / available, reinforcements left, breaches per wall
- [ ] Bans and backups per strat; duplicate-operator and banned-operator rules use them
- [ ] Snapshots every 10 min of activity + on demand; history panel with restore (bumps `roomEpoch`)
- [ ] Patch tags on strats; content release adds a `wallId` migration map per reworked map
- [ ] Stale-strat badges after a patch; "needs review" flag on unmapped objects
- [ ] Same rules package run server side nightly to flag stale strats

**Exit check:** ship a content update that reworks one map; existing strats on it migrate, flag what moved, and nothing is silently deleted.

## 1.0 Live sessions and launch

The scrim-day feature, then the public launch.

- [ ] Presenter role: controls map, floor, phase, viewport; followers snap to it, F to break out and re-sync
- [ ] Phase sync over the app channel; objects fade in and out per phase
- [ ] Per-player view: own slot highlighted with operator, loadout and one-line job
- [ ] Laser pointer trail for the presenter (awareness only)
- [ ] Round notes: won / lost / why per round, saved to the strat
- [ ] Mobile follow view: read-only, landscape-first, wake lock
- [ ] Docs site: getting started, keyboard map, FAQ
- [ ] Status page; on-call alert to your phone for server down
- [ ] Tag `v1.0.0`, launch post, short demo video

**Exit check (gate 3):** 5 teams use live sessions every week for a month, with sync errors under 0.1% of sessions.

## After 1.0

Pick by what teams ask for most; each is its own minor version.

- [ ] 1.1 Breached integration: replay round → board phase, strat overlay in replay review
- [ ] 1.2 Public strat library: publish, rate, fork
- [ ] 1.3 Timeline playback: animate operator paths per phase
- [ ] 1.4 Discord bot: post the next map's strat in a channel, link a guild to a team
- [ ] 1.5 Horizontal scaling: room leases in Redis, consistent hashing at the proxy (only when one box is full)
