import { afterEach, expect, it, vi } from 'vitest';
import { axisLabels, duration, request } from './api';
it('labels chart axes with dates only when a series spans several days', () => {
  expect(axisLabels(['2026-01-15T00:00:00Z', '2026-01-15T00:30:00Z'])).toEqual(['08:00', '08:30']);
  expect(axisLabels(['2025-11-01T00:00:00Z', '2025-11-02T00:00:00Z'])).toEqual([
    'Nov 01 08:00',
    'Nov 02 08:00',
  ]);
});
it('formats elapsed minutes for arrival times', () => {
  expect(duration(0)).toBe('At start');
  expect(duration(45)).toBe('45 min');
  expect(duration(90)).toBe('1 h 30 min');
  expect(duration(null)).toBe('Not reached');
});
afterEach(() => vi.unstubAllGlobals());
it('returns parsed data from a successful local API call', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"status":"ok"}')));
  expect(await request('/health')).toEqual({ status: 'ok' });
});
it('propagates dataset validation error details', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('{"detail":"Raster CRS is missing"}', { status: 422 })),
  );
  await expect(request('/datasets')).rejects.toThrow('Raster CRS is missing');
});
it('provides actionable information for a disconnected service', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
  await expect(request('/scenarios')).rejects.toThrow('Start the FastAPI backend');
});
