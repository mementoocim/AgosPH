import { useEffect, useRef, useState } from 'react';
import { Crosshair, LocateFixed, Pencil, Plus, Save, Siren, Trash2 } from 'lucide-react';
import { useApp } from '../store';
import { dateTime, json, request } from '../api';
import { fromPhtInput, severityTones, statusLabels, toPhtInput } from '../incidents';
import {
  incidentSeverities,
  incidentStatuses,
  incidentTypes,
  type Barangays,
  type Incident,
  type IncidentInput,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentType,
  type Mode,
} from '../types';
import type { MapHandle } from './GeoMap';
import { Badge, Button, Empty, Field, Modal } from './ui';

interface Draft {
  type: IncidentType;
  severity: IncidentSeverity;
  title: string;
  description: string;
  barangay: string;
  longitude: string;
  latitude: string;
  reporter: string;
  reported: string;
}
const blank = (): Draft => ({
  type: 'flooding',
  severity: 'moderate',
  title: '',
  description: '',
  barangay: '',
  longitude: '',
  latitude: '',
  reporter: '',
  reported: toPhtInput(new Date().toISOString()),
});
const draftOf = (incident: Incident): Draft => ({
  type: incident.type,
  severity: incident.severity,
  title: incident.title,
  description: incident.description,
  barangay: incident.barangay,
  longitude: incident.longitude == null ? '' : String(incident.longitude),
  latitude: incident.latitude == null ? '' : String(incident.latitude),
  reporter: incident.reporter,
  reported: toPhtInput(incident.reported_at),
});
// Six decimals is about 0.1 m, finer than a map click can place a report.
const coordinate = (value: number) => String(Math.round(value * 1e6) / 1e6);
const optional = (value: string) => (value.trim() === '' ? null : Number(value));
/** The record being edited (none for a new one) and the data mode fixed when the form opened. */
type DialogTarget = { incident: Incident | null; mode: Mode } | null;
const upsert = (record: Incident) => (incidents: Incident[]) =>
  incidents.some((i) => i.id === record.id)
    ? incidents.map((i) => (i.id === record.id ? record : i))
    : [record, ...incidents];
/** Shows a saved change at once; a failed refresh afterwards never makes the save look failed. */
function settle(change: (incidents: Incident[]) => Incident[], message: string) {
  const { incidents, set, refresh, notify } = useApp.getState();
  set({ incidents: change(incidents) });
  notify(message);
  refresh().catch((e) => notify(`${message} The workspace did not refresh: ${e.message}`));
}

