# 0001. License: AGPL-3.0

Status: accepted, 2026-10-23

## Context

Planted is meant to be a free hosted service. R6 Battle Planner, the closest earlier attempt at multiplayer strat rooms, shut down on hosting cost. The license has to be picked before the first public push; changing it later needs every contributor's consent.

The two candidates were MIT, which lets anyone fork including into a closed product, and AGPL-3.0, which requires anyone running a modified version as a network service to publish their changes.

## Decision

AGPL-3.0.

A closed, hosted fork could take the community without giving anything back, and the free hosted instance is the product. AGPL keeps any hosted fork open. Self-hosting and forking stay allowed.

## Consequences

- Companies with a no-AGPL policy will not contribute or embed the code. Acceptable: the audience is players and teams, not integrators.
- Every contributor's code lands under AGPL. Relicensing later, for example for a paid tier, needs a CLA or contributor consent; decide that before accepting outside PRs.
- `packages/schema` will be shared with Breached. If Breached needs a different license, that package may need dual licensing; revisit when the integration starts.
