import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { ApiClientError, api } from '../lib/api';
import { saveKeys } from '../realtime/keys';
import { Button, type ButtonProps } from '../ui/button';
import { loadPickerContent, MapPicker, type PickerContent } from './MapPicker';

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'rate_limited') {
    return 'Too many rooms, wait a minute';
  }
  if (error instanceof ApiClientError && error.code === 'network') {
    return 'Could not reach the server, try again';
  }
  if (error instanceof ApiClientError && error.code === 'bad_request') {
    // The CDN lists a map the server doesn't have yet: content was released before the server.
    return "That map isn't available yet. Pick another, or try again later.";
  }
  return 'Could not create a room, try again';
}

/** "New room": opens the map picker; picking a map creates the room and opens it. */
export function NewRoomButton({
  variant = 'primary',
  size,
}: Pick<ButtonProps, 'variant' | 'size'>) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Fetched on the first open, then kept so the picker reopens instantly; refetched after a
  // failed load.
  const [content, setContent] = useState<Promise<PickerContent> | null>(null);
  const failed = useRef(false);

  function openPicker() {
    if (!content || failed.current) {
      failed.current = false;
      const next = loadPickerContent();
      void next.then((c) => {
        failed.current = !c.ok;
      });
      setContent(next);
    }
    setOpen(true);
  }

  async function createRoom(mapId: string) {
    try {
      const { roomId, editKey, viewKey } = await api.createRoom(mapId);
      // The keys come back only now; without them nobody, the creator included, gets back in.
      saveKeys(roomId, { editKey, viewKey });
      setOpen(false);
      await navigate({ to: '/r/$roomId', params: { roomId } });
    } catch (e) {
      throw new Error(errorMessage(e));
    }
  }

  return (
    <>
      <Button variant={variant} {...(size && { size })} onClick={openPicker} aria-haspopup="dialog">
        New room
      </Button>
      {content && (
        <MapPicker
          open={open}
          content={content}
          onPick={createRoom}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
