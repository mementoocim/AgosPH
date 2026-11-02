import type { ImageryLayer, Viewer } from 'cesium';
import { create } from 'zustand';
import type { Metric, Scenario } from './types';

const STORAGE_KEY = 'agosph.surface.smooth';
function storedSmooth() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}
/** Per-viewer display preference: interpolated flood edges, or the model cells as computed. */
export const useSurfaceDisplay = create<{ smooth: boolean; setSmooth: (smooth: boolean) => void }>(
  (set) => ({
    smooth: storedSmooth(),
    setSmooth: (smooth) => {
      set({ smooth });
      try {
        localStorage.setItem(STORAGE_KEY, smooth ? '1' : '0');
      } catch {
        /* storage unavailable: the choice lasts for this session */
      }
    },
  }),
);

type SurfaceScenario = Pick<Scenario, 'id' | 'updated_at' | 'frames'>;
/** Versioned image URL: its content never changes, so the browser can cache it. */
export function surfaceUrl(
  scenario: SurfaceScenario,
  frame: number,
  metric: Metric,
  smooth: boolean,
) {
  const index = Math.max(0, Math.min(frame, scenario.frames.length - 1));
  return `/api/scenarios/${scenario.id}/surface.png?frame=${index}&metric=${metric}&smooth=${smooth ? 1 : 0}&v=${encodeURIComponent(scenario.updated_at)}`;
}
/** Images of the next frames, fetched ahead so playback swaps from cache. */
export function prefetchUrls(
  scenario: SurfaceScenario,
  frame: number,
  metric: Metric,
  smooth: boolean,
  ahead = 2,
) {
  const urls: string[] = [];
  for (let i = frame + 1; i <= Math.min(frame + ahead, scenario.frames.length - 1); i++)
    urls.push(surfaceUrl(scenario, i, metric, smooth));
  return urls;
}
/** Crossfade length, kept under one playback interval so transitions never pile up. */
export function fadeMs(speed: number) {
  return Math.round(Math.min(450, 600 / speed));
}
/** The unfinished crossfade of each map, settled when the next frame arrives. */
const fading = new WeakMap<Viewer, () => void>();
/**
 * Fades a new flood frame in on top while the previous one fades out underneath, then removes
 * the old frame. `alpha` is read on every tick so an opacity change made mid-fade is not lost.
 */
export function crossfade(
  v: Viewer,
  incoming: ImageryLayer,
  outgoing: ImageryLayer[],
  alpha: () => number,
  ms: number,
) {
  fading.get(v)?.();
  const added = performance.now();
  let started: number | undefined;
  let done = false;
  incoming.alpha = 0;
  // Cesium prepares a new layer's imagery over several renders. The fade starts after the first
  // render that finished loading it, so the old frame never fades out over undrawn tiles.
  const drawn = v.scene.postRender.addEventListener(() => {
    if (v.scene.globe.tilesLoaded) started ??= performance.now();
  });
  const finish = () => {
    if (done) return;
    done = true;
    drawn();
    if (fading.get(v) === finish) fading.delete(v);
    if (!incoming.isDestroyed()) incoming.alpha = alpha();
    outgoing.forEach((layer) => v.imageryLayers.remove(layer, true));
    v.scene.requestRender();
  };
  fading.set(v, finish);
  const tick = () => {
    if (done || v.isDestroyed()) return;
    // A newer frame or a cleared scenario removed this one; the frames under it must go too.
    if (incoming.isDestroyed()) return finish();
    const target = alpha();
    const now = performance.now();
    // Other tiles streaming in can keep the globe loading; start anyway after half the fade.
    if (started === undefined && now - added >= ms / 2) started = now;
    const progress = started === undefined ? 0 : ms ? Math.min(1, (now - started) / ms) : 1;
    // Smoothstep, so neither frame pops in or out at the ends of the fade.
    const eased = progress * progress * (3 - 2 * progress);
    // Two translucent layers drawn together look darker than one. Splitting the see-through
    // share (1 − target) between them keeps the combined opacity at the target wherever both
    // frames are wet, and fades the old frame out as gradually as the new one fades in.
    const clear = 1 - target;
    incoming.alpha = 1 - clear ** eased;
    outgoing.forEach((layer) => (layer.alpha = 1 - clear ** (1 - eased)));
    v.scene.requestRender();
    if (progress < 1) requestAnimationFrame(tick);
    else finish();
  };
  requestAnimationFrame(tick);
}
