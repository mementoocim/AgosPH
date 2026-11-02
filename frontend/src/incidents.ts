import type { Incident, IncidentSeverity, IncidentStatus, Mode } from './types';

/** Monitoring palette: moderate = watch, high = warning, critical = critical; low uses the rainfall blue. */
export const incidentColors: Record<IncidentSeverity, string> = {
  low: '#7db6e9',
  moderate: '#f4d36b',
  high: '#f0a85a',
  critical: '#ef6a5b',
};
export const resolvedColor = '#8897a3';
export const severityTones: Record<IncidentSeverity, string> = {
  low: 'blue',
  moderate: 'yellow',
  high: 'orange',
  critical: 'red',
};
export const statusLabels: Record<IncidentStatus, string> = {
  reported: 'Reported',
  verified: 'Verified',
  responding: 'Responding',
  resolved: 'Resolved',
};

// The Philippines keeps UTC+08:00 all year, so PHT form values convert without a zone database.
const PHT = 8 * 3600_000;
export function toPhtInput(value: string) {
  return new Date(new Date(value).getTime() + PHT).toISOString().slice(0, 16);
}
export function fromPhtInput(value: string) {
  return `${value.length === 16 ? `${value}:00` : value}+08:00`;
}

export interface IncidentMarker {
  id: string;
  longitude: number;
  latitude: number;
  title: string;
  color: string;
  caption: string;
  resolved: boolean;
}
/** Map markers for located incidents of one data mode; exercise markers carry their label. */
export function incidentMarkers(incidents: Incident[], mode: Mode): IncidentMarker[] {
  return incidents
    .filter((i) => i.mode === mode && i.longitude != null && i.latitude != null)
    .map((i) => ({
      id: i.id,
      longitude: i.longitude!,
      latitude: i.latitude!,
      title: i.title,
      color: i.status === 'resolved' ? resolvedColor : incidentColors[i.severity],
      caption: i.mode === 'demonstration' ? 'EXERCISE' : '',
      resolved: i.status === 'resolved',
    }));
}
