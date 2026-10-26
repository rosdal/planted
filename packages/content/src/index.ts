import config from '../content.json';
import { MAPS } from './maps.gen';
import { ContentConfig } from './schema';

export { MAPS, type MapSummary } from './maps.gen';
export * from './schema';

const parsed = ContentConfig.parse(config);

/**
 * The content version this build of the app was made with, e.g. `y11s3.1`. New rooms pin it;
 * existing rooms keep the version they were created with.
 */
export const CONTENT_VERSION = `${parsed.season}.${parsed.build}`;

/** Map ids in the current content version, in picker order. */
export const MAP_IDS: readonly string[] = parsed.maps;

/** Floor ids of a map in the current content version, bottom to top; undefined if unknown. */
export function floorIds(mapId: string): readonly string[] | undefined {
  return MAPS.find((m) => m.id === mapId)?.floors.map((f) => f.id);
}
