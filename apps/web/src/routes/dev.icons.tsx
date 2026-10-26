import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';
import { Icon, useIconSprite } from '../components/Icon';
import { loadLatest } from '../content/loader';

/**
 * Stand-in lineup slot colours until 0.6 settles the slot palette. Each is dark enough for a
 * white icon at 3:1 or better (WCAG 1.4.11).
 */
const SLOT_COLOURS = ['#1f6feb', '#9a6700', '#8250df', '#bf3989', '#1a7f6e'];
const SIZES = [16, 20, 28];

export const Route = createFileRoute('/dev/icons')({
  loader: async () => ({ version: await loadLatest() }),
  component: IconsPage,
});

function IconsPage() {
  const { version } = Route.useLoaderData();
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Icons</h1>
        <p className="text-sm text-muted">
          Content {version}: every icon at {SIZES.join(', ')} px, and in a 28 px board chip.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-muted">Loading icons…</p>}>
        <Gallery version={version} />
      </Suspense>
    </section>
  );
}

function Gallery({ version }: { version: string }) {
  const ids = useIconSprite(version);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {(['dark', 'light'] as const).map((theme) => (
        <div
          key={theme}
          className="rounded-control border border-border p-3"
          style={
            theme === 'dark'
              ? { background: '#0a0a0a', color: '#ededed' }
              : { background: '#ffffff', color: '#171717' }
          }
        >
          <h2 className="mb-2 text-sm font-medium">On {theme}</h2>
          <ul className="flex flex-col gap-1" data-testid={`icons-${theme}`}>
            {ids.map((id, i) => (
              <li key={id} className="flex items-center gap-3">
                {SIZES.map((size) => (
                  <Icon key={size} id={id} size={size} />
                ))}
                <Chip id={id} colour={SLOT_COLOURS[i % SLOT_COLOURS.length] as string} />
                <span className="font-mono text-xs">{id}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The board's stamp chip: slot colour fill, white 20 px icon, 1 px dark ring. */
function Chip({ id, colour }: { id: string; colour: string }) {
  return (
    <span
      className="inline-flex size-7 items-center justify-center rounded-full text-white"
      style={{ background: colour, boxShadow: '0 0 0 1px rgb(0 0 0 / 0.7)' }}
    >
      <Icon id={id} size={20} />
    </span>
  );
}
