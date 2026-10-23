import { useEffect, useState } from 'react';
import type { Board, BoardStats } from './board';

const SAMPLE_MS = 500;
const int = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const dec = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Dev builds and `?perf=1` only; production users never get the overlay or `__board`. */
export function perfEnabled(): boolean {
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') return true;
  try {
    return new URLSearchParams(window.location.search).get('perf') === '1';
  } catch {
    return false;
  }
}

/** F3 toggles the overlay; it samples the board twice a second, never per frame. */
export function DevOverlay({ board }: { board: Board | null }) {
  const [visible, setVisible] = useState(false);
  const [stats, setStats] = useState<BoardStats | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F3') return;
      e.preventDefault();
      setVisible((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!visible || !board) return;
    setStats(board.stats());
    const timer = setInterval(() => setStats(board.stats()), SAMPLE_MS);
    return () => clearInterval(timer);
  }, [visible, board]);

  if (!visible || !stats) return null;
  const rows: [string, string][] = [
    ['FPS', int.format(stats.fps)],
    ['p95 frame (5 s)', `${dec.format(stats.p95FrameMs)} ms`],
    ['Longest frame', `${dec.format(stats.longestFrameMs)} ms`],
    ['Dropped (5 s)', `${dec.format(stats.droppedShare * 100)}%`],
    ['Zoom', `${dec.format(stats.scale)}×`],
    ['Objects', int.format(stats.objects)],
    ['Live strokes', int.format(stats.liveStrokes)],
    ['Cursors', int.format(stats.cursors)],
    ['Doc', `${dec.format(stats.docBytes / 1024)} kB`],
    ['Frames in / s', int.format(stats.framesInPerSec)],
    ['Frames out / s', int.format(stats.framesOutPerSec)],
    ['JS heap', stats.heapMb === null ? 'n/a' : `${int.format(stats.heapMb)} MB`],
  ];
  return (
    <section
      aria-label="Performance overlay"
      className="pointer-events-none absolute top-3 left-3 rounded-panel border border-border bg-surface-1/90 px-3 py-2 shadow-md"
    >
      <dl className="grid grid-cols-[auto_auto] gap-x-4 font-mono text-xs tabular-nums">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
