import { stationKey } from './readings';
import type { Dataset, Mode, Scenario, Settings, Station } from './types';

export interface LayerSpec {
  id: string;
  version: string;
  role: string;
  kind: 'vector' | 'raster';
  name: string;
  bounds: number[] | null;
  opacity: number;
}
const rasterLayers = ['terrain', 'rainfall'];
/** Imported reference geography is drawn in both modes; demonstration layers only in demo mode. */
export function referenceDatasets(datasets: Dataset[], mode: Mode) {
  return datasets.filter((d) => d.mode === 'imported' || d.mode === mode);
}
export function mapLayers(
  datasets: Dataset[],
  settings: Settings,
  mode: Mode,
  rainfallIndex: number,
): LayerSpec[] {
  const rainFrames = rainfallFrames(datasets, mode);
  return referenceDatasets(datasets, mode)
    .filter((d) =>
      d.kind === 'vector'
        ? settings.layers[d.role]?.visible !== false
        : d.kind === 'raster' &&
          rasterLayers.includes(d.role) &&
          !!settings.layers[d.role]?.visible &&
          (!(d.role === 'rainfall' && d.observation_timestamp) ||
            d.id === rainFrames[rainfallIndex]?.id),
    )
    .map((d) => ({
      id: d.id,
      version: d.replaced_at ?? d.created_at,
      role: d.role,
      kind: d.kind as LayerSpec['kind'],
      name: d.name,
      bounds: d.bounds,
      opacity: settings.layers[d.role]?.opacity ?? 0.7,
    }));
}
export function rainfallFrames(datasets: Dataset[], mode: Mode) {
  return referenceDatasets(datasets, mode)
    .filter((d) => d.role === 'rainfall' && d.kind === 'raster' && d.observation_timestamp)
    .sort(
      (a, b) =>
        new Date(a.observation_timestamp!).getTime() - new Date(b.observation_timestamp!).getTime(),
    );
}

export type TerrainSource =
  | { kind: 'url'; url: string }
  | { kind: 'dataset'; id: string; name: string; automatic: boolean }
  | { kind: 'none' };
export function terrainSource(settings: Settings, datasets: Dataset[]): TerrainSource {
  if (settings.terrain_url) return { kind: 'url', url: settings.terrain_url };
  const dems = datasets.filter(
    (d) => d.role === 'terrain' && d.kind === 'raster' && d.mode === 'imported',
  );
  const chosen = dems.find((d) => d.id === settings.terrain_dataset);
  if (chosen) return { kind: 'dataset', id: chosen.id, name: chosen.name, automatic: false };
  const first = [...dems].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (settings.terrain_auto !== false && first)
    return { kind: 'dataset', id: first.id, name: first.name, automatic: true };
  return { kind: 'none' };
}

const priorityRivers = /\b(cagayan|ilagan|pinacanauan|abuan|bintacan)\b/i;
/** Visual weight for river lines; the CDRRMO priority rivers are emphasized. */
export function riverClass(properties: Record<string, unknown> | null | undefined) {
  const name = String(properties?.name ?? '');
  if (priorityRivers.test(name) && !name.includes('OSM way/')) return 'priority';
  return properties?.waterway === 'river' ? 'river' : 'minor';
}

export function chartSeries(stations: Station[], preferred = '') {
  const has = (s: Station, key: 'water_level_m' | 'rainfall_mm') =>
    s.history.some((r) => r[key] != null);
  const station =
    stations.find((s) => stationKey(s) === preferred) ??
    stations.find((s) => has(s, 'water_level_m')) ??
    stations[0];
  if (!station) return null;
  return {
    station,
    metric: has(station, 'water_level_m') ? ('water_level_m' as const) : ('rainfall_mm' as const),
  };
}

export function pickScenario(scenarios: Scenario[], mode: Mode, preferred = '') {
  const available = scenarios.filter((s) => s.mode === mode);
  return (
    available.find((s) => s.id === preferred) ??
    available.find((s) => s.settings?.featured === true) ??
    available[0]
  );
}

/** 2D draw order, bottom to top: basemap, reference rasters, flood surface, reference vectors, stations, incidents. */
function stackRank(id: string) {
  if (id.startsWith('ref-')) return id.endsWith('-raster') ? 1 : 3;
  return ({ flood: 2, stations: 4, incidents: 5 } as Record<string, number>)[id] ?? 0;
}
/** The existing MapLibre layer to insert a new layer beneath so that order holds (none: on top). */
export function layerBefore(layerIds: string[], id: string) {
  return layerIds.find((other) => stackRank(other) > stackRank(id));
}
