import { RoomId } from '@planted/schema';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { useState } from 'react';
import { NewRoomButton } from '../components/new-room-button';
import { NotFoundPage } from '../components/not-found-page';
import { ApiClientError, api } from '../lib/api';
import { Button } from '../ui/button';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

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
  component: RoomPage,
  notFoundComponent: () => (
    <NotFoundPage
      title="Room not found"
      detail="This room doesn't exist, or it has expired. Start a new one and share the link."
    />
  ),
});

function RoomPage() {
  const room = Route.useLoaderData();

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted">Room</p>
        <h1 className="font-mono text-lg font-medium break-all">{room.roomId}</h1>
        <p className="text-sm text-muted">
          Created{' '}
          <time dateTime={room.createdAt}>{dateFormat.format(new Date(room.createdAt))}</time>
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <CopyLinkButton />
        <NewRoomButton variant="secondary" />
      </div>
    </section>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

function CopyLinkButton() {
  const [state, setState] = useState<CopyState>('idle');
  const url = window.location.href;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="primary" onClick={copy}>
        {state === 'copied' ? 'Copied' : 'Copy link'}
      </Button>
      <p role="status" className="min-h-4 max-w-full text-xs break-all text-muted">
        {state === 'failed' && <>Couldn't copy. Select the link instead: {url}</>}
      </p>
    </div>
  );
}
