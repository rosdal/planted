import { useEffect, useRef } from 'react';
import type { LoadedMap } from '../content/loader';
import { useRoomClient } from '../realtime/react';
import { Board, type BoardIdentity, type BoardReadOnly } from './board';
import { perfEnabled } from './overlay';

declare global {
  interface Window {
    /** Dev, test and `?perf=1` builds: hooks for Playwright and manual checks. */
    __board?: {
      objectCount: () => number;
      docHash: () => string;
      authors: () => string[];
      fps: () => number;
      stats: () => ReturnType<Board['stats']>;
      resetLongestFrame: () => void;
      floor: () => string;
      floors: () => readonly string[];
      setFloor: (floorId: string) => void;
      overlay: () => boolean;
      /** Strokes on the floor in view. */
      visibleStrokes: () => number;
      visibleCallouts: () => string[];
      hoverCallout: () => string | null;
    };
  }
}

/**
 * Hosts the Pixi board. The board is made in an effect and driven imperatively, so this
 * component renders once per mount, never per frame. `identity` is read through a ref so a
 * rename doesn't remount the canvas.
 */
export function BoardCanvas({
  identity,
  readOnly,
  content,
  onBoard,
}: {
  identity: BoardIdentity;
  /** The room's map; a change of map remounts the board. */
  content: LoadedMap;
  /** Viewers can pan, zoom and point, but not draw or undo. */
  readOnly: boolean;
  onBoard?: (board: Board | null) => void;
}) {
  const client = useRoomClient();
  const host = useRef<HTMLDivElement>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const onBoardRef = useRef(onBoard);
  onBoardRef.current = onBoard;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // StrictMode mounts, unmounts and mounts again: the first board may still be initialising
    // when it is destroyed, and then tears itself down as soon as `init` resolves.
    let disposed = false;
    const isReadOnly: BoardReadOnly = () => readOnlyRef.current;
    const board = new Board(element, client, () => identityRef.current(), isReadOnly, content);
    void board
      .init()
      .then(() => {
        if (disposed) return;
        onBoardRef.current?.(board);
        if (perfEnabled()) {
          window.__board = {
            objectCount: () => board.objectCount,
            docHash: () => board.docHash,
            authors: () => board.authors,
            fps: () => board.fps,
            stats: () => board.stats(),
            resetLongestFrame: () => board.resetLongestFrame(),
            floor: () => board.view.floor,
            floors: () => board.floorIds,
            setFloor: (floorId) => board.setFloor(floorId),
            overlay: () => board.view.overlay,
            visibleStrokes: () => board.visibleStrokeCount,
            visibleCallouts: () => board.visibleCallouts,
            hoverCallout: () => board.hoverCallout,
          };
        }
      })
      .catch((err: unknown) => console.error('board: failed to start', err));
    return () => {
      disposed = true;
      board.destroy();
      onBoardRef.current?.(null);
      if (window.__board) delete window.__board;
    };
  }, [client, content]);

  return <div ref={host} className="absolute inset-0 overflow-hidden" data-testid="board" />;
}
