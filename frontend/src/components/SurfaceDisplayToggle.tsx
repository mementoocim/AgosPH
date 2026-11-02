import { useSurfaceDisplay } from '../surface';

export function SurfaceDisplayToggle() {
  const { smooth, setSmooth } = useSurfaceDisplay();
  return (
    <div className="surface-display">
      <label className="check-row">
        <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} />
        Smooth flood display
      </label>
      <p className="tiny muted">
        {smooth
          ? 'Display only: edges are interpolated between model cells. Inspection, exposure and reports always use the model cells.'
          : 'Showing the model cells exactly as computed, one square per grid cell.'}
      </p>
    </div>
  );
}
