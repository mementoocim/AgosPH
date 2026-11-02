import type { ImageryLayer, Viewer } from 'cesium';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crossfade, fadeMs, prefetchUrls, surfaceUrl, useSurfaceDisplay } from './surface';
import type { Scenario } from './types';

const scenario = {
  id: 'terrain',
  updated_at: '2026-11-01T12:00:00+00:00',
  frames: [0, 1, 2, 3].map((i) => ({ timestamp: `2026-01-15T0${i}:00:00Z`, depth: `d${i}` })),
} as unknown as Scenario;
beforeEach(() => {
  localStorage.clear();
  useSurfaceDisplay.setState({ smooth: true });
});

it('builds versioned surface URLs and clamps the frame to the timeline', () => {
  expect(surfaceUrl(scenario, 2, 'depth', true)).toBe(
    '/api/scenarios/terrain/surface.png?frame=2&metric=depth&smooth=1&v=2026-11-01T12%3A00%3A00%2B00%3A00',
  );
  expect(surfaceUrl(scenario, 9, 'velocity', false)).toContain('frame=3&metric=velocity&smooth=0');
});

it('prefetches the next frames without running past the last one', () => {
  expect(prefetchUrls(scenario, 0, 'depth', true)).toEqual([
    surfaceUrl(scenario, 1, 'depth', true),
    surfaceUrl(scenario, 2, 'depth', true),
  ]);
  expect(prefetchUrls(scenario, 3, 'depth', true)).toEqual([]);
});

it('shortens the crossfade as playback speeds up', () => {
  expect(fadeMs(0.25)).toBe(450);
  expect(fadeMs(1)).toBe(450);
  expect(fadeMs(2)).toBe(300);
  expect(fadeMs(4)).toBe(150);
});

it('defaults to the smooth display and remembers the choice for this viewer', () => {
  expect(useSurfaceDisplay.getState().smooth).toBe(true);
  useSurfaceDisplay.getState().setSmooth(false);
  expect(useSurfaceDisplay.getState().smooth).toBe(false);
  expect(localStorage.getItem('agosph.surface.smooth')).toBe('0');
});

