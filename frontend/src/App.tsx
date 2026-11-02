import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  Activity,
  ArrowRight,
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CloudRain,
  Database,
  FileChartColumnIncreasing,
  FlaskConical,
  FolderOpen,
  GitCompareArrows,
  HelpCircle,
  Layers,
  LayoutDashboard,
  MapPinned,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  TriangleAlert,
  Waves,
  X,
} from 'lucide-react';
import { useApp } from './store';
import { dateTime, number, request, time } from './api';
import { referenceDatasets } from './geo';
import {
  metricLabels,
  type CameraPosition,
  type Exposure,
  type Monitoring,
  type Settings,
  type View,
} from './types';
import { Badge, Busy, Button, Empty, Modal } from './components/ui';
import { GeoMap, type MapHandle } from './components/GeoMap';
import {
  LiveTelemetry,
  MonitoringPanel,
  RainfallPanel,
  ReplayControls,
  replayStep,
  StationSummary,
  StationTrend,
} from './components/MonitoringPanel';
import { AlertCenter } from './components/AlertCenter';
import { IncidentLog } from './components/IncidentLog';
import { InspectionPanel } from './components/InspectionPanel';
import { Timeline } from './components/Timeline';
import { DataPanel } from './components/DataPanel';
import { ScenarioPanel } from './components/ScenarioPanel';
import {
  ExposurePanel,
  LayersPanel,
  ReportsPanel,
  SettingsPanel,
  SimulationPanel,
} from './components/AnalysisPanels';

const navigation: { view: View; label: string; icon: typeof Activity }[] = [
  { view: 'command', label: 'Command', icon: LayoutDashboard },
  { view: 'simulation', label: 'Simulation', icon: Waves },
  { view: 'monitoring', label: 'Monitoring', icon: Radio },
  { view: 'rainfall', label: 'Rainfall', icon: CloudRain },
  { view: 'exposure', label: 'Exposure', icon: ShieldAlert },
  { view: 'scenarios', label: 'Scenarios', icon: FolderOpen },
  { view: 'data', label: 'Data center', icon: Database },
  { view: 'reports', label: 'Reports', icon: FileChartColumnIncreasing },
];

function Logo() {
  return (
    <div className="brand">
      <div className="brand-symbol">
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path
            d="M3 18c4-9 8-9 12 0s8 9 14 0M3 25c4-9 8-9 12 0"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
          <path
            d="M8 9l5-5 5 5"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div>
        <strong>
          AGOS<span>PH</span>
        </strong>
        <small>SEE THE FLOOD BEFORE IT ARRIVES</small>
      </div>
    </div>
  );
}

export function CommandPanel({
  openAlerts,
  map,
}: {
  openAlerts: () => void;
  map: MapHandle | null;
}) {
  const { scenarios, scenarioId, set, alerts, mode } = useApp();
  const scenario = scenarios.find((s) => s.id === scenarioId);
  const active = alerts.filter((a) => a.status === 'active' && a.mode === mode);
  const live = alerts.filter((a) => a.status === 'active' && a.mode === 'live');
  return (
    <>
      <div className="panel-heading command-heading">
        <span className="eyebrow">
          <span className="health-dot" />
          LOCAL INTELLIGENCE WORKSPACE
        </span>
        <h1>
          Every second.
          <br />A clearer picture.
        </h1>
        <p>City of Ilagan, Isabela</p>
      </div>
      <div className="section-heading">
        <h3>River monitoring</h3>
        <button className="text-button" onClick={() => set({ view: 'monitoring' })}>
          View all <ChevronRight size={12} />
        </button>
      </div>
      <LiveTelemetry compact />
      <StationSummary />
      <StationTrend />
      <div className="section-heading">
        <h3>Monitoring replay</h3>
        <FlaskConical size={14} className="orange" />
      </div>
      <ReplayControls />
      <p className="tiny muted">
        Advance readings to test local threshold alerts. These are not actual live measurements.
      </p>
      <div className="section-heading">
        <h3>Local warning status</h3>
        <span className="badge-group">
          {live.length > 0 && <Badge tone="red">{live.length} LIVE</Badge>}
          <Badge tone={active.length ? 'orange' : 'neutral'}>{active.length} ACTIVE TESTS</Badge>
        </span>
      </div>
      <button className="warning-summary" onClick={openAlerts}>
        <TriangleAlert size={19} />
        <div>
          <strong>
            {live.length
              ? 'Review live threshold alerts'
              : active.length
                ? 'Review test notifications'
                : 'Test alert system ready'}
          </strong>
          <span>
            {live.length
              ? 'Authorized sensor readings crossed saved station thresholds'
              : active.length
                ? 'Acknowledge or resolve local test alerts'
                : 'Replay data or generate a test notification'}
          </span>
        </div>
        <ChevronRight size={15} />
      </button>
      <IncidentLog map={map} />
      <div className="active-scenario-note">
        <span className="eyebrow">ACTIVE SCENARIO</span>
        <h3>{scenario?.name ?? 'No scenario loaded'}</h3>
        <p>
          {scenario?.mode === 'demonstration'
            ? scenario.settings?.reference_geography === 'imported'
              ? 'Illustrative terrain-based inundation for an assumed river rise. Not a forecast.'
              : 'Illustrative temporal test grid. No forecast or actual flood extent.'
            : (scenario?.source ?? 'Import model outputs to begin.')}
        </p>
        <button className="text-button" onClick={() => set({ view: 'simulation' })}>
          Inspect simulation <ArrowRight size={12} />
        </button>
      </div>
    </>
  );
}

