import { RoomId } from '@planted/schema';
import { createFileRoute, notFound, Outlet } from '@tanstack/react-router';
import { NotFoundPage } from '../components/not-found-page';
import { ApiClientError, api } from '../lib/api';

export const Route = createFileRoute('/r/$roomId')({
  params: {
    // A malformed id doesn't match this route at all, so the root not-found page renders.
    parse: ({ roomId }) => {
      const parsed = RoomId.safeParse(roomId);
      return parsed.success ? { roomId: parsed.data } : false;
    },
    stringify: ({ roomId }) => ({ roomId }),
  },
  loader: async ({ params }) => {
    try {
      return await api.getRoom(params.roomId);
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'not_found') throw notFound();
      throw error;
    }
  },
  // Layout for the room page and its debug page; both read this loader's data.
  component: Outlet,
  notFoundComponent: () => (
    <NotFoundPage
      title="Room not found"
      detail="This room doesn't exist, or it has expired. Start a new one and share the link."
    />
  ),
});
