import { describe, expect, it } from 'vitest';
import { ago, freshness, intensity, readingBadge, stationKey } from './readings';
import type { LiveTelemetry, Reading, Station } from './types';

const live: LiveTelemetry = {
  ingest: { enabled: true, endpoint: '/api/monitoring/ingest', detail: 'Accepting authorized readings (bearer token).' },
  stale_after_minutes: 30,
  unavailable_after_minutes: 360,
  evaluated_at: '2026-11-01T12:00:00+00:00',
  stations: [],
};
const reading: Reading = {
  timestamp: '2026-11-01T11:59:00+00:00',
  station_id: 'gauge-1',
  name: 'Artificial gauge',
  water_level_m: 1.25,
  source: 'Test fixture',
  received_at: '2026-11-01T11:59:05+00:00',
  channel: 'POST /api/monitoring/ingest',
};
const station = (fields: Partial<Station> = {}): Station => ({
  id: 'gauge-1',
  name: 'Artificial gauge',
  data_class: 'live',
  freshness: 'live',
  received_at: reading.received_at,
  age_seconds: 60,
  latest: reading,
  thresholds: null,
  connected: true,
  severity: 'unavailable',
  history: [reading],
  longitude: null,
  latitude: null,
  source: 'Test fixture',
  ...fields,
});

describe('reading classes', () => {
  it('labels only fresh ingested readings LIVE', () => {
    expect(readingBadge(station(), live).label).toBe('LIVE');
    expect(readingBadge(station({ freshness: 'stale', age_seconds: 2400 }), live).label).toBe('STALE');
    expect(readingBadge(station({ freshness: 'unavailable', age_seconds: 30000 }), live).label).toBe(
      'UNAVAILABLE',
    );
    expect(readingBadge(station({ data_class: 'replay' }), live).label).toBe('REPLAY');
    expect(readingBadge(station({ data_class: 'demonstration' }), live).label).toBe('DEMO');
  });
  it('keeps ageing a live reading after its snapshot arrived', () => {
    const fresh = station({ age_seconds: 1700 });
    expect(freshness(fresh, live, 0)).toBe('live');
    expect(freshness(fresh, live, 101)).toBe('stale');
    expect(freshness(fresh, live, 360 * 60)).toBe('unavailable');
    expect(freshness(station({ freshness: 'stale', age_seconds: 1900 }), live, -500)).toBe('stale');
  });
  it('never reports LIVE without the live telemetry settings', () => {
    expect(freshness(station(), undefined, 0)).toBe('unavailable');
    expect(freshness(station({ data_class: 'replay' }), live, 0)).toBeNull();
  });
  it('keeps live and replay data for one station id apart', () => {
    expect(stationKey(station())).not.toBe(stationKey(station({ data_class: 'replay' })));
    expect(stationKey(station({ data_class: 'replay' }))).toBe('gauge-1');
  });
  it('describes observation age', () => {
    expect(ago(30)).toBe('under 1 min ago');
    expect(ago(125 * 60)).toBe('2 h 5 min ago');
  });
  it('derives intensity from the declared interval before row spacing', () => {
    const rows = [
      { ...reading, rainfall_mm: 3, rainfall_interval_minutes: 15 },
      { ...reading, timestamp: '2026-11-01T12:59:00+00:00', rainfall_mm: 2 },
      { ...reading, timestamp: '2026-11-01T13:59:00+00:00' },
    ];
    expect(intensity(rows)).toEqual([12, 2, null]);
  });
});