function SituationPanel() {
  const { exposure, scenarios, scenarioId, frame, set, monitoring, datasets, mode } = useApp();
  const scenario = scenarios.find((s) => s.id === scenarioId);
  const rain = monitoring?.stations[0]?.latest?.rainfall_mm;
  const geographic = referenceDatasets(datasets, mode);
  // Keep the last result on screen (dimmed) while the next frame is computed.
  const last = useRef<Exposure | null>(null);
  if (exposure?.scenario_id === scenarioId) last.current = exposure;
  else if (last.current?.scenario_id !== scenarioId) last.current = null;
  const shown = last.current;
  const stale = !!shown && shown.frame !== frame;
  const terrainDemo = scenario?.settings?.reference_geography === 'imported';
  return (
    <aside className="situation-panel glass">
      <div className="section-heading">
        <h3>Situation overview</h3>
        <span className="live-local">
          <i />
          LOCAL
        </span>
      </div>
      <div className="situation-context">
        <Badge tone={mode === 'demonstration' ? 'orange' : 'cyan'}>
          {mode === 'demonstration' ? 'DEMONSTRATION' : 'IMPORTED DATA'}
        </Badge>
        <span>{time(scenario?.frames[frame]?.timestamp)} PHT</span>
      </div>
      <div className={`situation-stat ${stale ? 'stale' : ''}`}>
        <span>Modeled inundation extent</span>
        <strong>
          {number(
            shown ? shown.inundation_area_m2 / 1e6 : null,
            shown && shown.inundation_area_m2 > 1e7 ? 1 : 3,
          )}
          <small>km²</small>
        </strong>
        <div className="mini-bar">
          <i
            style={{
              width: shown?.valid_cells ? `${(100 * shown.wet_cells) / shown.valid_cells}%` : '0%',
            }}
          />
        </div>
        <p>
          {mode === 'imported'
            ? 'Current simulation frame'
            : terrainDemo
              ? 'Illustrative · share of modeled grid'
              : 'Synthetic test domain only'}
        </p>
      </div>
      <div className={`situation-stat ${stale ? 'stale' : ''}`}>
        <span>Maximum frame depth</span>
        <strong>
          {number(shown?.maximum_depth_m)}
          <small>m</small>
        </strong>
        <p>From selected georeferenced depth raster</p>
      </div>
      {shown && shown.counts.boundaries != null && (
        <button
          className={`situation-exposure ${stale ? 'stale' : ''}`}
          onClick={() => set({ view: 'exposure' })}
        >
          <span>
            <strong>{shown.counts.boundaries}</strong> of {shown.totals.boundaries} barangays
          </span>
          {shown.counts.buildings != null && (
            <span>
              <strong>{shown.counts.buildings.toLocaleString('en-PH')}</strong> mapped buildings
            </span>
          )}
          {shown.counts.roads != null && (
            <span>
              <strong>{shown.counts.roads.toLocaleString('en-PH')}</strong> road segments
            </span>
          )}
          <small>
            {shown.mode === 'demonstration' ? 'Illustrative hazard · ' : ''}intersecting the
            inundation · open exposure
          </small>
        </button>
      )}
      <div className="section-label">
        PRECIPITATION <CloudRain size={13} />
      </div>
      <div className="weather-summary">
        <strong>
          {number(rain, 1)}
          <small> mm</small>
        </strong>
        <div>
          <span>Interval accumulation</span>
          <small>{dateTime(monitoring?.timestamp)}</small>
        </div>
      </div>
      <button className="text-button" onClick={() => set({ view: 'rainfall' })}>
        Analyze rainfall <ArrowRight size={12} />
      </button>
      <div className="section-label">GEOGRAPHIC DATA HEALTH</div>
      {[
        ['River networks', 'rivers'],
        ['Barangay boundaries', 'boundaries'],
        ['Critical facilities', 'facilities'],
        ['Elevation model', 'terrain'],
      ].map(([label, role]) => (
        <div className="source-health" key={role}>
          <span
            className={
              geographic.some((d) => d.role === role) ? 'health-dot' : 'health-dot unavailable'
            }
          />
          <span>{label}</span>
          <small>{geographic.some((d) => d.role === role) ? 'Imported' : 'Unavailable'}</small>
        </div>
      ))}
      <button className="text-button" onClick={() => set({ view: 'data' })}>
        Manage local datasets <ArrowRight size={12} />
      </button>
      <p className="situation-footnote">
        Hazard ≠ exposure ≠ risk.
        <br />
        No population or loss estimates without suitable source data.
      </p>
    </aside>
  );
}

