import { USER_COLOURS } from '@planted/schema';

export { USER_COLOURS };

export type GuestIdentity = { name: string; colour: string };

export const NAME_MIN = 2;
export const NAME_MAX = 20;

const STORAGE_KEY = 'planted.guest';

function isIdentity(value: unknown): value is GuestIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const { name, colour } = value as Record<string, unknown>;
  return typeof name === 'string' && name.length > 0 && typeof colour === 'string';
}

function randomIdentity(): GuestIdentity {
  const colour = USER_COLOURS[Math.floor(Math.random() * USER_COLOURS.length)] ?? USER_COLOURS[0];
  return { name: `Guest ${Math.floor(1000 + Math.random() * 9000)}`, colour };
}

/** One fallback per tab, so every caller agrees until the user picks a name. */
let fallback: GuestIdentity | null = null;

/** The identity saved by the name dialog, or null on a first visit. Storage can be missing or throw. */
export function readStoredIdentity(): GuestIdentity | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (isIdentity(stored)) return stored;
  } catch {
    // Private mode, blocked storage or a corrupt value: treat it as a first visit.
  }
  return null;
}

/** The saved identity, or this tab's "Guest 1234" with a random colour. */
export function loadGuestIdentity(): GuestIdentity {
  const stored = readStoredIdentity();
  if (stored) return stored;
  fallback ??= randomIdentity();
  return fallback;
}

/** Returns false when storage refused it; the identity still holds for this tab. */
export function saveGuestIdentity(identity: GuestIdentity): boolean {
  fallback = identity;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
    return true;
  } catch {
    return false;
  }
}

export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function isValidName(name: string): boolean {
  const length = normaliseName(name).length;
  return length >= NAME_MIN && length <= NAME_MAX;
}

/** `preferred` if nobody else has it, else the first free palette colour (or `preferred`). */
export function firstFreeColour(preferred: string, taken: ReadonlySet<string>): string {
  if (!taken.has(preferred)) return preferred;
  return USER_COLOURS.find((colour) => !taken.has(colour)) ?? preferred;
}