function IncidentDialog({ target, onClose }: { target: DialogTarget; onClose: () => void }) {
  const { picking, picked, set } = useApp();
  const [draft, setDraft] = useState<Draft>(blank),
    [barangays, setBarangays] = useState<Barangays | null>(null),
    [located, setLocated] = useState(''),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  // An untouched report time on edit keeps the stored time; a new report keeps the time shown.
  const initialReported = useRef('');
  const generation = useRef(0),
    picks = useRef(0);
  const editing = target?.incident ?? null;
  // Fixed when the form opened: switching data mode while picking never relabels the draft.
  const exercise = target?.mode === 'demonstration';
  const patch = (changes: Partial<Draft>) => setDraft((d) => ({ ...d, ...changes }));
  useEffect(() => {
    if (!target) return;
    const current = ++generation.current;
    picks.current++;
    const next = target.incident ? draftOf(target.incident) : blank();
    setDraft(next);
    initialReported.current = next.reported;
    setError('');
    setLocated('');
    setBarangays(null);
    request<Barangays>('/barangays')
      .then((value) => current === generation.current && setBarangays(value))
      .catch(() => {});
  }, [target]);
  useEffect(() => {
    if (!picked || !target) return;
    set({ picked: null });
    // Only the latest pick may fill the form; a slow lookup for an earlier point is dropped.
    const current = ++picks.current;
    const longitude = coordinate(picked.longitude),
      latitude = coordinate(picked.latitude);
    patch({ longitude, latitude });
    request<Barangays>(`/barangays?longitude=${longitude}&latitude=${latitude}`)
      .then((value) => {
        if (current !== picks.current || !value.available) return;
        setLocated(
          value.containing
            ? `Map point lies within ${value.containing} (imported boundary).`
            : 'Map point lies outside the imported barangay boundaries.',
        );
        if (value.containing)
          setDraft((d) => (d.barangay ? d : { ...d, barangay: value.containing! }));
      })
      .catch(() => {});
  }, [picked, target, set]);
  useEffect(() => {
    if (!picking) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') set({ picking: false });
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [picking, set]);
  useEffect(() => () => useApp.getState().set({ picking: false, picked: null }), []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!target) return;
    setSaving(true);
    setError('');
    try {
      const payload: IncidentInput = {
        type: draft.type,
        severity: draft.severity,
        title: draft.title,
        description: draft.description,
        barangay: draft.barangay,
        longitude: optional(draft.longitude),
        latitude: optional(draft.latitude),
        reporter: draft.reporter,
        reported_at:
          draft.reported && (!editing || draft.reported !== initialReported.current)
            ? fromPhtInput(draft.reported)
            : null,
        mode: target.mode,
      };
      const record = await request<Incident>(
        editing ? `/incidents/${editing.id}` : '/incidents',
        json(editing ? 'PUT' : 'POST', payload),
      );
      onClose();
      settle(
        upsert(record),
        exercise
          ? 'Exercise incident saved locally. Nothing was transmitted.'
          : 'Incident saved to the local operator log. Nothing was transmitted.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const names = barangays?.names ?? [];
  return (
    <Modal
      open={!!target && !picking}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={editing ? 'Edit incident' : 'Log incident'}
      description={
        exercise
          ? 'Demonstration mode saves an EXERCISE record for drills. It is not a real incident and nothing is transmitted.'
          : 'A user-entered field report kept on this computer. It stays unverified until you mark it verified; nothing is transmitted.'
      }
      wide
    >
      <form onSubmit={save} className="incident-editor">
        <div className={`source-banner ${exercise ? '' : 'operator-banner'}`}>
          <Siren size={14} />
          {exercise ? 'EXERCISE · DEMONSTRATION MODE' : 'OPERATOR LOG · USER-ENTERED'}
        </div>
        <div className="form-grid">
          <Field label="Type">
            <select
              aria-label="Incident type"
              value={draft.type}
              onChange={(e) => patch({ type: e.target.value as IncidentType })}
            >
              {Object.entries(incidentTypes).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Severity">
            <select
              aria-label="Incident severity"
              value={draft.severity}
              onChange={(e) => patch({ severity: e.target.value as IncidentSeverity })}
            >
              {incidentSeverities.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Title">
          <input
            aria-label="Incident title"
            required
            maxLength={120}
            placeholder="e.g. Knee-deep water on the national highway"
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </Field>
        <Field label="Details">
          <textarea
            aria-label="Incident description"
            rows={3}
            maxLength={3000}
            value={draft.description}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </Field>
        <div className="form-grid">
          <Field
            label="Barangay"
            hint={
              barangays?.available
                ? `Checked against ${names.length} imported barangay boundaries.`
                : barangays
                  ? 'No barangay boundary layer imported · saved as typed and marked unchecked.'
                  : 'Loading imported boundary names…'
            }
          >
            <input
              aria-label="Barangay"
              list="incident-barangays"
              maxLength={100}
              value={draft.barangay}
              onChange={(e) => patch({ barangay: e.target.value })}
            />
            <datalist id="incident-barangays">
              {names.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </Field>
          <Field label="Reported by" hint="Caller, office, or radio channel.">
            <input
              aria-label="Reported by"
              required
              maxLength={200}
              value={draft.reporter}
              onChange={(e) => patch({ reporter: e.target.value })}
            />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Longitude (WGS 84)">
            <input
              aria-label="Longitude"
              type="number"
              step="any"
              min={-180}
              max={180}
              value={draft.longitude}
              onChange={(e) => patch({ longitude: e.target.value })}
            />
          </Field>
          <Field label="Latitude (WGS 84)">
            <input
              aria-label="Latitude"
              type="number"
              step="any"
              min={-90}
              max={90}
              value={draft.latitude}
              onChange={(e) => patch({ latitude: e.target.value })}
            />
          </Field>
        </div>
        <div className="button-row">
          <Button type="button" size="sm" onClick={() => set({ picking: true, picked: null })}>
            <Crosshair size={13} />
            Pick location on map
          </Button>
          {(draft.longitude || draft.latitude) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                patch({ longitude: '', latitude: '' });
                setLocated('');
              }}
            >
              Clear location
            </Button>
          )}
        </div>
        {located && <p className="muted small">{located}</p>}
        <Field label="Reported at (PHT, UTC+08:00)">
          <input
            aria-label="Reported at (PHT)"
            type="datetime-local"
            min="2000-01-01T00:00"
            required
            value={draft.reported}
            onChange={(e) => patch({ reported: e.target.value })}
          />
        </Field>
        {error && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        <div className="button-row">
          <Button variant="default" type="submit" disabled={saving}>
            <Save size={14} />
            {saving
              ? 'Saving…'
              : editing
                ? 'Save changes'
                : exercise
                  ? 'Save exercise incident'
                  : 'Save incident'}
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function IncidentRecord({
  incident,
  map,
  onEdit,
  editable,
}: {
  incident: Incident;
  map: MapHandle | null;
  onEdit: () => void;
  editable: boolean;
}) {
  const { notify } = useApp();
  const [confirm, setConfirm] = useState<'' | 'resolve' | 'delete'>(''),
    [busy, setBusy] = useState(false);
  const rank = incidentStatuses.indexOf(incident.status);
  async function act(
    init: RequestInit,
    message: string,
    change: (result: Incident) => (incidents: Incident[]) => Incident[],
  ) {
    setBusy(true);
    try {
      settle(change(await request<Incident>(`/incidents/${incident.id}`, init)), message);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
      setConfirm('');
    }
  }
  const advance = (status: IncidentStatus) =>
    act(
      json('PATCH', { status }),
      `Incident marked ${statusLabels[status].toLowerCase()}.`,
      upsert,
    );
  return (
    <article
      className={`incident-record severity-${incident.severity} ${incident.status === 'resolved' ? 'resolved' : ''}`}
    >
      <div className="incident-heading">
        <span className={`incident-dot severity-${incident.severity}`} aria-hidden="true" />
        <h3>{incident.title}</h3>
      </div>
      <p className="incident-meta">
        {incidentTypes[incident.type]} · {incident.barangay || 'Barangay not stated'}
      </p>
      <div className="incident-badges">
        <Badge tone={incident.mode === 'demonstration' ? 'orange' : 'cyan'}>{incident.label}</Badge>
        <Badge tone={severityTones[incident.severity]}>{incident.severity.toUpperCase()}</Badge>
        {incident.barangay && !incident.barangay_validated && <Badge>UNCHECKED BARANGAY</Badge>}
        {incident.longitude == null && <Badge>NO MAP LOCATION</Badge>}
      </div>
      {incident.description && <p className="incident-description">{incident.description}</p>}
      <small className="incident-source">
        {incident.reporter} · {dateTime(incident.reported_at)}
      </small>
      {confirm ? (
        <div className="incident-confirm">
          <span>
            {confirm === 'delete'
              ? 'Delete this record permanently?'
              : 'Resolved incidents cannot be reopened.'}
          </span>
          <Button
            size="sm"
            variant={confirm === 'delete' ? 'danger' : 'default'}
            disabled={busy}
            onClick={() =>
              void (confirm === 'delete'
                ? act(
                    { method: 'DELETE' },
                    'Incident deleted from the local log.',
                    () => (incidents) => incidents.filter((i) => i.id !== incident.id),
                  )
                : advance('resolved'))
            }
          >
            {confirm === 'delete' ? 'Confirm delete' : 'Confirm resolve'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm('')}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="button-row">
          <select
            aria-label={`Status of ${incident.title}`}
            value={incident.status}
            disabled={busy || incident.status === 'resolved'}
            onChange={(e) => {
              const status = e.target.value as IncidentStatus;
              if (status === 'resolved') setConfirm('resolve');
              else void advance(status);
            }}
          >
            {incidentStatuses.map((status, index) => (
              <option key={status} value={status} disabled={index < rank}>
                {statusLabels[status]}
              </option>
            ))}
          </select>
          <Button
            size="icon"
            aria-label={`Locate ${incident.title}`}
            disabled={incident.longitude == null || !map}
            onClick={() => map?.flyTo(incident.longitude!, incident.latitude!, 2500)}
          >
            <LocateFixed size={13} />
          </Button>
          <Button
            size="icon"
            aria-label={`Edit ${incident.title}`}
            disabled={!editable}
            onClick={onEdit}
          >
            <Pencil size={13} />
          </Button>
          <Button
            size="icon"
            aria-label={`Delete ${incident.title}`}
            disabled={busy}
            onClick={() => setConfirm('delete')}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      )}
    </article>
  );
}

export function IncidentLog({ map }: { map: MapHandle | null }) {
  const { incidents, mode, picking } = useApp();
  const [status, setStatus] = useState<'open' | 'all' | IncidentStatus>('open'),
    [severity, setSeverity] = useState<'all' | IncidentSeverity>('all'),
    [target, setTarget] = useState<DialogTarget>(null);
  // Exercise records and operator reports are never listed together.
  const current = incidents.filter((i) => i.mode === mode);
  const open = current.filter((i) => i.status !== 'resolved');
  const shown = current.filter(
    (i) =>
      (status === 'all' || (status === 'open' ? i.status !== 'resolved' : i.status === status)) &&
      (severity === 'all' || i.severity === severity),
  );
  return (
    <>
      <div className="section-heading">
        <h3>
          Incident log
          <Badge
            tone={
              open.some((i) => i.severity === 'critical')
                ? 'red'
                : open.length
                  ? 'orange'
                  : 'neutral'
            }
          >
            {open.length} OPEN
          </Badge>
        </h3>
        <Button
          size="sm"
          variant="default"
          disabled={picking}
          onClick={() => setTarget({ incident: null, mode })}
        >
          <Plus size={13} />
          Log incident
        </Button>
      </div>
      <div className="incident-toolbar">
        <select
          aria-label="Filter incident status"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          <option value="open">Open</option>
          <option value="all">All statuses</option>
          {incidentStatuses.map((s) => (
            <option key={s} value={s}>
              {statusLabels[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter incident severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as typeof severity)}
        >
          <option value="all">All severities</option>
          {incidentSeverities.map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      </div>
      <div className="incident-list">
        {shown.length ? (
          shown.map((incident) => (
            <IncidentRecord
              key={incident.id}
              incident={incident}
              map={map}
              editable={!picking}
              onEdit={() => setTarget({ incident, mode: incident.mode })}
            />
          ))
        ) : (
          <Empty title={current.length ? 'No matching incidents' : 'No incidents logged'}>
            {mode === 'demonstration'
              ? 'Log drill reports here. Demo mode saves them as EXERCISE records.'
              : 'Log field reports as they arrive. Records stay on this computer; nothing is transmitted.'}
          </Empty>
        )}
      </div>
      <IncidentDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}
