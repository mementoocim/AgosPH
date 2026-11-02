import { duration, time } from './api';
import type { Freshness, LiveTelemetry, Reading, Station } from './types';

export type ReadingLabel = 'LIVE' | 'STALE' | 'UNAVAILABLE' | 'REPLAY' | 'DEMO';

/** Selection key: live and replay data for the same station id stay distinct. */
export const stationKey = (station: Station) =>
  station.data_class === 'live' ? `live:${station.id}` : station.id;

/**
 * Freshness of a live station, aged by the browser time elapsed since its snapshot arrived so
 * that LIVE never outlasts a frozen backend. Null for replay and demonstration stations.
 */
export function freshness(
  station: Station,
  live: LiveTelemetry | undefined,
  elapsedSeconds = 0,
): Freshness | null {
  if (station.data_class !== 'live') return null;
  if (!live || station.age_seconds == null || !station.freshness || station.freshness === 'unavailable')
    return 'unavailable';
  const age = station.age_seconds + Math.max(0, elapsedSeconds);
  if (age > live.unavailable_after_minutes * 60) return 'unavailable';
  return station.freshness === 'stale' || age > live.stale_after_minutes * 60 ? 'stale' : 'live';
}

const tones: Record<ReadingLabel, string> = {
  LIVE: 'green',
  STALE: 'stale',
  UNAVAILABLE: 'neutral',
  REPLAY: 'cyan',
  DEMO: 'orange',
};
export function readingBadge(station: Station, live: LiveTelemetry | undefined, elapsedSeconds = 0) {
  const state = freshness(station, live, elapsedSeconds);
  const label: ReadingLabel = state
    ? (state.toUpperCase() as ReadingLabel)
    : station.data_class === 'replay'
      ? 'REPLAY'
      : 'DEMO';
  return { label, tone: tones[label] };
}

export function ago(seconds: number) {
  return seconds < 60 ? 'under 1 min ago' : `${duration(Math.floor(seconds / 60))} ago`;
}

/** Time context for a station row: receipt time for live readings, measurement time for replay. */
export function readingTime(station: Station, elapsedSeconds = 0) {
  if (station.data_class === 'live')
    return `Received ${time(station.received_at)} PHT · observed ${ago((station.age_seconds ?? 0) + Math.max(0, elapsedSeconds))}`;
  return station.latest ? `Reading ${time(station.latest.timestamp)} PHT` : 'No reading at the replay cursor';
}

/** mm/h per row: a declared accumulation interval wins over the spacing between rows. */
export function intensity(rows: Reading[]) {
  return rows.map((r, index) => {
    if (r.rainfall_mm == null) return null;
    if (r.rainfall_interval_minutes) return r.rainfall_mm / (r.rainfall_interval_minutes / 60);
    const prev = rows[index - 1] ?? rows[index + 1];
    const hours = prev
      ? Math.abs(new Date(r.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 3600000
      : 0;
    return hours ? r.rainfall_mm / hours : null;
  });
}