function Legend() {
  const { metric, mode, scenarios, scenarioId } = useApp();
  const depth = ['depth', 'maximum', 'extent'].includes(metric);
  if (!scenarios.find((s) => s.id === scenarioId)?.frames.length)
    return (
      <div className="map-legend glass">
        <div>
          <strong>No flood surface</strong>
          <span>UNAVAILABLE</span>
        </div>
        <small>
          {mode === 'imported'
            ? 'IMPORT MODEL OUTPUTS OR SWITCH TO DEMO MODE'
            : 'SELECT A DEMONSTRATION SCENARIO'}
        </small>
      </div>
    );
  return (
    <div className="map-legend glass">
      <div>
        <strong>{metricLabels[metric]}</strong>
        <span>
          {depth
            ? 'METERS'
            : metric === 'velocity'
              ? 'm/s'
              : metric === 'direction'
                ? 'DEGREES CLOCKWISE FROM N'
                : metric === 'arrival' || metric === 'duration'
                  ? 'MINUTES'
                  : 'METERS · DECLARED DATUM'}
        </span>
      </div>
      {depth ? (
        <>
          <div className="legend-colors">
            {[0, 1, 2, 3, 4].map((i) => (
              <i className={`depth-${i}`} key={i} />
            ))}
          </div>
          <div className="legend-labels">
            <span>0.01</span>
            <span>0.3</span>
            <span>1.0</span>
            <span>2.0</span>
            <span>≥3.0</span>
          </div>
        </>
      ) : (
        <>
          <div className="legend-gradient" />
          <div className="legend-labels">
            <span>
              {metric === 'velocity' ? '0' : metric === 'direction' ? '0°' : 'Raster minimum'}
            </span>
            <span>
              {metric === 'velocity' ? '≥3' : metric === 'direction' ? '360°' : 'Raster maximum'}
            </span>
          </div>
        </>
      )}
      <small>
        {mode === 'demonstration'
          ? 'ILLUSTRATIVE TEST DATA · NOT A FORECAST'
          : 'SUPPLIED MODEL OUTPUT · REVIEW VALIDATION'}
      </small>
    </div>
  );
}

