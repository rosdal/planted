import { NewRoomButton } from './new-room-button';

export function NotFoundPage({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="flex flex-col gap-3">
      <p className="font-mono text-xs text-muted">404</p>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-muted">{detail}</p>
      <div className="mt-3">
        <NewRoomButton size="lg" />
      </div>
    </section>
  );
}
