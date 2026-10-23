import { RoomClient, type StopReason, type SyncStatus } from '@planted/client';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type * as Y from 'yjs';
import { type GuestIdentity, loadGuestIdentity } from './identity';

const RoomContext = createContext<RoomClient | null>(null);

/** `VITE_API_URL` with the scheme swapped: http → ws, https → wss. */
function socketUrl(): string {
  return import.meta.env.VITE_API_URL.replace(/^http/, 'ws');
}

/**
 * Owns one `RoomClient` for `roomId`. The client is made in an effect, not during render, so
 * StrictMode's mount → unmount → mount makes two clients and destroys the first, instead of
 * leaking one.
 */
export function RoomProvider({ roomId, children }: { roomId: string; children: ReactNode }) {
  const [client, setClient] = useState<RoomClient | null>(null);

  useEffect(() => {
    const next = new RoomClient({ url: socketUrl(), roomId });
    next.awareness.setLocalStateField('user', loadGuestIdentity());
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
    return () => {
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      next.destroy();
      setClient(null);
    };
  }, [roomId]);

  if (!client) return null;
  return <RoomContext value={client}>{children}</RoomContext>;
}

export function useRoomClient(): RoomClient {
  const client = useContext(RoomContext);
  if (!client) throw new Error('useRoomClient must be used inside <RoomProvider>');
  return client;
}

export function useRoomDoc(): Y.Doc {
  return useRoomClient().doc;
}

export type SyncState = { status: SyncStatus; attempt: number; stopReason: StopReason | null };

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
        () => ({ status: client.status, attempt: client.attempt, stopReason: client.stopReason }),
      ),
    [client],
  );
  return useStore(store);
}

export type Peer = { clientId: number; user: GuestIdentity | null };

/** Everyone in the room's awareness except this tab. */
export function usePeers(): Peer[] {
  const client = useRoomClient();
  const store = useMemo(
    () =>
      derivedStore(
        (onChange) => {
          client.awareness.on('change', onChange);
          return () => client.awareness.off('change', onChange);
        },
        () =>
          [...client.awareness.getStates()]
            .filter(([clientId]) => clientId !== client.doc.clientID)
            .map(([clientId, state]) => ({
              clientId,
              user: (state.user as GuestIdentity | undefined) ?? null,
            })),
      ),
    [client],
  );
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
