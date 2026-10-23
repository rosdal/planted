# 0005. Access model: signed share links until accounts exist

Status: accepted, 2026-10-23

## Context

Until 0.3, knowing a room id was enough to read and edit it: `GET /rooms/:id` and the socket were open to anyone. Ids are 128 random bits, so they can't be guessed, but they travel in every link and every log line, and there was no way to share a board read-only or to cut someone off. Accounts and teams arrive in 0.8; rooms need access control before then.

## Decision

Access comes from two kinds of secret, and nothing else.

**Link keys** are long-lived and live in share URLs. Each room has one edit link and one view link. A key is 32 random bytes as base64url; the server stores only its SHA-256 (`room_links.key_hash`) and returns the raw key exactly once, from `POST /rooms` or the rotate route. Share URLs put the key in the fragment, `/r/<roomId>#k=<key>`, so it never reaches a server log or a `Referer` header. The web app moves it to localStorage (`room:<id>:key`) and strips it from the address bar.

**Room tokens** are short-lived. `POST /rooms/:roomId/token { key }` exchanges a key for a 5-minute HS256 JWT carrying `sub` (room id), `role` and `lid` (link id). Every HTTP call that needs access sends it as `Authorization: Bearer`, and the socket sends it in `hello`.

| Who | Holds | Can |
| --- | --- | --- |
| Room creator | Edit link key, saved in localStorage | Edit, copy both links |
| Anyone with the edit link | Edit link key | Edit |
| Anyone with the view link | View link key | View, cursors visible, no edits |
| Anyone with only the room id | Nothing | Nothing: 403 |

- **Role comes only from a verified token.** The server never trusts a role the client states.
- **Rotation** (`POST /rooms/:roomId/links/rotate`, edit role) revokes both links, issues new ones and closes every open socket with 4401. On `hello` the server re-checks that the token's `lid` isn't revoked, so a token minted from an old link can't get back in during its last five minutes.
- **A wrong key and a missing room look the same**: 403, the same query, and a constant-time compare over the room's links.
- **`GET /rooms/:id` now needs a token.** This changes 0.1, where it was open.

## Consequences

- Keys sit in localStorage, which any script on the page can read. That's acceptable while a key only unlocks one board and can be rotated; when accounts arrive (0.8), team boards move to cookie sessions and links become an extra, not the only, way in.
- Tokens travel in an `Authorization` header, never a cookie, so the token and rotate routes aren't exposed to CSRF.
- The token route allows 30 requests per minute per IP, from the in-memory store. With more than one server instance the effective limit multiplies; it moves to a shared store when the server scales out (1.5).
- Token signing uses `ROOM_TOKEN_SECRET` (at least 32 random bytes, checked at boot). Tokens carry a `kid` derived from the secret, and the server also accepts `ROOM_TOKEN_SECRET_PREVIOUS`, so the secret can rotate without logging everyone out.
- Losing the edit link of a room with no other editor means losing edit access for good. There is no recovery before accounts.
