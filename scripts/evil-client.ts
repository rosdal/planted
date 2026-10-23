/**
 * A raw socket client that sends whatever it's told: frames before `welcome`, invalid objects,
 * unknown root types, floods. The server's integration tests drive it, and it pokes a deployed
 * server from the command line:
 *
 *   pnpm evil --room <id> --key <key> --attack bad-stroke
 *   pnpm evil --room <id> --key <view key> --attack viewer-update
 *   pnpm evil --room <id> --attack no-hello
 *
 * Attacks: no-hello, pre-welcome, old-protocol, bad-stroke, unknown-root, viewer-update, flood.
 * Prints the close code and reason the server answered with.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  CloseCode,
  type ControlMessage,
  controlFrame,
  decodeControl,
  decodeFrame,
  type Frame,
  sync1Frame,
  updateFrame,
  YjsType,
} from '@planted/protocol';
import { PROTOCOL_VERSION, type WelcomeMessage } from '@planted/schema';
import WebSocket from 'ws';
import * as Y from 'yjs';

export type Closed = { code: number; reason: string };

export class EvilClient {
  readonly frames: Frame[] = [];
  readonly controls: ControlMessage[] = [];
  /** A local doc for crafting updates; it learns the room's state from sync-2 and updates. */
  readonly doc = new Y.Doc();
  readonly closed: Promise<Closed>;
  /** False makes the server see this socket as hopelessly behind. */
  answerPings = true;
  #seq = 1;
  #listeners = new Set<() => void>();

  private constructor(readonly socket: WebSocket) {
    socket.binaryType = 'nodebuffer';
    this.closed = new Promise((resolve) =>
      socket.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
        this.#notify();
      }),
    );
    socket.on('message', (data: Buffer) => {
      const frame = decodeFrame(new Uint8Array(data));
      this.frames.push(frame);
      if (frame.channel === 0) {
        const control = decodeControl(frame);
        this.controls.push(control);
        // Like a real client, unless told to play dead.
        if (control.kind === 'ping' && this.answerPings) {
          this.send(controlFrame({ kind: 'pong', seq: control.seq, body: control.body }));
        }
      }
      if (frame.channel === 1 && frame.type !== YjsType.Sync1) {
        Y.applyUpdate(this.doc, frame.payload, 'server');
      }
      this.#notify();
    });
    socket.on('error', () => {});
  }

  /** Opens a socket to `ws(s)://…/rooms/:roomId/ws` and resolves once it's open. */
  static async connect(wsUrl: string, roomId: string): Promise<EvilClient> {
    const socket = new WebSocket(`${wsUrl.replace(/\/$/, '')}/rooms/${roomId}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new EvilClient(socket);
  }

  /** Raw bytes, or anything `ws` sends: a string makes a text frame. */
  send(data: Uint8Array | string): void {
    this.socket.send(data);
  }

  hello(
    token: string,
    { protocol = PROTOCOL_VERSION as number }: { protocol?: number } = {},
  ): void {
    this.send(
      controlFrame({
        kind: 'hello',
        seq: this.#seq++,
        body: { protocol, token, clientName: 'evil-client' },
      }),
    );
  }

  /** `hello`, then wait for `welcome` and a sync-2, so `doc` holds the room. */
  async join(token: string): Promise<WelcomeMessage> {
    this.hello(token);
    const welcome = await this.waitFor(() =>
      this.controls.find(
        (c): c is Extract<ControlMessage, { kind: 'welcome' }> => c.kind === 'welcome',
      ),
    );
    this.send(sync1Frame(this.doc));
    await this.waitFor(() => this.frames.some((f) => f.channel === 1 && f.type === YjsType.Sync2));
    return welcome.body;
  }

  /** Makes `change` on the local doc and sends exactly that update to the server. */
  update(change: (doc: Y.Doc) => void): Uint8Array {
    let captured: Uint8Array | null = null;
    const capture = (update: Uint8Array, origin: unknown) => {
      if (origin === 'evil') captured = update;
    };
    this.doc.on('update', capture);
    this.doc.transact(() => change(this.doc), 'evil');
    this.doc.off('update', capture);
    if (!captured) throw new Error('the change produced no update');
    this.send(updateFrame(captured));
    return captured;
  }

  errors(): string[] {
    return this.controls.flatMap((c) => (c.kind === 'error' ? [c.body.code] : []));
  }

  /** Resolves with the first truthy value of `check`, re-run on every frame and on close. */
  waitFor<T>(check: () => T | undefined | false | null, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        const value = check();
        if (value) {
          cleanup();
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('EvilClient.waitFor timed out'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.#listeners.delete(run);
      };
      this.#listeners.add(run);
      run();
    });
  }

  close(): void {
    this.socket.terminate();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** A stroke that passes the schema except for the field you override. */
export function strokeFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'stroke',
    floor: 'test-1',
    phase: null,
    colour: '#57ab5a',
    width: 0.002,
    points: new Uint8Array(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer),
    by: 'evil',
    at: Date.now(),
    ...overrides,
  };
}

export function putObject(doc: Y.Doc, id: string, fields: Record<string, unknown>): void {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(fields)) map.set(key, value);
  doc.getMap('objects').set(id, map);
}

const ATTACKS = [
  'no-hello',
  'pre-welcome',
  'old-protocol',
  'bad-stroke',
  'unknown-root',
  'viewer-update',
  'flood',
] as const;

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      url: { type: 'string', default: process.env.VITE_API_URL ?? 'http://localhost:3000' },
      room: { type: 'string' },
      key: { type: 'string' },
      attack: { type: 'string' },
    },
  });
  const attack = args.attack as (typeof ATTACKS)[number];
  if (!args.room || !ATTACKS.includes(attack)) {
    console.error(`usage: pnpm evil --room <id> [--key <key>] --attack <${ATTACKS.join('|')}>`);
    process.exit(2);
  }
  const apiUrl = args.url.replace(/\/$/, '');
  const token = async () => {
    if (!args.key) throw new Error(`--attack ${attack} needs --key`);
    const res = await fetch(`${apiUrl}/rooms/${args.room}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: args.key }),
    });
    if (!res.ok) throw new Error(`token request answered ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };
  const evil = await EvilClient.connect(apiUrl.replace(/^http/, 'ws'), args.room);
  switch (attack) {
    case 'no-hello':
      break;
    case 'pre-welcome':
      evil.send(sync1Frame(evil.doc));
      break;
    case 'old-protocol':
      evil.hello(await token(), { protocol: 0 });
      break;
    case 'bad-stroke':
      await evil.join(await token());
      evil.update((doc) => putObject(doc, 'evil00000001', strokeFields({ colour: 'red' })));
      break;
    case 'unknown-root':
      await evil.join(await token());
      evil.update((doc) => doc.getMap('evil').set('x', 1));
      break;
    case 'viewer-update':
      await evil.join(await token());
      evil.update((doc) => putObject(doc, 'evil00000002', strokeFields()));
      break;
    case 'flood': {
      await evil.join(await token());
      const timer = setInterval(() => {
        for (let i = 0; i < 50; i++) evil.update((doc) => doc.getMap('meta').set('n', i));
      }, 50);
      void evil.closed.then(() => clearInterval(timer));
      break;
    }
  }
  const closed = await evil.closed;
  const name = Object.entries(CloseCode).find(([, code]) => code === closed.code)?.[0] ?? '?';
  console.log(
    `closed ${closed.code} (${name}) ${closed.reason}; errors: ${evil.errors().join(', ') || 'none'}`,
  );
}

// Run as a script, not when the tests import it.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
