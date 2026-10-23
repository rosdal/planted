import { createDb } from '@planted/db';
import closeWithGrace from 'close-with-grace';
import { buildApp } from './app';
import { loadEnv } from './env';

const env = loadEnv();
const { db, close: closeDb } = createDb(env.DATABASE_URL);
const app = await buildApp({ db, env });

closeWithGrace({ delay: 10_000 }, async ({ signal, err }) => {
  if (err) app.log.error({ err }, 'shutting down after an error');
  else app.log.info({ signal }, 'shutting down');
  await app.close();
  app.log.info('http server closed');
  await closeDb();
  app.log.info('database pool closed');
});

await app.listen({ port: env.SERVER_PORT, host: env.SERVER_HOST });
