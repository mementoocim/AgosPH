import { useEffect, useState } from 'react';
import {
  ChevronDown,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Square,
  Waves,
} from 'lucide-react';
import { useApp } from '../store';
import { axisLabels, dateTime } from '../api';
import type { Scenario } from '../types';
import { Badge, Button, Field, Modal } from './ui';

export function Timeline({ scenario }: { scenario?: Scenario }) {
  const { frame, playing, speed, set, step, notify } = useApp();
  const count = scenario?.frames.length ?? 0;
  const [range, setRange] = useState<[number, number]>([0, Math.max(0, count - 1)]),
    [windowOpen, setWindowOpen] = useState(false);
  useEffect(() => {
    setRange([0, Math.max(0, count - 1)]);
  }, [scenario?.id, count]);
  useEffect(() => {
    if (!playing || !count) return;
    const timer = setInterval(() => {
      const state = useApp.getState();
      if (state.frame >= range[1]) state.set({ playing: false });
      else state.step(1);
    }, 1000 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, count, range]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (
        (event.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable=true],[role=dialog]',
        )
      )
        return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (count) set({ playing: !useApp.getState().playing });
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        set({ frame: Math.min(range[1], useApp.getState().frame + 1), exposure: null });
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        set({ frame: Math.max(range[0], useApp.getState().frame - 1), exposure: null });
      } else if (event.key === 'Home') {
        event.preventDefault();
        set({ frame: range[0], playing: false, exposure: null });
      } else if (event.key === 'Escape')
        set({ playing: false, monitoringPlaying: false, layersOpen: false });
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [count, range, set, step]);
  const current = scenario?.frames[frame];
  const labels = axisLabels(scenario?.frames.map((f) => f.timestamp) ?? []);
  return (
    <div className="timeline">
      <div className="timeline-title">
        <div>
          <Waves size={17} />
          <span>SIMULATION PLAYBACK</span>
          <Badge tone={scenario?.mode === 'demonstration' ? 'orange' : 'cyan'}>
            {scenario?.mode === 'demonstration' ? 'DEMO' : (scenario?.status ?? 'UNAVAILABLE')}
          </Badge>
        </div>
        <div>
          <span>{current ? dateTime(current.timestamp) : 'No temporal model outputs loaded'}</span>
          <Button size="sm" disabled={!count} onClick={() => setWindowOpen(true)}>
            Time window <ChevronDown size={11} />
          </Button>
        </div>
      </div>
      <div className="timeline-main">
        <div className="playback-buttons">
          <Button
            size="icon"
            aria-label="Restart simulation"
            disabled={!count}
            onClick={() => set({ frame: range[0], playing: false, exposure: null })}
          >
            <RotateCcw size={15} />
          </Button>
          <Button
            size="icon"
            aria-label="Previous frame"
            disabled={!count || frame <= range[0]}
            onClick={() => step(-1)}
          >
            <SkipBack size={16} />
          </Button>
          <Button
            size="icon"
            variant="default"
            className="play-button"
            aria-label={playing ? 'Pause simulation' : 'Play simulation'}
            disabled={!count}
            onClick={() => {
              if (!playing && frame >= range[1]) set({ frame: range[0] });
              set({ playing: !playing });
            }}
          >
            {playing ? (
              <Pause size={18} fill="currentColor" />
            ) : (
              <Play size={18} fill="currentColor" />
            )}
          </Button>
          <Button
            size="icon"
            aria-label="Next frame"
            disabled={!count || frame >= range[1]}
            onClick={() => step(1)}
          >
            <SkipForward size={16} />
          </Button>
          <Button
            size="icon"
            aria-label="Stop simulation"
            disabled={!count}
            onClick={() => set({ frame: range[0], playing: false, exposure: null })}
          >
            <Square size={13} />
          </Button>
        </div>
        <div className="timeline-track">
          <input
            aria-label="Simulation timeline"
            type="range"
            disabled={!count}
            min={range[0]}
            max={range[1]}
            step="1"
            value={frame}
            onChange={(e) => set({ frame: Number(e.target.value), exposure: null })}
            style={
              {
                '--progress': `${range[1] === range[0] ? 0 : ((frame - range[0]) / (range[1] - range[0])) * 100}%`,
              } as React.CSSProperties
            }
          />
          <div className="timeline-ticks">
            {scenario?.frames
              .map((f, i) => ({ key: f.timestamp, label: labels[i], i }))
              .filter(({ i }) => i >= range[0] && i <= range[1])
              .filter((_, j) => count <= 9 || j % Math.ceil(count / 8) === 0)
              .map(({ key, label }) => (
                <span key={key}>{label}</span>
              ))}
          </div>
        </div>
        <div className="timeline-speed">
          <select
            aria-label="Playback speed"
            value={speed}
            onChange={(e) => set({ speed: Number(e.target.value) })}
          >
            {[0.25, 0.5, 1, 2, 4].map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
          <select
            aria-label="Select simulation time step"
            disabled={!count}
            value={count ? frame : ''}
            onChange={(e) => set({ frame: Number(e.target.value), exposure: null })}
          >
            {!count && <option value="">No frames</option>}
            {scenario?.frames.map((f, i) => (
              <option key={f.timestamp} value={i} disabled={i < range[0] || i > range[1]}>
                Frame {i + 1} · {labels[i]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Modal
        open={windowOpen}
        onOpenChange={setWindowOpen}
        title="Simulation time window"
        description="Select an inclusive playback range from existing output frames."
      >
        <div className="form-grid">
          <Field label="Start frame">
            <select
              value={range[0]}
              onChange={(e) => {
                const start = Number(e.target.value);
                setRange([start, Math.max(start, range[1])]);
                set({ frame: start, playing: false });
              }}
            >
              {labels.map((label, i) => (
                <option key={i} value={i}>
                  {i + 1} · {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="End frame">
            <select
              value={range[1]}
              onChange={(e) => {
                const end = Number(e.target.value);
                setRange([Math.min(end, range[0]), end]);
                set({ frame: Math.min(frame, end), playing: false });
              }}
            >
              {labels.map((label, i) => (
                <option key={i} value={i}>
                  {i + 1} · {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button
          onClick={() => {
            setWindowOpen(false);
            notify('Playback window updated. Output files are unchanged.');
          }}
        >
          Apply time window
        </Button>
      </Modal>
    </div>
  );
}
