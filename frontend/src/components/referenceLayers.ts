import * as C from 'cesium';
import type { FilterSpecification, Map as LibreMap, LayerSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import { request } from '../api';
import { layerBefore, riverClass, type LayerSpec } from '../geo';

export const layerColors: Record<string, string> = {
  rivers: '#57c7dd',
  boundaries: '#a9c19f',
  roads: '#dec292',
  bridges: '#f0a85a',
  buildings: '#a0adbb',
  facilities: '#f4b76b',
  inundation: '#5bbfea',
  rainfall: '#8f95ed',
};
const priorityRiver = '#3fdcff';

export interface MountedLayer {
  version: string;
  setOpacity: (opacity: number) => void;
  dispose: () => void;
}

// GeoJSON is fetched once per dataset version and reused across toggles and refreshes.
const collections = new Map<string, Promise<FeatureCollection>>();
function load(spec: LayerSpec) {
  const key = `${spec.id}:${spec.version}`;
  if (!collections.has(key))
    collections.set(
      key,
      request<FeatureCollection>(`/datasets/${spec.id}/geojson`).catch((error) => {
        collections.delete(key);
        throw error;
      }),
    );
  return collections.get(key)!;
}

const polygonal = (g: Geometry | null) => g?.type === 'Polygon' || g?.type === 'MultiPolygon';
function rings(g: Geometry): Position[][] {
  if (g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') return g.coordinates.flat();
  return [];
}
function anchor(g: Geometry): Position | null {
  if (g.type === 'Point') return g.coordinates;
  const line =
    g.type === 'LineString'
      ? g.coordinates
      : g.type === 'MultiLineString'
        ? [...g.coordinates].sort((a, b) => b.length - a.length)[0]
        : null;
  if (line?.length) return line[Math.floor(line.length / 2)];
  const ring = rings(g)[0];
  if (!ring?.length) return null;
  const sum = ring.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}
function longest(features: Feature[]) {
  const size = (f: Feature) =>
    f.geometry.type === 'LineString'
      ? f.geometry.coordinates.length
      : f.geometry.type === 'MultiLineString'
        ? f.geometry.coordinates.flat().length
        : 0;
  return [...features].sort((a, b) => size(b) - size(a))[0];
}
/** Label anchors: priority rivers once per name, barangays, and named facilities. */
function labels(spec: LayerSpec, data: FeatureCollection) {
  const named = data.features.filter((f) => f.geometry && f.properties?.name);
  if (spec.role === 'rivers') {
    const byName = new Map<string, Feature[]>();
    for (const f of named)
      if (riverClass(f.properties) === 'priority')
        byName.set(f.properties!.name, [...(byName.get(f.properties!.name) ?? []), f]);
    return [...byName].map(([name, features]) => ({
      name,
      at: anchor(longest(features).geometry),
    }));
  }
  if (['boundaries', 'facilities'].includes(spec.role))
    return named.map((f) => ({ name: String(f.properties!.name), at: anchor(f.geometry) }));
  return [];
}

export function mountLayer(
  spec: LayerSpec,
  viewer: C.Viewer | null,
  map: LibreMap | null,
  render: () => void,
  onError: (message: string) => void,
): MountedLayer {
  let disposed = false,
    opacity = spec.opacity,
    restyle = () => {};
  const cleanups: (() => void)[] = [];
  const color = layerColors[spec.role] ?? '#69c8d5';
  const live = () => !disposed && (!viewer || !viewer.isDestroyed());

  async function mountCesium(data: FeatureCollection, v: C.Viewer) {
    const options = {
      clampToGround: true,
      markerColor: C.Color.fromCssColorString(color),
      markerSize: 22,
    };
    // Polygon outlines are unsupported on terrain: fill polygons, and draw rings as ground polylines.
    const fills = data.features.filter((f) => polygonal(f.geometry));
    const lines: FeatureCollection = {
      type: 'FeatureCollection',
      features:
        spec.role === 'buildings'
          ? data.features.filter((f) => !polygonal(f.geometry))
          : data.features.map((f) =>
              polygonal(f.geometry)
                ? { ...f, geometry: { type: 'MultiLineString', coordinates: rings(f.geometry) } }
                : f,
            ),
    };
    const sources: C.DataSource[] = [];
    if (fills.length)
      sources.push(
        await C.GeoJsonDataSource.load({ type: 'FeatureCollection', features: fills }, options),
      );
    if (lines.features.length) sources.push(await C.GeoJsonDataSource.load(lines, options));
    const text = new C.CustomDataSource(`${spec.id}-labels`);
    for (const { name, at } of labels(spec, data)) {
      if (!at) continue;
      // Solid text on a dark plate stays legible over imagery; heavy outlines on small
      // canvas-rendered glyphs smear into blocks. Barangay names appear only up close,
      // where they do not duplicate the basemap's own place labels.
      text.entities.add({
        position: C.Cartesian3.fromDegrees(at[0], at[1]),
        label: {
          text: name,
          font:
            spec.role === 'rivers'
              ? '600 13px "Segoe UI", sans-serif'
              : '500 11px "Segoe UI", sans-serif',
          style: C.LabelStyle.FILL,
          showBackground: true,
          backgroundColor: C.Color.fromCssColorString('#07121a').withAlpha(0.78),
          backgroundPadding: new C.Cartesian2(6, 3),
          pixelOffset: spec.role === 'facilities' ? new C.Cartesian2(0, -16) : C.Cartesian2.ZERO,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new C.DistanceDisplayCondition(
            0,
            spec.role === 'rivers' ? 70000 : spec.role === 'boundaries' ? 7000 : 5000,
          ),
        },
      });
    }
    sources.push(text);
    if (!live()) return;
    restyle = () => {
      const now = C.JulianDate.now();
      for (const source of sources)
        for (const entity of source.entities.values) {
          if (entity.polyline) {
            const kind =
              spec.role === 'rivers' ? riverClass(entity.properties?.getValue(now)) : 'river';
            entity.polyline.width = new C.ConstantProperty(
              kind === 'priority'
                ? 4.5
                : kind === 'minor'
                  ? 1.2
                  : spec.role === 'boundaries'
                    ? 1.6
                    : 2.4,
            );
            entity.polyline.material = new C.ColorMaterialProperty(
              C.Color.fromCssColorString(kind === 'priority' ? priorityRiver : color).withAlpha(
                opacity * (kind === 'minor' ? 0.5 : 1),
              ),
            );
          }
          if (entity.polygon) {
            entity.polygon.outline = new C.ConstantProperty(false);
            entity.polygon.material = new C.ColorMaterialProperty(
              C.Color.fromCssColorString(color).withAlpha(
                opacity * (spec.role === 'buildings' ? 0.55 : 0.12),
              ),
            );
          }
          if (entity.billboard)
            entity.billboard.color = new C.ConstantProperty(C.Color.WHITE.withAlpha(opacity));
          if (entity.label)
            entity.label.fillColor = new C.ConstantProperty(
              C.Color.fromCssColorString(spec.role === 'rivers' ? '#bdf3ff' : '#e6efe2'),
            );
        }
      render();
    };
    restyle();
    for (const source of sources) await v.dataSources.add(source);
    if (!live()) {
      sources.forEach((s) => !v.isDestroyed() && v.dataSources.remove(s, true));
      return;
    }
    cleanups.push(() => {
      if (!v.isDestroyed()) sources.forEach((s) => v.dataSources.remove(s, true));
      render();
    });
    render();
  }

  function mountLibre(data: FeatureCollection, m: LibreMap) {
    const id = `ref-${spec.id}`;
    const classified: FeatureCollection = {
      ...data,
      features: data.features.map((f) => ({
        ...f,
        properties: {
          ...f.properties,
          agos_class: spec.role === 'rivers' ? riverClass(f.properties) : 'river',
        },
      })),
    };
    m.addSource(id, { type: 'geojson', data: classified });
    const before = layerBefore(
      m.getStyle().layers.map((layer) => layer.id),
      `${id}-fill`,
    );
    const kinds = (...types: string[]): FilterSpecification => [
      'in',
      ['geometry-type'],
      ['literal', types],
    ];
    const layers: LayerSpecification[] = [
      {
        id: `${id}-fill`,
        type: 'fill',
        source: id,
        filter: kinds('Polygon', 'MultiPolygon'),
        paint: { 'fill-color': color },
      },
      {
        id: `${id}-line`,
        type: 'line',
        source: id,
        filter: kinds('LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'),
        paint: {
          'line-color': ['match', ['get', 'agos_class'], 'priority', priorityRiver, color],
          'line-width': ['match', ['get', 'agos_class'], 'priority', 3.5, 'minor', 1, 1.6],
        },
      },
      {
        id: `${id}-point`,
        type: 'circle',
        source: id,
        filter: kinds('Point', 'MultiPoint'),
        paint: { 'circle-color': color, 'circle-radius': 5 },
      },
    ];
    layers.forEach((layer) => m.addLayer(layer, before));
    restyle = () => {
      if (!m.getLayer(`${id}-fill`)) return;
      m.setPaintProperty(
        `${id}-fill`,
        'fill-opacity',
        opacity * (spec.role === 'buildings' ? 0.55 : 0.15),
      );
      m.setPaintProperty(`${id}-line`, 'line-opacity', [
        'match',
        ['get', 'agos_class'],
        'minor',
        opacity * 0.5,
        opacity,
      ]);
      m.setPaintProperty(`${id}-point`, 'circle-opacity', opacity);
    };
    restyle();
    cleanups.push(() => {
      layers.forEach((layer) => m.getLayer(layer.id) && m.removeLayer(layer.id));
      if (m.getSource(id)) m.removeSource(id);
    });
  }

  async function mountRaster(v: C.Viewer | null, m: LibreMap | null) {
    if (!spec.bounds) return;
    const [w, s, e, n] = spec.bounds;
    const url = `/api/datasets/${spec.id}/image.png`;
    if (v) {
      const provider = await C.SingleTileImageryProvider.fromUrl(url, {
        rectangle: C.Rectangle.fromDegrees(w, s, e, n),
      });
      if (!live()) return;
      const layer = v.imageryLayers.addImageryProvider(provider);
      // Keep reference rasters directly above the basemap, beneath flood results.
      v.imageryLayers.lowerToBottom(layer);
      v.imageryLayers.raise(layer);
      restyle = () => {
        layer.alpha = opacity;
        render();
      };
      restyle();
      cleanups.push(() => {
        if (!v.isDestroyed()) v.imageryLayers.remove(layer, true);
        render();
      });
    }
    if (m) {
      const id = `ref-${spec.id}`;
      m.addSource(id, {
        type: 'image',
        url,
        coordinates: [
          [w, n],
          [e, n],
          [e, s],
          [w, s],
        ],
      });
      // Beneath the flood surface, vectors, stations and incidents even when no flood surface is shown.
      m.addLayer(
        { id: `${id}-raster`, type: 'raster', source: id },
        layerBefore(
          m.getStyle().layers.map((layer) => layer.id),
          `${id}-raster`,
        ),
      );
      restyle = () =>
        m.getLayer(`${id}-raster`) && m.setPaintProperty(`${id}-raster`, 'raster-opacity', opacity);
      restyle();
      cleanups.push(() => {
        if (m.getLayer(`${id}-raster`)) m.removeLayer(`${id}-raster`);
        if (m.getSource(id)) m.removeSource(id);
      });
    }
  }

  (async () => {
    if (spec.kind === 'raster') return mountRaster(viewer, map);
    const data = await load(spec);
    if (!live()) return;
    if (viewer) await mountCesium(data, viewer);
    if (map && live()) mountLibre(data, map);
  })().catch((error) => {
    if (live())
      onError(`Layer ${spec.name}: ${error instanceof Error ? error.message : String(error)}`);
  });

  return {
    version: spec.version,
    setOpacity: (value) => {
      opacity = value;
      restyle();
    },
    dispose: () => {
      disposed = true;
      cleanups.splice(0).forEach((cleanup) => cleanup());
    },
  };
}
