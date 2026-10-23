# 0002. Monorepo tooling: pnpm, Turborepo, Biome

Status: accepted, 2026-10-23

## Context

The web client, the server and the shared schema must change together: a new board object touches all three in one commit. Separate repos would mean publishing packages to make one change.

## Decision

- **pnpm workspaces** with a version catalog, so every package uses the same TypeScript and Vitest. Strict `node_modules` catches undeclared dependencies. Pinned through Corepack.
- **Turborepo** to run tasks in dependency order and cache them locally and in CI.
- **Biome** for both linting and formatting: one tool and one config instead of ESLint plus Prettier, and fast enough to run on every commit.
- **Vitest** projects from one root config; **Lefthook** runs Biome on staged files and commitlint on messages.
- Internal packages export their TypeScript source (`"exports": "./src/index.ts"`); only apps compile. No stale `dist/` between packages.

## Consequences

- Biome has fewer rules than the ESLint ecosystem, with no type-aware lints. Add typescript-eslint for specific rules if a real bug slips through.
- Exporting source means every consumer needs a bundler or TS-aware runtime. Fine for our apps; a package published to npm (the Breached export schema) would need its own build.
- Turborepo's remote cache is off; CI caches `.turbo` with `actions/cache` instead.
