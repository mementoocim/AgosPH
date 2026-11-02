import type { IncidentMarker } from '../incidents';

const SIZE = 28;
/** Pixels from the top of an incident icon down to the diamond's center, which marks the location. */
export const INCIDENT_ANCHOR = SIZE / 2;
const icons = new Map<string, { canvas: HTMLCanvasElement; url: string }>();

export function incidentIconKey(marker: IncidentMarker) {
  return `incident-${marker.color.slice(1)}-${marker.caption ? 'exercise' : 'log'}-${marker.resolved ? 'resolved' : 'open'}`;
}
/** Hazard diamond in the severity color, distinct from station dots and facility pins.
 * Exercise markers carry an EXERCISE plate, so the 2D map (which has no text glyphs) labels them too. */
function icon(marker: IncidentMarker) {
  const key = incidentIconKey(marker);
  const cached = icons.get(key);
  if (cached) return cached;
  const ratio = 2,
    width = marker.caption ? 64 : SIZE,
    height = SIZE + (marker.caption ? 14 : 0);
  const canvas = document.createElement('canvas');
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(ratio, ratio);
  const cx = width / 2,
    cy = SIZE / 2,
    r = SIZE / 2 - 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fillStyle = marker.color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0b1118';
  ctx.stroke();
  ctx.fillStyle = '#0b1118';
  ctx.font = '700 14px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(marker.resolved ? '✓' : '!', cx, cy + 1);
  if (marker.caption) {
    ctx.fillStyle = '#07121ae6';
    ctx.beginPath();
    ctx.roundRect(cx - 29, SIZE - 1, 58, 13, 2);
    ctx.fill();
    ctx.fillStyle = '#edb780';
    ctx.font = '700 8px "Segoe UI", sans-serif';
    ctx.fillText(marker.caption, cx, SIZE + 5.5);
  }
  const value = { canvas, url: canvas.toDataURL('image/png') };
  icons.set(key, value);
  return value;
}
/** Shared data URL, so Cesium keeps one texture per icon variant. */
export const incidentIconUrl = (marker: IncidentMarker) => icon(marker).url;
export function incidentIconImage(marker: IncidentMarker) {
  const { canvas } = icon(marker);
  return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
}
