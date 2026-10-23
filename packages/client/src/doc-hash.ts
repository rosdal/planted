import * as Y from 'yjs';

/**
 * Short hash of what the doc has seen, for checking convergence across tabs and bots.
 *
 * Hashes the encoded snapshot (state vector + delete set, both written in sorted order) rather
 * than `encodeStateAsUpdate`, whose struct layout can differ between two converged docs.
 * FNV-1a, 32 bits, as 8 hex chars; not for security.
 */
export function docHash(doc: Y.Doc): string {
  const bytes = Y.encodeSnapshot(Y.snapshot(doc));
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
