# planted

A free, real-time multiplayer strat board for Rainbow Six Siege: your whole team draws on the same map at once, with tools that understand operators, gadgets and walls.

![status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-lightgrey)
[![ci](https://github.com/rosdal/planted/actions/workflows/ci.yml/badge.svg)](https://github.com/rosdal/planted/actions/workflows/ci.yml)

This repo is at v0.1: the web app creates a room through the API and lands on its page. There is no board yet. See the [roadmap](docs/roadmap.md) for what comes next.

## Prerequisites

- Node, at the major version in [`.nvmrc`](.nvmrc) (`fnm use` or `nvm use`)
- pnpm through Corepack: `corepack enable`; the version is pinned in `package.json`
- Docker (Postgres for local development)

## Getting started

```sh
cp .env.example .env
pnpm install   # also installs the git hooks
pnpm dev       # starts Postgres, runs migrations, then the server and web app
```

Open http://localhost:5173 and click "New room".

| Service  | Port   | Notes                                                           |
| -------- | ------ | --------------------------------------------------------------- |
| web      | `5173` | Vite dev server                                                 |
| server   | `3000` | Fastify API; `curl localhost:3000/health`                       |
| Postgres | `5433` | 5433 on the host, so it never fights a Postgres already on 5432 |

## Develop

```sh
pnpm check       # lint, typecheck, build and test: what CI runs
pnpm format      # fix formatting and import order
pnpm db:up       # start Postgres (db:down stops it, db:reset wipes the volume)
pnpm db:generate # write a migration after changing packages/db/src/schema.ts
pnpm db:migrate  # apply migrations to DATABASE_URL
pnpm db:studio   # browse the dev database
```

Tests run against a separate `planted_test` database (`TEST_DATABASE_URL`), never the dev one. It is created on the first start of the Postgres volume; if your volume predates it, run `pnpm db:reset`. Migrations are append-only: never edit one that is committed.

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/); a hook checks the message.

## Layout

| Path              | What                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| `apps/web`        | React client: Vite, TanStack Router, Tailwind                                           |
| `apps/server`     | Fastify HTTP API (WebSocket relay from v0.2)                                            |
| `packages/schema` | Types shared by client and server: board objects, wire messages, API                    |
| `packages/db`     | Drizzle schema, migrations and client factory                                           |
| `docs/`           | [Design doc](docs/design.md), [roadmap](docs/roadmap.md), [decision records](docs/adr/) |

Internal packages export their TypeScript source directly; only apps have a build step. The server build bundles them with tsup.

## License

[AGPL-3.0](LICENSE). Copyright (C) 2026 Mark de Graaff. The reasoning is in [ADR 0001](docs/adr/0001-license.md).
