import { CloseCode, controlFrame, decodeControl, decodeFrame } from '@planted/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LinkRevokedError,
  PING_INTERVAL_MS,
  RATE_LIMITED_BACKOFF_MS,
  RoomClient,
  type TokenReason,
  type WebSocketLike,
} from './room-client';

/** A socket the test drives by hand: open it, feed it frames, close it with a code. */
class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  binaryType = 'blob';
  readyState = 0;
  sent: Uint8Array[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(bytes: Uint8Array): void {
    const copy = bytes.slice();
    this.onmessage?.({ data: copy.buffer });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }

  /** Kinds of the control messages this socket sent. */
  controlsSent(): string[] {
    return this.sent.flatMap((bytes) => {
      const frame = decodeFrame(bytes);
      return frame.channel === 0 ? [decodeControl(frame).kind] : [];
    });
  }
}

const welcome = (role: 'edit' | 'view' = 'edit', roomEpoch = 1) =>
  controlFrame({
    kind: 'welcome',
    seq: 1,
    body: { role, roomEpoch, serverTime: 0, limits: { maxFrameBytes: 1, maxObjects: 1 } },
  });

/** Let the token promise resolve and the socket be constructed. */
const settle = () => vi.advanceTimersByTimeAsync(0);

let client: RoomClient | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
});
afterEach(() => {
  client?.destroy();
  client = null;
  vi.useRealTimers();
});

async function connected(
  options: { dev?: boolean; getToken?: (reason: TokenReason) => Promise<string> } = {},
): Promise<FakeSocket> {
  client = new RoomClient({
    url: 'ws://x',
    roomId: 'r',
    getToken: async () => 'token',
    WebSocketImpl: FakeSocket,
    random: () => 0.5,
    ...options,
  });
  await settle();
  const socket = FakeSocket.all.at(-1);
  if (!socket) throw new Error('no socket');
  socket.open();
  return socket;
}

describe('RoomClient handshake', () => {
  it('sends hello on open and sync-1 only after welcome', async () => {
    const socket = await connected();
    expect(socket.controlsSent()).toEqual(['hello']);
    expect(socket.sent).toHaveLength(1);
    socket.receive(welcome());
    expect(decodeFrame(socket.sent[1] ?? new Uint8Array())).toMatchObject({ channel: 1, type: 0 });
    expect(client?.role).toBe('edit');
  });
});

describe('RoomClient close codes', () => {
  it.each([
    [CloseCode.ProtocolTooOld, 'upgrade_required'],
    [CloseCode.Forbidden, 'forbidden'],
    [CloseCode.BadFrame, 'protocol_error'],
    [CloseCode.RoomNotFound, 'room_not_found'],
  ] as const)('stops reconnecting on %i (%s)', async (code, reason) => {
    const socket = await connected();
    socket.serverClose(code);
    expect(client?.stopReason).toBe(reason);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('waits at least 30 s after a 4429', async () => {
    const socket = await connected();
    const notices: string[] = [];
    client?.on('notice', (n) => notices.push(n.code));
    socket.serverClose(CloseCode.RateLimited);
    await vi.advanceTimersByTimeAsync(RATE_LIMITED_BACKOFF_MS - 1);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(2);
    expect(notices).toEqual(['rate_limited']);
  });

  it('reconnects as normal after a 1001', async () => {
    const socket = await connected();
    socket.serverClose(CloseCode.GoingAway);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(client?.stopReason).toBeNull();
  });
});

describe('RoomClient liveness', () => {
  it('pings every 15 s and reconnects after two missed pongs', async () => {
    const socket = await connected();
    socket.receive(welcome());
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
    expect(socket.controlsSent().filter((k) => k === 'ping')).toHaveLength(2);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('stays connected while pongs come back', async () => {
    const socket = await connected();
    socket.receive(welcome());
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      socket.receive(controlFrame({ kind: 'pong', seq: 1, body: { t: 0 } }));
    }
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('RoomClient as a viewer', () => {
  it('never sends a doc update, and throws in dev builds', async () => {
    const socket = await connected({ dev: true });
    socket.receive(welcome('view'));
    const sentBefore = socket.sent.length;
    expect(() => client?.doc.getArray('debug-items').push(['x'])).toThrow(/viewer/);
    expect(socket.sent.slice(sentBefore).filter((b) => decodeFrame(b).channel === 1)).toEqual([]);
  });
});

describe('RoomClient tokens', () => {
  it('refetches after a 4401, keeps retrying with backoff, and never calls it revoked on its own', async () => {
    const reasons: TokenReason[] = [];
    const socket = await connected({
      getToken: async (reason) => {
        reasons.push(reason);
        return 'token';
      },
    });
    socket.serverClose(CloseCode.BadToken);
    await settle();
    FakeSocket.all.at(-1)?.open();
    FakeSocket.all.at(-1)?.serverClose(CloseCode.BadToken);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client?.stopReason).toBeNull();
    expect(reasons).toEqual(['connect', 'refresh', 'refresh']);
  });

  it('stops with link_revoked when the key itself is refused', async () => {
    let revoked = false;
    const socket = await connected({
      getToken: async () => {
        if (revoked) throw new LinkRevokedError();
        return 'token';
      },
    });
    revoked = true;
    socket.serverClose(CloseCode.BadToken);
    await vi.waitFor(() => expect(client?.stopReason).toBe('link_revoked'));
  });
});

describe('RoomClient epochs', () => {
  it('resets once for a clear: on the 4409, not again on the welcome that follows', async () => {
    const socket = await connected();
    socket.receive(welcome('edit', 1));
    let resets = 0;
    client?.on('reset', () => resets++);
    socket.serverClose(CloseCode.EpochChanged);
    await settle();
    const next = FakeSocket.all.at(-1);
    next?.open();
    client?.doc.getArray('debug-items').push(['drawn while reconnecting']);
    next?.receive(welcome('edit', 2));
    expect(resets).toBe(1);
    expect(client?.doc.getArray('debug-items').length).toBe(1);
    expect(client?.epoch).toBe(2);
  });

  it('resets on a welcome with a new epoch after an ordinary reconnect', async () => {
    const socket = await connected();
    socket.receive(welcome('edit', 1));
    let resets = 0;
    client?.on('reset', () => resets++);
    socket.serverClose(CloseCode.GoingAway);
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.all.at(-1);
    next?.open();
    next?.receive(welcome('edit', 2));
    expect(resets).toBe(1);
  });
});
