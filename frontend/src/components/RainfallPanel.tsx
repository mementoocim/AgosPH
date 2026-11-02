import { useMemo, useState } from 'react';
import { CloudRain } from 'lucide-react';
import { useApp, useSnapshotElapsed } from '../store';
import { axisLabels, dateTime, number } from '../api';
import { intensity, readingBadge, readingTime, stationKey } from '../readings';
import { Badge, Empty, Field } from './ui';
import { Chart, type Series } from './Chart';
import { ReplayControls, replayStep } from './MonitoringPanel';
import { RainfallRasterPlayer } from './RainfallRasterPlayer';

export function RainfallPanel() {
  const { monitoring, notify } = useApp();
  const elapsed = useSnapshotElapsed();
  const [range, setRange] = useState('all'),
    [compare, setCompare] = useState(false),
    [stationId, setStationId] = useState('');
  const stations = [...(monitoring?.live?.stations ?? []), ...(monitoring?.stations ?? [])].filter(
    (s) => s.history.some((r) => r.rainfall_mm != null),
  );
  const station = stations.find((s) => stationKey(s) === stationId) ?? stations[0];
  const live = station?.data_class === 'live';
  const demo = station?.data_class === 'demonstration';
  const badge = station ? readingBadge(station, monitoring?.live, elapsed) : null;
  // Live accumulation runs to the newest observation; replay accumulation runs to the cursor.
  const anchor = live ? station.latest?.timestamp : monitoring?.timestamp;
  const current = anchor ? new Date(anchor).getTime() : Infinity;
  const rows = useMemo(
    () =>
      station?.history.filter(
        (r) =>
          range === 'all' || new Date(r.timestamp).getTime() >= current - Number(range) * 3600000,
      ) ?? [],
    [station, range, current],
  );
  const observed = rows.filter((r) => new Date(r.timestamp).getTime() <= current);
  const accumulation = observed.reduce((sum, r) => sum + (r.rainfall_mm ?? 0), 0);
  const series: Series[] = [
    {
      name: station?.name ?? 'Rainfall',
      values: rows.map((r) => r.rainfall_mm ?? null),
      color: '#7db6e9',
      type: 'bar',
    },
  ];
  if (compare && demo)
    series.push({
      name: monitoring?.rainfall_scenario === 'steady' ? 'Intense test' : 'Steady test',
      values: rows.map(
        (r) => (r.rainfall_mm ?? 0) * (monitoring?.rainfall_scenario === 'steady' ? 1.7 : 1 / 1.7),
      ),
      color: '#c7a26a',
      type: 'line',
    });
  const latestShown = live ? badge?.label !== 'UNAVAILABLE' : station?.connected;
  return (
    <>
      <div className="panel-heading">
        <span className="eyebrow">PRECIPITATION ANALYSIS</span>
        <h1>Rainfall & weather</h1>
        <p>Interval observations and accumulated rainfall. No forecast source configured.</p>
      </div>
      <div className="source-banner">
        <CloudRain size={14} />
        {live && badge
          ? `${badge.label} · AUTHORIZED SENSOR INGESTION`
          : (monitoring?.label ?? 'No rainfall measurements')}
      </div>
      <div className="form-grid">
        <Field label="Rainfall scenario">
          <select
            aria-label="Rainfall scenario"
            disabled={!demo}
            value={monitoring?.rainfall_scenario ?? 'steady'}
            onChange={(e) =>
              void replayStep(true, e.target.value as 'steady' | 'intense').catch((e) =>
                notify(e.message),
              )
            }
          >
            <option value="steady">Steady test series</option>
            <option value="intense">Intense test series</option>
          </select>
        </Field>
        <Field label="Time range">
          <select value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="all">All observations</option>
            <option value="1">Last 1 hour</option>
            <option value="3">Last 3 hours</option>
          </select>
        </Field>
      </div>
      {stations.length > 0 && (
        <Field label="Rainfall station">
          <select
            aria-label="Rainfall station"
            value={station ? stationKey(station) : ''}
            onChange={(e) => setStationId(e.target.value)}
          >
            {stations.map((s) => (
              <option key={stationKey(s)} value={stationKey(s)}>
                {s.name} · {readingBadge(s, monitoring?.live, elapsed).label}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!live && <ReplayControls />}
      {station ? (
        <>
          <div className="metric-pair">
            <div>
              <span>{live ? 'ACCUMULATED · RECEIVED' : 'ACCUMULATED TO CURSOR'}</span>
              <strong>
                {number(accumulation, 1)}
                <small> mm</small>
              </strong>
            </div>
            <div>
              <span>LATEST INTERVAL</span>
              <strong>
                {latestShown ? number(station.latest?.rainfall_mm, 1) : '—'}
                <small>
                  {' '}
                  mm
                  {station.latest?.rainfall_interval_minutes
                    ? ` / ${station.latest.rainfall_interval_minutes} min`
                    : ''}
                </small>
              </strong>
            </div>
          </div>
          <div className="section-heading">
            <h3>Interval rainfall</h3>
            <Badge tone="blue">mm / interval</Badge>
          </div>
          <Chart
            labels={axisLabels(rows.map((r) => r.timestamp))}
            series={series}
            unit="mm"
            cursor={rows.findIndex((r) => r.timestamp === anchor)}
          />
          {demo && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={compare}
                onChange={(e) => setCompare(e.target.checked)}
              />
              Compare steady and intense test rainfall
            </label>
          )}
          <div className="section-heading">
            <h3>Rainfall intensity</h3>
            <Badge tone="blue">mm / h</Badge>
          </div>
          <Chart
            labels={axisLabels(rows.map((r) => r.timestamp))}
            series={[
              {
                name: 'Derived interval intensity',
                values: intensity(rows),
                color: '#9caaec',
                area: true,
              },
            ]}
            unit="mm/h"
          />
          <div className="provenance">
            <h4>STATION & SOURCE</h4>
            <p>
              {station.name} · {badge?.label} ·{' '}
              {live ? readingTime(station, elapsed) : dateTime(station.latest?.timestamp)}
            </p>
            <p>{station.source}</p>
            <p>
              Intensity is interval accumulation divided by its declared interval, or by the
              spacing between records when none is declared. Accumulation sums records through the
              replay cursor, or through the newest observation for a live gauge. Records must
              represent non-overlapping interval totals. Missing rainfall values are not drawn as
              zero intensity.
            </p>
          </div>
        </>
      ) : (
        <Empty title="Rainfall measurements unavailable">
          Import rainfall CSV/JSON with timestamp, station_id, and rainfall_mm fields.
        </Empty>
      )}
      <RainfallRasterPlayer />
      <div className="notice">
        Rainfall assumptions do not generate flood predictions. Georeferenced rainfall overlays
        require an imported raster or GeoJSON rainfall layer; enable it in Layers.
      </div>
    </>
  );
}
