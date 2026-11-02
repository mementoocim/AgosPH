import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { request, json } from './api';
import { pickScenario } from './geo';
import type {
  AlertRecord,
  Dataset,
  Exposure,
  Incident,
  Inspection,
  Metric,
  Mode,
  Monitoring,
  Scenario,
  Settings,
  View,
} from './types';
interface State {
  view: View;
  mode: Mode;
  scenarios: Scenario[];
  datasets: Dataset[];
  monitoring: Monitoring | null;
  alerts: AlertRecord[];
  incidents: Incident[];
  /** Waiting for a map click that sets an incident location. */
  picking: boolean;
  picked: { longitude: number; latitude: number } | null;
  settings: Settings;
  scenarioId: string;
  frame: number;
  playing: boolean;
  speed: number;
  metric: Metric;
  comparisonId: string;
  comparison: boolean;
  mapMode: '3d' | '2d';
  rainfallIndex: number;
  exposure: Exposure | null;
  inspection: Inspection | null;
  selectedStation: string;
  monitoringPlaying: boolean;
  loading: boolean;
  online: boolean;
  socketOnline: boolean;
  error: string;
  toast: string;
  layersOpen: boolean;
  navCollapsed: boolean;
  set: (patch: Partial<State>) => void;
  notify: (message: string) => void;
  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  selectScenario: (id: string) => void;
  changeMode: (mode: Mode) => void;
  step: (delta: number) => void;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
}
const defaults: Settings = {
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
let settingsQueue: Promise<unknown> = Promise.resolve();
let settingsRevision = 0;
let bootstrapping: Promise<void> | null = null;
export const useApp = create<State>((set, get) => ({
  view: 'command',
  mode: 'demonstration',
  scenarios: [],
  datasets: [],
  monitoring: null,
  alerts: [],
  incidents: [],
  picking: false,
  picked: null,
  settings: defaults,
  scenarioId: '',
  frame: 0,
  playing: false,
  speed: 1,
  metric: 'depth',
  comparisonId: '',
  comparison: false,
  mapMode: '3d',
  rainfallIndex: 0,
  exposure: null,
  inspection: null,
  selectedStation: '',
  monitoringPlaying: false,
  loading: true,
  online: false,
  socketOnline: false,
  error: '',
  toast: '',
  layersOpen: false,
  navCollapsed: false,
  set,
  notify: (toast) => {
    set({ toast });
    setTimeout(() => {
      if (get().toast === toast) set({ toast: '' });
    }, 6000);
  },
  bootstrap: () => {
    // React StrictMode and the retry button can overlap; share one in-flight load.
    bootstrapping ??= (async () => {
      set({ loading: true, error: '' });
      try {
        // Monitoring must be requested for the saved data mode, never the default.
        const settings = { ...defaults, ...(await request<Settings>('/settings')) };
        const [scenarios, datasets, monitoring, alerts, incidents] = await Promise.all([
          request<Scenario[]>('/scenarios'),
          request<Dataset[]>('/datasets'),
          request<Monitoring>(`/monitoring?mode=${settings.data_mode}`),
          request<AlertRecord[]>('/alerts'),
          request<Incident[]>('/incidents'),
        ]);
        set({
          scenarios,
          datasets,
          monitoring,
          alerts,
          incidents,
          settings,
          scenarioId:
            pickScenario(scenarios, settings.data_mode, settings.active_scenario)?.id ?? '',
          mode: settings.data_mode,
          online: true,
          loading: false,
        });
      } catch (e) {
        set({ error: (e as Error).message, online: false, loading: false });
      } finally {
        bootstrapping = null;
      }
    })();
    return bootstrapping;
  },
  refresh: async () => {
    try {
      const [scenarios, datasets, monitoring, alerts, incidents] = await Promise.all([
        request<Scenario[]>('/scenarios'),
        request<Dataset[]>('/datasets'),
        request<Monitoring>(`/monitoring?mode=${get().mode}`),
        request<AlertRecord[]>('/alerts'),
        request<Incident[]>('/incidents'),
      ]);
      set({ scenarios, datasets, monitoring, alerts, incidents, online: true, error: '' });
      if (!scenarios.some((s) => s.id === get().scenarioId))
        get().selectScenario(pickScenario(scenarios, get().mode)?.id ?? '');
    } catch (e) {
      set({ online: false, error: (e as Error).message });
      throw e;
    }
  },
  selectScenario: (scenarioId) => {
    const scenario = get().scenarios.find((s) => s.id === scenarioId);
    set({
      scenarioId,
      frame: 0,
      playing: false,
      inspection: null,
      exposure: null,
      comparison: false,
      metric: 'depth',
      ...(scenario ? { mode: scenario.mode } : {}),
    });
    void get()
      .saveSettings({ active_scenario: scenarioId, data_mode: scenario?.mode ?? get().mode })
      .catch((e) => get().notify(e.message));
  },
  changeMode: (mode) => {
    const scenario = pickScenario(get().scenarios, mode);
    set({
      mode,
      scenarioId: scenario?.id ?? '',
      frame: 0,
      playing: false,
      monitoringPlaying: false,
      comparison: false,
      inspection: null,
      exposure: null,
      monitoring: null,
    });
    void get()
      .saveSettings({ data_mode: mode, active_scenario: scenario?.id ?? '' })
      .catch((e) => get().notify(e.message));
  },
  step: (delta) => {
    const scenario = get().scenarios.find((s) => s.id === get().scenarioId);
    // The inspected location stays open; InspectionPanel re-reads it for the new frame.
    set({
      frame: Math.max(0, Math.min((scenario?.frames.length ?? 1) - 1, get().frame + delta)),
      exposure: null,
    });
  },
  saveSettings: async (patch) => {
    const previous = get().settings;
    const next = { ...previous, ...patch };
    const revision = ++settingsRevision;
    set({ settings: next });
    const pending = settingsQueue
      .catch(() => {})
      .then(() => request<Settings>('/settings', json('PUT', next)));
    settingsQueue = pending;
    try {
      const settings = await pending;
      if (revision === settingsRevision) set({ settings: settings ?? next });
    } catch (error) {
      if (revision === settingsRevision) set({ settings: previous });
      throw error;
    }
  },
}));
// Browser time at which the current monitoring snapshot arrived. Live readings keep ageing from
// here, so a frozen backend or dropped socket can never leave a LIVE badge on screen.
let monitoringSeenAt = Date.now();
useApp.subscribe((state, previous) => {
  if (state.monitoring !== previous.monitoring) monitoringSeenAt = Date.now();
});
/** Seconds since the monitoring snapshot arrived; re-renders every few seconds. */
export function useSnapshotElapsed(interval = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return Math.max(0, (now - monitoringSeenAt) / 1000);
}
export function scenarioInput(scenario: Scenario) {
  const {
    name,
    description,
    mode,
    status,
    source,
    model,
    model_version,
    validation_notes,
    assumptions,
    frames,
    settings,
  } = scenario;
  return {
    name,
    description,
    mode,
    status,
    source,
    model,
    model_version,
    validation_notes,
    assumptions,
    frames,
    settings,
  };
}
