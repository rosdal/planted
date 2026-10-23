/**
 * Link keys in this browser (ADR 0005). A share URL carries its key in the fragment,
 * `/r/<id>#k=<key>`; the room page moves it to localStorage and strips it from the address bar.
 * The creator also keeps the view key, so the share dialog can show both links.
 *
 * Storage can be missing or throw (private mode, blocked cookies): every access is guarded, and
 * a key that can't be stored still works for this page load.
 */

const keyName = (roomId: string) => `room:${roomId}:key`;
const viewKeyName = (roomId: string) => `room:${roomId}:viewKey`;

/** Keys that couldn't be stored, so this tab still has them. */
const memory = new Map<string, string>();

function read(name: string): string | null {
  try {
    const value = localStorage.getItem(name);
    if (value) return value;
  } catch {
    // Fall through to this tab's copy.
  }
  return memory.get(name) ?? null;
}

function write(name: string, value: string): void {
  memory.set(name, value);
  try {
    localStorage.setItem(name, value);
  } catch {
    // Kept in memory for this tab only.
  }
}

/** The key this browser opens the room with: an edit key or a view key. */
export function readKey(roomId: string): string | null {
  return read(keyName(roomId));
}

/** The view key, if this browser created the room or rotated its links. */
export function readViewKey(roomId: string): string | null {
  return read(viewKeyName(roomId));
}

/** After creating a room or rotating its links: keep both keys. */
export function saveKeys(roomId: string, keys: { editKey: string; viewKey: string }): void {
  write(keyName(roomId), keys.editKey);
  write(viewKeyName(roomId), keys.viewKey);
}

/** The `k` parameter of a URL fragment, with or without the leading `#`. */
export function keyFromHash(hash: string): string | null {
  const key = new URLSearchParams(hash.replace(/^#/, '')).get('k');
  return key && key.length <= 128 ? key : null;
}

/**
 * Stores the key from a share URL's fragment, if it has one. A link someone opened replaces
 * whatever key was stored: it's the access they asked for.
 */
export function takeKeyFromHash(roomId: string, hash: string): void {
  const key = keyFromHash(hash);
  if (key && key !== readKey(roomId)) write(keyName(roomId), key);
}

/** Drops `#k=…` from the address bar, so it doesn't linger in screenshots or history. */
export function stripKeyFromUrl(): void {
  if (!keyFromHash(window.location.hash)) return;
  const { pathname, search } = window.location;
  // Keep the router's history state; only the URL changes.
  window.history.replaceState(window.history.state, '', `${pathname}${search}`);
}

export function shareUrl(origin: string, roomId: string, key: string): string {
  return `${origin}/r/${roomId}#k=${key}`;
}

let rotation: Promise<unknown> | null = null;

/**
 * Rotating links closes every socket with 4401, this tab's included, and the close can arrive
 * before the rotate response does. Token requests wait for the rotation to finish, so they use
 * the new key rather than reporting the old one as revoked.
 */
export function trackRotation<T>(pending: Promise<T>): Promise<T> {
  rotation = pending;
  void pending.finally(() => {
    if (rotation === pending) rotation = null;
  });
  return pending;
}

export async function rotationSettled(): Promise<void> {
  await rotation?.catch(() => {});
}
