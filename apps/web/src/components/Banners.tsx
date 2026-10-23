import { CloseCode, type Notice, type StopReason } from '@planted/client';
import { type ReactNode, useEffect, useState } from 'react';
import { useNotices, useSyncStatus } from '../realtime/react';
import { Button } from '../ui/button';

const TOAST_MS = 4000;

/** Close codes behind the stops that mean a client bug or tampering, shown so a report has it. */
const STOP_CODES: Partial<Record<StopReason, number>> = {
  forbidden: CloseCode.Forbidden,
  protocol_error: CloseCode.BadFrame,
};

function stopMessage(reason: StopReason, detail: string | null): { title: string; body: string } {
  switch (reason) {
    case 'link_revoked':
      return {
        title: 'This link was revoked',
        body: 'Ask whoever shared the board for the new link.',
      };
    case 'room_not_found':
      return { title: 'This board no longer exists', body: 'It may have expired.' };
    case 'forbidden':
    case 'protocol_error':
      return {
        title: `Disconnected by the server (${STOP_CODES[reason]})`,
        body: `${detail ?? 'This tab sent something the server refused.'} Reload to reconnect.`,
      };
    default:
      return { title: 'Disconnected', body: 'Reload to reconnect.' };
  }
}

/**
 * Everything the connection needs to tell the user, over the board: a short toast for passing
 * events (board reset, too much traffic), a banner while the board is full, and a banner that
 * stays when the client has stopped for good.
 */
export function Banners() {
  const { stopReason, lastError } = useSyncStatus();
  const [toast, setToast] = useState<Notice | null>(null);
  const [full, setFull] = useState<Notice | null>(null);

  useNotices((notice) => {
    if (notice.code === 'doc_limit' || notice.code === 'object_limit') setFull(notice);
    else setToast(notice);
  });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const stopped = stopReason && stopReason !== 'destroyed' ? stopReason : null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-10 flex flex-col items-center gap-2 px-3">
      {stopped === 'upgrade_required' ? (
        <Banner tone="alert" title="A new version is available">
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </Banner>
      ) : stopped ? (
        <Banner tone="alert" {...stopMessage(stopped, lastError?.message ?? null)} />
      ) : null}
      {full && !stopped && (
        <Banner title="This board is full" body={full.message}>
          <Button onClick={() => setFull(null)}>Dismiss</Button>
        </Banner>
      )}
      {/* Always rendered, so screen readers announce the toast when its text appears. */}
      <p
        role="status"
        className={`rounded-full border border-border bg-surface-1 px-3 py-1 text-sm shadow-md ${toast ? '' : 'sr-only'}`}
      >
        {toast?.message}
      </p>
    </div>
  );
}

function Banner({
  title,
  body,
  tone = 'info',
  children,
}: {
  title: string;
  body?: string;
  tone?: 'info' | 'alert';
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === 'alert' ? 'alert' : 'status'}
      className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-panel border border-border bg-surface-1 px-4 py-3 shadow-md"
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        {body && <p className="text-sm text-muted">{body}</p>}
      </div>
      {children && <div className="ml-auto flex shrink-0 gap-2">{children}</div>}
    </div>
  );
}
