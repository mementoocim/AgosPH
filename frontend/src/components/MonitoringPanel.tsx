import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  Pause,
  Play,
  Radio,
  RotateCcw,
  SkipForward,
  Unplug,
  Wifi,
  Navigation,
} from 'lucide-react';
import { useApp, useSnapshotElapsed } from '../store';
import { axisLabels, dateTime, duration, json, number, request } from '../api';
import { chartSeries } from '../geo';
import { ago, readingBadge, readingTime, stationKey } from '../readings';
import type { Monitoring, Station, Thresholds } from '../types';
import { Badge, Button, Empty, Field } from './ui';
import { Chart } from './Chart';
import type { MapHandle } from './GeoMap';

export async function replayStep(reset = false, rainfall?: 'steady' | 'intense') {
  const state = useApp.getState();
  const monitoring = await request<Monitoring>(
    `/monitoring/${reset ? 'reset' : 'step'}`,
    json('POST', {
      mode: state.mode,
      rainfall_scenario: rainfall ?? state.monitoring?.rainfall_scenario ?? 'steady',
    }),
  );
  state.set({ monitoring });
  await state.refresh();
}
export function ReplayControls() {
  const { monitoring, monitoringPlaying, set, notify } = useApp();
  return (
    <div className="replay-controls">
      <Button
        size="icon"
        aria-label="Reset monitoring replay"
        onClick={() => {
          set({ monitoringPlaying: false });
          void replayStep(true).catch((e) => notify(e.message));
        }}
      >
        <RotateCcw size={15} />
      </Button>
      <Button
        variant={monitoringPlaying ? 'secondary' : 'default'}
        disabled={!monitoring?.steps}
        onClick={() => set({ monitoringPlaying: !monitoringPlaying })}
      >
        {monitoringPlaying ? <Pause size={14} /> : <Play size={14} />}{' '}
        {monitoringPlaying ? 'Pause replay' : 'Replay readings'}
      </Button>
      <Button
        size="icon"
        aria-label="Next monitoring reading"
        disabled={!monitoring?.steps || monitoring.index >= monitoring.steps - 1}
        onClick={() => void replayStep().catch((e) => notify(e.message))}
      >
        <SkipForward size={15} />
      </Button>
      <span className="mono">
        {monitoring ? monitoring.index + 1 + ' / ' + monitoring.steps : '—'}
      </span>
    </div>
  );
}
/** Station rows with their reading class (LIVE/STALE/UNAVAILABLE/REPLAY/DEMO), time, and source. */
export function StationSummary({
  stations,
  onSelect,
  empty,
}: {
  stations?: Station[];
  onSelect?: (station: Station) => void;
  empty?: ReactNode;
}) {
  const { monitoring, selectedStation, set } = useApp();
  const elapsed = useSnapshotElapsed();
  const list = stations ?? monitoring?.stations ?? [];
  if (!list.length)
    return (
      empty ?? (
        <Empty title="No monitoring measurements">
          Import a monitoring CSV or switch to demonstration mode.
        </Empty>
      )
    );
  return (
    <div className="station-list">
      {list.map((s) => {
        const badge = readingBadge(s, monitoring?.live, elapsed);
        const shown = s.data_class === 'live' ? badge.label !== 'UNAVAILABLE' : s.connected;
        const rainOnly = s.latest?.water_level_m == null && s.latest?.rainfall_mm != null;
        return (
          <button
            key={stationKey(s)}
            className={`station-row ${selectedStation === stationKey(s) ? 'selected' : ''}`}
            onClick={() => {
              set({ selectedStation: stationKey(s) });
              onSelect?.(s);
            }}
          >
            <span
              className={`station-status status-${shown && badge.label !== 'STALE' ? s.severity : 'unavailable'}`}
            />
            <span className="station-name">
              <strong>{s.name}</strong>
              <small>{readingTime(s, elapsed)}</small>
              <small className="station-source" title={s.source}>
                {s.source}
              </small>
            </span>
            <Badge tone={badge.tone}>{badge.label}</Badge>
            <span className="station-value">
              {shown
                ? number(rainOnly ? s.latest?.rainfall_mm : s.latest?.water_level_m, rainOnly ? 1 : 2)
                : '—'}
              <small>{rainOnly ? 'mm' : 'm'}</small>
            </span>
            <ArrowUpRight size={12} />
          </button>
        );
      })}
    </div>
  );
}
/** Readings that arrived through authorized ingestion; kept apart from the replay list. */
export function LiveTelemetry({ compact = false }: { compact?: boolean }) {
  const live = useApp((s) => s.monitoring?.live);
  if (!live) return null;
  return (
    <div className="live-telemetry">
      <div className="section-heading">
        <h3>Live telemetry</h3>
        <Badge tone={live.ingest.enabled ? 'green' : 'neutral'}>
          {live.ingest.enabled ? 'INGEST ON' : 'INGEST OFF'}
        </Badge>
      </div>
      <StationSummary
        stations={live.stations}
        empty={
          <p className="tiny muted">
            {live.ingest.enabled
              ? 'No authorized sensor has reported yet. Readings sent to the ingestion endpoint appear here as LIVE.'
              : live.ingest.detail}
          </p>
        }
      />
      {!compact && (
        <p className="tiny muted">
          LIVE: observed within {duration(live.stale_after_minutes)}. STALE afterwards,
          UNAVAILABLE after {duration(live.unavailable_after_minutes)}. Only authorized ingestion
          creates live readings; replay and demonstration data never do.
        </p>
      )}
    </div>
  );
}
/** Trend of the selected station, live or replay, labeled with its own reading class. */
export function StationTrend() {
  const { monitoring, selectedStation } = useApp();
  const elapsed = useSnapshotElapsed();
  const series = chartSeries(
    [...(monitoring?.live?.stations ?? []), ...(monitoring?.stations ?? [])],
    selectedStation,
  );
  if (!series) return null;
  const { station } = series;
  const water = series.metric === 'water_level_m';
  const badge = readingBadge(station, monitoring?.live, elapsed);
  const kind =
    station.data_class === 'live'
      ? 'Live'
      : station.data_class === 'demonstration'
        ? 'Demonstration'
        : 'Imported historical';
  return (
    <>
      <div className="chart-caption">
        <span>
          {station.name} · {water ? 'water level' : 'interval rainfall'}
        </span>
        <span>{water ? 'm' : 'mm'}</span>
      </div>
      <Chart
        labels={axisLabels(station.history.map((r) => r.timestamp))}
        series={[
          {
            name: `${kind} ${water ? 'water level' : 'rainfall'}`,
            values: station.history.map((r) => r[series.metric] ?? null),
            color: water ? '#51c6ce' : '#7db6e9',
            area: water,
            type: water ? 'line' : 'bar',
          },
        ]}
        height={135}
        cursor={station.history.findIndex((r) => r.timestamp === station.latest?.timestamp)}
      />
      <div className="monitor-time">
        <Radio size={12} />
        <span>
          {station.data_class === 'live'
            ? readingTime(station, elapsed)
            : dateTime(station.latest?.timestamp)}
        </span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
    </>
  );
}
const thresholdText = (t: Thresholds | null) => ({
  watch: t ? String(t.watch) : '',
  warning: t ? String(t.warning) : '',
  critical: t ? String(t.critical) : '',
});
function ThresholdForm({ station }: { station: Station }) {
  const [values, setValues] = useState(() => thresholdText(station.thresholds)),
    [saving, setSaving] = useState(false);
  const { notify, refresh } = useApp();
  const live = station.data_class === 'live';
  // Snapshots arrive every few seconds: reset the inputs only when the saved values change.
  const saved = JSON.stringify(station.thresholds);
  useEffect(() => setValues(thresholdText(station.thresholds)), [station.id, saved]);
  return (
    <form
      className="threshold-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await request(
            `/monitoring/${station.id}/thresholds`,
            json('PUT', {
              watch: Number(values.watch),
              warning: Number(values.warning),
              critical: Number(values.critical),
            }),
          );
          await refresh();
          notify(
            live
              ? 'Station thresholds saved. Fresh readings that cross them raise LIVE alerts.'
              : 'Station thresholds saved locally. New upward crossings generate test alerts.',
          );
        } catch (e) {
          notify((e as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="section-label">
        WARNING THRESHOLDS <span>METERS</span>
      </div>
      {live && !station.thresholds && (
        <p className="tiny muted">
          No thresholds saved for this station: live alerts stay off until station-specific values
          are saved. Replay data with the same station id shares them.
        </p>
      )}
      <div className="threshold-inputs">
        {(['watch', 'warning', 'critical'] as const).map((key) => (
          <Field key={key} label={key}>
            <input
              aria-label={`${key} threshold`}
              type="number"
              step=".1"
              min="0"
              max="1000"
              value={values[key]}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            />
          </Field>
        ))}
      </div>
      <Button type="submit" size="sm" disabled={saving}>
        Save thresholds
      </Button>
    </form>
  );
}
function StationDetail({ station, map }: { station: Station; map: MapHandle | null }) {
  const { monitoring, notify, refresh } = useApp();
  const elapsed = useSnapshotElapsed();
  const badge = readingBadge(station, monitoring?.live, elapsed);
  const live = station.data_class === 'live';
  const shown = live ? badge.label !== 'UNAVAILABLE' : station.connected;
  const latest = station.latest;
  const rows = station.history;
  return (
    <>
      <div className="section-heading">
        <h3>{station.name}</h3>
        <span className="badge-group">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {!live && (
            <Badge tone={station.connected ? 'cyan' : 'orange'}>
              {station.connected ? 'Replay connected' : 'Test disconnect'}
            </Badge>
          )}
        </span>
      </div>
      <div className="metric-pair">
        <div>
          <span>WATER LEVEL</span>
          <strong>
            {shown ? number(latest?.water_level_m) : '—'}
            <small> m</small>
          </strong>
        </div>
        <div>
          <span>INTERVAL RAINFALL</span>
          <strong>
            {shown ? number(latest?.rainfall_mm, 1) : '—'}
            <small>
              {' '}
              mm
              {latest?.rainfall_interval_minutes ? ` / ${latest.rainfall_interval_minutes} min` : ''}
            </small>
          </strong>
        </div>
      </div>
      <Chart
        labels={axisLabels(rows.map((r) => r.timestamp))}
        series={[
          {
            name: live ? 'Live water level' : 'Water level',
            values: rows.map((r) => r.water_level_m ?? null),
            color: '#56cbd3',
            area: true,
          },
        ]}
        unit="m"
        cursor={rows.findIndex((r) => r.timestamp === latest?.timestamp)}
        thresholds={Object.entries(station.thresholds ?? {}).map(([name, value]) => ({
          name,
          value,
        }))}
      />
      {live ? (
        <>
          <div className="detail-row">
            <span>Observed</span>
            <span>{dateTime(latest?.timestamp)}</span>
          </div>
          <div className="detail-row">
            <span>Received</span>
            <span>{dateTime(station.received_at)}</span>
          </div>
          <div className="detail-row">
            <span>Observation age</span>
            <span>{ago((station.age_seconds ?? 0) + elapsed)}</span>
          </div>
          <div className="detail-row">
            <span>Channel</span>
            <span>{latest?.channel ?? 'Unavailable'}</span>
          </div>
        </>
      ) : (
        <>
          <div className="detail-row">
            <span>Measurement timestamp</span>
            <span>{dateTime(latest?.timestamp)}</span>
          </div>
          <div className="detail-row">
            <span>Quality</span>
            <span>
              {!station.connected
                ? 'Disconnected in test controls'
                : station.data_class === 'demonstration'
                  ? 'Demonstration replay fixture'
                  : 'Historical replay'}
            </span>
          </div>
        </>
      )}
      <div className="button-row">
        <Button
          size="sm"
          disabled={station.longitude == null}
          onClick={() => map?.flyTo(station.longitude!, station.latitude!)}
        >
          <Navigation size={13} />
          Locate station
        </Button>
        {!live && (
          <Button
            size="sm"
            onClick={async () => {
              try {
                await request(
                  '/monitoring/connection',
                  json('PUT', { station_id: station.id, connected: !station.connected }),
                );
                await refresh();
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            {station.connected ? <Unplug size={13} /> : <Wifi size={13} />}{' '}
            {station.connected ? 'Test disconnect' : 'Reconnect replay'}
          </Button>
        )}
      </div>
      <ThresholdForm station={station} />
      <div className="provenance">
        <h4>DATA PROVENANCE</h4>
        <p>{station.source}</p>
        <p>
          {station.longitude == null
            ? 'No actual monitoring-station coordinates supplied. No station marker is drawn.'
            : `WGS84: ${station.latitude}, ${station.longitude}`}
        </p>
      </div>
    </>
  );
}
export function MonitoringPanel({ map }: { map: MapHandle | null }) {
  const { monitoring, selectedStation, socketOnline } = useApp();
  const all = [...(monitoring?.live?.stations ?? []), ...(monitoring?.stations ?? [])];
  const station = all.find((s) => stationKey(s) === selectedStation) ?? all[0];
  return (
    <>
      <div className="panel-heading">
        <span className="eyebrow">SENSOR WORKBENCH</span>
        <h1>
          River monitoring
          <span className="title-dot" />
        </h1>
        <p>Authorized live readings. Replay history. Test thresholds. Inspect source health.</p>
      </div>
      <LiveTelemetry />
      <div className="source-banner">
        <Activity size={14} />
        {monitoring?.label ?? 'Measurements unavailable'}
      </div>
      <ReplayControls />
      <StationSummary />
      {station && <StationDetail station={station} map={map} />}
      <div className="service-health">
        <span className={socketOnline ? 'health-dot' : 'health-dot offline'} />
        {socketOnline
          ? 'Local WebSocket connected'
          : 'WebSocket disconnected · HTTP retry available'}
      </div>
      <div className="provenance">
        <h4>EXTERNAL ADAPTERS</h4>
        {(monitoring?.adapters ?? []).map((adapter) => (
          <p key={adapter.name}>
            <b>{adapter.name}:</b> {adapter.detail}
          </p>
        ))}
      </div>
    </>
  );
}
export { RainfallPanel } from './RainfallPanel';
