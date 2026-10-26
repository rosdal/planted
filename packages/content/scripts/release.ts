/**
 * `pnpm content:release [--dir <built>] [--cors <origin,…>]`: uploads a built content version to
 * the R2 bucket. Run by .github/workflows/content-release.yml on a `content-v*` tag, after
 * `content:check` and `content:build`.
 *
 * Order matters, so nobody ever sees a half-uploaded release: every hashed file first, then
 * `<version>/manifest.json`, then `latest.json` last. Nothing is ever deleted: rooms keep pointing
 * at the version they were created with. A version that is already in the bucket is refused
 * rather than overwritten, since its files are cached as immutable.
 *
 * Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY; R2_BUCKET defaults to
 * planted-content. `--cors` (re)sets the bucket's CORS rule to allow GETs from those origins.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  HeadObjectCommand,
  NotFound,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { contentVersion, DIST_DIR, readConfig } from './lib/repo';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const LATEST = 'public, max-age=60';
const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const { values } = parseArgs({ options: { dir: { type: 'string' }, cors: { type: 'string' } } });
const dir = values.dir ? resolve(values.dir) : DIST_DIR;

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return value;
}

const accountId = env('R2_ACCOUNT_ID');
const bucket = process.env.R2_BUCKET || 'planted-content';
const s3 = new S3Client({
  // R2 has no regions, but the SDK refuses to sign without one.
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
  },
});

if (values.cors) {
  const origins = values.cors
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ['GET', 'HEAD'],
            AllowedHeaders: ['*'],
            MaxAgeSeconds: 86400,
          },
        ],
      },
    }),
  );
  console.log(`CORS on ${bucket} now allows GET from ${origins.join(', ')}`);
}

const version = contentVersion(await readConfig());
const tag = process.env.GITHUB_REF_NAME;
if (tag && tag !== `content-v${version}`) {
  console.error(
    `Tag ${tag} doesn't match content.json, which builds ${version} (content-v${version})`,
  );
  process.exit(1);
}

const versionDir = join(dir, version);
const files = (await walk(versionDir)).map((f) => relative(versionDir, f).replaceAll('\\', '/'));
if (!files.includes('manifest.json')) {
  console.error(`${versionDir} has no manifest.json; run pnpm content:build first`);
  process.exit(1);
}

if (await exists(`${version}/manifest.json`)) {
  console.error(`${version} is already released; bump "build" in content.json for a new version`);
  process.exit(1);
}

const put = async (key: string, body: Buffer, cacheControl: string) => {
  const ext = key.slice(key.lastIndexOf('.'));
  const contentType = TYPES[ext];
  if (!contentType) throw new Error(`no content type for ${key}`);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    }),
  );
};

const hashed = files.filter((f) => f !== 'manifest.json');
// A handful at a time: plenty for ~30 files without tripping rate limits.
for (let i = 0; i < hashed.length; i += 8) {
  await Promise.all(
    hashed
      .slice(i, i + 8)
      .map(async (f) => put(`${version}/${f}`, await readFile(join(versionDir, f)), IMMUTABLE)),
  );
}
console.log(`Uploaded ${hashed.length} files to ${bucket}/${version}/`);
await put(`${version}/manifest.json`, await readFile(join(versionDir, 'manifest.json')), IMMUTABLE);
await put('latest.json', Buffer.from(`${JSON.stringify({ version })}\n`), LATEST);
console.log(`Released ${version}: latest.json now points at it.`);

async function walk(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(path, e.name)) : [join(path, e.name)])),
  );
  return nested.flat().sort();
}

async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') return false;
    throw err;
  }
}
