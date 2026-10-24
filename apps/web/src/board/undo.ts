import type * as Y from 'yjs';
import { isTyping } from './camera';

/**
 * Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl+Y redo. The manager only tracks this client's
 * own transactions (see `createUndoManager`), so these never touch anyone else's strokes.
 * Ignored while typing in a field, and while `blocked`: a stroke is still being drawn, or the
 * user only has the view link.
 */
export function bindUndoKeys(undo: Y.UndoManager, blocked: () => boolean): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (isTyping(event.target) || event.altKey) return;
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    const redo = (key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey);
    const doUndo = key === 'z' && !event.shiftKey;
    if (!redo && !doUndo) return;
    event.preventDefault();
    if (blocked()) return;
    if (redo) undo.redo();
    else undo.undo();
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
