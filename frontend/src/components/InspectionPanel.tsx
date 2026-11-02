import { useEffect } from 'react';
import { MapPinned, X } from 'lucide-react';
import { useApp } from '../store';
import { dateTime, duration, number, request, time } from '../api';
import type { Inspection } from '../types';
import { Badge, Button } from './ui';

export function InspectionPanel() {
  const { inspection, set, scenarios, scenarioId, frame, notify } = useApp();
  const target = scenarios.find((s) => s.id === scenarioId)?.frames[frame]?.timestamp;
  // A modeled reading from another frame is re-read at the same spot for the current one.
  const stale = !!inspection?.timestamp && !!target && inspection.timestamp !== target;
  const lon = inspection?.longitude,
    lat = inspection?.latitude;
  useEffect(() => {
    if (!stale || lon == null || lat == null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      request<Inspection>(
        `/scenarios/${scenarioId}/inspect?frame=${frame}&longitude=${lon}&latitude=${lat}`,
        { signal: controller.signal },
      )
        .then((next) => {
          const current = useApp.getState().inspection;
          // Skip if the panel was closed or another spot was clicked meanwhile.
          if (current?.longitude === lon && current?.latitude === lat)
            set({ inspection: { ...next, elevation: current.elevation } });
        })
        .catch((error) => {
          if (!controller.signal.aborted) notify((error as Error).message);
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [stale, scenarioId, frame, lon, lat, set, notify]);
  if (!inspection) return null;
  const inside = inspection.inside_model;
  return (
    <div className="inspection-panel glass" role="status">
      <div className="section-heading">
        <h3>
          <MapPinned size={15} />
          Location inspection
        </h3>
        <Button
          size="icon"
          aria-label="Close location inspection"
          onClick={() => set({ inspection: null })}
        >
          <X size={14} />
        </Button>
      </div>
      <p className="mono">
        {inspection.latitude.toFixed(6)}° N · {inspection.longitude.toFixed(6)}° E
      </p>
      <Badge tone={!inside ? 'neutral' : inspection.mode === 'demonstration' ? 'orange' : 'cyan'}>
        {!inside
          ? 'OUTSIDE MODEL'
          : inspection.mode === 'demonstration'
            ? 'ILLUSTRATIVE · NOT A FORECAST'
            : inspection.validation_status}
      </Badge>
      {stale && <p className="tiny muted">Updating for {time(target)}…</p>}
      {inside ? (
        <>
          <div className={`inspection-values ${stale ? 'stale' : ''}`}>
            <div>
              <span>Depth</span>
              <strong>{number(inspection.values.depth)} m</strong>
            </div>
            <div>
              <span>Velocity</span>
              <strong>{number(inspection.values.velocity)} m/s</strong>
            </div>
            <div>
              <span>Direction</span>
              <strong>{number(inspection.values.direction, 0)}°</strong>
            </div>
            <div>
              <span>WSE</span>
              <strong>{number(inspection.values.wse)} m</strong>
            </div>
          </div>
          <div className="inspection-values timing">
            <div>
              <span>Arrival</span>
              <strong>{duration(inspection.arrival_minutes)}</strong>
            </div>
            <div>
              <span>Peak depth</span>
              <strong>{number(inspection.peak_depth_m)} m</strong>
            </div>
            <div>
              <span>Peak time</span>
              <strong>{inspection.peak_timestamp ? time(inspection.peak_timestamp) : '—'}</strong>
            </div>
          </div>
          <p className="tiny muted">
            Arrival is elapsed time from the first frame to depth &gt;0.01 m at this cell. Timing
            precision equals the frame interval.
          </p>
        </>
      ) : (
        <p className="notice">
          No modeled value at this location. Outside the selected raster or NoData.
        </p>
      )}
      <p className="tiny">
        Terrain elevation:{' '}
        {inspection.elevation != null
          ? number(inspection.elevation) + ' m · terrain model vertical datum'
          : 'Unavailable; ellipsoid is not topography'}
      </p>
      <p className="tiny muted">
        {inspection.scenario}
        <br />
        {dateTime(inspection.timestamp)}
      </p>
      <details>
        <summary>Source & validation</summary>
        <p>{inspection.source}</p>
        <p>{inspection.validation_status}</p>
      </details>
    </div>
  );
}
