import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import {
  firstFreeColour,
  type GuestIdentity,
  isValidName,
  NAME_MAX,
  NAME_MIN,
  normaliseName,
  USER_COLOURS,
} from '../realtime/identity';
import { Button } from '../ui/button';

const COLOUR_NAMES: Record<string, string> = {
  '#e5534b': 'Red',
  '#f69d50': 'Orange',
  '#c69026': 'Gold',
  '#57ab5a': 'Green',
  '#39c5cf': 'Cyan',
  '#6cb6ff': 'Blue',
  '#b083f0': 'Purple',
  '#ec6cb9': 'Pink',
};

export type IdentityDialogProps = {
  open: boolean;
  /** First visit asks "who are you"; later it's a rename. */
  mode: 'welcome' | 'edit';
  initial: GuestIdentity;
  /** Colours other people in the room already use. */
  taken: ReadonlySet<string>;
  onSave: (identity: GuestIdentity) => void;
  /** Escape or Cancel: keep the current identity. */
  onClose: () => void;
};

/**
 * Name (2–20 characters) and one of 8 colours. A native modal `<dialog>`: the browser traps
 * focus, closes on Escape and hands focus back to whatever opened it.
 */
export function IdentityDialog({
  open,
  mode,
  initial,
  taken,
  onSave,
  onClose,
}: IdentityDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(initial.name);
  const [colour, setColour] = useState(initial.colour);
  const [touched, setTouched] = useState(false);
  const nameId = useId();
  const errorId = useId();
  const titleId = useId();

  // Reset the form each time it opens; pre-select a free colour if someone has yours.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on open, not on every peer change
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setName(initial.name);
      setColour(firstFreeColour(initial.colour, taken));
      setTouched(false);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const valid = isValidName(name);
  const showError = touched && !valid;

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!valid) return;
    onSave({ name: normaliseName(name), colour });
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(360px,calc(100vw-32px))] rounded-dialog border border-border bg-surface-1 p-0 text-fg shadow-xl backdrop:bg-black/50"
    >
      <form onSubmit={submit} className="flex flex-col gap-5 p-5" noValidate>
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-md font-semibold">
            {mode === 'welcome' ? 'Join the board' : 'Your name and colour'}
          </h2>
          <p className="text-sm text-muted">
            Others see this next to your cursor. Saved in this browser only.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor={nameId} className="text-sm font-medium">
            Name
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched(true)}
            maxLength={NAME_MAX + 10}
            autoComplete="nickname"
            autoFocus
            aria-invalid={showError}
            aria-describedby={showError ? errorId : undefined}
            className="h-8 rounded-control border border-border bg-bg px-2 text-base aria-invalid:border-[#e5534b]"
          />
          <p id={errorId} role="alert" className="min-h-4 text-xs text-muted">
            {showError && `Use ${NAME_MIN} to ${NAME_MAX} characters.`}
          </p>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Colour</legend>
          <div className="grid grid-cols-8 gap-1">
            {USER_COLOURS.map((c) => {
              const label = `${COLOUR_NAMES[c] ?? c}${taken.has(c) ? ' (in use)' : ''}`;
              return (
                <label key={c} className="relative grid size-8 place-items-center" title={label}>
                  <input
                    type="radio"
                    name="colour"
                    value={c}
                    checked={colour === c}
                    onChange={() => setColour(c)}
                    aria-label={label}
                    className="peer absolute inset-0 cursor-pointer appearance-none rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg"
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none size-6 rounded-full ring-offset-2 ring-offset-surface-1 peer-checked:ring-2 peer-checked:ring-fg"
                    style={{ backgroundColor: c }}
                  />
                  {taken.has(c) && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute size-1.5 rounded-full bg-bg"
                    />
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex justify-end gap-2">
          {mode === 'edit' && <Button onClick={() => ref.current?.close()}>Cancel</Button>}
          <Button type="submit" variant="primary">
            {mode === 'welcome' ? 'Start drawing' : 'Save'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
