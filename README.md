# planted

A free, real-time multiplayer strat board for Rainbow Six Siege: your whole team draws on the same map at once, with tools that understand operators, gadgets and walls.

![status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-lightgrey)
[![ci](https://github.com/rosdal/planted/actions/workflows/ci.yml/badge.svg)](https://github.com/rosdal/planted/actions/workflows/ci.yml)

Nothing runs yet. This repo is at v0.0: tooling and CI only. See the [roadmap](docs/roadmap.md) for what comes next.

## Prerequisites

- Node, at the major version in [`.nvmrc`](.nvmrc) (`fnm use` or `nvm use`)
- pnpm through Corepack: `corepack enable`; the version is pinned in `package.json`
- Docker, from v0.1 onwards (Postgres for local development)

## Develop

```sh
pnpm install   # also installs the git hooks
pnpm dev       # start all apps
pnpm check     # lint, typecheck, build and test: what CI runs
```

`pnpm format` fixes formatting and import order. Commits must follow [Conventional Commits](https://www.conventionalcommits.org/); a hook checks the message.

## Layout

| Path              | What                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| `apps/web`        | React client (stub)                                                                     |
| `apps/server`     | Fastify HTTP API and WebSocket relay (stub)                                             |
| `packages/schema` | Types shared by client and server: board objects, wire messages, API                    |
| `packages/db`     | Drizzle schema and migrations (stub)                                                    |
| `docs/`           | [Design doc](docs/design.md), [roadmap](docs/roadmap.md), [decision records](docs/adr/) |

Internal packages export their TypeScript source directly; only apps have a build step.

## License

[AGPL-3.0](LICENSE). Copyright (C) 2026 Mark de Graaff. The reasoning is in [ADR 0001](docs/adr/0001-license.md).
