import { docHash, type RoomClient, type SyncStatus } from '@planted/client';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import * as Y from 'yjs';
import { RoomProvider, usePeers, useRoomClient, useSyncStatus, useYArray } from '../realtime/react';
import { Button } from '../ui/button';

const ITEMS = 'debug-items';
const roomRoute = getRouteApi('/r/$roomId');

export const Route = createFileRoute('/r/$roomId/debug')({
  component: DebugPage,
});

function DebugPage() {
  const access = roomRoute.useLoaderData();
  if (access.status !== 'ok') return null;
  const { roomId } = access;
  return (
    <RoomProvider roomId={roomId} initialToken={access.token}>
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Link
            to="/r/$roomId"
            params={{ roomId }}
            className="self-start rounded-control text-xs text-muted hover:text-fg"
          >
            ← Room
          </Link>
          <h1 className="text-lg font-semibold">Sync debug</h1>
          <p className="font-mono text-xs break-all text-muted">{roomId}</p>
        </div>
        <ConnectionBar />
        <div className="grid gap-4 sm:grid-cols-2">
          <SharedList />
          <div className="flex flex-col gap-4">
            <Peers />
            <Stats />
          </div>
        </div>
      </section>
    </RoomProvider>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-panel border border-border bg-surface-1 p-4">
      <h2 className="text-sm font-medium text-muted">{title}</h2>
      {children}
    </section>
  );
}

const statusLabel: Record<SyncStatus, string> = {
  connecting: 'Connecting',
  syncing: 'Syncing',
  synced: 'Synced',
  offline: 'Offline',
};

function ConnectionBar() {
  const client = useRoomClient();
  const { status, attempt, stopReason } = useSyncStatus();
  const [online, setOnline] = useState(client.wantsOnline);

  function toggle() {
    client.setOnline(!online);
    setOnline(!online);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span
        role="status"
        className="inline-flex h-7 items-center gap-2 rounded-full border border-border px-3 text-sm"
      >
        <span
          aria-hidden="true"
          className={`size-2 rounded-full ${status === 'synced' ? 'bg-green' : status === 'offline' ? 'border border-muted' : 'bg-muted'}`}
        />
        {statusLabel[status]}
        {stopReason && <span className="text-muted">· {stopReason.replace('_', ' ')}</span>}
        {attempt > 0 && status !== 'synced' && !stopReason && (
          <span className="font-mono text-xs text-muted tabular-nums">retry {attempt}</span>
        )}
      </span>
      <Button onClick={toggle} aria-pressed={!online}>
        {online ? 'Go offline' : 'Go online'}
      </Button>
    </div>
  );
}

let addCounter = 0;
function newItem(client: RoomClient): string {
  addCounter++;
  return `${client.doc.clientID.toString(36).slice(-4)}-${addCounter}`;
}

function SharedList() {
  const client = useRoomClient();
  const items = useYArray<string>(ITEMS);
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const array = client.doc.getArray<string>(ITEMS);

  function add(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim() || newItem(client);
    array.push([value]);
    setDraft('');
  }

  function addHundred() {
    client.doc.transact(() => {
      array.push(Array.from({ length: 100 }, () => newItem(client)));
    });
  }

  return (
    <Panel title={`Shared list · ${items.length}`}>
      <form onSubmit={add} className="flex gap-2">
        <label htmlFor={inputId} className="sr-only">
          New item
        </label>
        <input
          id={inputId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="New item"
          autoComplete="off"
          className="h-8 min-w-0 flex-1 rounded-control border border-border bg-bg px-2 text-base placeholder:text-muted"
        />
        <Button type="submit" variant="primary">
          Add
        </Button>
        <Button onClick={addHundred}>Add 100</Button>
      </form>
      {items.length === 0 ? (
        <p className="text-sm text-muted">
          Empty. Add something, then open this page in another tab.
        </p>
      ) : (
        <ul className="flex max-h-96 flex-col overflow-y-auto">
          {items.map((item, index) => (
            // Positions are the identity here: two items can share a value.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={index}>
              <button
                type="button"
                onClick={() => array.delete(index, 1)}
                aria-label={`Delete ${item}`}
                className="w-full rounded-control px-2 py-1 text-left font-mono text-sm break-all hover:bg-surface-2 hover:line-through"
              >
                {item}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Peers() {
  const peers = usePeers();
  return (
    <Panel title={`Peers · ${peers.length}`}>
      {peers.length === 0 ? (
        <p className="text-sm text-muted">Nobody else is here.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {peers.map(({ clientId, user }) => (
            <li key={clientId} className="flex items-center gap-2 text-sm">
              <span
                aria-hidden="true"
                className="size-2 rounded-full"
                style={{ backgroundColor: user?.colour ?? 'var(--muted)' }}
              />
              {user?.name ?? 'Unnamed'}
              <span className="font-mono text-xs text-muted">{clientId}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

type Sample = {
  docBytes: number;
  hash: string;
  sentPerSec: number;
  receivedPerSec: number;
  rttMs: number | null;
  rejected: number;
};

function useStatsSample(client: RoomClient): Sample {
  const read = (sentPerSec: number, receivedPerSec: number): Sample => ({
    docBytes: Y.encodeStateAsUpdate(client.doc).byteLength,
    hash: docHash(client.doc),
    sentPerSec,
    receivedPerSec,
    rttMs: client.stats.lastRttMs,
    rejected: client.stats.framesRejected,
  });
  const [sample, setSample] = useState(() => read(0, 0));

  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` only closes over `client`
  useEffect(() => {
    let last = { ...client.stats, at: performance.now() };
    let tick = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      const seconds = (now - last.at) / 1000;
      const { framesSent, framesReceived } = client.stats;
      setSample(
        read(
          (framesSent - last.framesSent) / seconds,
          (framesReceived - last.framesReceived) / seconds,
        ),
      );
      last = { ...client.stats, at: now };
      // A sync-1 every 2 s measures the round trip (and costs one small sync-2).
      if (tick++ % 2 === 0) client.probe();
    }, 1000);
    return () => clearInterval(timer);
  }, [client]);

  return sample;
}

const bytes = new Intl.NumberFormat(undefined, {
  style: 'unit',
  unit: 'byte',
  unitDisplay: 'narrow',
});
const rate = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function Stats() {
  const client = useRoomClient();
  const sample = useStatsSample(client);
  const rows: [string, string][] = [
    ['Doc hash', sample.hash],
    ['Doc size', bytes.format(sample.docBytes)],
    ['Frames sent / s', rate.format(sample.sentPerSec)],
    ['Frames received / s', rate.format(sample.receivedPerSec)],
    ['Round trip', sample.rttMs === null ? '–' : `${Math.round(sample.rttMs)} ms`],
    ['Frames rejected', String(sample.rejected)],
  ];
  return (
    <Panel title="Stats">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="text-right font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
