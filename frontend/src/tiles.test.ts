import { expect, it } from 'vitest';
import { OSM_MAX_ZOOM, reportTileError } from './tiles';

it('caps OpenStreetMap at the deepest zoom it serves', () => {
  expect(OSM_MAX_ZOOM).toBe(19);
});

it('retries transient tile failures and reports only repeated ones', () => {
  const first = { timesRetried: 0, retry: false };
  expect(reportTileError(first)).toBe(false);
  expect(first.retry).toBe(true);
  const last = { timesRetried: 2, retry: false };
  expect(reportTileError(last)).toBe(true);
  expect(last.retry).toBe(false);
});
