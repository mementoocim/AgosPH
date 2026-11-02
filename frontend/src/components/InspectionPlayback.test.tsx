import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApp } from '../store';
import { request } from '../api';
import { InspectionPanel } from './InspectionPanel';
import { Timeline } from './Timeline';
import type { Inspection, Scenario } from '../types';
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api');
  return { ...actual, request: vi.fn() };
});
const frames = ['2026-01-15T00:00:00Z', '2026-01-15T02:00:00Z', '2026-01-15T04:00:00Z'].map(
  (timestamp, i) => ({ timestamp, depth: `d${i}` }),
);
const scenario = {
  id: 'terrain',
  name: 'Terrain demonstration',
  mode: 'demonstration',
  status: 'illustrative',
  frames,
  settings: {},
  assumptions: {},
} as unknown as Scenario;
const at = (frame: number, depth: number): Inspection => ({
  longitude: 121.91,
  latitude: 17.11,
  timestamp: frames[frame].timestamp,
  scenario: 'Terrain demonstration',
  mode: 'demonstration',
  source: 'Test fixture',
  validation_status: 'illustrative',
  inside_model: true,
  values: { depth, velocity: 0.4, direction: 299, wse: null },
  arrival_minutes: 0,
  peak_depth_m: 7.5,
  peak_timestamp: frames[2].timestamp,
});
beforeEach(() => {
  useApp.setState(useApp.getInitialState(), true);
  vi.clearAllMocks();
  useApp.setState({ scenarios: [scenario], scenarioId: 'terrain', frame: 0 });
});

it('keeps the inspected location open while playback steps frames', () => {
  const inspection = at(0, 1.24);
  useApp.setState({ inspection });
  useApp.getState().step(1);
  expect(useApp.getState().inspection).toBe(inspection);
});

it('keeps the inspected location when a frame is picked on the timeline', () => {
  const inspection = at(0, 1.24);
  useApp.setState({ inspection });
  render(<Timeline scenario={scenario} />);
  fireEvent.change(screen.getByLabelText('Select simulation time step'), {
    target: { value: '2' },
  });
  expect(useApp.getState().frame).toBe(2);
  expect(useApp.getState().inspection).toBe(inspection);
});

it('re-reads the same location for each new frame and marks values while updating', async () => {
  useApp.setState({ inspection: { ...at(0, 1.24), elevation: 29 } });
  let resolve: (value: Inspection) => void = () => {};
  vi.mocked(request).mockReturnValue(new Promise((r) => (resolve = r)));
  render(<InspectionPanel />);
  act(() => useApp.setState({ frame: 1 }));
  expect(await screen.findByText(/Updating/)).toBeVisible();
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/scenarios/terrain/inspect?frame=1&longitude=121.91&latitude=17.11',
      expect.anything(),
    ),
  );
  await act(async () => resolve(at(1, 2.5)));
  expect(await screen.findByText('2.50 m')).toBeVisible();
  expect(screen.queryByText(/Updating/)).toBeNull();
  expect(useApp.getState().inspection?.elevation).toBe(29);
});
