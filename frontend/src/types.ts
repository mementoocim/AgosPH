export type Mode = 'demonstration' | 'imported';
export type Metric =
  'depth' | 'velocity' | 'direction' | 'extent' | 'maximum' | 'arrival' | 'duration' | 'wse';
export type View =
  | 'command'
  | 'simulation'
  | 'monitoring'
  | 'rainfall'
  | 'exposure'
  | 'scenarios'
  | 'data'
  | 'reports'
  | 'settings';
export interface Frame {
  timestamp: string;
  depth: string;
  velocity?: string | null;
  direction?: string | null;
  wse?: string | null;
}
export interface ScenarioInput {
  name: string;
  description: string;
  mode: Mode;
  status: 'illustrative' | 'unvalidated' | 'validated' | 'pending';
  source: string;
  model: string;
  model_version: string;
  validation_notes: string;
  assumptions: Record<string, unknown>;
  frames: Frame[];
  settings: Record<string, unknown>;
}
export interface Scenario extends ScenarioInput {
  id: string;
  updated_at: string;
  time_step_seconds: number | null;
  crs: string | null;
  bounds: number[] | null;
  format_validation: string;
  validation_label: string;
}
export interface Dataset {
  id: string;
  name: string;
  role: string;
  kind: 'raster' | 'vector' | 'timeseries';
  mode: Mode;
  source: string;
  status: string;
  crs: string | null;
  bounds: number[] | null;
  created_at: string;
  replaced_at?: string;
  path: string;
  warnings: string[];
  unit?: string;
  width?: number;
  height?: number;
  minimum?: number;
  maximum?: number;
  feature_count?: number;
  record_count?: number;
  size_bytes: number;
  records?: Reading[];
  observation_timestamp?: string;
}
export interface Reading {
  timestamp: string;
  station_id: string;
  name: string;
  water_level_m?: number;
  rainfall_mm?: number;
  discharge_m3s?: number;
  source: string;
  longitude?: number;
  latitude?: number;
  rainfall_interval_minutes?: number;
  /** Live readings only: server receipt time and the channel that delivered them. */
  received_at?: string;
  channel?: string;
  units?: Record<string, string>;
}
export interface Thresholds {
  watch: number;
  warning: number;
  critical: number;
}
/** Live comes only from authorized ingestion; replay and demonstration data never become live. */
export type DataClass = 'demonstration' | 'replay' | 'live';
export type Freshness = 'live' | 'stale' | 'unavailable';
export interface Station {
  id: string;
  name: string;
  data_class: DataClass;
  latest: Reading | null;
  /** Null for a live station until an operator saves station-specific thresholds. */
  thresholds: Thresholds | null;
  connected: boolean;
  severity: string;
  history: Reading[];
  longitude: number | null;
  latitude: number | null;
  source: string;
  freshness?: Freshness;
  received_at?: string;
  age_seconds?: number;
}
export interface LiveTelemetry {
  ingest: { enabled: boolean; endpoint: string; detail: string };
  stale_after_minutes: number;
  unavailable_after_minutes: number;
  evaluated_at: string;
  stations: Station[];
}
export interface MonitoringAdapter {
  name: string;
  transport: 'push' | 'pull';
  enabled: boolean;
  detail: string;
}
export interface Monitoring {
  mode: Mode;
  label: string;
  index: number;
  steps: number;
  timestamp: string | null;
  stations: Station[];
  rainfall_scenario: 'steady' | 'intense';
  live: LiveTelemetry;
  adapters: MonitoringAdapter[];
  updated_at: string;
}
export interface AlertRecord {
  id: string;
  station_id: string;
  station_name: string;
  severity: string;
  status: 'active' | 'acknowledged' | 'resolved';
  /** 'live' alerts come from authorized readings; demonstration/imported alerts are TEST exercises. */
  mode: Mode | 'live';
  label: string;
  message: string;
  water_level_m: number | null;
  measurement_timestamp: string | null;
  created_at: string;
  updated_at: string;
  source: string;
  threshold_m?: number;
  received_at?: string;
  channel?: string;
}
export interface Settings {
  terrain_url: string;
  imagery_url: string;
  imagery_attribution: string;
  terrain_dataset: string;
  terrain_auto: boolean;
  exaggeration: number;
  cameras: CameraPosition[];
  layers: Record<string, { visible: boolean; opacity: number }>;
  opacity: number;
  active_scenario: string;
  data_mode: Mode;
}
export interface CameraPosition {
  name: string;
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
}
export interface Inspection {
  longitude: number;
  latitude: number;
  timestamp: string;
  scenario: string;
  mode: Mode;
  source: string;
  validation_status: string;
  inside_model: boolean;
  values: {
    depth: number | null;
    velocity: number | null;
    direction: number | null;
    wse: number | null;
  };
  arrival_minutes: number | null;
  peak_depth_m: number | null;
  peak_timestamp?: string | null;
  elevation?: number | null;
}
export interface ExposureFeature {
  dataset: string;
  role: string;
  name: string;
  maximum_depth_m: number | null;
  inundation_area_m2: number | null;
  inundated_length_m: number | null;
  inundated_share?: number;
  flooded_buildings?: number | null;
  flooded_road_length_m?: number | null;
}
export interface Exposure {
  scenario_id: string;
  scenario_name: string;
  mode: Mode;
  reference_geography: Mode;
  source: string;
  timestamp: string;
  frame: number;
  inundation_area_m2: number;
  maximum_depth_m: number | null;
  wet_cells: number;
  valid_cells: number;
  counts: Record<string, number | null>;
  totals: Record<string, number | null>;
  features: ExposureFeature[];
  categories: { label: string; area_m2: number; cells: number }[];
  unavailable: string[];
  method: string;
  sources: { name: string; source: string; mode: Mode }[];
}
export type IncidentType =
  'flooding' | 'landslide' | 'road_closure' | 'rescue_request' | 'evacuation' | 'other';
