import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useApp } from '../store';
import { request } from '../api';
import { MonitoringPanel, RainfallPanel, StationTrend } from './MonitoringPanel';
import { AlertCenter } from './AlertCenter';
import { CommandPanel } from '../App';
import type { AlertRecord, LiveTelemetry, Monitoring, Reading, Station } from '../types';
vi.mock('./Chart', () => ({ Chart: () => null }));
vi.mock('./GeoMap', () => ({ GeoMap: () => null }));
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api');
  return { ...actual, request: vi.fn() };
});

const demoReading: Reading = {
  timestamp: '2026-01-15T00:00:00+00:00',
  station_id: 'test-a',
  name: 'Test sensor A',
  water_level_m: 1.1,
  rainfall_mm: 1,
  source: 'DEMONSTRATION DATA · deterministic replay fixture; station has no geographic location',
};
const demo: Station = {
  id: 'test-a',
  name: 'Test sensor A',
  data_class: 'demonstration',
  latest: demoReading,
  thresholds: { watch: 2, warning: 3, critical: 4 },
  connected: true,
  severity: 'normal',
  history: [demoReading],
  longitude: null,
  latitude: null,
  source: demoReading.source,
};
const gaugeReading: Reading = {
  timestamp: '2026-11-01T12:04:00+00:00',
  station_id: 'bridge-gauge',
  name: 'Bridge gauge',
  water_level_m: 2.41,
  source: 'CDRRMO test gauge · gauge-zero datum',
  received_at: '2026-11-01T12:05:00+00:00',
  channel: 'POST /api/monitoring/ingest',
  units: { water_level: 'm' },
};
const gauge: Station = {
  id: 'bridge-gauge',
  name: 'Bridge gauge',
  data_class: 'live',
  freshness: 'live',
  received_at: gaugeReading.received_at,
  age_seconds: 120,
  latest: gaugeReading,
  thresholds: null,
  connected: true,
  severity: 'unavailable',
  history: [gaugeReading],
  longitude: null,
  latitude: null,
  source: gaugeReading.source,
};
const rainReadings: Reading[] = ['11:45', '12:00'].map((clock, index) => ({
  timestamp: `2026-11-01T${clock}:00+00:00`,
  station_id: 'rain-gauge',
  name: 'Rain gauge',
  rainfall_mm: [3, 2][index],
  rainfall_interval_minutes: 15,
  source: 'CDRRMO test rain gauge',
  received_at: `2026-11-01T${clock}:30+00:00`,
  channel: 'POST /api/monitoring/ingest',
}));
const rainGauge: Station = {
  ...gauge,
  id: 'rain-gauge',
  name: 'Rain gauge',
  latest: rainReadings[1],
  received_at: rainReadings[1].received_at,
  age_seconds: 360,
  history: rainReadings,
  source: 'CDRRMO test rain gauge',
};
const liveBlock = (stations: Station[], enabled = true): LiveTelemetry => ({
  ingest: {
    enabled,
    endpoint: '/api/monitoring/ingest',
    detail: enabled
      ? 'Accepting authorized readings (bearer token).'
      : 'Live ingestion is disabled: set AGOS_INGEST_TOKEN for the backend process to accept authorized sensor readings.',
  },
  stale_after_minutes: 30,
  unavailable_after_minutes: 360,
  evaluated_at: '2026-11-01T12:06:00+00:00',
  stations,
});
const snapshot = (fields: Partial<Monitoring> = {}): Monitoring => ({
  mode: 'demonstration',
  label: 'DEMONSTRATION DATA',
  index: 0,
  steps: 12,
  timestamp: demoReading.timestamp,
  stations: [demo],
  rainfall_scenario: 'steady',
  updated_at: '2026-11-01T12:06:00+00:00',
  live: liveBlock([gauge]),
  adapters: [
    {
      name: 'Authorized sensor push',
      transport: 'push',
      enabled: true,
      detail: 'Accepting authorized readings at POST /api/monitoring/ingest (bearer token).',
    },
    {
      name: 'PAGASA',
      transport: 'pull',
      enabled: false,
      detail: 'Disabled. Requires an authorized endpoint and credentials issued by PAGASA.',
    },
  ],
  ...fields,
});
const alert = (fields: Partial<AlertRecord>): AlertRecord => ({
  id: 'alert-test',
  station_id: 'test-a',
  station_name: 'Test sensor A',
  severity: 'watch',
  status: 'active',
  mode: 'demonstration',
  label: 'TEST · DEMONSTRATION',
  message: 'Test sensor A threshold exercise. Local test notification only.',
  water_level_m: 2.2,
  measurement_timestamp: '2026-01-15T00:45:00+00:00',
  created_at: '2026-11-01T12:00:00+00:00',
  updated_at: '2026-11-01T12:00:00+00:00',
  source: demoReading.source,
  ...fields,
});
const liveAlert = alert({
  id: 'alert-live',
  station_id: 'bridge-gauge',
  station_name: 'Bridge gauge',
  severity: 'warning',
  mode: 'live',
  label: 'LIVE · SENSOR THRESHOLD',
  message: 'Bridge gauge: water level 3.20 m reached the warning threshold (3.00 m).',
  source: gaugeReading.source,
});
const row = (name: RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  useApp.setState(useApp.getInitialState(), true);
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

it('labels authorized readings LIVE with receipt time and source, and fixtures DEMO', () => {
  useApp.setState({ monitoring: snapshot() });
  render(<MonitoringPanel map={null} />);
  const live = row(/Bridge gauge/);
  expect(within(live).getByText('LIVE')).toBeVisible();
  expect(within(live).getByText(/Received 20:05 PHT/)).toBeVisible();
  expect(within(live).getByText(/CDRRMO test gauge/)).toBeVisible();
  const fixture = row(/Test sensor A/);
  expect(within(fixture).getByText('DEMO')).toBeVisible();
  expect(within(fixture).queryByText('LIVE')).toBeNull();
  expect(within(fixture).getByText(/deterministic replay fixture/)).toBeVisible();
});

it('explains why live ingestion is off and lists PAGASA as disabled', () => {
  useApp.setState({ monitoring: snapshot({ live: liveBlock([], false) }) });
  render(<MonitoringPanel map={null} />);
  expect(screen.getByText('INGEST OFF')).toBeVisible();
  expect(screen.getByText(/set AGOS_INGEST_TOKEN/)).toBeVisible();
  expect(screen.getByText(/Requires an authorized endpoint and credentials/)).toBeVisible();
  expect(screen.queryByText('LIVE')).toBeNull();
});

it('offers no test disconnect for a live station and says alerts need thresholds', () => {
  useApp.setState({ monitoring: snapshot(), selectedStation: 'live:bridge-gauge' });
  render(<MonitoringPanel map={null} />);
  expect(screen.queryByRole('button', { name: /Test disconnect/ })).toBeNull();
  expect(screen.getByText(/live alerts stay off/i)).toBeVisible();
  expect(screen.getByText('POST /api/monitoring/ingest')).toBeVisible();
});

it('turns a LIVE badge STALE when no newer snapshot arrives', () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-01T12:06:00Z'));
  useApp.setState({ monitoring: snapshot({ live: liveBlock([{ ...gauge, age_seconds: 1780 }]) }) });
  render(<MonitoringPanel map={null} />);
  expect(within(row(/Bridge gauge/)).getByText('LIVE')).toBeVisible();
  act(() => vi.advanceTimersByTime(30_000));
  expect(within(row(/Bridge gauge/)).getByText('STALE')).toBeVisible();
});

