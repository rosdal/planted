import { TEST_FLOOR } from '@planted/schema';
import type { LoadedMap } from './loader';

/**
 * Rooms created before 0.5 have no map: they get the fictional 0.3 test floor, under the one
 * floor id the server accepts for them. No rooms, walls or callouts.
 */
export const LEGACY_MAP: LoadedMap = {
  version: 'legacy',
  map: {
    id: 'legacy',
    name: 'Test floor',
    contentRev: 'legacy',
    floors: [{ id: TEST_FLOOR, label: 'Test', order: 1, art: 'test-floor.svg' }],
    sites: [],
    rooms: [],
    walls: [],
    hatches: [],
    openings: [],
    spawns: [],
  },
  floorArt: { [TEST_FLOOR]: '/dev/test-floor.svg' },
  iconAtlas: null,
};
