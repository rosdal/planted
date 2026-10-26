import type { RoomId, RoomRole } from '@planted/schema';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BoardCanvas } from '../board/BoardCanvas';
import type { Board, BoardView } from '../board/board';
import { IdentityDialog } from '../board/identity-dialog';
import { DevOverlay, perfEnabled } from '../board/overlay';
import { Banners } from '../components/Banners';
import { ShareDialog } from '../components/ShareDialog';
import type { LoadedMap } from '../content/loader';
import {
  type GuestIdentity,
  loadGuestIdentity,
  readStoredIdentity,
  saveGuestIdentity,
} from '../realtime/identity';
import { RoomProvider, usePeers, useRole, useRoomClient, useSyncStatus } from '../realtime/react';
import { Button } from '../ui/button';

const roomRoute = getRouteApi('/r/$roomId');

export const Route = createFileRoute('/r/$roomId/')({
  component: RoomPage,
});

function RoomPage() {
  const access = roomRoute.useLoaderData();
  // The layout renders the need-link page itself; this only runs with a working key.
  if (access.status !== 'ok') return null;
  return (
    <RoomProvider roomId={access.roomId} initialToken={access.token} overlay={<Banners />}>
      <BoardRoom roomId={access.roomId} initialRole={access.role} content={access.content} />
    </RoomProvider>
  );
}

function BoardRoom({
  roomId,
  initialRole,
  content,
}: {
  roomId: RoomId;
  initialRole: RoomRole;
  content: LoadedMap;
}) {
  const client = useRoomClient();
  const peers = usePeers();
  const role = useRole(initialRole);
  const viewer = role === 'view';
  const [sharing, setSharing] = useState(false);
  const [identity, setIdentity] = useState<GuestIdentity>(loadGuestIdentity);
  const [dialog, setDialog] = useState<'welcome' | 'edit' | null>(() =>
    readStoredIdentity() ? null : 'welcome',
  );
  const [board, setBoard] = useState<Board | null>(null);
  const [view, setView] = useState<BoardView | null>(null);
  // The board owns floor and overlay state (keys 1 to 5 and L change it too); this mirrors it.
  useEffect(() => (board ? board.onView(setView) : setView(null)), [board]);
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
      <BoardCanvas
        identity={identityGetter}
        readOnly={viewer}
        content={content}
        onBoard={setBoard}
      />
      {board && view && <FloorBar board={board} view={view} content={content} />}
      {perfEnabled() && <DevOverlay board={board} />}
      <div className="absolute top-3 right-3 flex flex-wrap items-center justify-end gap-2">
        <StatusPill />
        {viewer && (
          <span className="inline-flex h-8 items-center rounded-full border border-border bg-bg px-3 text-sm">
            View only
          </span>
        )}
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
        {!viewer && (
          <Button variant="primary" onClick={() => setSharing(true)} aria-haspopup="dialog">
            Share
          </Button>
        )}
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
        {viewer ? (
          <>
            View only · <Kbd>Space</Kbd> drag or middle drag to pan · scroll to zoom · <Kbd>0</Kbd>{' '}
            fit · <Kbd>1</Kbd>–<Kbd>5</Kbd> floor · <Kbd>L</Kbd> overlay
          </>
        ) : (
          <>
            Draw with the mouse · <Kbd>Space</Kbd> drag or middle drag to pan · scroll to zoom ·{' '}
            <Kbd>0</Kbd> fit · <Kbd>1</Kbd>–<Kbd>5</Kbd> floor · <Kbd>L</Kbd> overlay ·{' '}
            <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> undo
          </>
        )}
      </p>
      <p className="pointer-events-none absolute right-3 bottom-3 text-xs text-muted">
        {content.map.name} · content {content.version} · Not affiliated with Ubisoft
      </p>
      {!viewer && <ShareDialog open={sharing} roomId={roomId} onClose={() => setSharing(false)} />}
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

/**
 * Floor buttons (bottom floor last, as the floors stack) and the overlay toggle. Proper tabs
 * and the stack view arrive in 0.6.
 */
function FloorBar({ board, view, content }: { board: Board; view: BoardView; content: LoadedMap }) {
  const labels = new Map(content.map.floors.map((f) => [f.id, f.label]));
  const floors = [...board.floorIds].reverse();
  return (
    <div className="absolute top-3 left-3 flex flex-col items-start gap-2">
      <fieldset className="flex flex-col gap-1">
        <legend className="sr-only">Floor</legend>
        {floors.map((id) => {
          const key = board.floorIds.indexOf(id) + 1;
          return (
            <Button
              key={id}
              variant={view.floor === id ? 'primary' : 'secondary'}
              aria-pressed={view.floor === id}
              onClick={() => board.setFloor(id)}
              title={key <= 5 ? `Floor ${labels.get(id) ?? id} (${key})` : undefined}
              className={`min-w-11 ${view.floor === id ? '' : 'bg-bg'}`}
            >
              {labels.get(id) ?? id}
            </Button>
          );
        })}
      </fieldset>
      {content.map.rooms.length > 0 && (
        <Button
          aria-pressed={view.overlay}
          onClick={() => board.setOverlay(!view.overlay)}
          title="Map overlay (L)"
          className={view.overlay ? 'bg-surface-2' : 'bg-bg'}
        >
          Overlay
        </Button>
      )}
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
