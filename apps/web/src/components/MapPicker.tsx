import type { Manifest } from '@planted/content';
import {
  type KeyboardEvent,
  Suspense,
  use,
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { fileOf, loadLatest, loadManifest } from '../content/loader';
import { Button } from '../ui/button';

export type PickerContent = { ok: true; manifest: Manifest } | { ok: false; message: string };

/** What the picker shows: the latest release's maps. Never rejects, so it can sit in a loader. */
export async function loadPickerContent(): Promise<PickerContent> {
  try {
    return { ok: true, manifest: await loadManifest(await loadLatest()) };
  } catch (error) {
    console.error('map picker: content failed to load', error);
    return { ok: false, message: "Couldn't load the maps. Check your connection and try again." };
  }
}

export type MapPickerProps = {
  open: boolean;
  content: Promise<PickerContent>;
  /** Called with the chosen map; resolves once the room exists (or rejects with a message). */
  onPick: (mapId: string) => Promise<void>;
  onClose: () => void;
};

/**
 * "New room": pick a map from the latest content. A native modal `<dialog>`, so the browser
 * traps focus, closes on Escape and restores focus to the button that opened it.
 */
export function MapPicker({ open, content, onPick, onClose }: MapPickerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(calc(100vw-2rem),720px)] rounded-[10px] border border-border bg-bg p-0 text-fg backdrop:bg-black/60"
    >
      <div className="flex max-h-[80dvh] flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-md font-semibold">
            Pick a map
          </h2>
          <Button onClick={onClose} aria-label="Close">
            Esc
          </Button>
        </div>
        {open && (
          <Suspense fallback={<p className="text-sm text-muted">Loading maps…</p>}>
            <PickerBody content={content} onPick={onPick} />
          </Suspense>
        )}
      </div>
    </dialog>
  );
}

function PickerBody({
  content,
  onPick,
}: {
  content: Promise<PickerContent>;
  onPick: (mapId: string) => Promise<void>;
}) {
  const loaded = use(content);
  const searchId = useId();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grid = useRef<HTMLUListElement>(null);

  if (!loaded.ok) {
    return (
      <p role="alert" className="text-sm">
        {loaded.message}
      </p>
    );
  }
  const { manifest } = loaded;
  const needle = deferred.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(needle);
  const maps = manifest.maps.filter((m) => matches(m.name));
  const upcoming = manifest.upcoming.filter((m) => matches(m.name));

  async function pick(mapId: string) {
    setPending(mapId);
    setError(null);
    try {
      await onPick(mapId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a room, try again');
      setPending(null);
    }
  }

  /** Arrow keys move between cards, row by row, as a grid would. */
  function onGridKey(event: KeyboardEvent<HTMLUListElement>) {
    const cards = [...(grid.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const top = (el: HTMLElement) => el.getBoundingClientRect().top;
    const columns = cards.filter((c) => top(c) === top(cards[0] as HTMLElement)).length || 1;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    cards[Math.min(cards.length - 1, Math.max(0, index + step))]?.focus();
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <label htmlFor={searchId} className="text-sm text-muted">
          Search maps
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              grid.current?.querySelector('button')?.focus();
            }
          }}
          autoComplete="off"
          className="h-9 rounded-control border border-border bg-surface-1 px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-fg"
        />
      </div>
      <div className="flex flex-col gap-4 overflow-y-auto">
        {maps.length === 0 && upcoming.length === 0 && (
          <p className="text-sm text-muted">No map matches “{deferred}”.</p>
        )}
        {maps.length > 0 && (
          <ul
            ref={grid}
            onKeyDown={onGridKey}
            aria-label="Maps"
            className="grid grid-cols-2 gap-3 sm:grid-cols-3"
          >
            {maps.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  disabled={pending !== null}
                  aria-busy={pending === m.id}
                  onClick={() => void pick(m.id)}
                  className="group flex w-full flex-col overflow-hidden rounded-control border border-border text-left transition-colors duration-150 hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg disabled:opacity-60 motion-reduce:transition-none"
                >
                  <img
                    src={fileOf(manifest, m.thumb)}
                    alt=""
                    width={1024}
                    height={1024}
                    loading="lazy"
                    className="aspect-square w-full bg-[#16181d] object-cover"
                  />
                  <span className="px-2 py-1.5 text-sm font-medium">
                    {pending === m.id ? 'Creating…' : m.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {upcoming.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm text-muted">Coming soon</h3>
            <ul
              className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3"
              aria-label="Coming soon"
            >
              {upcoming.map((m) => (
                <li key={m.id} className="text-sm text-muted">
                  {m.name}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <p role="status" className="min-h-4 text-xs text-muted">
        {error}
      </p>
    </>
  );
}
