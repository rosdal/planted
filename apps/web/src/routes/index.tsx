import { createFileRoute } from '@tanstack/react-router';
import { NewRoomButton } from '../components/new-room-button';

export const Route = createFileRoute('/')({
  component: Landing,
});

function Landing() {
  return (
    <section className="flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Plan the round together.</h1>
      <p className="text-md text-muted">
        A free, real-time multiplayer strat board for Rainbow Six Siege. Pre-alpha: rooms exist, the
        board doesn't yet.
      </p>
      <div className="mt-4">
        <NewRoomButton size="lg" />
      </div>
    </section>
  );
}
