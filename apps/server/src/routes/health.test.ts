import { createDb } from '@planted/db';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { makeTestApp, testEnv } from '../test/helpers';

describe('GET /health', () => {
  it('returns 200 with the database up', async () => {
    const t = await makeTestApp();
    try {
      const res = await t.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, db: 'up' });
    } finally {
      await t.close();
    }
  });

  it('returns 503 when the database is unreachable', async () => {
    // Port 1 is never a Postgres server, so every connection attempt is refused.
    const { db, close } = createDb('postgres://planted:planted@127.0.0.1:1/planted');
    const app = await buildApp({ db, env: testEnv });
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ok: false, db: 'down' });
    } finally {
      await app.close();
      await close();
    }
  });
});
