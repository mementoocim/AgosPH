import { useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  Camera,
  CheckCircle2,
  GitCompareArrows,
  Layers,
  Save,
  ShieldAlert,
} from 'lucide-react';
import { useApp } from '../store';
import { dateTime, download, downloadBlob, json, number, request } from '../api';
import { metricLabels, type Exposure, type Metric, type Settings } from '../types';
import { referenceDatasets } from '../geo';
import type { MapHandle } from './GeoMap';
import { SurfaceDisplayToggle } from './SurfaceDisplayToggle';
import { Badge, Busy, Button, Empty, Field } from './ui';

export function LayersPanel() {
  const { datasets, mode, settings, saveSettings, notify, set } = useApp();
  const layerRoles = [
    'rivers',
    'boundaries',
    'roads',
    'bridges',
    'buildings',
    'facilities',
    'inundation',
    'terrain',
    'rainfall',
  ];
  return (
    <div className="layer-control">
      <div className="section-heading">
        <h3>
          <Layers size={14} />
          Map layers
        </h3>
        <Badge>
          {
            referenceDatasets(datasets, mode).filter(
              (d) =>
                d.kind === 'vector' ||
                (d.kind === 'raster' && ['terrain', 'rainfall'].includes(d.role)),
            ).length
          }{' '}
          layers
        </Badge>
      </div>
      {layerRoles.map((role) => {
        const matches = referenceDatasets(datasets, mode).filter(
          (d) =>
            d.role === role &&
            (d.kind === 'vector' ||
              (d.kind === 'raster' && ['terrain', 'rainfall'].includes(role))),
        );
        const available = matches.length > 0;
        const visible = settings.layers[role]?.visible ?? !['terrain', 'rainfall'].includes(role);
        return (
          <div className="layer-row" key={role}>
            <label>
              <input
                type="checkbox"
                disabled={!available}
                checked={available && visible}
                onChange={(e) =>
                  void saveSettings({
                    layers: {
                      ...settings.layers,
                      [role]: {
                        visible: e.target.checked,
                        opacity: settings.layers[role]?.opacity ?? 0.7,
                      },
                    },
                  }).catch((e) => notify(e.message))
                }
              />
              <span className="capitalize">
                {role === 'boundaries'
                  ? 'Barangay boundaries'
                  : role === 'terrain'
                    ? 'DEM elevation colors'
                    : role}
              </span>
              <small>{available ? matches.length : 'Unavailable'}</small>
            </label>
            {available && visible && (
              <input
                type="range"
                aria-label={`${role} opacity`}
                min="0"
                max="1"
                step=".05"
                value={settings.layers[role]?.opacity ?? 0.7}
                onChange={(e) => {
                  const next = {
                    ...settings.layers,
                    [role]: { visible: true, opacity: Number(e.target.value) },
                  };
                  useApp
                    .getState()
                    .set({ settings: { ...useApp.getState().settings, layers: next } });
                }}
                onPointerUp={() =>
                  void saveSettings({ layers: useApp.getState().settings.layers }).catch((e) =>
                    notify(e.message),
                  )
                }
                onKeyUp={() =>
                  void saveSettings({ layers: useApp.getState().settings.layers }).catch((e) =>
                    notify(e.message),
                  )
                }
              />
            )}
          </div>
        );
      })}
      <Button size="sm" onClick={() => set({ view: 'data', layersOpen: false })}>
        Import missing geographic layers
      </Button>
      <p className="tiny muted">
        Pinacanauan de Ilagan, Abuan, Bintacan & Cagayan river networks require sourced geographic
        imports. No alignments are invented.
      </p>
    </div>
  );
}

