import { useState } from 'react';
import {
  Copy,
  Download,
  FileInput,
  FolderOpen,
  Mountain,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { useApp, scenarioInput } from '../store';
import { dateTime, download, downloadBlob, json, request } from '../api';
import type { Frame, Scenario, ScenarioInput } from '../types';
import { Badge, Button, Empty, Field, Modal } from './ui';
const newScenario = (): ScenarioInput => ({
  name: 'New model scenario',
  description: '',
  mode: 'imported',
  status: 'pending',
  source: '',
  model: 'Imported georeferenced results',
  model_version: '',
  validation_notes: '',
  assumptions: {},
  frames: [],
  settings: {},
});
export function ScenarioPanel() {
  const {
    scenarios,
    scenarioId,
    mode,
    selectScenario,
    refresh,
    notify,
    datasets,
    settings,
    saveSettings,
  } = useApp();
  const [editor, setEditor] = useState<ScenarioInput | null>(null),
    [editingId, setEditingId] = useState(''),
    [assumptions, setAssumptions] = useState('{}'),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false),
    [rename, setRename] = useState<Scenario | null>(null),
    [renameValue, setRenameValue] = useState(''),
    [generating, setGenerating] = useState(false);
  const imported = (role: string, kind: string) =>
    datasets.some((d) => d.role === role && d.kind === kind && d.mode === 'imported');
  const canGenerate = imported('terrain', 'raster') && imported('rivers', 'vector');
  async function generateTerrainDemo() {
    setGenerating(true);
    try {
      const result = await request<{ scenarios: Scenario[] }>('/demo/terrain', json('POST'));
      await refresh();
      if (result.scenarios[0]) selectScenario(result.scenarios[0].id);
      notify(
        'Terrain demonstration regenerated from imported terrain and rivers. Illustrative only.',
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }
  function edit(s?: Scenario) {
    setEditor(s ? scenarioInput(s) : newScenario());
    setEditingId(s?.id ?? '');
    setAssumptions(JSON.stringify(s?.assumptions ?? {}, null, 2));
    setError('');
  }
  function patch(patch: Partial<ScenarioInput>) {
    setEditor((s) => (s ? { ...s, ...patch } : s));
  }
  function patchFrame(index: number, changes: Partial<Frame>) {
    if (editor)
      patch({ frames: editor.frames.map((f, i) => (i === index ? { ...f, ...changes } : f)) });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editor) return;
    setSaving(true);
    setError('');
    try {
      const parsed = JSON.parse(assumptions);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
        throw new Error('Assumptions must be a JSON object.');
      const payload = {
        ...editor,
        assumptions: parsed,
        frames: editor.status === 'pending' ? [] : editor.frames,
      };
      const result = await request<Scenario>(
        editingId ? `/scenarios/${editingId}` : '/scenarios',
        json(editingId ? 'PUT' : 'POST', payload),
      );
      await refresh();
      selectScenario(result.id);
      await saveSettings({ active_scenario: result.id });
      setEditor(null);
      notify('Scenario manifest saved locally. No hydraulic outputs were recomputed.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function importManifest(file: File) {
    try {
      if (file.size > 2_000_000)
        throw new Error('Scenario JSON limit is 2 MB. Import raster files in Data Management.');
      const value = JSON.parse(await file.text());
      const result = await request<Scenario>('/scenarios', json('POST', value));
      await refresh();
      selectScenario(result.id);
      notify('Scenario imported. All referenced dataset IDs were checked.');
    } catch (e) {
      notify((e as Error).message);
    }
  }
  const list = scenarios.filter((s) => s.mode === mode);
  return (
    <>
      <div className="panel-heading">
        <span className="eyebrow">LOCAL MODEL WORKSPACE</span>
        <h1>Scenario management</h1>
        <p>Keep assumptions separate from imported or illustrative results.</p>
      </div>
      <div className="button-row">
        <Button variant="default" onClick={() => edit()}>
          <Plus size={14} />
          Create scenario
        </Button>
        <Button asChild>
          <label className="file-button">
            <FileInput size={14} />
            Import manifest
            <input
              type="file"
              accept=".json"
              aria-label="Import scenario manifest"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importManifest(f);
                e.target.value = '';
              }}
            />
          </label>
        </Button>
      </div>
      {mode === 'demonstration' && (
        <div className="provenance">
          <h4>TERRAIN DEMONSTRATION</h4>
          <p>
            Illustrative scenarios spread an assumed river rise from imported river lines over the
            imported DEM, only into connected lower terrain. Not a hydraulic model or forecast.
          </p>
          <Button disabled={!canGenerate || generating} onClick={() => void generateTerrainDemo()}>
            <Mountain size={14} />
            {generating
              ? 'Generating from terrain…'
              : canGenerate
                ? 'Regenerate terrain demonstration'
                : 'Import a DEM and river lines first'}
          </Button>
        </div>
      )}
      <div className="scenario-list">
        {list.length ? (
          list.map((s) => (
            <article
              key={s.id}
              className={`scenario-record ${s.id === scenarioId ? 'active' : ''}`}
            >
              <div className="section-heading">
                <Badge tone={s.mode === 'demonstration' ? 'orange' : 'cyan'}>
                  {s.mode === 'demonstration' ? 'ILLUSTRATIVE' : s.status}
                </Badge>
                <small>{s.frames.length} frames</small>
              </div>
              <h3>{s.name}</h3>
              <p>
                {s.description ||
                  'Pending model run; add outputs after export from a hydraulic model.'}
              </p>
              <div className="scenario-meta">
                <span>{s.crs ?? 'No result grid'}</span>
                <span>
                  {s.time_step_seconds ? `${s.time_step_seconds / 60} min steps` : 'No time step'}
                </span>
              </div>
              <div className="button-row">
                <Button
                  size="sm"
                  variant={s.id === scenarioId ? 'default' : 'secondary'}
                  onClick={() => {
                    selectScenario(s.id);
                    void saveSettings({ active_scenario: s.id }).catch((e) => notify(e.message));
                  }}
                >
                  <FolderOpen size={13} />
                  {s.id === scenarioId ? 'Loaded' : 'Load'}
                </Button>
                <Button size="icon" aria-label={`Edit ${s.name}`} onClick={() => edit(s)}>
                  <Pencil size={13} />
                </Button>
                <Button
                  size="icon"
                  aria-label={`Rename ${s.name}`}
                  onClick={() => {
                    setRename(s);
                    setRenameValue(s.name);
                  }}
                >
                  <span className="mono">Aa</span>
                </Button>
                <Button
                  size="icon"
                  aria-label={`Duplicate ${s.name}`}
                  onClick={async () => {
                    try {
                      await request(`/scenarios/${s.id}/duplicate`, json('POST'));
                      await refresh();
                      notify('Scenario duplicated. Result datasets are shared by reference.');
                    } catch (e) {
                      notify((e as Error).message);
                    }
                  }}
                >
                  <Copy size={13} />
                </Button>
                <Button
                  size="icon"
                  aria-label={`Export ${s.name}`}
                  onClick={() =>
                    void download(`/scenarios/${s.id}/export`, `AgosPH-${s.id}.json`).catch((e) =>
                      notify(e.message),
                    )
                  }
                >
                  <Download size={13} />
                </Button>
                <Button
                  size="icon"
                  aria-label={`Delete ${s.name}`}
                  onClick={async () => {
                    try {
                      await request(`/scenarios/${s.id}`, { method: 'DELETE' });
                      await refresh();
                      notify('Scenario manifest deleted; referenced datasets retained.');
                    } catch (e) {
                      notify((e as Error).message);
                    }
                  }}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
              <small className="muted">Saved {dateTime(s.updated_at)}</small>
            </article>
          ))
        ) : (
          <Empty title="No scenarios in this mode">
            Create a pending scenario, then attach imported depth rasters in the editor.
          </Empty>
        )}
      </div>
      <Button
        size="sm"
        onClick={() =>
          downloadBlob(
            new Blob([JSON.stringify(newScenario(), null, 2)], { type: 'application/json' }),
            'AgosPH-scenario-template.json',
          )
        }
      >
        Download manifest template
      </Button>
      <div className="provenance">
        <h4>PORTABILITY</h4>
        <p>
          Manifests reference dataset IDs in this installation. To migrate, copy the entire data
          directory with AgosPH stopped. A manifest alone does not contain raster outputs.
        </p>
      </div>
      <Modal
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        title={editingId ? 'Edit scenario manifest' : 'Create a model scenario'}
        description="Assumptions are documentation. Saving them never generates hydraulic results."
        wide
      >
        {editor && (
          <form onSubmit={save} className="scenario-editor">
            <div className="form-grid">
              <Field label="Scenario name">
                <input
                  aria-label="Scenario name"
                  required
                  maxLength={100}
                  value={editor.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field label="Result status">
                <select
                  aria-label="Scenario result status"
                  value={editor.status}
                  disabled={editor.mode === 'demonstration'}
                  onChange={(e) => patch({ status: e.target.value as ScenarioInput['status'] })}
                >
                  {editor.mode === 'demonstration' ? (
                    <option value="illustrative">Illustrative demonstration</option>
                  ) : (
                    <>
                      <option value="pending">Pending model run</option>
                      <option value="unvalidated">Imported · unvalidated</option>
                      <option value="validated">User-asserted validated</option>
                    </>
                  )}
                </select>
              </Field>
            </div>
            <Field label="Description">
              <textarea
                value={editor.description}
                onChange={(e) => patch({ description: e.target.value })}
                rows={2}
              />
            </Field>
            <Field label="Source / provenance">
              <input
                aria-label="Scenario source"
                required
                value={editor.source}
                onChange={(e) => patch({ source: e.target.value })}
              />
            </Field>
            <div className="form-grid">
              <Field label="Hydraulic model">
                <input value={editor.model} onChange={(e) => patch({ model: e.target.value })} />
              </Field>
              <Field label="Model version">
                <input
                  value={editor.model_version}
                  onChange={(e) => patch({ model_version: e.target.value })}
                  placeholder="e.g. HEC-RAS 6.6"
                />
              </Field>
            </div>
            <Field label="Validation evidence / limitations">
              <textarea
                value={editor.validation_notes}
                onChange={(e) => patch({ validation_notes: e.target.value })}
                rows={2}
                required={editor.status === 'validated'}
              />
            </Field>
            <Field label="Input assumptions (JSON object)">
              <textarea
                className="code-input"
                aria-label="Scenario assumptions"
                value={assumptions}
                onChange={(e) => setAssumptions(e.target.value)}
                rows={3}
              />
            </Field>
            {editor.status !== 'pending' && (
              <>
                <div className="section-heading">
                  <h3>Temporal result frames</h3>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      const last = editor.frames.at(-1);
                      const timestamp = new Date(
                        last ? new Date(last.timestamp).getTime() + 1800000 : Date.now(),
                      ).toISOString();
                      patch({ frames: [...editor.frames, { timestamp, depth: '' }] });
                    }}
                  >
                    <Plus size={13} />
                    Add frame
                  </Button>
                </div>
                <p className="muted small">
                  Import raster datasets first. Grids and elapsed time steps must align. Units:
                  depth m; velocity m/s; direction degrees clockwise from north; WSE m in the
                  declared vertical datum.
                </p>
                {editor.frames.map((f, index) => (
                  <div key={index} className="frame-editor">
                    <div className="section-heading">
                      <strong>Frame {String(index + 1).padStart(2, '0')}</strong>
                      <Button
                        type="button"
                        size="icon"
                        aria-label={`Remove frame ${index + 1}`}
                        onClick={() =>
                          patch({ frames: editor.frames.filter((_, i) => i !== index) })
                        }
                      >
                        <X size={13} />
                      </Button>
                    </div>
                    <div className="form-grid">
                      <Field label="Timestamp (ISO with UTC offset)">
                        <input
                          required
                          value={f.timestamp}
                          onChange={(e) => patchFrame(index, { timestamp: e.target.value })}
                        />
                      </Field>
                      <Field label="Depth raster">
                        <select
                          required
                          value={f.depth}
                          onChange={(e) => patchFrame(index, { depth: e.target.value })}
                        >
                          <option value="">Select depth GeoTIFF</option>
                          {datasets
                            .filter((d) => d.role === 'depth' && d.mode === editor.mode)
                            .map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name}
                              </option>
                            ))}
                        </select>
                      </Field>
                    </div>
                    <details>
                      <summary>Velocity, direction & water surface</summary>
                      <div className="form-grid">
                        {(['velocity', 'direction', 'wse'] as const).map((metric) => (
                          <Field key={metric} label={metric}>
                            <select
                              value={f[metric] ?? ''}
                              onChange={(e) =>
                                patchFrame(index, { [metric]: e.target.value || null })
                              }
                            >
                              <option value="">Unavailable</option>
                              {datasets
                                .filter((d) => d.role === metric && d.mode === editor.mode)
                                .map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.name}
                                  </option>
                                ))}
                            </select>
                          </Field>
                        ))}
                      </div>
                    </details>
                  </div>
                ))}
              </>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={Object.keys(editor.settings).length > 0}
                onChange={(e) =>
                  patch({
                    settings: e.target.checked
                      ? { opacity: settings.opacity, layers: settings.layers }
                      : {},
                  })
                }
              />
              Save current layer visibility and opacity with this scenario
            </label>
            {error && (
              <div className="error-message" role="alert">
                {error}
              </div>
            )}
            <div className="button-row">
              <Button variant="default" type="submit" disabled={saving}>
                <Save size={14} />
                {saving ? 'Validating…' : 'Validate & save manifest'}
              </Button>
              <Button type="button" onClick={() => setEditor(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={!!rename}
        onOpenChange={(open) => {
          if (!open) setRename(null);
        }}
        title="Rename scenario"
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!rename) return;
            try {
              await request(`/scenarios/${rename.id}/rename`, json('PATCH', { name: renameValue }));
              await refresh();
              setRename(null);
              notify('Scenario renamed.');
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        >
          <Field label="Scenario name">
            <input
              autoFocus
              required
              value={renameValue}
              maxLength={100}
              onChange={(e) => setRenameValue(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="default">
            Save name
          </Button>
        </form>
      </Modal>
    </>
  );
}