describe('crossfade', () => {
  let now = 0;
  let pending: FrameRequestCallback[] = [];
  let renders: (() => void)[] = [];
  beforeEach(() => {
    now = 0;
    pending = [];
    renders = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      pending.push(callback),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  /** One animation frame: the globe renders first, then the frame callbacks run. */
  const advance = (ms: number) => {
    now += ms;
    renders.forEach((render) => render());
    const due = pending;
    pending = [];
    due.forEach((callback) => callback(now));
  };
  /** The parts of a Cesium viewer the crossfade touches: its imagery layers and render requests. */
  function globe({ tilesLoaded = true } = {}) {
    const shown = new Set<object>();
    const listeners = new Set<() => void>();
    renders.push(() => listeners.forEach((listener) => listener()));
    const tiles = { tilesLoaded };
    const viewer = {
      isDestroyed: () => false,
      scene: {
        requestRender: () => {},
        globe: tiles,
        postRender: {
          addEventListener(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
      imageryLayers: {
        remove(layer: { destroyed: boolean }, destroy: boolean) {
          if (!shown.delete(layer)) return false;
          layer.destroyed = destroy;
          return true;
        },
      },
    };
    const add = () => {
      const layer = {
        alpha: 1,
        destroyed: false,
        isDestroyed() {
          return this.destroyed;
        },
      };
      shown.add(layer);
      return layer as typeof layer & ImageryLayer;
    };
    return { viewer: viewer as unknown as Viewer, shown, add, tiles };
  }

  it('keeps the previous frame underneath until the new one has faded in', () => {
    const map = globe();
    const previous = map.add(),
      next = map.add();
    crossfade(map.viewer, next, [previous], () => 0.8, 400);
    advance(16);
    advance(200);
    expect(next.alpha).toBeGreaterThan(0);
    expect(next.alpha).toBeLessThan(0.8);
    expect(map.shown.has(previous)).toBe(true);
    advance(200);
    expect(next.alpha).toBeCloseTo(0.8);
    expect(map.shown.has(previous)).toBe(false);
  });

  it('still removes the previous frame when the new one is cleared mid-fade', () => {
    const map = globe();
    const previous = map.add(),
      next = map.add();
    crossfade(map.viewer, next, [previous], () => 0.8, 400);
    advance(100);
    map.viewer.imageryLayers.remove(next, true);
    advance(16);
    expect([...map.shown]).toEqual([]);
  });

  it('still removes the oldest frame when a shorter fade overtakes this one', () => {
    const map = globe();
    const oldest = map.add(),
      middle = map.add(),
      newest = map.add();
    crossfade(map.viewer, middle, [oldest], () => 0.8, 450);
    advance(50);
    crossfade(map.viewer, newest, [middle], () => 0.8, 150);
    advance(16);
    advance(150);
    expect([...map.shown]).toEqual([newest]);
  });

  it('follows opacity changes made while the frame fades in', () => {
    const map = globe();
    let opacity = 0.8;
    const next = map.add();
    crossfade(map.viewer, next, [], () => opacity, 400);
    advance(16);
    advance(200);
    opacity = 0.5;
    advance(200);
    expect(next.alpha).toBeCloseTo(0.5);
  });

  it('keeps the combined flood opacity steady while one frame fades into the next', () => {
    const map = globe();
    const previous = map.add(),
      next = map.add();
    previous.alpha = 0.72;
    crossfade(map.viewer, next, [previous], () => 0.72, 400);
    // Where both frames are wet, the top layer covers `alpha` and the one under it covers the rest.
    for (const step of [16, 100, 100, 100]) {
      advance(step);
      expect(next.alpha + (1 - next.alpha) * previous.alpha).toBeCloseTo(0.72, 6);
    }
  });

  it('waits until the new frame is drawn before fading the old one out', () => {
    const map = globe({ tilesLoaded: false });
    const previous = map.add(),
      next = map.add();
    previous.alpha = 0.72;
    crossfade(map.viewer, next, [previous], () => 0.72, 400);
    advance(16);
    advance(16);
    expect(next.alpha).toBe(0);
    expect(previous.alpha).toBeCloseTo(0.72);
    map.tiles.tilesLoaded = true;
    advance(16);
    advance(100);
    expect(next.alpha).toBeGreaterThan(0);
  });

  it('eases both frames at the ends of the fade so neither pops in or out', () => {
    const map = globe();
    const previous = map.add(),
      next = map.add();
    crossfade(map.viewer, next, [previous], () => 0.72, 400);
    advance(16);
    advance(20);
    expect(next.alpha).toBeLessThan(0.02);
    advance(360);
    expect(previous.alpha).toBeLessThan(0.02);
  });

  it('starts the fade after half its length when map tiles keep loading', () => {
    const map = globe({ tilesLoaded: false });
    const previous = map.add(),
      next = map.add();
    crossfade(map.viewer, next, [previous], () => 0.72, 400);
    advance(100);
    expect(next.alpha).toBe(0);
    advance(100);
    advance(400);
    expect([...map.shown]).toEqual([next]);
    expect(next.alpha).toBeCloseTo(0.72);
  });

  it('settles an unfinished fade before the next frame starts fading in', () => {
    const map = globe();
    const oldest = map.add(),
      middle = map.add(),
      newest = map.add();
    crossfade(map.viewer, middle, [oldest], () => 0.8, 400);
    advance(100);
    crossfade(map.viewer, newest, [middle], () => 0.8, 400);
    expect(map.shown.has(oldest)).toBe(false);
    expect(middle.alpha).toBeCloseTo(0.8);
    expect(newest.alpha).toBe(0);
  });
});
