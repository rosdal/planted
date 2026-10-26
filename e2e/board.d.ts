/** The test hooks the board exposes in dev builds; see apps/web/src/board/BoardCanvas.tsx. */
interface Window {
  __board?: {
    objectCount: () => number;
    docHash: () => string;
    authors: () => string[];
    fps: () => number;
    floor: () => string;
    floors: () => readonly string[];
    setFloor: (floorId: string) => void;
    overlay: () => boolean;
    visibleStrokes: () => number;
    visibleCallouts: () => string[];
    hoverCallout: () => string | null;
  };
}
