import { afterEach, expect, it, vi } from 'vitest';
import { fromPhtInput, incidentMarkers, toPhtInput } from './incidents';
import type { Incident } from './types';
const exercise: Incident = {
  id: 'inc-1',
  label: 'EXERCISE · DEMONSTRATION MODE',
  mode: 'demonstration',
  status: 'reported',
  type: 'flooding',
  severity: 'high',
  title: 'Knee-deep water at the school',
  barangay: 'Alibagu',
  barangay_validated: true,
  longitude: 121.89,
  latitude: 17.13,
  reporter: 'Test radio report',
  description: 'Test fixture',
  reported_at: '2026-01-15T06:05:00+00:00',
  history: [{ status: 'reported', at: '2026-01-15T06:06:00+00:00' }],
  created_at: '2026-01-15T06:06:00+00:00',
  updated_at: '2026-01-15T06:06:00+00:00',
};
afterEach(() => vi.unstubAllEnvs());
it('reads and writes report times in Philippine Standard Time whatever the browser zone', () => {
  vi.stubEnv('TZ', 'America/New_York');
  expect(new Date('2026-01-15T12:00:00Z').getHours()).toBe(7);
  expect(toPhtInput('2026-01-15T01:30:00Z')).toBe('2026-01-15T09:30');
  expect(toPhtInput('2026-01-15T23:30:00+08:00')).toBe('2026-01-15T23:30');
  expect(fromPhtInput('2026-01-15T09:30')).toBe('2026-01-15T09:30:00+08:00');
});
it('marks only located incidents of the active mode, in palette colors, resolved ones gray', () => {
  const markers = incidentMarkers(
    [
      exercise,
      { ...exercise, id: 'unlocated', longitude: null, latitude: null },
      { ...exercise, id: 'operator', mode: 'imported', label: 'OPERATOR LOG · USER-ENTERED' },
      { ...exercise, id: 'done', status: 'resolved', severity: 'critical' },
      { ...exercise, id: 'urgent', severity: 'critical' },
    ],
    'demonstration',
  );
  expect(markers.map((m) => [m.id, m.color, m.caption])).toEqual([
    ['inc-1', '#f0a85a', 'EXERCISE'],
    ['done', '#8897a3', 'EXERCISE'],
    ['urgent', '#ef6a5b', 'EXERCISE'],
  ]);
  const imported = incidentMarkers([{ ...exercise, mode: 'imported' }], 'imported');
  expect(imported[0].caption).toBe('');
});
