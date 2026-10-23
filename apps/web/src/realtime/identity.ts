/**
 * User cursor colours: 8 hues kept away from the attack, defence and lineup-slot colours (see
 * docs/design.md, "Visual design"), each readable on both the dark and light canvas.
 */
export const USER_COLOURS = [
  '#e5534b',
  '#f69d50',
  '#c69026',
  '#57ab5a',
  '#39c5cf',
  '#6cb6ff',
  '#b083f0',
  '#ec6cb9',
] as const;

export type GuestIdentity = { name: string; colour: string };

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

/** Kept in localStorage so a reload keeps your name; storage can be missing or throw. */
export function loadGuestIdentity(): GuestIdentity {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (isIdentity(stored)) return stored;
  } catch {
    // Private mode, blocked storage or a corrupt value: fall through to a fresh identity.
  }
  const identity = randomIdentity();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Not persisted; this tab still uses it.
  }
  return identity;
}
