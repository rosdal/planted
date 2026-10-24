import {
  cachedTokens,
  type IssuedToken,
  LinkRevokedError,
  type Notice,
  RoomClient,
  type StopReason,
  type SyncStatus,
} from '@planted/client';
import type { RoomId, RoomRole } from '@planted/schema';
import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type * as Y from 'yjs';
import { ApiClientError, api } from '../lib/api';
import { type GuestIdentity, loadGuestIdentity } from './identity';
import { readKey, rotationSettled } from './keys';

const RoomContext = createContext<RoomClient | null>(null);

/** `VITE_API_URL` with the scheme swapped: http → ws, https → wss. */
function socketUrl(): string {
  return import.meta.env.VITE_API_URL.replace(/^http/, 'ws');
}

/**
 * A room token from the key stored for this room. A 403 means the link is gone; the client then
 * stops with `link_revoked`.
 */
async function fetchToken(roomId: RoomId): Promise<IssuedToken> {
  await rotationSettled();
  const key = readKey(roomId);
  if (!key) throw new LinkRevokedError();
  try {
    return await api.roomToken(roomId, key);
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'forbidden') throw new LinkRevokedError();
    throw error;
  }
}

/**
 * Owns one `RoomClient` for `roomId`. The client is made in an effect, not during render, so
 * StrictMode's mount → unmount → mount makes two clients and destroys the first, instead of
 * leaking one.
 *
 * `children` remount when the board is reset (an epoch change replaces the doc), so nothing
 * keeps the old doc or its undo stack. `overlay` doesn't, so a "Board was reset" toast survives.
 */
export function RoomProvider({
  roomId,
  initialToken,
  children,
  overlay,
}: {
  roomId: RoomId;
  /** The loader's token: still fresh, so the first `hello` doesn't need another request. */
  initialToken?: IssuedToken;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  const [client, setClient] = useState<RoomClient | null>(null);
  const [generation, setGeneration] = useState(0);

  // The initial token only matters for the first connect; a new one must not remake the client.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const next = new RoomClient({
      url: socketUrl(),
      roomId,
      // Reused until a minute before it expires; a 4401 always fetches a new one. The token
      // route allows 30 a minute per IP, which a household behind one address shares.
      getToken: cachedTokens(() => fetchToken(roomId), { initial: initialToken }),
      clientName: loadGuestIdentity().name,
      dev: import.meta.env.DEV,
    });
    next.awareness.setLocalStateField('user', loadGuestIdentity());
    const offReset = next.on('reset', () => setGeneration(next.generation));
    const wake = () => next.wake();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') next.wake();
    };
    // A page kept in the back/forward cache keeps its socket open (the browser still answers
    // pings), which leaves a ghost connection that stops the room from unloading. Go offline
    // while hidden that way, and come back if the page is restored.
    let wasOnline = true;
    const onPageHide = () => {
      wasOnline = next.wantsOnline;
      next.setOnline(false);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && wasOnline) next.setOnline(true);
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    setClient(next);
    setGeneration(next.generation);
    return () => {
      offReset();
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      next.destroy();
      setClient(null);
    };
  }, [roomId]);

  if (!client) return null;
  return (
    <RoomContext value={client}>
      {overlay}
      <Fragment key={generation}>{children}</Fragment>
    </RoomContext>
  );
}

export function useRoomClient(): RoomClient {
  const client = useContext(RoomContext);
  if (!client) throw new Error('useRoomClient must be used inside <RoomProvider>');
  return client;
}

export function useRoomDoc(): Y.Doc {
  return useRoomClient().doc;
}

export type SyncState = {
  status: SyncStatus;
  attempt: number;
  stopReason: StopReason | null;
  /** The server's last error frame, e.g. why a socket was closed. */
  lastError: Notice | null;
};

type Store<T> = { subscribe: (onStoreChange: () => void) => () => void; getSnapshot: () => T };

/**
 * A `useSyncExternalStore` store over a source that only says "something changed": the
 * snapshot is re-read on each change and cached, so `getSnapshot` stays referentially stable.
 */
function derivedStore<T>(listen: (onChange: () => void) => () => void, read: () => T): Store<T> {
  let value = read();
  return {
    subscribe: (onStoreChange) =>
      listen(() => {
        value = read();
        onStoreChange();
      }),
    getSnapshot: () => value,
  };
}

function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function useSyncStatus(): SyncState {
  const client = useRoomClient();
  const store = useMemo(
    () =>
      derivedStore(
        (onChange) => {
          const offStatus = client.on('status', onChange);
          const offStop = client.on('stop', onChange);
          return () => {
            offStatus();
            offStop();
          };
        },
        () => ({
          status: client.status,
          attempt: client.attempt,
          stopReason: client.stopReason,
          lastError: client.lastError,
        }),
      ),
    [client],
  );
  return useStore(store);
}

export type Peer = { clientId: number; user: GuestIdentity | null };

/**
 * Everyone in the room's awareness except this tab. Awareness changes on every cursor move
 * (30 Hz per peer), but this only produces a new list, and so a re-render, when someone joins,
 * leaves, or changes name or colour.
 */
export function usePeers(): Peer[] {
  const client = useRoomClient();
  const store = useMemo(() => {
    let key = '';
    let peers: Peer[] = [];
    const read = () => {
      const next = [...client.awareness.getStates()]
        .filter(([clientId]) => clientId !== client.doc.clientID)
        .map(([clientId, state]) => ({
          clientId,
          user: (state.user as GuestIdentity | undefined) ?? null,
        }));
      const nextKey = next
        .map((p) => `${p.clientId}:${p.user?.name ?? ''}:${p.user?.colour ?? ''}`)
        .join('|');
      if (nextKey !== key) {
        key = nextKey;
        peers = next;
      }
      return peers;
    };
    return derivedStore((onChange) => {
      client.awareness.on('change', onChange);
      return () => client.awareness.off('change', onChange);
    }, read);
  }, [client]);
  return useStore(store);
}

export function useYArray<T>(name: string): T[] {
  const doc = useRoomDoc();
  const store = useMemo(() => {
    const array = doc.getArray<T>(name);
    return derivedStore(
      (onChange) => {
        array.observe(onChange);
        return () => array.unobserve(onChange);
      },
      () => array.toArray(),
    );
  }, [doc, name]);
  return useStore(store);
}

/** The role from the last `welcome`, or `initial` (from the loader's token) before the first. */
export function useRole(initial: RoomRole): RoomRole {
  const client = useRoomClient();
  const store = useMemo(
    () =>
      derivedStore(
        (onChange) => client.on('role', onChange),
        () => client.role,
      ),
    [client],
  );
  return useStore(store) ?? initial;
}

/** Calls `listener` for every notice: a board reset, `object_limit`, `doc_limit`, a 4429. */
export function useNotices(listener: (notice: Notice) => void): void {
  const client = useRoomClient();
  // The latest listener without resubscribing on every render.
  const [box] = useState(() => ({ listener }));
  box.listener = listener;
  useEffect(() => client.on('notice', (notice) => box.listener(notice)), [client, box]);
}
