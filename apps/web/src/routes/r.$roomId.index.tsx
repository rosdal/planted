import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { NewRoomButton } from '../components/new-room-button';
import { Button } from '../ui/button';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const roomRoute = getRouteApi('/r/$roomId');

export const Route = createFileRoute('/r/$roomId/')({
  component: RoomPage,
});

function RoomPage() {
  const room = roomRoute.useLoaderData();

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
      {import.meta.env.DEV && (
        <Link
          to="/r/$roomId/debug"
          params={{ roomId: room.roomId }}
          className="self-start rounded-control text-sm text-muted underline underline-offset-4 hover:text-fg"
        >
          Sync debug page
        </Link>
      )}
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
