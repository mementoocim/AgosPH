/** OpenStreetMap serves zoom 0–19; closer views reuse (overzoom) zoom 19 tiles. */
export const OSM_MAX_ZOOM = 19;
const RETRIES = 2;

/**
 * Cesium tile error policy: retry a failed tile a couple of times, and report it to the
 * operator only when the retries are exhausted. Returns true when the failure should be shown.
 */
export function reportTileError(error: { timesRetried: number; retry: boolean }) {
  error.retry = error.timesRetried < RETRIES;
  return !error.retry;
}
