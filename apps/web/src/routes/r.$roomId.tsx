import { type GetRoomResponse, RoomId, type RoomRole } from '@planted/schema';
import { createFileRoute, notFound, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { NeedLink } from '../components/NeedLink';
import { NotFoundPage } from '../components/not-found-page';
import { LEGACY_MAP } from '../content/legacy';
import { type LoadedMap, loadMap } from '../content/loader';
import { ApiClientError, api } from '../lib/api';
import { readKey, stripKeyFromUrl, takeKeyFromHash } from '../realtime/keys';

export type RoomAccess =
  | {
      status: 'ok';
      roomId: RoomId;
      room: GetRoomResponse;
      role: RoomRole;
      /** Reused for the first `hello`, so opening a board costs one token request, not two. */
      token: { token: string; expiresAt: string };
      /** The room's map in the content version it pinned at creation. */
      content: LoadedMap;
    }
  /** No key in the URL or in this browser: nothing to ask the server. */
  | { status: 'need_link'; roomId: RoomId }
  /** The key was refused (403): wrong, or its link was rotated. */
  | { status: 'revoked'; roomId: RoomId };

export const Route = createFileRoute('/r/$roomId')({
  params: {
    // A malformed id doesn't match this route at all, so the root not-found page renders.
    parse: ({ roomId }) => {
      const parsed = RoomId.safeParse(roomId);
      return parsed.success ? { roomId: parsed.data } : false;
    },
    stringify: ({ roomId }) => ({ roomId }),
  },
  beforeLoad: ({ params, location }) => {
    // A share link's `#k=` key moves into storage before the loader looks for one.
    takeKeyFromHash(params.roomId, location.hash);
  },
  loader: async ({ params }): Promise<RoomAccess> => {
    const { roomId } = params;
    const key = readKey(roomId);
    if (!key) return { status: 'need_link', roomId };
    try {
      const { token, role, expiresAt } = await api.roomToken(roomId, key);
      const room = await api.getRoom(roomId, token);
      // The server wrote the same mapId and version into the doc's meta; reading them here
      // lets the floor art start loading before the socket has synced.
      const content =
        room.mapId && room.contentVersion
          ? await loadMap(room.contentVersion, room.mapId)
          : LEGACY_MAP;
      return { status: 'ok', roomId, room, role, token: { token, expiresAt }, content };
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'forbidden') {
        return { status: 'revoked', roomId };
      }
      if (error instanceof ApiClientError && error.code === 'not_found') throw notFound();
      throw error;
    }
  },
  // Layout for the room page and its debug page; both read this loader's data.
  component: RoomLayout,
  notFoundComponent: () => (
    <NotFoundPage
      title="Room not found"
      detail="This room doesn't exist, or it has expired. Start a new one and share the link."
    />
  ),
});

function RoomLayout() {
  const access = Route.useLoaderData();
  useEffect(() => {
    stripKeyFromUrl();
  }, []);
  if (access.status === 'need_link') return <NeedLink reason="no_key" />;
  if (access.status === 'revoked') return <NeedLink reason="revoked" />;
  return <Outlet />;
}
