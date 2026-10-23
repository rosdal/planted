import { NewRoomButton } from './new-room-button';

const copy = {
  no_key: {
    title: 'You need a link to open this board',
    detail:
      'Boards are only reachable through the link their creator shares. Ask them for it, or start a board of your own.',
  },
  revoked: {
    title: 'This link was revoked',
    detail:
      "The board's links were replaced, so this one no longer works. Ask whoever shared it for the new link.",
  },
} as const;

/** Shown instead of a board when this browser has no working key for it (ADR 0005). */
export function NeedLink({ reason }: { reason: keyof typeof copy }) {
  const { title, detail } = copy[reason];
  return (
    <section className="flex max-w-xl flex-col gap-3">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-muted">{detail}</p>
      <div className="mt-3">
        <NewRoomButton size="lg" />
      </div>
    </section>
  );
}
