# Contributing

## Branches

Branch from `main` as `feat/<slug>`, `fix/<slug>`, `chore/<slug>` or `docs/<slug>`. `main` only changes through pull requests, which are squash-merged once CI is green.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, where scope is the workspace name (`web`, `server`, `schema`, `db`) or left out when a change spans more. The `commit-msg` hook rejects anything else, and the `pre-commit` hook runs Biome on staged files.

Hooks install with `pnpm install`. If they are missing, run `pnpm lefthook install`.

## Checks

```sh
pnpm check    # lint, typecheck, build, test: the same as CI
pnpm format   # fix formatting and import order
pnpm test --coverage
```

Decisions that are hard to reverse get a short record in [`docs/adr/`](docs/adr/).
