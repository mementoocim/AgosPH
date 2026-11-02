import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApp } from '../store';
import { request } from '../api';
import { LayersPanel, SimulationPanel } from './AnalysisPanels';
import { AlertCenter } from './AlertCenter';
import { InspectionPanel } from './InspectionPanel';
import { Timeline } from './Timeline';
import type { AlertRecord, Dataset, Inspection, Scenario } from '../types';
vi.mock('./Chart', () => ({ Chart: () => null }));
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api');
  return { ...actual, request: vi.fn() };
});
const scenario: Scenario = {
  id: 'a',
  name: 'Scenario A',
  description: 'Explicit synthetic test data',
  mode: 'demonstration',
  status: 'illustrative',
  source: 'Test fixture',
  model: 'Synthetic arrays',
  model_version: '',
  validation_notes: '',
  assumptions: {},
  settings: {},
  frames: [{ timestamp: '2026-01-01T00:00:00Z', depth: 'd' }],
  updated_at: '2026-01-01',
  time_step_seconds: null,
  crs: 'EPSG:4326',
  bounds: [121, 17, 122, 18],
  format_validation: 'aligned',
  validation_label: 'illustrative',
};
beforeEach(() => {
  useApp.setState(useApp.getInitialState(), true);
  vi.clearAllMocks();
});
it('loads a selected scenario through an operational selector', () => {
  useApp.setState({
    scenarios: [scenario, { ...scenario, id: 'b', name: 'Scenario B' }],
    scenarioId: 'a',
  });
  render(<SimulationPanel />);
  fireEvent.change(screen.getByLabelText('Simulation scenario'), { target: { value: 'b' } });
  expect(useApp.getState().scenarioId).toBe('b');
});
it('disables missing velocity and WSE rather than fabricating output', () => {
  useApp.setState({ scenarios: [scenario], scenarioId: 'a' });
  render(<SimulationPanel />);
  expect(
    screen.getByRole('option', { name: 'Water surface elevation · unavailable' }),
  ).toBeDisabled();
  expect(screen.getByRole('option', { name: 'Velocity · unavailable' })).toBeDisabled();
});
it('changes visualization metric and opacity', () => {
  useApp.setState({ scenarios: [scenario], scenarioId: 'a' });
  render(<SimulationPanel />);
  fireEvent.change(screen.getByLabelText('Visualized variable'), { target: { value: 'maximum' } });
  fireEvent.change(screen.getByLabelText('Flood surface opacity'), { target: { value: '.4' } });
  expect(useApp.getState().metric).toBe('maximum');
  expect(useApp.getState().settings.opacity).toBe(0.4);
});
it('validates scenario comparison before opening the second map', async () => {
  useApp.setState({
    scenarios: [scenario, { ...scenario, id: 'b', name: 'Scenario B' }],
    scenarioId: 'a',
    comparisonId: 'b',
  });
  vi.mocked(request).mockResolvedValue({ compatible: true, reason: 'Aligned test grids' });
  render(<SimulationPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Compare side by side' }));
  await waitFor(() => expect(useApp.getState().comparison).toBe(true));
  expect(request).toHaveBeenCalledWith('/compare?first=a&second=b');
});
it('keeps missing geographic layers visibly unavailable', () => {
  render(<LayersPanel />);
  expect(screen.getByLabelText(/Barangay boundaries/)).toBeDisabled();
  expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
});
it('persists an available layer visibility change', async () => {
  useApp.setState({
    datasets: [
      {
        id: 'r',
        name: 'Test river geometry',
        mode: 'demonstration',
        kind: 'vector',
        role: 'rivers',
      } as Dataset,
    ],
  });
  vi.mocked(request).mockImplementation(async (_path, init) => JSON.parse(init!.body as string));
  render(<LayersPanel />);
  fireEvent.click(screen.getByRole('checkbox', { name: /rivers/i }));
  await waitFor(() => expect(useApp.getState().settings.layers.rivers.visible).toBe(false));
});
it('acknowledges local test alerts and retains explicit test labels', async () => {
  const alert: AlertRecord = {
    id: 'alert',
    station_id: 'test-a',
    station_name: 'Test A',
    severity: 'watch',
    status: 'active',
    mode: 'demonstration',
    label: 'TEST · DEMONSTRATION',
    message: 'Local threshold test',
    water_level_m: 2.2,
    measurement_timestamp: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    source: 'Test fixture',
  };
  useApp.setState({ alerts: [alert], refresh: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(request).mockResolvedValue({ ...alert, status: 'acknowledged' });
  render(<AlertCenter open onOpenChange={() => {}} />);
  expect(screen.getByText('TEST · DEMONSTRATION')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/alerts/alert',
      expect.objectContaining({ method: 'PATCH', body: '{"status":"acknowledged"}' }),
    ),
  );
});
it('offers imported reference layers in demonstration mode', () => {
  useApp.setState({
    mode: 'demonstration',
    datasets: [
      { id: 'r', name: 'OSM rivers', mode: 'imported', kind: 'vector', role: 'rivers' } as Dataset,
    ],
  });
  render(<LayersPanel />);
  expect(screen.getByRole('checkbox', { name: /rivers/i })).toBeEnabled();
});
it('generates exercise alerts for the active data mode', async () => {
  useApp.setState({ mode: 'imported', refresh: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(request).mockResolvedValue({});
  render(<AlertCenter open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Generate test alert' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/alerts/test',
      expect.objectContaining({ method: 'POST', body: '{"mode":"imported"}' }),
    ),
  );
});
const inspection: Inspection = {
  longitude: 121.9,
  latitude: 17.1,
  timestamp: '2026-01-15T02:00:00Z',
  scenario: 'Terrain demonstration',
  mode: 'demonstration',
  source: 'Test fixture',
  validation_status: 'illustrative',
  inside_model: true,
  values: { depth: 1.2, velocity: 0.4, direction: 180, wse: null },
  arrival_minutes: 90,
  peak_depth_m: 2.4,
  peak_timestamp: '2026-01-15T04:00:00Z',
};
it('reports arrival time and peak depth for a modeled location', () => {
  useApp.setState({ inspection });
  render(<InspectionPanel />);
  expect(screen.getByText('1 h 30 min')).toBeVisible();
  expect(screen.getByText('2.40 m')).toBeVisible();
});
it('labels locations outside the model instead of calling them test cells', () => {
  useApp.setState({
    inspection: {
      ...inspection,
      inside_model: false,
      values: { depth: null, velocity: null, direction: null, wse: null },
      arrival_minutes: null,
      peak_depth_m: null,
    },
  });
  render(<InspectionPanel />);
  expect(screen.getByText('OUTSIDE MODEL')).toBeVisible();
  expect(screen.queryByText('SYNTHETIC TEST CELL')).toBeNull();
});
it('labels timeline frames with dates when a scenario spans several days', () => {
  const frames = ['2026-01-15T00:00:00Z', '2026-01-15T12:00:00Z', '2026-01-16T00:00:00Z'].map(
    (timestamp) => ({ timestamp, depth: 'd' }),
  );
  const multiDay = { ...scenario, frames };
  useApp.setState({ scenarios: [multiDay], scenarioId: 'a' });
  render(<Timeline scenario={multiDay} />);
  expect(screen.getByRole('option', { name: 'Frame 1 · Jan 15 08:00' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Frame 3 · Jan 16 08:00' })).toBeInTheDocument();
});
