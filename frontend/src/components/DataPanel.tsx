import { useRef, useState } from 'react';
import {
  ArrowUpFromLine,
  CheckCircle2,
  FileJson,
  FileSpreadsheet,
  Layers,
  LocateFixed,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useApp } from '../store';
import { dateTime, request } from '../api';
import { roles, type Dataset } from '../types';
import type { MapHandle } from './GeoMap';
import { Badge, Busy, Button, Empty, Field, Modal } from './ui';

export function DataPanel({ map }: { map: MapHandle | null }) {
  const { datasets, mode, refresh, changeMode, notify, saveSettings, settings } = useApp();
  const [file, setFile] = useState<File | null>(null),
    [role, setRole] = useState('boundaries'),
    [source, setSource] = useState(''),
    [unit, setUnit] = useState('m'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState(''),
    [inspect, setInspect] = useState<Dataset | null>(null),
    [preview, setPreview] = useState<unknown>(null),
    [replacement, setReplacement] = useState<Dataset | null>(null);
  const [observedAt, setObservedAt] = useState('');
  const replacementFile = useRef<HTMLInputElement>(null);
  async function importFile(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('role', role);
      form.append('source', source);
      form.append('unit', unit);
      if (observedAt) form.append('observation_timestamp', observedAt);
      const d = await request<Dataset>('/datasets', { method: 'POST', body: form });
      await refresh();
      changeMode('imported');
      await saveSettings({
        layers: { ...settings.layers, [role]: { visible: true, opacity: 0.7 } },
      });
      map?.zoomDataset(d);
      setFile(null);
      setInspect(d);
      notify(`Imported ${d.name}. Available in imported-data mode.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function openInspect(d: Dataset) {
    setInspect(d);
    setPreview(null);
    if (d.kind !== 'raster') {
      try {
        setPreview(
          await request(d.kind === 'vector' ? `/datasets/${d.id}/geojson` : `/datasets/${d.id}`),
        );
      } catch (e) {
        notify((e as Error).message);
      }
    }
  }
  async function replace(file: File) {
    if (!replacement) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('source', source || replacement.source);
      form.append('unit', replacement.unit ?? unit);
      await request(`/datasets/${replacement.id}/replace`, { method: 'PUT', body: form });
      await refresh();
      notify('Dataset replaced. Identifier and grid alignment preserved.');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
      setReplacement(null);
    }
  }
  const visible = datasets.filter(
    (d) =>
      d.mode === mode &&
      (d.name.toLowerCase().includes(filter.toLowerCase()) ||
        d.role.includes(filter.toLowerCase())),
  );
  return (
    <>
      <div className="panel-heading">
        <span className="eyebrow">LOCAL GEOSPATIAL CATALOG</span>
        <h1>Data management</h1>
        <p>Import real data. Inspect its coordinates, provenance, and validation.</p>
      </div>
      <form onSubmit={importFile} className="import-form">
        <label
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setFile(e.dataTransfer.files[0] ?? null);
          }}
        >
          <Upload size={24} />
          <strong>{file ? file.name : 'Choose or drop a dataset'}</strong>
          <span>GeoJSON · CSV · JSON · GeoTIFF · up to 64 MiB</span>
          <input
            aria-label="Choose dataset file"
            type="file"
            accept=".geojson,.json,.csv,.tif,.tiff,.hdf,.h5,.hdf5"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <div className="form-grid">
          <Field label="Dataset role">
            <select
              aria-label="Dataset role"
              value={role}
              onChange={(e) => {
                setRole(e.target.value);
                setUnit(
                  e.target.value === 'velocity'
                    ? 'm/s'
                    : e.target.value === 'direction'
                      ? 'degrees'
                      : e.target.value === 'rainfall'
                        ? 'mm'
                        : 'm',
                );
              }}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Raster units">
            <select
              aria-label="Raster units"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            >
              <option value="m">Meters (m)</option>
              <option value="m/s">Velocity (m/s)</option>
              <option value="degrees">Degrees clockwise from N</option>
              <option value="mm">Rainfall (mm)</option>
            </select>
          </Field>
        </div>
        <Field
          label="Observation timestamp (optional ISO 8601)"
          hint="Required for temporal rainfall raster playback, e.g. 2026-01-15T00:00:00+08:00."
        >
          <input
            aria-label="Dataset observation timestamp"
            value={observedAt}
            onChange={(e) => setObservedAt(e.target.value)}
            placeholder="YYYY-MM-DDTHH:mm:ss+08:00"
          />
        </Field>
        <Field
          label="Source / provenance"
          hint="Include provider, acquisition date, license, and any scientific validation limits."
        >
          <textarea
            aria-label="Dataset source"
            required
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="e.g. Agency export, surveyed date, CRS, license…"
            rows={2}
            maxLength={2000}
          />
        </Field>
        {error && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        <Button variant="default" type="submit" disabled={!file || !source.trim() || busy}>
          <ArrowUpFromLine size={15} />
          {busy ? 'Validating & importing…' : 'Validate & import locally'}
        </Button>
      </form>
      <div className="section-heading">
        <h3>
          Dataset catalog <span className="muted">{visible.length}</span>
        </h3>
        <Badge tone={mode === 'demonstration' ? 'orange' : 'cyan'}>
          {mode === 'demonstration' ? 'DEMO FIXTURES' : 'IMPORTED'}
        </Badge>
      </div>
      <div className="search-field">
        <Search size={14} />
        <input
          aria-label="Filter datasets"
          placeholder="Filter by name or role…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="dataset-list">
        {visible.length ? (
          visible.map((d) => (
            <article className="dataset-row" key={d.id}>
              <div className="dataset-icon">
                {d.kind === 'vector' ? (
                  <FileJson size={18} />
                ) : d.kind === 'raster' ? (
                  <Layers size={18} />
                ) : (
                  <FileSpreadsheet size={18} />
                )}
              </div>
              <div className="dataset-info">
                <strong title={d.name}>{d.name}</strong>
                <span>
                  {d.role} · {d.crs ?? 'Time series'} ·{' '}
                  {d.kind === 'raster'
                    ? `${d.width} × ${d.height}`
                    : d.kind === 'vector'
                      ? `${d.feature_count} features`
                      : `${d.record_count} records`}
                </span>
                <small>
                  <CheckCircle2 size={10} />
                  Format validated · {d.mode}
                </small>
              </div>
              <div className="dataset-actions">
                <Button
                  size="icon"
                  aria-label={`Inspect ${d.name}`}
                  onClick={() => void openInspect(d)}
                >
                  <Search size={13} />
                </Button>
                <Button
                  size="icon"
                  aria-label={`Zoom to ${d.name}`}
                  disabled={!d.bounds}
                  onClick={() => map?.zoomDataset(d)}
                >
                  <LocateFixed size={13} />
                </Button>
                {d.mode === 'imported' && (
                  <Button
                    size="icon"
                    aria-label={`Replace ${d.name}`}
                    disabled={busy}
                    onClick={() => {
                      setReplacement(d);
                      replacementFile.current?.click();
                    }}
                  >
                    <RefreshCw size={13} />
                  </Button>
                )}
                <Button
                  size="icon"
                  aria-label={`Remove ${d.name}`}
                  onClick={async () => {
                    try {
                      await request(`/datasets/${d.id}`, { method: 'DELETE' });
                      await refresh();
                      notify('Dataset removed locally.');
                    } catch (e) {
                      notify((e as Error).message);
                    }
                  }}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            </article>
          ))
        ) : (
          <Empty title="No datasets in this mode">
            Import your geographic or monitoring datasets above. Demonstration fixtures are
            available in demo mode.
          </Empty>
        )}
      </div>
      <input
        ref={replacementFile}
        className="sr-only"
        aria-label="Replacement dataset file"
        type="file"
        accept=".geojson,.json,.csv,.tif,.tiff"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void replace(f);
          e.target.value = '';
        }}
      />
      <div className="provenance">
        <h4>EXPECTED DATA CONTRACTS</h4>
        <p>
          GeoJSON: WGS84 FeatureCollection with valid geometries. Raster: one north-up,
          georeferenced band with CRS and declared NoData. Monitoring CSV: timestamp, station_id,
          water_level_m, rainfall_mm. Rainfall CSV: timestamp, station_id, rainfall_mm. HEC-HMS:
          timestamp, station_id, discharge_m3s.
        </p>
        <p>
          GeoTIFF uploads are available to the scenario editor as time-stamped frames. A DEM can
          drive local 3D terrain through Settings. Raw HEC-RAS HDF structures are explicitly
          rejected; use RAS Mapper georeferenced exports.
        </p>
      </div>
      <Modal
        open={!!inspect}
        onOpenChange={(open) => {
          if (!open) setInspect(null);
        }}
        title={inspect?.name ?? 'Dataset inspection'}
        description="Validation checks file format and geographic structure; it does not certify source accuracy."
        wide
      >
        {inspect && (
          <>
            <div className="detail-row">
              <Badge tone="cyan">{inspect.role}</Badge>
              <Badge tone={inspect.mode === 'demonstration' ? 'orange' : 'neutral'}>
                {inspect.mode}
              </Badge>
            </div>
            <dl className="metadata">
              <dt>CRS</dt>
              <dd>{inspect.crs ?? 'Not spatial'}</dd>
              <dt>Bounds W,S,E,N</dt>
              <dd>{inspect.bounds?.map((n) => n.toFixed(6)).join(', ') ?? 'Unavailable'}</dd>
              <dt>Source</dt>
              <dd>{inspect.source}</dd>
              <dt>Imported</dt>
              <dd>{dateTime(inspect.created_at)}</dd>
              <dt>Validation</dt>
              <dd>{inspect.status}</dd>
              <dt>Local path</dt>
              <dd>{inspect.path}</dd>
              <dt>Dimensions / records</dt>
              <dd>
                {inspect.kind === 'raster'
                  ? `${inspect.width} × ${inspect.height} · ${inspect.unit}`
                  : (inspect.feature_count ?? inspect.record_count)}
              </dd>
            </dl>
            {inspect.warnings.map((w) => (
              <div className="notice" key={w}>
                {w}
              </div>
            ))}
            {inspect.kind === 'raster' ? (
              <div className="raster-preview">
                <img
                  src={`/api/datasets/${inspect.id}/image.png`}
                  alt={`${inspect.role} raster preview`}
                />
                <small>WGS84 reprojected preview · native raster retained for analysis</small>
              </div>
            ) : preview ? (
              <pre className="code-preview">{JSON.stringify(preview, null, 2).slice(0, 25000)}</pre>
            ) : (
              <Busy />
            )}
            <div className="button-row">
              <Button
                disabled={!inspect.bounds}
                onClick={() => {
                  map?.zoomDataset(inspect);
                  setInspect(null);
                }}
              >
                <LocateFixed size={14} />
                Zoom to dataset
              </Button>
              <Button onClick={() => setInspect(null)}>
                <X size={14} />
                Close inspection
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
