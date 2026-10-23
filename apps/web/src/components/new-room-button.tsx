import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiClientError, api } from '../lib/api';
import { saveKeys } from '../realtime/keys';
import { Button, type ButtonProps } from '../ui/button';

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'rate_limited') {
    return 'Too many rooms, wait a minute';
  }
  if (error instanceof ApiClientError && error.code === 'network') {
    return 'Could not reach the server, try again';
  }
  return 'Could not create a room, try again';
}

export function NewRoomButton({
  variant = 'primary',
  size,
}: Pick<ButtonProps, 'variant' | 'size'>) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createRoom() {
    setPending(true);
    setError(null);
    try {
      const { roomId, editKey, viewKey } = await api.createRoom();
      // The keys come back only now; without them nobody, the creator included, gets back in.
      saveKeys(roomId, { editKey, viewKey });
      await navigate({ to: '/r/$roomId', params: { roomId } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant={variant}
        {...(size && { size })}
        disabled={pending}
        aria-busy={pending}
        onClick={createRoom}
      >
        {pending ? 'Creating…' : 'New room'}
      </Button>
      <p role="status" className="min-h-4 text-xs text-muted">
        {error}
      </p>
    </div>
  );
}