interface SearchResult {
  name: string;
  longitude: number;
  latitude: number;
  source: string;
}
function GeographicSearch({
  open,
  setOpen,
  map,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  map: RefObject<MapHandle | null>;
}) {
  const { datasets, settings, monitoring, notify } = useApp();
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<SearchResult[]>([]),
    [busy, setBusy] = useState(false);
  const local: SearchResult[] = [
    {
      name: 'Ilagan · reference map center',
      longitude: 121.89,
      latitude: 17.13,
      source: 'Approximate navigation center; not an administrative boundary',
    },
    ...settings.cameras.map((c) => ({ ...c, source: 'Saved camera position' })),
    ...datasets
      .filter((d) => d.bounds && d.mode === useApp.getState().mode)
      .filter((d) => d.kind === 'vector' || d.role === 'terrain')
      .map((d) => ({
        name: d.name,
        longitude: (d.bounds![0] + d.bounds![2]) / 2,
        latitude: (d.bounds![1] + d.bounds![3]) / 2,
        source: d.source,
      })),
    ...[...(monitoring?.live?.stations ?? []), ...(monitoring?.stations ?? [])]
      .filter((s) => s.longitude != null)
      .map((s) => ({
        name: s.name,
        longitude: s.longitude!,
        latitude: s.latitude!,
        source: s.source,
      })),
    {
      name: 'Synthetic demonstration grid · test center',
      longitude: 121.89,
      latitude: 17.13,
      source: 'Synthetic grid near Ilagan. Not a real flood prediction.',
    },
  ];
  async function search(event: React.FormEvent) {
    event.preventDefault();
    const pair = query.split(',').map(Number);
    if (
      pair.length === 2 &&
      pair.every(Number.isFinite) &&
      Math.abs(pair[0]) <= 90 &&
      Math.abs(pair[1]) <= 180
    ) {
      setResults([
        {
          name: 'Entered coordinates',
          latitude: pair[0],
          longitude: pair[1],
          source: 'User-entered WGS84 coordinates',
        },
      ]);
      return;
    }
    setBusy(true);
    try {
      const imported = await request<SearchResult[]>(
        `/search?q=${encodeURIComponent(query)}&mode=${useApp.getState().mode}`,
      );
      setResults([
        ...local.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())),
        ...imported,
      ]);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title="Geographic search"
      description="Search imported feature names, datasets, cameras, or enter latitude, longitude. No external geocoder is required."
    >
      <form onSubmit={search} className="button-row">
        <input
          aria-label="Geographic search query"
          autoFocus
          placeholder="Ilagan, imported place, or 17.13, 121.89"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" variant="default">
          <Search size={15} />
          Search
        </Button>
      </form>
      {busy ? (
        <Busy />
      ) : (
        <div className="search-results">
          {(query ? results : local).slice(0, 30).map((result, index) => (
            <button
              key={index}
              onClick={() => {
                map.current?.flyTo(result.longitude, result.latitude);
                setOpen(false);
              }}
            >
              <MapPinned size={16} />
              <span>
                <strong>{result.name}</strong>
                <small>{result.source}</small>
              </span>
              <ArrowRight size={13} />
            </button>
          ))}
          {query && !results.length && (
            <Empty title="No matching local places">
              Import a geographic layer or search WGS84 coordinates.
            </Empty>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function App() {
  const state = useApp();
  const {
    view,
    mode,
    scenarios,
    scenarioId,
    frame,
    comparisonId,
    comparison,
    mapMode,
    loading,
    online,
    error,
    toast,
    layersOpen,
    navCollapsed,
    settings,
    monitoringPlaying,
    set,
    notify,
  } = state;
  const mainMap = useRef<MapHandle | null>(null),
    comparisonMap = useRef<MapHandle | null>(null);
  const [mapHandle, setMapHandle] = useState<MapHandle | null>(null),
    [alertsOpen, setAlertsOpen] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [panelOpen, setPanelOpen] = useState(true),
    [clock, setClock] = useState(new Date());
  const scenario = scenarios.find((s) => s.id === scenarioId),
    otherScenario = scenarios.find((s) => s.id === comparisonId);
  useEffect(() => {
    void useApp.getState().bootstrap();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setMapHandle(mainMap.current), 400);
    return () => clearTimeout(timer);
  }, [loading, mapMode]);
  useEffect(() => {
    if (!online) return;
    let stopped = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/monitoring?mode=${mode}`,
      );
      socket.onopen = () => set({ socketOnline: true });
      socket.onmessage = (event) => {
        if (stopped) return;
        try {
          const message = JSON.parse(event.data);
          set({ monitoring: message.monitoring, alerts: message.alerts });
        } catch {
          notify('Invalid local monitoring message.');
        }
      };
      socket.onerror = () => set({ socketOnline: false });
      socket.onclose = () => {
        set({ socketOnline: false });
        if (!stopped) timer = setTimeout(connect, 4000);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
      set({ socketOnline: false });
    };
  }, [online, mode, set, notify]);
  useEffect(() => {
    if (!online) return;
    let active = true;
    void request<Monitoring>(`/monitoring?mode=${mode}`)
      .then((monitoring) => {
        if (active) set({ monitoring });
      })
      .catch((e) => notify(e.message));
    return () => {
      active = false;
    };
  }, [mode, online, set, notify]);
  useEffect(() => {
    if (!monitoringPlaying) return;
    let pending = false;
    const timer = setInterval(async () => {
      if (pending) return;
      const s = useApp.getState();
      if (!s.monitoring?.steps || s.monitoring.index >= s.monitoring.steps - 1) {
        s.set({ monitoringPlaying: false });
        return;
      }
      pending = true;
      try {
        await replayStep();
      } catch (e) {
        s.set({ monitoringPlaying: false });
        notify((e as Error).message);
      } finally {
        pending = false;
      }
    }, 1300);
    return () => clearInterval(timer);
  }, [monitoringPlaying, notify]);
  useEffect(() => {
    if (view !== 'command' || !scenario?.frames.length) {
      if (!scenario?.frames.length) set({ exposure: null });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        void request<Exposure>(`/exposure/${scenarioId}?frame=${frame}`, {
          signal: controller.signal,
        })
          .then((exposure) => set({ exposure }))
          .catch((e) => {
            if (!controller.signal.aborted) notify(e.message);
          }),
      250,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [scenarioId, scenario?.frames.length, frame, view, set, notify]);
  useEffect(() => {
    const saved = scenario?.settings;
    if (saved && Object.keys(saved).length) {
      const current = useApp.getState().settings;
      set({
        settings: {
          ...current,
          ...(typeof saved.opacity === 'number' ? { opacity: saved.opacity } : {}),
          ...(saved.layers && typeof saved.layers === 'object'
            ? { layers: saved.layers as Settings['layers'] }
            : {}),
        },
      });
    }
  }, [scenarioId]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        (event.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable=true],[role=dialog]',
        )
      )
        return;
      if (event.key === '/') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key.toLowerCase() === 'l') {
        event.preventDefault();
        set({ layersOpen: !useApp.getState().layersOpen });
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [set]);
  useEffect(() => {
    let pending = false;
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        await request('/health');
        if (!useApp.getState().online) await useApp.getState().refresh();
      } catch (error) {
        useApp.getState().set({
          online: false,
          socketOnline: false,
          playing: false,
          monitoringPlaying: false,
          error: (error as Error).message,
        });
      } finally {
        pending = false;
      }
    }, 8000);
    return () => clearInterval(timer);
  }, []);
  function syncCamera(camera: CameraPosition) {
    if (comparison) comparisonMap.current?.setCamera(camera);
  }
  if (loading)
    return (
      <div className="startup">
        <Logo />
        <Busy>Opening local workspace…</Busy>
        <p>Geographic data · simulation manifests · monitoring replay</p>
      </div>
    );
  return (
    <div
      className={`app view-${view} ${comparison ? 'comparing' : ''} ${navCollapsed ? 'nav-collapsed' : ''} ${!panelOpen ? 'panel-collapsed' : ''}`}
    >
      <header className="topbar">
        <Logo />
        <div className="workspace-label">
          <span />
          ILAGAN WORKSPACE <ChevronDown size={12} />
        </div>
        <button className="global-search" onClick={() => setSearchOpen(true)}>
          <Search size={15} />
          <span>Search a location or dataset</span>
          <kbd>/</kbd>
        </button>
        <div className="header-status">
          <span className={online ? 'health-dot' : 'health-dot offline'} />
          <span>{online ? 'LOCAL SERVICES' : 'DISCONNECTED'}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open alerts"
          className="notification-button"
          onClick={() => setAlertsOpen(true)}
        >
          <Bell size={18} />
          {state.alerts.some((a) => a.status === 'active') && <i />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Help and shortcuts"
          onClick={() => setHelpOpen(true)}
        >
          <HelpCircle size={18} />
        </Button>
        <div className="header-clock">
          <strong>
            {clock.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour12: false })}
          </strong>
          <small>PHILIPPINE STANDARD TIME</small>
        </div>
      </header>
      <div className="workbench">
        <nav className="side-nav" aria-label="Main navigation">
          {navigation.map(({ view: key, label, icon: Icon }) => (
            <button
              key={key}
              title={label}
              aria-label={label}
              aria-current={view === key ? 'page' : undefined}
              className={view === key ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                set({ view: key });
                setPanelOpen(true);
              }}
            >
              <Icon size={21} />
              <span>{label}</span>
              {view === key && <i />}
            </button>
          ))}
          <div className="nav-spacer" />
          <button
            className={view === 'settings' ? 'nav-item active' : 'nav-item'}
            aria-label="Settings"
            onClick={() => {
              set({ view: 'settings' });
              setPanelOpen(true);
            }}
          >
            <Settings2 size={21} />
            <span>Settings</span>
          </button>
          <button
            className="nav-item collapse-nav"
            aria-label="Collapse navigation"
            onClick={() => set({ navCollapsed: !navCollapsed })}
          >
            {navCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </nav>
        <main className="map-stage">
          <div className={`maps ${comparison ? 'maps-comparing' : ''}`}>
            <GeoMap ref={mainMap} scenario={scenario} onCamera={syncCamera} />
            {comparison && <GeoMap ref={comparisonMap} scenario={otherScenario} secondary />}
          </div>
          <div className="map-topbar">
            <div className="breadcrumb">
              <span>Operations</span>
              <ChevronRight size={11} />
              <strong>{navigation.find((n) => n.view === view)?.label ?? 'Settings'}</strong>
            </div>
            <div className="map-actions">
              <select
                aria-label="Data mode"
                className={`mode-switch mode-${mode}`}
                value={mode}
                onChange={(e) => state.changeMode(e.target.value as 'demonstration' | 'imported')}
              >
                <option value="demonstration">● DEMO MODE</option>
                <option value="imported">● IMPORTED DATA</option>
              </select>
              <div className="dimension-toggle">
                <button
                  aria-label="Use 2D map"
                  className={mapMode === '2d' ? 'active' : ''}
                  onClick={() => set({ mapMode: '2d' })}
                >
                  2D
                </button>
                <button
                  aria-label="Use 3D map"
                  className={mapMode === '3d' ? 'active' : ''}
                  onClick={() => set({ mapMode: '3d' })}
                >
                  3D
                </button>
              </div>
              <Button
                size="sm"
                aria-expanded={layersOpen}
                onClick={() => set({ layersOpen: !layersOpen })}
              >
                <Layers size={14} />
                Layers
              </Button>
            </div>
          </div>
          {error && (
            <div className="service-error" role="alert">
              <TriangleAlert size={16} />
              <span>{error}</span>
              <Button size="sm" onClick={() => void state.bootstrap()}>
                <RefreshCw size={12} />
                Retry backend
              </Button>
            </div>
          )}
          <section
            className={`main-panel glass ${view === 'command' ? 'command-panel' : ''} ${panelOpen ? '' : 'hidden-panel'}`}
            aria-label={`${view} panel`}
          >
            <button
              className="panel-collapse"
              aria-label="Collapse work panel"
              onClick={() => setPanelOpen(false)}
            >
              <ChevronLeft size={15} />
            </button>
            <div className="panel-scroll">
              {view === 'command' && (
                <CommandPanel openAlerts={() => setAlertsOpen(true)} map={mapHandle} />
              )}{' '}
              {view === 'simulation' && <SimulationPanel />}
              {view === 'monitoring' && <MonitoringPanel map={mapHandle} />}{' '}
              {view === 'rainfall' && <RainfallPanel />}
              {view === 'exposure' && <ExposurePanel />}
              {view === 'scenarios' && <ScenarioPanel />}
              {view === 'data' && <DataPanel map={mapHandle} />}{' '}
              {view === 'reports' && <ReportsPanel map={mapHandle} />}{' '}
              {view === 'settings' && <SettingsPanel map={mapHandle} />}
            </div>
          </section>
          {!panelOpen && (
            <Button
              className="expand-panel"
              size="icon"
              aria-label="Expand work panel"
              onClick={() => setPanelOpen(true)}
            >
              <ChevronRight size={16} />
            </Button>
          )}
          {view === 'command' && panelOpen && !comparison && <SituationPanel />}
          {layersOpen && (
            <div className="layers-popover glass">
              <Button
                size="icon"
                className="popover-close"
                aria-label="Close layers"
                onClick={() => set({ layersOpen: false })}
              >
                <X size={14} />
              </Button>
              <LayersPanel />
            </div>
          )}
          <InspectionPanel />
          <Legend />
          {comparison && (
            <div className="compare-banner">
              <GitCompareArrows size={14} />
              <span>
                A · {scenario?.name} <i>vs.</i> B · {otherScenario?.name}
              </span>
              <Button size="sm" onClick={() => set({ comparison: false })}>
                Close comparison
              </Button>
            </div>
          )}
          <Timeline scenario={scenario} />
          <div className="bottom-status">
            <span>
              <span className={online ? 'health-dot' : 'health-dot offline'} />
              FILESYSTEM STORAGE <i /> NO DATABASE
            </span>
            <span>
              {mode === 'demonstration'
                ? 'SYNTHETIC DATA · NOT FOR OPERATIONAL FLOOD FORECASTING'
                : 'IMPORTED DATA · REVIEW SOURCE AND MODEL VALIDATION'}
            </span>
            <span>
              AGOSPH <b>LOCAL v1.0</b>
            </span>
          </div>
        </main>
      </div>
      <AlertCenter open={alertsOpen} onOpenChange={setAlertsOpen} />
      <GeographicSearch open={searchOpen} setOpen={setSearchOpen} map={mainMap} />
      <Modal
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title="AgosPH local workbench"
        description="A local flood-data testing and visualization platform for Ilagan."
      >
        <p className="body-copy">
          In demo mode, open a terrain demonstration, press Play, and click the map to inspect
          depth, arrival time, and peak depth. These illustrative scenarios spread an assumed river
          rise over the imported terrain; they are not forecasts. Open Simulation to compare the
          moderate and high scenarios. Use Monitoring replay to cross thresholds and generate local
          test alerts.
        </p>
        <p className="body-copy">
          Log field incidents from Command: name the barangay, pick the location on the map, and
          move each record from reported to verified, responding, and resolved. Demo mode saves them
          as EXERCISE records. Nothing is transmitted.
        </p>
        <p className="body-copy">
          Import real vector layers, GeoTIFF model outputs, monitoring/rainfall CSV, or hydrographs
          through Data Center. Attach time-stamped depth rasters to a scenario. Configure real
          terrain in Settings.
        </p>
        <div className="provenance">
          <h4>SHORTCUTS</h4>
          <p>
            Space: play/pause · Arrow keys: step frames · Home: rewind · Esc: pause both replays ·
            L: layers · /: geographic search
          </p>
          <h4>GEOGRAPHIC ACCURACY</h4>
          <p>
            OpenStreetMap provides the reference basemap. Terrain, barangay boundaries, rivers, and
            infrastructure come only from imported, sourced datasets shown in Data Center; an
            imported DEM drives 3D terrain automatically. Without one, the flat ellipsoid is
            labeled. Test sensors have no fabricated locations.
          </p>
        </div>
      </Modal>
      {toast && (
        <div className="toast" role="status">
          <Activity size={16} />
          <span>{toast}</span>
          <button aria-label="Dismiss notification" onClick={() => set({ toast: '' })}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
