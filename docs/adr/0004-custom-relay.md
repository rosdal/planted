# 0004. Custom relay over Hocuspocus

Status: accepted, 2026-10-23

## Context

ADR 0003 picked Yjs and left one question for the 0.2 spike: write our own relay inside Fastify, or run Hocuspocus. The design needs three things from the socket layer:
- Our own frame header, `[u8 channel][u8 type][u32 seq?][payload]`, with control and app channels arriving in 0.4.
- Server-side checks on every update: viewers' updates dropped, changed objects validated with Zod, bad updates rejected.
- The same protocol spoken from Rust, so Breached can join a room.

Hocuspocus 4.7.1 was timeboxed against a custom relay. Both ran inside the same Fastify app, with the same Yjs version.

## Decision

Custom relay: `packages/protocol` for the frame codec, `apps/server/src/realtime` for rooms and sockets, `packages/client` for a framework-free client.

Hocuspocus did not clearly win:

|                                               | Hocuspocus 4.7.1                                                                                                                                         | Custom relay                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Setup inside Fastify                          | About 25 lines, but v4's `handleConnection` silently does nothing until you forward `message`, `close` and `pong` yourself; that took reading its source | About 390 lines of server code; 830 with the codec and the client |
| Client bundle over Yjs alone (28.7 KB min+gz) | +7.1 KB                                                                                                                                                  | +2.6 KB                                                           |
| Frame format                                  | Fixed: varstring doc name, varuint message type, then y-protocols messages, plus its own auth, stateless and sync-status messages                        | Ours, from the design doc                                         |
| App messages (follow, phase, ping-map)        | Its "stateless" channel, JSON strings                                                                                                                    | Channel 3, CBOR (0.4)                                             |
| Per-message role checks                       | `readOnly` per connection works out of the box; `beforeHandleMessage` sees raw bytes in its framing                                                      | Every frame passes through `Room.#onFrame` already decoded        |
| Rust client                                   | Must implement its framing, auth handshake and multiplexing                                                                                              | Two header bytes, then Yjs's own encoding                         |
| Persistence, scaling                          | Database and Redis extensions exist                                                                                                                      | Ours to write in 0.4 and 1.5                                      |

Hocuspocus would save the 0.4 persistence work and gives a working read-only mode. It would cost the frame header the design and Breached depend on, and the validate-and-revert step in 0.4 would still be ours to write. That isn't a clear win, so the default holds.

## Consequences

- Reconnect, awareness cleanup and backpressure are our code. The spike found one non-obvious trap: y-protocols ignores an awareness state whose clock hasn't moved, and both sides keep the old clock across a disconnect. The client bumps its own clock on reconnect and forgets peers' clocks while offline (`packages/client/src/room-client.ts`); an integration test covers it.
- The design's 256 KB cap per frame can't apply to sync-2: on a first join, or when a client re-uploads after a server restart, sync-2 carries the whole doc, so any doc past 256 KB could never sync. The bots found this as clients stuck in `syncing`. sync-2 is now capped at the 5 MB doc limit (`MAX_SYNC_FRAME_BYTES`, also the server's `maxPayload`); every other frame keeps 256 KB. Docs past 5 MB still can't sync, which the 0.4 doc-size limit has to prevent.
- A page kept in the browser's back/forward cache keeps its socket open, and the browser keeps answering pings, so the room never unloads. `RoomProvider` goes offline on `pagehide`.
- Convergence is checked by a fast-check property over the real codec and the real star topology (200 cases in CI; 10,000 passed locally), and by doc hashes at the end of every bot run.

## Baseline load

`pnpm bots --rooms R --count N --rate 5`, 60 s per run unless noted. Each bot moves an awareness cursor at 30 Hz and edits the shared list 5 times a second. The server ran in dev mode (`tsx`, pino-pretty) and the bots ran in worker threads on the same machine: Windows 11, 16 logical cores, Node 24.22, Postgres 17 in Docker. Latency is a write by one bot seen by the others in its room. CPU is the server process as a share of one core.

| Rooms × bots | Frames out/s | p95 latency            | Server CPU | Server RSS |
| ------------ | ------------ | ---------------------- | ---------- | ---------- |
| 1 × 20       | ~10,500      | 12–16 ms               | 35–39%     | 154 MB     |
| 10 × 10      | ~25,000      | 23 ms – 4.7 s (5 runs) | 78–94%     | 144–166 MB |
| 50 × 6       | ~40,000      | 1.0–1.6 s              | 95–98%     | 227 MB     |

One room of 20 holds easily, including a 10-minute run where every bot's socket was killed every 30–90 s: median p95 16 ms, all 20 hashes equal. The worst 5-second window in that run was 669 ms, with server event-loop stalls up to 517 ms once the doc passed 400 KB. Churning the list leaves tombstones, so the doc grows about 0.7 KB/s under this load. These stalls are not profiled yet; check them again in 0.4, when snapshots and the doc-size limit land. From 100 bots up, the single event loop saturates. 10 × 10 sits on the knee, so identical runs land either side of it. No run lost data: when the load stops, every room converges, within 18 s at worst.

A CPU profile at 10 × 10 shows 34% of samples in `writev` and under 2% in Yjs and awareness code. The cost is one socket write per frame per peer, nearly all of them awareness at 30 Hz. The lever for 0.3 and 0.7 is to coalesce awareness per room per tick (one frame per peer per tick instead of one per change), then measure again against this table. Real cursors only move while someone is active, so this load is harsher than a real room, which is why it's the baseline.