export function SimulationPanel() {
  const {
    scenarios,
    scenarioId,
    selectScenario,
    frame,
    metric,
    set,
    settings,
    saveSettings,
    notify,
    comparisonId,
    comparison,
  } = useApp();
  const scenario = scenarios.find((s) => s.id === scenarioId);
  const [checking, setChecking] = useState(false),
    [compatibility, setCompatibility] = useState('');
  async function compare() {
    if (!scenarioId || !comparisonId) return;
    setChecking(true);
    try {
      const result = await request<{ compatible: boolean; reason: string }>(
        `/compare?first=${scenarioId}&second=${comparisonId}`,
      );
      setCompatibility(result.reason);
      set({ comparison: result.compatible });
      if (!result.compatible) notify(result.reason);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setChecking(false);
    }
  }
  const current = scenario?.frames[frame];
  return (
    <>
      <div className="panel-heading">
        <span className="eyebrow">TEMPORAL FLOOD VIEWER</span>
        <h1>Simulation laboratory</h1>
        <p>Explore georeferenced results across space and time.</p>
      </div>
      <Field label="Active scenario">
        <select
          aria-label="Simulation scenario"
          value={scenarioId}
          onChange={(e) => selectScenario(e.target.value)}
        >
          <option value="" disabled>
            Select a scenario
          </option>
          {scenarios
            .filter((s) => s.mode === useApp.getState().mode)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </Field>
      {scenario ? (
        <>
          <div className="source-banner">
            <ShieldAlert size={14} />
            {scenario.mode === 'demonstration'
              ? 'ILLUSTRATIVE · NOT A FLOOD FORECAST'
              : scenario.validation_label}
          </div>
          <p className="body-copy">{scenario.description}</p>
          <Field label="Visualized variable">
            <select
              aria-label="Visualized variable"
              value={metric}
              onChange={(e) => set({ metric: e.target.value as Metric })}
            >
              {Object.entries(metricLabels).map(([key, label]) => (
                <option
                  key={key}
                  value={key}
                  disabled={
                    ['velocity', 'direction', 'wse'].includes(key) &&
                    !current?.[key as keyof typeof current]
                  }
                >
                  {label}
                  {['velocity', 'direction', 'wse'].includes(key) &&
                  !current?.[key as keyof typeof current]
                    ? ' · unavailable'
                    : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Surface opacity · ${Math.round(settings.opacity * 100)}%`}>
            <input
              aria-label="Flood surface opacity"
              type="range"
              min="0"
              max="1"
              step=".02"
              value={settings.opacity}
              onChange={(e) => set({ settings: { ...settings, opacity: Number(e.target.value) } })}
              onPointerUp={() =>
                void saveSettings({ opacity: useApp.getState().settings.opacity }).catch((e) =>
                  notify(e.message),
                )
              }
              onKeyUp={() =>
                void saveSettings({ opacity: useApp.getState().settings.opacity }).catch((e) =>
                  notify(e.message),
                )
              }
            />
          </Field>
          <SurfaceDisplayToggle />
          <div className="section-heading">
            <h3>
              <GitCompareArrows size={15} />
              Compare results
            </h3>
            <Badge>{comparison ? 'SIDE BY SIDE' : 'ELAPSED TIME'}</Badge>
          </div>
          <Field label="Comparison scenario">
            <select
              aria-label="Comparison scenario"
              value={comparisonId}
              onChange={(e) => {
                set({ comparisonId: e.target.value, comparison: false });
                setCompatibility('');
              }}
            >
              <option value="">Select compatible scenario</option>
              {scenarios
                .filter((s) => s.id !== scenarioId && s.mode === scenario.mode && s.frames.length)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </Field>
          <div className="button-row">
            <Button disabled={!comparisonId || checking} onClick={() => void compare()}>
              <GitCompareArrows size={14} />
              {checking ? 'Checking grids…' : 'Compare side by side'}
            </Button>
            {comparison && (
              <Button onClick={() => set({ comparison: false })}>Close comparison</Button>
            )}
          </div>
          {compatibility && <p className="muted small">{compatibility}</p>}
          <div className="provenance">
            <h4>SIMULATION METADATA</h4>
            <dl className="metadata">
              <dt>Source</dt>
              <dd>{scenario.source}</dd>
              <dt>Model</dt>
              <dd>{scenario.model}</dd>
              <dt>CRS</dt>
              <dd>{scenario.crs ?? 'Awaiting model grid'}</dd>
              <dt>Grid bounds</dt>
              <dd>{scenario.bounds?.map((n) => n.toFixed(4)).join(', ') ?? 'Unavailable'}</dd>
              <dt>Frames</dt>
              <dd>{scenario.frames.length}</dd>
              <dt>Time step</dt>
              <dd>
                {scenario.time_step_seconds
                  ? scenario.time_step_seconds / 60 + ' minutes'
                  : 'Unavailable'}
              </dd>
              <dt>Cursor</dt>
              <dd>{dateTime(current?.timestamp)}</dd>
              <dt>Validation</dt>
              <dd>{scenario.validation_label}</dd>
            </dl>
            <p>
              {scenario.format_validation}. {scenario.validation_notes}
            </p>
          </div>
          <div className="provenance">
            <h4>CONFIDENCE & ASSUMPTIONS</h4>
            <p>
              <b>Confidence: </b>
              {scenario.mode === 'demonstration'
                ? 'Illustrative only · not calibrated or validated'
                : scenario.status === 'validated'
                  ? 'User-asserted validation · not independently verified'
                  : scenario.status === 'unvalidated'
                    ? 'Unvalidated model output'
                    : 'Awaiting model results'}
            </p>
            {Object.entries(scenario.assumptions).map(([key, value]) => (
              <p key={key}>
                <b>{key.replaceAll('_', ' ')}: </b>
                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
              </p>
            ))}
          </div>
          <div className="notice">
            Maximum depth, arrival, and duration are derived from the supplied depth frames. Arrival
            starts at depth &gt;0.01 m. Duration uses left-step intervals and excludes the unknown
            interval after the last frame. Direction values are degrees clockwise from north;
            vectors are illustrative in demo mode. WSE requires a supplied result raster and
            declared vertical datum.
          </div>
          <Button
            onClick={async () => {
              try {
                const input = Object.fromEntries(
                  [
                    'name',
                    'description',
                    'mode',
                    'status',
                    'source',
                    'model',
                    'model_version',
                    'validation_notes',
                    'assumptions',
                    'frames',
                    'settings',
                  ].map((k) => [k, scenario[k as keyof typeof scenario]]),
                );
                input.settings = { opacity: settings.opacity, layers: settings.layers };
                await request(`/scenarios/${scenario.id}`, json('PUT', input));
                await useApp.getState().refresh();
                notify('Visualization settings saved to scenario manifest.');
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            <Save size={13} />
            Save visualization settings
          </Button>
        </>
      ) : (
        <Empty title="No scenario selected">
          Create or import a scenario in Scenario Management.
        </Empty>
      )}
    </>
  );
}

export function ExposurePanel() {
  const { scenarios, scenarioId, frame, exposure, set, comparisonId, comparison, notify } =
    useApp();
  const scenario = scenarios.find((s) => s.id === scenarioId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [other, setOther] = useState<Exposure | null>(null);
  useEffect(() => {
    if (!scenario?.frames.length) return;
    const abort = new AbortController();
    setBusy(true);
    setError('');
    request<Exposure>(`/exposure/${scenarioId}?frame=${frame}`, { signal: abort.signal })
      .then((result) => {
        set({ exposure: result });
        setBusy(false);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(e.message);
          setBusy(false);
        }
      });
    return () => abort.abort();
  }, [scenarioId, frame, scenario?.frames.length, set]);
  const barangays = exposure?.features.filter((r) => r.role === 'boundaries') ?? [];
  const assets = exposure?.features.filter((r) => r.role !== 'boundaries') ?? [];
  useEffect(() => {
    setOther(null);
    if (comparison && comparisonId)
      void request<Exposure>(`/exposure/${comparisonId}?frame=${frame}`)
        .then(setOther)
        .catch((e) => notify(e.message));
  }, [comparison, comparisonId, frame, notify]);
  return (
    <>
      <div className="panel-heading">
        <span className="eyebrow">HAZARD & EXPOSURE SCREENING</span>
        <h1>Geographic exposure</h1>
        <p>Intersect supplied depth grids with sourced geographic features.</p>
      </div>
      {!scenario?.frames.length ? (
        <Empty title="Modeled depth unavailable">
          Attach depth outputs to a scenario before calculating exposure.
        </Empty>
      ) : busy ? (
        <Busy>Intersecting geographic data…</Busy>
      ) : error ? (
        <div className="error-message" role="alert">
          {error}
        </div>
      ) : (
        exposure && (
          <>
            <div className="source-banner">
              <ShieldAlert size={14} />
              {exposure.mode === 'demonstration'
                ? exposure.reference_geography === 'imported'
                  ? 'ILLUSTRATIVE HAZARD × REAL GEOGRAPHY · NOT AN IMPACT ASSESSMENT'
                  : 'SYNTHETIC TEST DOMAIN · NOT REAL FLOOD EXPOSURE'
                : 'IMPORTED MODEL OUTPUT · SCREENING ONLY'}
            </div>
            <p className="muted small">
              {exposure.scenario_name} · {dateTime(exposure.timestamp)}
            </p>
            <div className="metric-pair">
              <div>
                <span>INUNDATION EXTENT</span>
                <strong>
                  {number(exposure.inundation_area_m2 / 1e6, 3)}
                  <small> km²</small>
                </strong>
              </div>
              <div>
                <span>MAXIMUM FRAME DEPTH</span>
                <strong>
                  {number(exposure.maximum_depth_m)}
                  <small> m</small>
                </strong>
              </div>
            </div>
            {other && (
              <div className="comparison-summary">
                <h3>Scenario B · {other.scenario_name}</h3>
                <p>
                  {number(other.inundation_area_m2 / 1e6, 3)} km² · {number(other.maximum_depth_m)}{' '}
                  m maximum
                </p>
                <p>
                  Extent difference B − A:{' '}
                  {number((other.inundation_area_m2 - exposure.inundation_area_m2) / 1e6, 3)} km²
                </p>
              </div>
            )}
            <div className="section-label">
              DEPTH CLASSIFICATION <span>GEODESIC AREA</span>
            </div>
            <div className="depth-categories">
              {exposure.categories.map((c, i) => (
                <div key={c.label}>
                  <span className={`depth-swatch depth-${i}`} />
                  <span>{c.label}</span>
                  <div className="category-track">
                    <i
                      style={{
                        width: `${exposure.inundation_area_m2 ? (100 * c.area_m2) / exposure.inundation_area_m2 : 0}%`,
                      }}
                      className={`depth-${i}`}
                    />
                  </div>
                  <strong>{number(c.area_m2 / 1e6, 3)} km²</strong>
                </div>
              ))}
            </div>
            <div className="section-label">INTERSECTING GEOGRAPHIC FEATURES</div>
            <div className="exposure-counts">
              {Object.entries(exposure.counts).map(([role, count]) => (
                <div key={role}>
                  <span className="capitalize">{role === 'boundaries' ? 'Barangays' : role}</span>
                  <strong>
                    {count == null
                      ? 'Unavailable'
                      : `${count.toLocaleString('en-PH')} / ${exposure.totals[role]?.toLocaleString('en-PH')}`}
                  </strong>
                </div>
              ))}
            </div>
            {barangays.length > 0 && (
              <>
                <div className="section-label">
                  BARANGAY SUMMARY <span>{barangays.length} AFFECTED</span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Barangay</th>
                        <th>Inundated</th>
                        <th>Max m</th>
                        <th>Bldgs</th>
                        <th>Road km</th>
                      </tr>
                    </thead>
                    <tbody>
                      {barangays.map((row, index) => (
                        <tr key={index}>
                          <td>{row.name}</td>
                          <td>
                            {number((row.inundation_area_m2 ?? 0) / 1e6, 2)} km²
                            <small>{Math.round((row.inundated_share ?? 0) * 100)}% of area</small>
                          </td>
                          <td>{number(row.maximum_depth_m, 1)}</td>
                          <td>{row.flooded_buildings ?? '—'}</td>
                          <td>
                            {row.flooded_road_length_m == null
                              ? '—'
                              : number(row.flooded_road_length_m / 1000, 1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {assets.length > 0 && (
              <>
                <div className="section-label">ROADS, BRIDGES & FACILITIES</div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Inundated</th>
                        <th>Max m</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assets.map((row, index) => (
                        <tr key={index}>
                          <td>
                            {row.name}
                            <small>{row.role}</small>
                          </td>
                          <td>
                            {row.inundated_length_m != null
                              ? `${number(row.inundated_length_m / 1000, 2)} km`
                              : 'At sampled point'}
                          </td>
                          <td>{number(row.maximum_depth_m, 1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="section-label">UNAVAILABLE CALCULATIONS</div>
            {exposure.unavailable.map((message) => (
              <p className="missing-row" key={message}>
                {message}
              </p>
            ))}
            <div className="provenance">
              <h4>METHOD & LIMITATIONS</h4>
              <p>{exposure.method}</p>
              <p>{exposure.source}</p>
              {exposure.sources.map((source, i) => (
                <p key={i}>
                  {source.name}: {source.source}
                </p>
              ))}
            </div>
            <Button
              onClick={() =>
                void download(
                  `/reports/csv?kind=exposure&scenario_id=${scenarioId}&frame=${frame}`,
                  'AgosPH-exposure.csv',
                ).catch((e) => notify(e.message))
              }
            >
              <ArrowDownToLine size={14} />
              Export exposure CSV
            </Button>
          </>
        )
      )}
    </>
  );
}

export function ReportsPanel({ map }: { map: MapHandle | null }) {
  const { scenarios, scenarioId, frame, mode, notify } = useApp();
  const scenario = scenarios.find((s) => s.id === scenarioId);
  const [kind, setKind] = useState('monitoring'),
    [screenshot, setScreenshot] = useState(true),
    [busy, setBusy] = useState(false);
  async function exportPDF() {
    if (!scenario) return;
    setBusy(true);
    try {
      const image = screenshot ? map?.screenshot() : null;
      if (screenshot && !image)
        throw new Error(
          'Map screenshot is unavailable. Uncheck map capture to export a data-only report.',
        );
      await download(
        '/reports/pdf',
        'AgosPH-scenario-report.pdf',
        json('POST', { scenario_id: scenario.id, frame, screenshot: image }),
      );
      notify('PDF report exported and saved in data/reports.');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="panel-heading">
        <span className="eyebrow">LOCAL REPORTING</span>
        <h1>Reports & exports</h1>
        <p>Traceable scenario, monitoring, and alert records for prototype evaluation.</p>
      </div>
      <div className="notice prominent">NOT FOR OPERATIONAL FLOOD FORECASTING</div>
      <div className="report-preview">
        <div className="report-paper">
          <span>
            AGOS<span className="cyan">PH</span>
          </span>
          <small>FLOOD INTELLIGENCE REPORT</small>
          <h3>{scenario?.name ?? 'No scenario selected'}</h3>
          <div className="report-rule" />
          <p>Mode: {mode.toUpperCase()}</p>
          <p>Simulation: {dateTime(scenario?.frames[frame]?.timestamp)}</p>
          <p>{scenario?.source ?? 'Source unavailable'}</p>
          <div className="report-rule" />
          <p>
            Hazard & geographic exposure
            <br />
            Monitoring summary
            <br />
            Test alert history
            <br />
            {mode === 'demonstration' ? 'Exercise incident log' : 'Operator incident log'}
            <br />
            Simulation metadata & provenance
          </p>
          <strong>NOT FOR OPERATIONAL USE</strong>
        </div>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={screenshot}
          onChange={(e) => setScreenshot(e.target.checked)}
        />
        Include current map capture
      </label>
      <Button variant="default" disabled={!scenario || busy} onClick={() => void exportPDF()}>
        <ArrowDownToLine size={15} />
        {busy ? 'Generating PDF…' : 'Export scenario PDF report'}
      </Button>
      <div className="section-heading">
        <h3>Structured data</h3>
        <Badge>LOCAL FILES</Badge>
      </div>
      <Field label="CSV content">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="monitoring">Monitoring & rainfall history</option>
          <option value="alerts">Local test alert history</option>
          <option value="incidents">
            {mode === 'demonstration' ? 'Exercise incident log' : 'Operator incident log'}
          </option>
          <option value="exposure">Geographic exposure summary</option>
          <option value="metadata">Simulation frame metadata</option>
        </select>
      </Field>
      <div className="button-row">
        <Button
          disabled={['metadata', 'exposure'].includes(kind) && !scenario?.frames.length}
          onClick={() =>
            void download(
              `/reports/csv?kind=${kind}&mode=${mode}&scenario_id=${scenarioId}&frame=${frame}`,
              `AgosPH-${kind}.csv`,
            ).catch((e) => notify(e.message))
          }
        >
          <ArrowDownToLine size={14} />
          Export CSV
        </Button>
        <Button
          disabled={!scenario?.frames.length}
          onClick={() =>
            void download(
              `/reports/geojson?scenario_id=${scenarioId}&frame=${frame}`,
              'AgosPH-inundation.geojson',
            ).catch((e) => notify(e.message))
          }
        >
          Inundation GeoJSON
        </Button>
        <Button
          onClick={() => {
            const image = map?.screenshot();
            if (image)
              void fetch(image)
                .then((r) => r.blob())
                .then((blob) => downloadBlob(blob, 'AgosPH-map.png'));
          }}
        >
          <Camera size={14} />
          Map PNG
        </Button>
      </div>
      <div className="provenance">
        <h4>REPORT CONTENT</h4>
        <p>
          Reports identify data mode, model source, simulation and monitoring timestamps, validation
          status, available exposure calculations, and missing inputs. Incident logs cover the
          current data mode only, so exercise records never mix with operator reports. GeoJSON
          contains the modeled inundation extent at the current frame. Exports are also retained
          under data/reports.
        </p>
      </div>
    </>
  );
}

export function SettingsPanel({ map }: { map: MapHandle | null }) {
  const { settings, saveSettings, datasets, notify } = useApp();
  const [draft, setDraft] = useState<Settings>(settings),
    [cameraName, setCameraName] = useState('Ilagan view'),
    [saved, setSaved] = useState(false);
  return (
    <>
      <div className="panel-heading">
        <span className="eyebrow">LOCAL CONFIGURATION</span>
        <h1>Map & workspace</h1>
        <p>Configure authorized providers and save camera positions.</p>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (draft.imagery_url && !draft.imagery_attribution.trim())
              throw new Error('Supply imagery source attribution.');
            await saveSettings(draft);
            setSaved(true);
            notify('Workspace settings saved locally.');
          } catch (e) {
            notify((e as Error).message);
          }
        }}
      >
        <Field
          label="Self-hosted / authorized terrain URL"
          hint="Cesium quantized-mesh terrain endpoint. Leave empty to use an imported DEM or the labeled ellipsoid reference surface."
        >
          <input
            aria-label="Terrain provider URL"
            value={draft.terrain_url}
            onChange={(e) => setDraft({ ...draft, terrain_url: e.target.value })}
            placeholder="https://your-authorized-provider/terrain/"
          />
        </Field>
        <Field
          label="Imported DEM terrain provider"
          hint="Heights render in the DEM's own vertical datum (Copernicus GLO-30: EGM2008 orthometric); no geoid conversion is applied. Only the DEM footprint has sampled elevation; outside it the globe falls back to the ellipsoid."
        >
          <select
            aria-label="Imported DEM terrain provider"
            value={draft.terrain_dataset || (draft.terrain_auto ? 'auto' : 'none')}
            disabled={!!draft.terrain_url}
            onChange={(e) => {
              const value = e.target.value;
              setDraft({
                ...draft,
                terrain_dataset: ['auto', 'none'].includes(value) ? '' : value,
                terrain_auto: value === 'auto',
              });
            }}
          >
            <option value="auto">Automatic · first imported DEM</option>
            <option value="none">None · flat ellipsoid reference</option>
            {datasets
              .filter((d) => d.role === 'terrain' && d.mode === 'imported')
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label={`Vertical exaggeration · ${draft.exaggeration.toFixed(1)}×`}>
          <input
            aria-label="Terrain exaggeration"
            type="range"
            min="1"
            max="8"
            step=".1"
            value={draft.exaggeration}
            onChange={(e) => setDraft({ ...draft, exaggeration: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="Imagery XYZ URL"
          hint="Optional satellite or other licensed imagery: {z}/{x}/{y}. Default uses OpenStreetMap street tiles; internet required."
        >
          <input
            aria-label="Imagery provider URL"
            value={draft.imagery_url}
            onChange={(e) => setDraft({ ...draft, imagery_url: e.target.value })}
            placeholder="https://provider/{z}/{x}/{y}.png"
          />
        </Field>
        <Field label="Imagery attribution">
          <input
            value={draft.imagery_attribution}
            onChange={(e) => setDraft({ ...draft, imagery_attribution: e.target.value })}
          />
        </Field>
        <Button variant="default" type="submit">
          <Save size={14} />
          Save provider settings
        </Button>
        {saved && (
          <span className="saved-note">
            <CheckCircle2 size={13} />
            Saved locally
          </span>
        )}
      </form>
      <div className="section-heading">
        <h3>Saved camera positions</h3>
        <Badge>{settings.cameras.length} / 30</Badge>
      </div>
      <form
        className="button-row"
        onSubmit={async (e) => {
          e.preventDefault();
          const camera = map?.camera();
          if (!camera) {
            notify('Map camera unavailable.');
            return;
          }
          try {
            const cameras = [...settings.cameras, { ...camera, name: cameraName }];
            await saveSettings({ cameras });
            setDraft((d) => ({ ...d, cameras }));
            notify('Camera position saved.');
          } catch (e) {
            notify((e as Error).message);
          }
        }}
      >
        <input
          required
          aria-label="Camera position name"
          value={cameraName}
          maxLength={80}
          onChange={(e) => setCameraName(e.target.value)}
        />
        <Button type="submit" disabled={settings.cameras.length >= 30}>
          Save view
        </Button>
      </form>
      {settings.cameras.map((camera, i) => (
        <div className="saved-camera" key={i}>
          <Button variant="ghost" onClick={() => map?.setCamera(camera)}>
            {camera.name}
          </Button>
          <small>
            {camera.latitude.toFixed(4)}, {camera.longitude.toFixed(4)}
          </small>
          <Button
            size="sm"
            onClick={async () => {
              try {
                const cameras = settings.cameras.filter((_, index) => index !== i);
                await saveSettings({ cameras });
                setDraft((d) => ({ ...d, cameras }));
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="provenance">
        <h4>LOCAL STORAGE</h4>
        <p>
          Settings, scenarios, imports, monitoring replay state, and test alerts are stored by
          FastAPI in the data directory. No database or authentication service is used. To move or
          back up the workspace, stop AgosPH and copy data/.
        </p>
        <h4>KEYBOARD SHORTCUTS</h4>
        <p>
          Space: play / pause simulation · ← / →: previous / next frame · Home: rewind · Esc: pause
          playback · L: map layers · /: geographic search
        </p>
      </div>
    </>
  );
}
