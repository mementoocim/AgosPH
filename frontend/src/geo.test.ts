import { describe, expect, it } from 'vitest';
import {
  chartSeries,
  layerBefore,
  mapLayers,
  pickScenario,
  riverClass,
  terrainSource,
} from './geo';
import type { Dataset, Scenario, Settings, Station } from './types';

const settings: Settings = {
  terrain_url: '',
  imagery_url: '',
  imagery_attribution: '',
  terrain_dataset: '',
  terrain_auto: true,
  exaggeration: 1,
  cameras: [],
  layers: {},
  opacity: 0.72,
  active_scenario: '',
  data_mode: 'demonstration',
};
function dataset(id: string, role: string, kind: Dataset['kind'], mode: Dataset['mode']): Dataset {
  return {
    id,
    name: `${role} fixture`,
    role,
    kind,
    mode,
    source: 'TEST FIXTURE',
    status: 'validated-format',
    crs: 'EPSG:4326',
    bounds: [121, 17, 122, 18],
    created_at: '2026-01-01T00:00:00Z',
    path: 'x',
    warnings: [],
    size_bytes: 1,
  };
}
const rivers = dataset('rivers', 'rivers', 'vector', 'imported');
const dem = dataset('dem', 'terrain', 'raster', 'imported');
const demoDepth = dataset('depth', 'depth', 'raster', 'demonstration');

describe('map layer selection', () => {
  it('shows imported reference geography in demonstration mode too', () => {
    expect(mapLayers([rivers, demoDepth], settings, 'demonstration', 0).map((l) => l.id)).toEqual([
      'rivers',
    ]);
  });
  it('never draws demonstration layers in imported mode', () => {
    const demoRoads = dataset('demo-roads', 'roads', 'vector', 'demonstration');
    expect(mapLayers([rivers, demoRoads], settings, 'imported', 0).map((l) => l.id)).toEqual([
      'rivers',
    ]);
  });
  it('keeps raster overlays off until enabled and honors hidden vector layers', () => {
    expect(mapLayers([dem], settings, 'imported', 0)).toEqual([]);
    const shown = { ...settings, layers: { terrain: { visible: true, opacity: 0.5 } } };
    expect(mapLayers([dem], shown, 'imported', 0)).toMatchObject([{ id: 'dem', opacity: 0.5 }]);
    const hidden = { ...settings, layers: { rivers: { visible: false, opacity: 0.7 } } };
    expect(mapLayers([rivers], hidden, 'imported', 0)).toEqual([]);
  });
});

describe('terrain provider selection', () => {
  it('uses an imported DEM automatically unless terrain is disabled', () => {
    expect(terrainSource(settings, [dem])).toEqual({
      kind: 'dataset',
      id: 'dem',
      name: 'terrain fixture',
      automatic: true,
    });
    expect(terrainSource({ ...settings, terrain_auto: false }, [dem])).toEqual({ kind: 'none' });
    expect(terrainSource(settings, [])).toEqual({ kind: 'none' });
  });
  it('prefers explicit providers', () => {
    expect(
      terrainSource({ ...settings, terrain_dataset: 'dem', terrain_auto: false }, [dem]),
    ).toEqual({ kind: 'dataset', id: 'dem', name: 'terrain fixture', automatic: false });
    expect(terrainSource({ ...settings, terrain_url: 'https://terrain.test/' }, [dem])).toEqual({
      kind: 'url',
      url: 'https://terrain.test/',
    });
  });
});

describe('priority rivers', () => {
  it('emphasizes the Cagayan, Pinacanauan de Ilagan, Abuan and Bintacan rivers', () => {
    expect(riverClass({ name: 'Abuan River', waterway: 'river' })).toBe('priority');
    expect(riverClass({ name: 'Ilagan River', waterway: 'river' })).toBe('priority');
    expect(riverClass({ name: 'Pinacanauan de Ilagan River' })).toBe('priority');
    expect(riverClass({ name: 'Siffu River', waterway: 'river' })).toBe('river');
    expect(riverClass({ name: 'Rivers · OSM way/1', waterway: 'stream' })).toBe('minor');
  });
});

describe('monitoring chart series', () => {
  const station = (id: string, reading: Partial<Station['history'][number]>): Station => ({
    id,
    name: id,
    latest: null,
    thresholds: { watch: 1, warning: 2, critical: 3 },
    connected: true,
    severity: 'normal',
    history: [
      { timestamp: '2026-01-01T00:00:00Z', station_id: id, name: id, source: 'x', ...reading },
    ],
    longitude: null,
    latitude: null,
    source: 'x',
  });
  it('charts water level when a gauge exists and rainfall otherwise', () => {
    const rain = station('rain', { rainfall_mm: 3 });
    const gauge = station('gauge', { water_level_m: 1.2 });
    expect(chartSeries([rain, gauge])).toEqual({ station: gauge, metric: 'water_level_m' });
    expect(chartSeries([rain])).toEqual({ station: rain, metric: 'rainfall_mm' });
    expect(chartSeries([rain, gauge], 'rain')).toEqual({ station: rain, metric: 'rainfall_mm' });
    expect(chartSeries([])).toBeNull();
  });
});

describe('default scenario selection', () => {
  const scenario = (id: string, featured = false): Scenario =>
    ({
      id,
      mode: 'demonstration',
      frames: [],
      settings: featured ? { featured } : {},
    }) as unknown as Scenario;
  it('prefers the saved scenario, then a featured one, then the first', () => {
    const list = [scenario('lab'), scenario('terrain', true)];
    expect(pickScenario(list, 'demonstration', 'lab')?.id).toBe('lab');
    expect(pickScenario(list, 'demonstration', '')?.id).toBe('terrain');
    expect(pickScenario([scenario('lab')], 'demonstration', 'missing')?.id).toBe('lab');
    expect(pickScenario(list, 'imported', '')).toBeUndefined();
  });
});

describe('2D layer stacking', () => {
  const overlays = [
    'basemap',
    'ref-roads-fill',
    'ref-roads-line',
    'ref-roads-point',
    'stations',
    'incidents',
  ];
  it('puts a reference raster beneath vectors, stations and incidents when no flood surface exists', () => {
    expect(layerBefore(overlays, 'ref-dem-raster')).toBe('ref-roads-fill');
    expect(layerBefore(['basemap', 'stations', 'incidents'], 'ref-dem-raster')).toBe('stations');
  });
  it('keeps reference rasters beneath the flood surface', () => {
    expect(layerBefore(['basemap', 'flood', ...overlays.slice(1)], 'ref-dem-raster')).toBe('flood');
  });
  it('stacks a second raster above the first and vectors beneath stations', () => {
    expect(layerBefore(['basemap', 'ref-dem-raster', 'stations'], 'ref-rain-raster')).toBe(
      'stations',
    );
    expect(layerBefore(['basemap', 'flood', ...overlays.slice(1)], 'ref-rivers-fill')).toBe(
      'stations',
    );
    expect(layerBefore(['basemap'], 'ref-dem-raster')).toBeUndefined();
  });
});
