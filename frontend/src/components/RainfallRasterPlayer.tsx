import { useEffect, useState } from 'react';
import { Pause, Play, SkipForward } from 'lucide-react';
import { dateTime } from '../api';
import { useApp } from '../store';
import { rainfallFrames } from '../geo';
import { Button, Empty, Field } from './ui';

export function RainfallRasterPlayer() {
  const { datasets, mode, rainfallIndex, set, settings, saveSettings, notify } = useApp();
  const [playing, setPlaying] = useState(false);
  // Same frame list the map draws, so imported rainfall also plays in demo mode.
  const frames = rainfallFrames(datasets, mode);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const current = useApp.getState().rainfallIndex;
      if (current >= frames.length - 1) setPlaying(false);
      else set({ rainfallIndex: current + 1 });
    }, 1100);
    return () => clearInterval(timer);
  }, [playing, frames.length, set]);
  useEffect(() => {
    if (rainfallIndex >= frames.length) set({ rainfallIndex: 0 });
  }, [frames.length, rainfallIndex, set]);
  async function enable() {
    if (!settings.layers.rainfall?.visible)
      await saveSettings({
        layers: { ...settings.layers, rainfall: { visible: true, opacity: 0.65 } },
      });
  }
  return (
    <>
      <div className="section-heading">
        <h3>Georeferenced rainfall playback</h3>
      </div>
      {frames.length ? (
        <>
          <Field label="Rainfall raster timestamp">
            <select
              aria-label="Rainfall raster timestamp"
              value={Math.min(rainfallIndex, frames.length - 1)}
              onChange={(e) => {
                set({ rainfallIndex: Number(e.target.value) });
                void enable().catch((e) => notify(e.message));
              }}
            >
              {frames.map((d, i) => (
                <option key={d.id} value={i}>
                  {dateTime(d.observation_timestamp)} · {d.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="button-row">
            <Button
              onClick={async () => {
                try {
                  await enable();
                  if (rainfallIndex >= frames.length - 1) set({ rainfallIndex: 0 });
                  setPlaying(!playing);
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            >
              {playing ? <Pause size={13} /> : <Play size={13} />}{' '}
              {playing ? 'Pause rainfall layers' : 'Animate rainfall layers'}
            </Button>
            <Button
              aria-label="Next rainfall raster"
              disabled={rainfallIndex >= frames.length - 1}
              onClick={() => {
                set({ rainfallIndex: rainfallIndex + 1 });
                void enable().catch((e) => notify(e.message));
              }}
            >
              <SkipForward size={13} />
            </Button>
          </div>
          <p className="tiny muted">
            {frames[rainfallIndex]?.source}. Timeline shows supplied raster observation times; no
            forecast is generated.
          </p>
        </>
      ) : (
        <Empty title="Temporal rainfall rasters unavailable">
          Import rainfall GeoTIFFs with observation timestamps to animate actual georeferenced
          layers.
        </Empty>
      )}
    </>
  );
}
