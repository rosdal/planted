import type { RoomId } from '@planted/schema';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiClientError, api } from '../lib/api';
import { readKey, readViewKey, saveKeys, shareUrl, trackRotation } from '../realtime/keys';
import { Button } from '../ui/button';

export type ShareDialogProps = {
  open: boolean;
  roomId: RoomId;
  onClose: () => void;
};

type Confirming = 'rotate' | 'clear' | null;

async function editToken(roomId: RoomId): Promise<string> {
  const key = readKey(roomId);
  if (!key) throw new ApiClientError('forbidden', 403, 'No key for this board');
  return (await api.roomToken(roomId, key)).token;
}

/**
 * Edit links only. The dialog can show only keys this browser holds: the edit key it opens the
 * board with, and the view key kept when the board was created or its links rotated. A native
 * modal `<dialog>`: the browser traps focus, closes on Escape and restores focus.
 */
export function ShareDialog({ open, roomId, onClose }: ShareDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [keys, setKeys] = useState(() => ({ edit: readKey(roomId), view: readViewKey(roomId) }));
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setKeys({ edit: readKey(roomId), view: readViewKey(roomId) });
      setConfirming(null);
      setMessage(null);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, roomId]);

  async function rotate() {
    setBusy(true);
    setMessage(null);
    try {
      const token = await editToken(roomId);
      const next = await trackRotation(
        api.rotateLinks(roomId, token).then((rotated) => {
          // Stored before the promise settles, so the reconnect that follows uses the new key.
          saveKeys(roomId, rotated);
          return rotated;
        }),
      );
      setKeys({ edit: next.editKey, view: next.viewKey });
      setMessage('New links made. The old ones stopped working: send these to everyone else.');
    } catch {
      setMessage('Could not rotate the links. Try again.');
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  async function clear() {
    setBusy(true);
    setMessage(null);
    try {
      await api.clearRoom(roomId, await editToken(roomId));
      ref.current?.close();
    } catch {
      setMessage('Could not clear the board. Try again.');
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  const origin = window.location.origin;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(480px,calc(100vw-32px))] rounded-dialog border border-border bg-surface-1 p-0 text-fg shadow-xl backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-5 p-5">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-md font-semibold">
            Share this board
          </h2>
          <p className="text-sm text-muted">
            Anyone with a link can open the board until you rotate them.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <LinkRow
            label="Edit link"
            hint="Can draw and undo"
            url={keys.edit ? shareUrl(origin, roomId, keys.edit) : null}
          />
          <LinkRow
            label="View link"
            hint="Sees strokes and cursors live, can't draw"
            url={keys.view ? shareUrl(origin, roomId, keys.view) : null}
          />
        </div>

        <p role="status" className="min-h-4 text-sm text-muted">
          {message}
        </p>

        {confirming === 'rotate' ? (
          <Confirm
            text="Both links stop working, for everyone with them open too. You get new ones to send round."
            action="Rotate links"
            busy={busy}
            onConfirm={rotate}
            onCancel={() => setConfirming(null)}
          />
        ) : confirming === 'clear' ? (
          <Confirm
            text="Every stroke is removed for everyone, and undo can't bring them back."
            action="Clear board"
            busy={busy}
            onConfirm={clear}
            onCancel={() => setConfirming(null)}
          />
        ) : (
          <div className="flex flex-wrap justify-between gap-2">
            <div className="flex gap-2">
              <Button onClick={() => setConfirming('rotate')}>Rotate links</Button>
              {import.meta.env.DEV && (
                <Button onClick={() => setConfirming('clear')}>Clear board</Button>
              )}
            </div>
            <Button variant="primary" onClick={() => ref.current?.close()}>
              Done
            </Button>
          </div>
        )}
      </div>
    </dialog>
  );
}

function LinkRow({ label, hint, url }: { label: string; hint: string; url: string | null }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const inputId = useId();

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2000);
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label} <span className="font-normal text-muted">· {hint}</span>
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          readOnly
          value={url ?? 'Not stored in this browser'}
          onFocus={(e) => e.currentTarget.select()}
          className="h-8 min-w-0 flex-1 rounded-control border border-border bg-bg px-2 font-mono text-xs text-muted"
        />
        <Button onClick={copy} disabled={!url} aria-label={`Copy ${label.toLowerCase()}`}>
          <span aria-live="polite">
            {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
          </span>
        </Button>
      </div>
    </div>
  );
}

function Confirm({
  text,
  action,
  busy,
  onConfirm,
  onCancel,
}: {
  text: string;
  action: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-3 text-sm">{text}</legend>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm} disabled={busy} aria-busy={busy}>
          {busy ? 'Working…' : action}
        </Button>
      </div>
    </fieldset>
  );
}
