import type { RoomId } from '@planted/schema';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { BoardCanvas } from '../board/BoardCanvas';
import type { Board } from '../board/board';
import { IdentityDialog } from '../board/identity-dialog';
import { DevOverlay, perfEnabled } from '../board/overlay';
import {
  type GuestIdentity,
  loadGuestIdentity,
  readStoredIdentity,
  saveGuestIdentity,
} from '../realtime/identity';
import { RoomProvider, usePeers, useRoomClient, useSyncStatus } from '../realtime/react';
import { Button } from '../ui/button';

const roomRoute = getRouteApi('/r/$roomId');

export const Route = createFileRoute('/r/$roomId/')({
  component: RoomPage,
});

function RoomPage() {
  const { roomId } = roomRoute.useLoaderData();
  return (
    <RoomProvider roomId={roomId}>
      <BoardRoom roomId={roomId} />
    </RoomProvider>
  );
}

function BoardRoom({ roomId }: { roomId: RoomId }) {
  const client = useRoomClient();
  const peers = usePeers();
  const [identity, setIdentity] = useState<GuestIdentity>(loadGuestIdentity);
  const [dialog, setDialog] = useState<'welcome' | 'edit' | null>(() =>
    readStoredIdentity() ? null : 'welcome',
  );
  const [board, setBoard] = useState<Board | null>(null);
  const taken = useMemo(
    () => new Set(peers.flatMap((p) => (p.user ? [p.user.colour] : []))),
    [peers],
  );
  // Read by the pen at stroke start and commit; stable so the canvas never remounts.
  const identityGetter = useCallback(() => loadGuestIdentity(), []);

  function save(next: GuestIdentity) {
    saveGuestIdentity(next);
    setIdentity(next);
    client.awareness.setLocalStateField('user', next);
    setDialog(null);
  }

  return (
    // The board fills everything under the header; the root layout's centred column is for pages.
    <div className="fixed inset-x-0 top-14 bottom-0 bg-bg">
      <BoardCanvas identity={identityGetter} onBoard={setBoard} />
      {perfEnabled() && <DevOverlay board={board} />}
      <div className="absolute top-3 right-3 flex flex-wrap items-center justify-end gap-2">
        <StatusPill />
        <PeerDots peers={peers.length} />
        <Button
          onClick={() => setDialog('edit')}
          className="bg-bg"
          aria-label={`You are ${identity.name}. Change name or colour`}
        >
          <span
            aria-hidden="true"
            className="size-2.5 rounded-full"
            style={{ backgroundColor: identity.colour }}
          />
          {identity.name}
        </Button>
        <CopyLinkButton />
        {import.meta.env.DEV && (
          <Link
            to="/r/$roomId/debug"
            params={{ roomId }}
            className="rounded-control px-1 text-sm text-muted underline underline-offset-4 hover:text-fg"
          >
            Debug
          </Link>
        )}
      </div>
      <p className="pointer-events-none absolute bottom-3 left-3 hidden text-xs text-muted sm:block">
        Draw with the mouse · <Kbd>Space</Kbd> drag or middle drag to pan · scroll to zoom ·{' '}
        <Kbd>0</Kbd> fit · <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> undo
      </p>
      <IdentityDialog
        open={dialog !== null}
        mode={dialog ?? 'edit'}
        initial={identity}
        taken={taken}
        onSave={save}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded-[4px] border border-border bg-surface-1 px-1 font-mono text-[11px]">
      {children}
    </kbd>
  );
}

function StatusPill() {
  const { status } = useSyncStatus();
  const label = {
    connecting: 'Connecting',
    syncing: 'Syncing',
    synced: 'Live',
    offline: 'Offline',
  }[status];
  return (
    <span
      role="status"
      className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-bg px-3 text-sm"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${status === 'synced' ? 'bg-green' : status === 'offline' ? 'border border-muted' : 'bg-muted'}`}
      />
      {label}
    </span>
  );
}

function PeerDots({ peers }: { peers: number }) {
  return (
    <span className="inline-flex h-8 items-center rounded-full border border-border bg-bg px-3 text-sm text-muted tabular-nums">
      {peers === 0 ? 'Just you' : `${peers + 1} here`}
    </span>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

function CopyLinkButton() {
  const [state, setState] = useState<CopyState>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2000);
  }

  return (
    <Button variant="primary" onClick={copy}>
      <span aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy link'}
      </span>
    </Button>
  );
}