it('shows a live rain gauge with its class, source, and received accumulation', () => {
  useApp.setState({ monitoring: snapshot({ live: liveBlock([rainGauge]) }) });
  render(<RainfallPanel />);
  fireEvent.change(screen.getByLabelText('Rainfall station'), {
    target: { value: 'live:rain-gauge' },
  });
  expect(screen.getByRole('option', { name: 'Rain gauge · LIVE' })).toBeInTheDocument();
  expect(screen.getByText('LIVE · AUTHORIZED SENSOR INGESTION')).toBeVisible();
  expect(screen.getByText('CDRRMO test rain gauge')).toBeVisible();
  expect(screen.getByText('5.0')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Next monitoring reading' })).toBeNull();
});

it('labels the charted station by its own class instead of a fixed REPLAY badge', () => {
  useApp.setState({ monitoring: snapshot(), selectedStation: 'live:bridge-gauge' });
  const { rerender } = render(<StationTrend />);
  expect(screen.getByText('LIVE')).toBeVisible();
  expect(screen.queryByText('REPLAY')).toBeNull();
  act(() => useApp.setState({ selectedStation: 'test-a' }));
  rerender(<StationTrend />);
  expect(screen.getByText('DEMO')).toBeVisible();
});

it('keeps LIVE alerts apart from TEST exercises in the warning center', () => {
  useApp.setState({ alerts: [liveAlert, alert({})], refresh: vi.fn().mockResolvedValue(undefined) });
  render(<AlertCenter open onOpenChange={() => {}} />);
  const live = screen.getByText('LIVE · SENSOR THRESHOLD').closest('article')!;
  expect(within(live).getByRole('button', { name: 'Resolve alert' })).toBeVisible();
  expect(within(live).queryByRole('button', { name: 'Resolve test alert' })).toBeNull();
  const exercise = screen.getByText('TEST · DEMONSTRATION').closest('article')!;
  expect(within(exercise).getByRole('button', { name: 'Resolve test alert' })).toBeVisible();
  expect(screen.getByRole('dialog')).not.toHaveTextContent('All notifications are local TEST alerts');
});

it('counts active LIVE alerts separately from TEST exercises on the command panel', () => {
  vi.mocked(request).mockResolvedValue({ type: 'FeatureCollection', features: [] });
  useApp.setState({ monitoring: snapshot(), alerts: [liveAlert, alert({})] });
  render(<CommandPanel openAlerts={() => {}} map={null} />);
  expect(screen.getByText('1 LIVE')).toBeVisible();
  expect(screen.getByText('1 ACTIVE TESTS')).toBeVisible();
  expect(within(row(/Bridge gauge/)).getByText('LIVE')).toBeVisible();
});
