export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: {
        ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(45000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error(
      'Local service unavailable. Start the FastAPI backend on port 8000, then retry.',
    );
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      message = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    } catch {
      /* retain HTTP status */
    }
    throw new Error(message);
  }
  return response.json();
}
export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function download(path: string, name: string, init?: RequestInit) {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const data = await response.json();
    throw new Error(typeof data.detail === 'string' ? data.detail : 'Export failed');
  }
  downloadBlob(await response.blob(), name);
}
export function time(value?: string | null) {
  return value
    ? new Date(value).toLocaleTimeString('en-PH', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Manila',
      })
    : 'Unavailable';
}
export function dateTime(value?: string | null) {
  return value
    ? new Date(value).toLocaleString('en-PH', {
        timeZone: 'Asia/Manila',
        month: 'short',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }) + ' PHT'
    : 'Unavailable';
}
const manilaDay = (value: string) =>
  new Date(value).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: '2-digit',
  });
/** Time-only axis labels, with dates once a series spans more than one Manila calendar day. */
export function axisLabels(timestamps: string[]) {
  const multiDay = new Set(timestamps.map(manilaDay)).size > 1;
  return timestamps.map((t) => (multiDay ? `${manilaDay(t)} ${time(t)}` : time(t)));
}
export function duration(minutes: number | null | undefined) {
  if (minutes == null) return 'Not reached';
  if (minutes === 0) return 'At start';
  const hours = Math.floor(minutes / 60),
    rest = Math.round(minutes % 60);
  return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`;
}
export function number(value: number | null | undefined, digits = 2) {
  return value == null
    ? '—'
    : value.toLocaleString('en-PH', {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });
}
