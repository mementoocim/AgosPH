import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from './store';
import { request } from './api';
import type { Scenario } from './types';
vi.mock('./api', () => ({
  request: vi.fn(),
  json: (method: string, body: unknown) => ({ method, body: JSON.stringify(body) }),
}));
export const demo: Scenario = {
  id: 'demo',
  name: 'Test playback',
  description: 'Synthetic test arrays',
  source: 'TEST FIXTURE',
  mode: 'demonstration',
  status: 'illustrative',
  model: 'No hydraulic model',
  model_version: '',
  validation_notes: '',
  assumptions: {},
  settings: {},
  frames: [
    { timestamp: '2026-01-01T00:00:00Z', depth: 'd1', velocity: 'v1' },
    { timestamp: '2026-01-01T00:30:00Z', depth: 'd2', velocity: 'v2' },
    { timestamp: '2026-01-01T01:00:00Z', depth: 'd3', velocity: 'v3' },
  ],
  updated_at: '2026-01-01T00:00:00Z',
  time_step_seconds: 1800,
  crs: 'EPSG:4326',
  bounds: [121, 17, 122, 18],
  format_validation: 'aligned',
  validation_label: 'illustrative',
};
beforeEach(() => {
  useApp.setState(useApp.getInitialState(), true);
  vi.clearAllMocks();
});
describe('local application state', () => {
  it('steps through supplied frames and clamps at both ends', () => {
    useApp.setState({ scenarios: [demo], scenarioId: 'demo', frame: 1 });
    useApp.getState().step(1);
    expect(useApp.getState().frame).toBe(2);
    useApp.getState().step(4);
    expect(useApp.getState().frame).toBe(2);
    useApp.getState().step(-8);
    expect(useApp.getState().frame).toBe(0);
  });
  it('resets timeline and comparison on scenario selection', () => {
    const second = { ...demo, id: 'second' };
    useApp.setState({ scenarios: [demo, second], frame: 2, playing: true, comparison: true });
    useApp.getState().selectScenario('second');
    expect(useApp.getState()).toMatchObject({
      scenarioId: 'second',
      frame: 0,
      playing: false,
      comparison: false,
    });
  });
  it('never substitutes demo results in imported-data mode', () => {
    useApp.setState({ scenarios: [demo], scenarioId: 'demo', monitoringPlaying: true });
    useApp.getState().changeMode('imported');
    expect(useApp.getState()).toMatchObject({
      mode: 'imported',
      scenarioId: '',
      monitoring: null,
      monitoringPlaying: false,
    });
  });
  it('surfaces backend failure without fake fallback data', async () => {
    vi.mocked(request).mockRejectedValue(new Error('Disconnected test service'));
    await useApp.getState().bootstrap();
    expect(useApp.getState()).toMatchObject({
      online: false,
      loading: false,
      error: 'Disconnected test service',
      scenarios: [],
    });
  });
  it('loads monitoring for the saved data mode instead of the default mode', async () => {
    vi.mocked(request).mockImplementation(async (path: string) => {
      if (path === '/settings') return { data_mode: 'imported' };
      if (path.startsWith('/monitoring'))
        return { mode: path.includes('imported') ? 'imported' : 'demonstration', stations: [] };
      return [];
    });
    await useApp.getState().bootstrap();
    const paths = vi.mocked(request).mock.calls.map(([path]) => path);
    expect(paths).toContain('/monitoring?mode=imported');
    expect(paths).not.toContain('/monitoring?mode=demonstration');
    expect(useApp.getState()).toMatchObject({ mode: 'imported', monitoring: { mode: 'imported' } });
  });
  it('coalesces concurrent bootstrap calls into one set of requests', async () => {
    vi.mocked(request).mockImplementation(async (path: string) =>
      path === '/settings' ? {} : path.startsWith('/monitoring') ? { stations: [] } : [],
    );
    await Promise.all([useApp.getState().bootstrap(), useApp.getState().bootstrap()]);
    expect(vi.mocked(request).mock.calls.filter(([path]) => path === '/settings')).toHaveLength(1);
  });
  it('opens the featured demonstration when switching to demo mode', () => {
    vi.mocked(request).mockResolvedValue({});
    const featured = { ...demo, id: 'terrain', settings: { featured: true } };
    useApp.setState({ scenarios: [demo, featured], mode: 'imported', scenarioId: '' });
    useApp.getState().changeMode('demonstration');
    expect(useApp.getState().scenarioId).toBe('terrain');
  });
  it('saves settings through the filesystem service contract', async () => {
    vi.mocked(request).mockImplementation(async (_path, init) => JSON.parse(init!.body as string));
    await useApp.getState().saveSettings({ opacity: 0.35 });
    expect(request).toHaveBeenCalledWith('/settings', expect.objectContaining({ method: 'PUT' }));
    expect(useApp.getState().settings.opacity).toBe(0.35);
  });
});
