import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as C from 'cesium';
import * as maplibregl from 'maplibre-gl';
import type { Map as LibreMap, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  AlertTriangle,
  Compass,
  Crosshair,
  LocateFixed,
  Maximize,
  Minus,
  Plus,
  Ruler,
  RotateCcw,
  Mountain,
  MousePointer2,
} from 'lucide-react';
import { useApp } from '../store';
import { request, number } from '../api';
import { mapLayers, terrainSource, type TerrainSource } from '../geo';
import { incidentMarkers } from '../incidents';
import {
  INCIDENT_ANCHOR,
  incidentIconImage,
  incidentIconKey,
  incidentIconUrl,
} from './incidentMarkers';
import type { CameraPosition, Dataset, Inspection, Scenario, Station } from '../types';
import { Button } from './ui';
import { mountLayer, type MountedLayer } from './referenceLayers';
import { crossfade, fadeMs, prefetchUrls, surfaceUrl, useSurfaceDisplay } from '../surface';
import { OSM_MAX_ZOOM, reportTileError } from '../tiles';

export interface MapHandle {
  flyTo: (lon: number, lat: number, height?: number) => void;
  camera: () => CameraPosition | null;
  setCamera: (camera: CameraPosition) => void;
  screenshot: () => string | null;
  zoomDataset: (dataset: Dataset | Scenario) => void;
}
// Copied beside the app by vite.config.ts. Without its worker MapLibre draws no GeoJSON layer at all;
// the version query keeps a cached worker from outliving a MapLibre upgrade.
maplibregl.setWorkerUrl(`/maplibre/maplibre-gl-worker.mjs?v=${maplibregl.getVersion()}`);
const HOME = { longitude: 121.89, latitude: 17.13 };
const severityColors: Record<string, string> = {
  normal: '#69dfcb',
  watch: '#f4d36b',
  warning: '#f0a85a',
  critical: '#ef6a5b',
  unavailable: '#8897a3',
};
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
/** Request-render mode only draws on demand: keep drawing while new imagery, terrain or vectors load. */
function renderBurst(v: C.Viewer, ms = 6000) {
  const started = performance.now();
  const tick = () => {
    if (v.isDestroyed()) return;
    v.scene.requestRender();
    const elapsed = performance.now() - started;
    const loading = !v.scene.globe.tilesLoaded || !v.dataSourceDisplay.ready;
    if (elapsed < 400 || (loading && elapsed < ms)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function terrainNotice(terrain: TerrainSource) {
  if (terrain.kind === 'url') return 'External terrain · provider-dependent coverage';
  if (terrain.kind === 'dataset')
    return `${terrain.automatic ? 'Imported DEM (auto)' : 'Imported DEM'} · heights in DEM datum · ellipsoid outside coverage`;
  return 'Terrain off · flat ellipsoid reference surface';
}
export const GeoMap = forwardRef<
  MapHandle,
  { scenario?: Scenario; secondary?: boolean; onCamera?: (camera: CameraPosition) => void }
>(({ scenario, secondary = false, onCamera }, ref) => {
  const {
    settings,
    datasets,
    mapMode,
    mode,
    frame,
    metric,
    monitoring,
    rainfallIndex,
    incidents,
    picking,
  } = useApp();
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<C.Viewer | null>(null),
    libre = useRef<LibreMap | null>(null),
    libreLoaded = useRef<LibreMap | null>(null);
  // `ready` can still count an earlier renderer while a new 2D map loads its style (which waits for an
  // animation frame, paused in background tabs); adding sources before its own load event throws.
  const drawable = () => !libre.current || libre.current === libreLoaded.current;
  const [ready, setReady] = useState(0),
    [mapError, setMapError] = useState(''),
    [tileError, setTileError] = useState('');
  useEffect(() => {
    if (!tileError) return;
    // The notice reports recent failures; it clears itself and returns if tiles keep failing.
    const timer = setTimeout(() => setTileError(''), 12000);
    return () => clearTimeout(timer);
  }, [tileError]);
  const [coords, setCoords] = useState<{ lon: number; lat: number } | null>(null);
  const [measure, setMeasure] = useState(false),
    [distance, setDistance] = useState<number | null>(null);
  const measureStart = useRef<C.Cartographic | null>(null);
  const [measuringFirst, setMeasuringFirst] = useState(false);
  const clickRef = useRef<(lon: number, lat: number) => void>(() => {});
  const cameraCallback = useRef(onCamera);
  cameraCallback.current = onCamera;
  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const opacityRef = useRef(settings.opacity);
  opacityRef.current = settings.opacity;
  const smooth = useSurfaceDisplay((state) => state.smooth);
  const terrain = useMemo(() => terrainSource(settings, datasets), [settings, datasets]);
  const terrainKey = JSON.stringify(terrain);
  const terrainRef = useRef(terrain);
  terrainRef.current = terrain;
  const floodLayers = useRef<C.ImageryLayer[]>([]);
  const mounted = useRef(new Map<string, MountedLayer>());
  const specs = useMemo(
    () => mapLayers(datasets, settings, mode, rainfallIndex),
    [datasets, settings, mode, rainfallIndex],
  );
  const specsRef = useRef(specs);
  specsRef.current = specs;
  // Refreshed-but-unchanged datasets keep the same keys, so layers are not rebuilt.
  const structureKey = specs.map((s) => `${s.id}:${s.version}`).join('|');
  const opacityKey = specs.map((s) => `${s.id}:${s.opacity}`).join('|');
  const stations = useMemo(
    () =>
      [...(monitoring?.live?.stations ?? []), ...(monitoring?.stations ?? [])].filter(
        (s) => s.longitude != null && s.latitude != null,
      ),
    [monitoring?.live?.stations, monitoring?.stations],
  );
  const stationKey = JSON.stringify(
    stations.map((s) => [s.id, s.name, s.longitude, s.latitude, s.connected, s.severity]),
  );
  const stationsRef = useRef<Station[]>(stations);
  stationsRef.current = stations;
  const markers = useMemo(() => incidentMarkers(incidents, mode), [incidents, mode]);
  // Markers hold only drawn fields, so a refresh returning the same incidents keeps the key.
  const incidentKey = JSON.stringify(markers);
  const markersRef = useRef(markers);
  markersRef.current = markers;

  const inspect = useCallback(
    async (lon: number, lat: number) => {
      setCoords({ lon, lat });
      if (useApp.getState().picking) {
        useApp.getState().set({ picking: false, picked: { longitude: lon, latitude: lat } });
        return;
      }
      if (measure) {
        const point = C.Cartographic.fromDegrees(lon, lat);
        if (!measureStart.current) {
          measureStart.current = point;
          setDistance(null);
          setMeasuringFirst(true);
        } else {
          const line = new C.EllipsoidGeodesic(measureStart.current, point);
          setDistance(line.surfaceDistance);
          measureStart.current = null;
          setMeasuringFirst(false);
        }
        return;
      }
      const selected = scenarioRef.current;
      try {
        let result: Inspection;
        if (selected?.frames.length)
          result = await request<Inspection>(
            `/scenarios/${selected.id}/inspect?frame=${frameRef.current}&longitude=${lon}&latitude=${lat}`,
          );
        else
          result = {
            longitude: lon,
            latitude: lat,
            timestamp: '',
            scenario: 'No modeled surface selected',
            mode,
            source: 'Geographic coordinate inspection',
            validation_status: 'No model result',
            inside_model: false,
            values: { depth: null, velocity: null, direction: null, wse: null },
            arrival_minutes: null,
            peak_depth_m: null,
          };
        const source = terrainRef.current;
        if (source.kind === 'dataset') {
          const elevation = await request<{ value: number | null }>(
            `/datasets/${source.id}/sample?longitude=${lon}&latitude=${lat}`,
          );
          result.elevation = elevation.value;
        } else if (source.kind === 'url' && viewer.current) {
          try {
            const sampled = await C.sampleTerrainMostDetailed(viewer.current.terrainProvider, [
              C.Cartographic.fromDegrees(lon, lat),
            ]);
            result.elevation = sampled[0].height;
          } catch {
            result.elevation = null;
          }
        }
        useApp.getState().set({ inspection: result });
      } catch (error) {
        useApp.getState().notify(errorText(error));
      }
    },
    [measure, mode],
  );
  clickRef.current = inspect;

  function currentCamera(): CameraPosition | null {
    const v = viewer.current;
    if (v && !v.isDestroyed()) {
      const p = v.camera.positionCartographic;
      return {
        name: 'Saved view',
        longitude: C.Math.toDegrees(p.longitude),
        latitude: C.Math.toDegrees(p.latitude),
        height: p.height,
        heading: v.camera.heading,
        pitch: v.camera.pitch,
        roll: v.camera.roll,
      };
    }
    const m = libre.current;
    if (m) {
      const p = m.getCenter();
      return {
        name: 'Saved view',
        longitude: p.lng,
        latitude: p.lat,
        height: (40075016.68 * Math.cos((p.lat * Math.PI) / 180)) / Math.pow(2, m.getZoom()),
        heading: (m.getBearing() * Math.PI) / 180,
        pitch: ((m.getPitch() - 90) * Math.PI) / 180,
        roll: 0,
      };
    }
    return null;
  }
  function applyCamera(camera: CameraPosition, fly = false) {
    const v = viewer.current;
    if (v && !v.isDestroyed()) {
      const options = {
        destination: C.Cartesian3.fromDegrees(camera.longitude, camera.latitude, camera.height),
        orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
      };
      if (fly) v.camera.flyTo({ ...options, duration: 1.2 });
      else v.camera.setView(options);
      v.scene.requestRender();
    }
    const m = libre.current;
    if (m) {
      const options = {
        center: [camera.longitude, camera.latitude] as [number, number],
        zoom: Math.max(
          1,
          Math.min(
            20,
            Math.log2((40075016.68 * Math.cos((camera.latitude * Math.PI) / 180)) / camera.height),
          ),
        ),
        bearing: (camera.heading * 180) / Math.PI,
        pitch: Math.max(0, Math.min(80, (camera.pitch * 180) / Math.PI + 90)),
      };
      if (fly) m.flyTo(options);
      else m.jumpTo(options);
    }
  }
  function flyToLocation(lon: number, lat: number, height = 11000) {
    const v = viewer.current;
    if (v)
      v.camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(lon, lat), 1), {
        offset: new C.HeadingPitchRange(0, -0.95, height),
        duration: 1.2,
      });
    libre.current?.flyTo({
      center: [lon, lat],
      zoom: Math.max(
        1,
        Math.min(20, Math.log2((40075016.68 * Math.cos((lat * Math.PI) / 180)) / height)),
      ),
    });
  }
  function requestRender() {
    const v = viewer.current;
    if (v && !v.isDestroyed()) renderBurst(v);
  }
  useImperativeHandle(ref, () => ({
    flyTo: flyToLocation,
    camera: currentCamera,
    setCamera: (camera) => applyCamera(camera),
    screenshot: () => {
      try {
        if (viewer.current) {
          viewer.current.render();
          return viewer.current.canvas.toDataURL('image/png');
        }
        return libre.current?.getCanvas().toDataURL('image/png') ?? null;
      } catch (error) {
        useApp.getState().notify('Map capture failed: ' + errorText(error));
        return null;
      }
    },
    zoomDataset: (dataset) => {
      if (!dataset.bounds) return;
      const [west, south, east, north] = dataset.bounds;
      const v = viewer.current;
      if (v)
        v.camera.flyTo({
          destination: C.Rectangle.fromDegrees(
            west - 0.005,
            south - 0.005,
            east + 0.005,
            north + 0.005,
          ),
          duration: 1.2,
        });
      libre.current?.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 60, duration: 1000 },
      );
    },
  }));

  useEffect(() => {
    if (!container.current) return;
    setMapError('');
    setTileError('');
    let canceled = false;
    const layers = mounted.current;
    const resetLayers = () => {
      layers.forEach((layer) => layer.dispose());
      layers.clear();
      floodLayers.current = [];
    };
    if (mapMode === '3d') {
      let v: C.Viewer;
      try {
        const imagery = settings.imagery_url
          ? new C.UrlTemplateImageryProvider({
              url: settings.imagery_url,
              credit:
                settings.imagery_attribution ||
                'User-configured imagery; source declaration required',
            })
          : new C.OpenStreetMapImageryProvider({
              url: 'https://tile.openstreetmap.org/',
              maximumLevel: OSM_MAX_ZOOM,
            });
        v = new C.Viewer(container.current, {
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          fullscreenButton: false,
          infoBox: false,
          selectionIndicator: false,
          baseLayer: new C.ImageryLayer(imagery),
          terrainProvider: new C.EllipsoidTerrainProvider(),
          requestRenderMode: true,
          maximumRenderTimeChange: Infinity,
          // Render at device pixel ratio so labels and imagery stay sharp on scaled displays.
          useBrowserRecommendedResolution: false,
          contextOptions: { webgl: { preserveDrawingBuffer: true, alpha: false } },
        });
        viewer.current = v;
        v.scene.backgroundColor = C.Color.fromCssColorString('#0b1118');
        v.scene.globe.baseColor = C.Color.fromCssColorString('#1e3034');
        v.scene.globe.showGroundAtmosphere = false;
        v.scene.skyAtmosphere && (v.scene.skyAtmosphere.show = false);
        v.scene.skyBox && (v.scene.skyBox.show = false);
        v.scene.fog.enabled = false;
        v.imageryLayers.get(0).brightness = 1;
        v.imageryLayers.get(0).saturation = 1;
        v.camera.lookAt(
          C.Cartesian3.fromDegrees(HOME.longitude, HOME.latitude),
          new C.HeadingPitchRange(0, -0.85, 15000),
        );
        v.camera.lookAtTransform(C.Matrix4.IDENTITY);
        // Tiles and imagery finishing asynchronously must still reach the screen.
        const keepLoading = v.scene.postRender.addEventListener(() => {
          if (!v.scene.globe.tilesLoaded || !v.dataSourceDisplay.ready) v.scene.requestRender();
        });
        imagery.errorEvent.addEventListener((error) => {
          if (reportTileError(error) && !canceled)
            setTileError('Basemap tiles unavailable. Local imported layers remain usable.');
        });
        v.scene.renderError.addEventListener((_scene, error) => {
          if (!canceled) setMapError('3D renderer: ' + errorText(error));
        });
        const handler = new C.ScreenSpaceEventHandler(v.canvas);
        handler.setInputAction((event: { position: C.Cartesian2 }) => {
          const ray = v.camera.getPickRay(event.position);
          const p = ray ? v.scene.globe.pick(ray, v.scene) : undefined;
          if (p) {
            const c = C.Cartographic.fromCartesian(p);
            clickRef.current(C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude));
          }
        }, C.ScreenSpaceEventType.LEFT_CLICK);
        const remove = v.camera.moveEnd.addEventListener(() => {
          const camera = currentCamera();
          if (camera) cameraCallback.current?.(camera);
        });
        setReady((n) => n + 1);
        renderBurst(v);
        return () => {
          canceled = true;
          resetLayers();
          handler.destroy();
          remove();
          keepLoading();
          viewer.current = null;
          if (!v.isDestroyed()) v.destroy();
        };
      } catch (error) {
        setMapError('3D rendering unavailable: ' + errorText(error));
        return () => {
          canceled = true;
        };
      }
    } else {
      try {
        const tiles = settings.imagery_url
          ? [settings.imagery_url]
          : ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];
        const m = new maplibregl.Map({
          container: container.current,
          style: {
            version: 8,
            sources: {
              basemap: {
                type: 'raster',
                tiles,
                tileSize: 256,
                ...(settings.imagery_url ? {} : { maxzoom: OSM_MAX_ZOOM }),
                attribution: settings.imagery_attribution || '© OpenStreetMap contributors',
              },
            },
            layers: [
              {
                id: 'basemap',
                type: 'raster',
                source: 'basemap',
                paint: { 'raster-brightness-max': 1, 'raster-saturation': 0 },
              },
            ],
          },
          center: [HOME.longitude, HOME.latitude],
          zoom: 12.2,
          attributionControl: false,
          canvasContextAttributes: { preserveDrawingBuffer: true },
        });
        libre.current = m;
        m.addControl(new maplibregl.AttributionControl({ compact: true }));
        m.on('load', () => {
          if (canceled) return;
          libreLoaded.current = m;
          setReady((n) => n + 1);
        });
        m.on('error', () => {
          if (!canceled)
            setTileError('A map source failed. Check connectivity and provider settings.');
        });
        m.on('click', (event) => {
          // A click on a repeated world copy reports |longitude| > 180; wrap it to WGS84.
          const point = event.lngLat.wrap();
          clickRef.current(point.lng, point.lat);
        });
        m.on('moveend', () => {
          const camera = currentCamera();
          if (camera) cameraCallback.current?.(camera);
        });
        return () => {
          canceled = true;
          resetLayers();
          libre.current = libreLoaded.current = null;
          m.remove();
        };
      } catch (error) {
        setMapError('2D rendering unavailable: ' + errorText(error));
      }
    }
    // Providers are rebuilt only when basemap or renderer changes.
  }, [mapMode, settings.imagery_url, settings.imagery_attribution]);

  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    const source = JSON.parse(terrainKey) as TerrainSource;
    let canceled = false;
    (async () => {
      try {
        let provider: C.TerrainProvider = new C.EllipsoidTerrainProvider();
        if (source.kind === 'url') provider = await C.CesiumTerrainProvider.fromUrl(source.url);
        else if (source.kind === 'dataset')
          provider = new C.CustomHeightmapTerrainProvider({
            width: 65,
            height: 65,
            callback: (x, y, level) =>
              request<{ heights: number[] }>(`/terrain/${source.id}/${level}/${x}/${y}`).then(
                (r) => {
                  if (!v.isDestroyed()) v.scene.requestRender();
                  return new Float32Array(r.heights);
                },
              ),
          });
        if (!canceled && !v.isDestroyed()) {
          v.terrainProvider = provider;
          provider.errorEvent.addEventListener((error) => {
            if (reportTileError(error) && !canceled)
              setTileError('Terrain provider error; elevation cannot be treated as verified.');
          });
          renderBurst(v);
        }
      } catch (error) {
        if (!canceled && !v.isDestroyed()) {
          setTileError('Terrain unavailable: ' + errorText(error));
          v.terrainProvider = new C.EllipsoidTerrainProvider();
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [ready, terrainKey]);
  useEffect(() => {
    const v = viewer.current;
    if (v) {
      v.scene.verticalExaggeration = settings.exaggeration;
      renderBurst(v);
    }
  }, [ready, settings.exaggeration]);

  useEffect(() => {
    if (!ready || !drawable()) return;
    const v = viewer.current,
      m = libre.current;
    if (!scenario?.frames.length || !scenario.bounds) {
      if (v && !v.isDestroyed()) {
        floodLayers.current.forEach((layer) => v.imageryLayers.remove(layer, true));
        v.scene.requestRender();
      }
      floodLayers.current = [];
      if (m?.getLayer('flood')) {
        m.removeLayer('flood');
        m.removeSource('flood');
      }
      return;
    }
    let canceled = false;
    const url = surfaceUrl(scenario, frame, metric, smooth);
    // Warm the browser cache so playback swaps the next frames without waiting on the network;
    // a failed prefetch is harmless because the real load reports its own error.
    for (const next of prefetchUrls(scenario, frame, metric, smooth))
      void fetch(next).catch(() => {});
    const [w, s, e, n] = scenario.bounds;
    if (v) {
      C.SingleTileImageryProvider.fromUrl(url, { rectangle: C.Rectangle.fromDegrees(w, s, e, n) })
        .then((provider) => {
          if (canceled || v.isDestroyed()) return;
          const layer = v.imageryLayers.addImageryProvider(provider);
          layer.minificationFilter = smooth
            ? C.TextureMinificationFilter.LINEAR
            : C.TextureMinificationFilter.NEAREST;
          layer.magnificationFilter = smooth
            ? C.TextureMagnificationFilter.LINEAR
            : C.TextureMagnificationFilter.NEAREST;
          const previous = floodLayers.current;
          floodLayers.current = [layer];
          crossfade(v, layer, previous, () => opacityRef.current, fadeMs(useApp.getState().speed));
        })
        .catch((error) => {
          if (!canceled) useApp.getState().notify(errorText(error));
        });
    }
    // `ready` follows the map's load event; isStyleLoaded() is false while tiles stream in.
    if (m) {
      const coordinates: [[number, number], [number, number], [number, number], [number, number]] =
        [
          [w, n],
          [e, n],
          [e, s],
          [w, s],
        ];
      const source = m.getSource('flood') as maplibregl.ImageSource | undefined;
      if (source) {
        source.updateImage({ url, coordinates });
        m.setPaintProperty('flood', 'raster-resampling', smooth ? 'linear' : 'nearest');
      } else {
        m.addSource('flood', { type: 'image', url, coordinates });
        const vectors = m
          .getStyle()
          .layers.find((layer) => layer.id.startsWith('ref-') && !layer.id.endsWith('-raster'));
        m.addLayer(
          {
            id: 'flood',
            type: 'raster',
            source: 'flood',
            paint: {
              'raster-opacity': opacityRef.current,
              'raster-fade-duration': 0,
              'raster-resampling': smooth ? 'linear' : 'nearest',
            },
          },
          vectors?.id ?? (m.getLayer('stations') ? 'stations' : undefined),
        );
      }
    }
    return () => {
      canceled = true;
    };
  }, [
    ready,
    scenario?.id,
    scenario?.updated_at,
    scenario?.frames.length,
    scenario?.bounds?.join(','),
    frame,
    metric,
    smooth,
  ]);
  useEffect(() => {
    const v = viewer.current,
      m = libre.current;
    if (v && !v.isDestroyed()) {
      floodLayers.current.forEach((layer) => (layer.alpha = settings.opacity));
      v.scene.requestRender();
    }
    if (m?.getLayer('flood')) m.setPaintProperty('flood', 'raster-opacity', settings.opacity);
  }, [ready, settings.opacity]);

  useEffect(() => {
    if (!ready || !drawable()) return;
    const v = viewer.current && !viewer.current.isDestroyed() ? viewer.current : null,
      m = libre.current;
    const wanted = new Map(specsRef.current.map((spec) => [spec.id, spec]));
    for (const [id, layer] of mounted.current)
      if (wanted.get(id)?.version !== layer.version) {
        layer.dispose();
        mounted.current.delete(id);
      }
    for (const spec of wanted.values())
      if (!mounted.current.has(spec.id))
        mounted.current.set(
          spec.id,
          mountLayer(spec, v, m, requestRender, (message) => useApp.getState().notify(message)),
        );
  }, [ready, structureKey]);
  useEffect(() => {
    for (const spec of specsRef.current) mounted.current.get(spec.id)?.setOpacity(spec.opacity);
  }, [opacityKey]);

  useEffect(() => {
    if (!ready || !drawable()) return;
    const v = viewer.current,
      m = libre.current;
    const entities: C.Entity[] = [];
    const located = stationsRef.current;
    if (v && !v.isDestroyed()) {
      for (const s of located) {
        const color = C.Color.fromCssColorString(
          s.connected ? (severityColors[s.severity] ?? severityColors.normal) : '#e09b60',
        );
        entities.push(
          v.entities.add({
            position: C.Cartesian3.fromDegrees(s.longitude!, s.latitude!),
            point: {
              color,
              pixelSize: 11,
              outlineColor: C.Color.BLACK,
              outlineWidth: 2,
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: s.name,
              font: '12px Segoe UI, sans-serif',
              pixelOffset: new C.Cartesian2(0, -20),
              fillColor: C.Color.WHITE,
              showBackground: true,
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        );
      }
      v.scene.requestRender();
    }
    if (m) {
      const data: FeatureCollection = {
        type: 'FeatureCollection',
        features: located.map((s) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.longitude!, s.latitude!] },
          properties: { name: s.name, color: severityColors[s.severity] ?? severityColors.normal },
        })),
      };
      if (m.getSource('stations')) (m.getSource('stations') as GeoJSONSource).setData(data);
      else {
        m.addSource('stations', { type: 'geojson', data });
        m.addLayer({
          id: 'stations',
          type: 'circle',
          source: 'stations',
          paint: {
            'circle-radius': 7,
            'circle-color': ['get', 'color'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#0b1118',
          },
        });
      }
    }
    return () => {
      if (v && !v.isDestroyed()) {
        entities.forEach((e) => v.entities.remove(e));
        v.scene.requestRender();
      }
    };
  }, [ready, stationKey]);

  useEffect(() => {
    if (!ready || !drawable()) return;
    const v = viewer.current,
      m = libre.current;
    const entities: C.Entity[] = [];
    const located = markersRef.current;
    if (v && !v.isDestroyed()) {
      for (const marker of located)
        entities.push(
          v.entities.add({
            position: C.Cartesian3.fromDegrees(marker.longitude, marker.latitude),
            billboard: {
              image: incidentIconUrl(marker),
              scale: 0.5,
              verticalOrigin: C.VerticalOrigin.TOP,
              pixelOffset: new C.Cartesian2(0, -INCIDENT_ANCHOR),
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: marker.title,
              font: '500 11px "Segoe UI", sans-serif',
              style: C.LabelStyle.FILL,
              fillColor: C.Color.WHITE,
              showBackground: true,
              backgroundColor: C.Color.fromCssColorString('#07121a').withAlpha(0.78),
              backgroundPadding: new C.Cartesian2(6, 3),
              verticalOrigin: C.VerticalOrigin.BOTTOM,
              pixelOffset: new C.Cartesian2(0, -INCIDENT_ANCHOR - 4),
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new C.DistanceDisplayCondition(0, 30000),
            },
          }),
        );
      v.scene.requestRender();
    }
    if (m) {
      for (const marker of located)
        if (!m.hasImage(incidentIconKey(marker)))
          m.addImage(incidentIconKey(marker), incidentIconImage(marker), { pixelRatio: 2 });
      const data: FeatureCollection = {
        type: 'FeatureCollection',
        features: located.map((marker) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [marker.longitude, marker.latitude] },
          properties: {
            icon: incidentIconKey(marker),
            title: marker.title,
            order: marker.resolved ? 0 : 1,
          },
        })),
      };
      if (m.getSource('incidents')) (m.getSource('incidents') as GeoJSONSource).setData(data);
      else {
        m.addSource('incidents', { type: 'geojson', data });
        // Icons only: the style has no glyphs, and exercise icons carry their own label plate.
        m.addLayer({
          id: 'incidents',
          type: 'symbol',
          source: 'incidents',
          layout: {
            'icon-image': ['get', 'icon'],
            'icon-anchor': 'top',
            'icon-offset': [0, -INCIDENT_ANCHOR],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'symbol-sort-key': ['get', 'order'],
          },
        });
      }
    }
    return () => {
      if (v && !v.isDestroyed()) {
        entities.forEach((e) => v.entities.remove(e));
        v.scene.requestRender();
      }
    };
  }, [ready, incidentKey]);

  return (
    <div className={`geomap ${secondary ? 'geomap-secondary' : ''} ${picking ? 'picking' : ''}`}>
      <div
        ref={container}
        className="map-canvas"
        data-testid={secondary ? 'comparison-map' : 'main-map'}
      />
      {secondary && (
        <div className="compare-map-label">
          B <span>{scenario?.name}</span>
        </div>
      )}
      {mapError && (
        <div className="map-error">
          <AlertTriangle />
          <strong>Map renderer unavailable</strong>
          <p>{mapError}</p>
          <Button
            onClick={() => useApp.getState().set({ mapMode: mapMode === '3d' ? '2d' : '3d' })}
          >
            Try {mapMode === '3d' ? '2D' : '3D'} renderer
          </Button>
        </div>
      )}
      {!secondary && (
        <>
          <div className="map-place">
            <span className="crosshair-icon">⌖</span>
            <div>
              <strong>ILAGAN, ISABELA</strong>
              <small>Cagayan Valley · Philippines</small>
            </div>
            <span className="map-dimension">{mapMode.toUpperCase()}</span>
          </div>
          <div className="terrain-notice" title={terrain.kind === 'dataset' ? terrain.name : ''}>
            <Mountain size={12} />
            {mapMode === '2d' ? 'Flat 2D map · switch to 3D for terrain' : terrainNotice(terrain)}
          </div>
          {tileError && (
            <div className="tile-notice" role="status">
              <AlertTriangle size={13} />
              {tileError}
            </div>
          )}
          <div className="map-tools">
            <Button
              size="icon"
              title="Return to Ilagan"
              aria-label="Return to Ilagan"
              onClick={() => flyToLocation(HOME.longitude, HOME.latitude, 15000)}
            >
              <LocateFixed size={17} />
            </Button>
            <Button
              size="icon"
              aria-label="Zoom in"
              onClick={() => {
                const c = currentCamera();
                if (c) applyCamera({ ...c, height: c.height * 0.65 }, true);
              }}
            >
              <Plus size={18} />
            </Button>
            <Button
              size="icon"
              aria-label="Zoom out"
              onClick={() => {
                const c = currentCamera();
                if (c) applyCamera({ ...c, height: c.height * 1.5 }, true);
              }}
            >
              <Minus size={18} />
            </Button>
            <Button
              size="icon"
              aria-label="Reset north"
              onClick={() => {
                const c = currentCamera();
                if (c) applyCamera({ ...c, heading: 0 }, true);
              }}
            >
              <Compass size={18} />
            </Button>
            <Button
              size="icon"
              aria-label="Tilt map"
              onClick={() => {
                const c = currentCamera();
                if (c) applyCamera({ ...c, pitch: c.pitch < -1.4 ? -0.7 : -Math.PI / 2 }, true);
              }}
            >
              <RotateCcw size={16} />
            </Button>
            <Button
              size="icon"
              aria-label="Measure distance"
              aria-pressed={measure}
              variant={measure ? 'default' : 'secondary'}
              onClick={() => {
                setMeasure(!measure);
                setDistance(null);
                setMeasuringFirst(false);
                measureStart.current = null;
              }}
            >
              <Ruler size={18} />
            </Button>
            <Button
              size="icon"
              aria-label="Full screen map"
              onClick={() => {
                const element = container.current?.parentElement?.parentElement;
                if (document.fullscreenElement)
                  void document
                    .exitFullscreen()
                    .catch((e) => useApp.getState().notify(errorText(e)));
                else
                  void element
                    ?.requestFullscreen()
                    .catch((e) => useApp.getState().notify(errorText(e)));
              }}
            >
              <Maximize size={17} />
            </Button>
          </div>
          {picking && (
            <div className="pick-banner" role="status">
              <Crosshair size={14} />
              Click the map to place the incident · Esc cancels
              <Button size="sm" onClick={() => useApp.getState().set({ picking: false })}>
                Cancel
              </Button>
            </div>
          )}
          {measure && (
            <div className="measure-readout">
              <Ruler size={14} />
              {distance != null
                ? `${number(distance / 1000)} km · geodesic surface distance`
                : measuringFirst
                  ? 'Select the second map point'
                  : 'Select two map points to measure'}
            </div>
          )}
          <div className="coordinate-readout">
            <MousePointer2 size={11} />
            {coords
              ? `${coords.lat.toFixed(5)}° N   ${coords.lon.toFixed(5)}° E`
              : 'Click map to inspect coordinates & modeled depth'}
            <span>WGS 84</span>
          </div>
        </>
      )}
    </div>
  );
});
GeoMap.displayName = 'GeoMap';
