# 0003. Yjs for real-time sync

Status: accepted, 2026-10-23; confirmed or reversed by the 0.2 relay spike

## Context

Five to ten people edit one board at once. Two of them will move the same stamp, or erase the same stroke, in the same instant. Each user needs undo that only undoes their own edits, and a flaky connection must heal without losing strokes.

Options: a hand-rolled operation protocol over WebSocket events, Socket.IO with server-authoritative state, or a CRDT (Yjs or Automerge).

## Decision

Yjs as the source of truth for board state, relayed by our own Fastify WebSocket server using `y-protocols` for sync and awareness. Hocuspocus is the fallback if the custom relay proves shaky in the 0.2 spike.
- Concurrent edits merge deterministically with no conflict code of ours.
- `Y.UndoManager` scoped to the local origin gives per-user undo.
- Updates are small binary diffs; reconnects exchange only the state-vector diff.

## Consequences

- The server cannot reject an edit before applying it; it applies, validates with Zod and reverts. This is in the design doc's security table.
- Document history grows with every edit. Live strokes go over awareness and only the simplified stroke is committed, plus periodic snapshots and GC.
- A room must live on exactly one server process, which shapes how we scale out later.
