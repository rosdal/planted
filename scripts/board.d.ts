/** The hooks the board exposes in `?perf=1` builds; see apps/web/src/board/BoardCanvas.tsx. */
interface Window {
  __board?: {
    objectCount: () => number;
    docHash: () => string;
    authors: () => string[];
    fps: () => number;
    stats: () => Record<string, number | null>;
    resetLongestFrame: () => void;
  };
}
