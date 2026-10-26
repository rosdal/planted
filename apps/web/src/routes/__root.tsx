import {
  createRootRoute,
  type ErrorComponentProps,
  Link,
  Outlet,
  useRouter,
} from '@tanstack/react-router';
import { NotFoundPage } from '../components/not-found-page';
import { Button } from '../ui/button';

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => (
    <NotFoundPage
      title="Nothing here"
      detail="That link doesn't point at a room. Check it, or start a new one."
    />
  ),
  errorComponent: RootError,
});

function RootLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-3xl items-center px-4">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-control text-md font-semibold tracking-[-0.02em]"
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-green" />
            planted
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-16 sm:py-24">
        <Outlet />
      </main>
      <footer className="mx-auto w-full max-w-3xl px-4 pb-6 text-xs text-muted">
        Planted is a fan project and is not affiliated with or endorsed by Ubisoft. Map, operator
        and gadget names are used only as labels.
      </footer>
    </div>
  );
}

function RootError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-muted">
        {error instanceof Error ? error.message : 'The page failed to load. Try again.'}
      </p>
      <div className="mt-3">
        <Button
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          Try again
        </Button>
      </div>
    </section>
  );
}