export type IncidentSeverity = 'low' | 'moderate' | 'high' | 'critical';
export type IncidentStatus = 'reported' | 'verified' | 'responding' | 'resolved';
export interface IncidentInput {
  type: IncidentType;
  title: string;
  description: string;
  severity: IncidentSeverity;
  barangay: string;
  longitude: number | null;
  latitude: number | null;
  reporter: string;
  reported_at: string | null;
  mode: Mode;
}
export interface Incident extends Omit<IncidentInput, 'reported_at'> {
  id: string;
  label: string;
  status: IncidentStatus;
  barangay_validated: boolean;
  reported_at: string;
  history: { status: IncidentStatus; at: string }[];
  created_at: string;
  updated_at: string;
}
export interface Barangays {
  available: boolean;
  names: string[];
  containing: string | null;
  sources: string[];
}
export const incidentTypes: Record<IncidentType, string> = {
  flooding: 'Flooding',
  landslide: 'Landslide',
  road_closure: 'Road closure',
  rescue_request: 'Rescue request',
  evacuation: 'Evacuation',
  other: 'Other',
};
export const incidentSeverities: IncidentSeverity[] = ['low', 'moderate', 'high', 'critical'];
export const incidentStatuses: IncidentStatus[] = [
  'reported',
  'verified',
  'responding',
  'resolved',
];
export const roles = [
  'boundaries',
  'rivers',
  'roads',
  'bridges',
  'buildings',
  'facilities',
  'inundation',
  'depth',
  'velocity',
  'direction',
  'wse',
  'terrain',
  'rainfall',
  'monitoring',
  'hydrograph',
];
export const metricLabels: Record<Metric, string> = {
  depth: 'Flood depth',
  velocity: 'Velocity',
  direction: 'Flow direction',
  extent: 'Inundation extent',
  maximum: 'Maximum depth',
  arrival: 'Arrival time',
  duration: 'Flood duration',
  wse: 'Water surface elevation',
};
