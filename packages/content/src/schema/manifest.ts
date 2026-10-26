import { z } from 'zod';
import { ContentVersion, SeasonTag, Slug } from './common';

/** `content.json`: what the next build is called and which maps it ships. */
export const ContentConfig = z.strictObject({
  season: SeasonTag,
  build: z.number().int().positive(),
  /** Maps in this release, in picker order; each has a `maps/<id>/` folder. */
  maps: z.array(Slug).min(1),
  /** Listed greyed out in the picker as "coming soon". Plain text names only. */
  upcoming: z.array(z.strictObject({ id: Slug, name: z.string().min(1) })),
});
export type ContentConfig = z.infer<typeof ContentConfig>;

export const ManifestMap = z.strictObject({
  id: Slug,
  name: z.string().min(1),
  /** Logical names; look them up in `files`. */
  map: z.string(),
  thumb: z.string(),
  floors: z.array(z.strictObject({ id: Slug, label: z.string(), art: z.string() })),
});
export type ManifestMap = z.infer<typeof ManifestMap>;

/** `<version>/manifest.json`: every file in a release, by logical name. */
export const Manifest = z.strictObject({
  version: ContentVersion,
  builtAt: z.iso.datetime(),
  maps: z.array(ManifestMap),
  upcoming: z.array(z.strictObject({ id: Slug, name: z.string() })),
  /** Logical name (`maps/bank/map.json`) → hashed path relative to the version folder. */
  files: z.record(z.string(), z.string()),
});
export type Manifest = z.infer<typeof Manifest>;

/** `latest.json` at the bucket root; the only file that isn't immutable. */
export const Latest = z.strictObject({ version: ContentVersion });
export type Latest = z.infer<typeof Latest>;
