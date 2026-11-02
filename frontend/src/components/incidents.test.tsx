import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useApp } from '../store';
import { download, request } from '../api';
import { IncidentLog } from './IncidentLog';
import { ReportsPanel } from './AnalysisPanels';
import type { MapHandle } from './GeoMap';
import type { Barangays, Incident } from '../types';
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api');
  return { ...actual, request: vi.fn(), download: vi.fn().mockResolvedValue(undefined) };
});
const exercise: Incident = {
  id: 'inc-1',
  label: 'EXERCISE · DEMONSTRATION MODE',
  mode: 'demonstration',
  status: 'reported',
  type: 'flooding',
  severity: 'high',
  title: 'Knee-deep water at the school',
  barangay: 'Alibagu',
  barangay_validated: true,
  longitude: 121.89,
  latitude: 17.13,
  reporter: 'Test radio report',
  description: 'Test fixture',
  reported_at: '2026-01-15T06:05:00+00:00',
  history: [{ status: 'reported', at: '2026-01-15T06:06:00+00:00' }],
  created_at: '2026-01-15T06:06:00+00:00',
  updated_at: '2026-01-15T06:06:00+00:00',
};
const operator: Incident = {
  ...exercise,
  id: 'inc-2',
  label: 'OPERATOR LOG · USER-ENTERED',
  mode: 'imported',
  title: 'Road closed at the bridge approach',
};
const boundaries: Barangays = {
  available: true,
  names: ['Alibagu', 'San Vicente (Pob.)'],
  containing: null,
  sources: ['TEST FIXTURE boundaries'],
};
function backend() {
  vi.mocked(request).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/barangays'))
      return path.includes('longitude') ? { ...boundaries, containing: 'Alibagu' } : boundaries;
    if (init?.method === 'POST' || init?.method === 'PUT' || init?.method === 'PATCH')
      return { ...exercise, ...JSON.parse(init.body as string) };
    return {};
  });
}
async function pickAt(longitude: number, latitude: number) {
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Pick location on map' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  act(() => useApp.getState().set({ picking: false, picked: { longitude, latitude } }));
  return screen.findByRole('dialog');
}
function fillRequired(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('Incident title'), {
    target: { value: 'Water over the road' },
  });
  fireEvent.change(within(dialog).getByLabelText('Reported by'), {
    target: { value: 'Barangay radio' },
  });
}
function sent(method: string) {
  const [path, init] = vi.mocked(request).mock.calls.find(([, init]) => init?.method === method)!;
  return { path, body: JSON.parse(init!.body as string) };
}
async function openNew() {
  fireEvent.click(screen.getByRole('button', { name: 'Log incident' }));
  return screen.findByRole('dialog');
}
beforeEach(() => {
  useApp.setState(useApp.getInitialState(), true);
  useApp.setState({ refresh: vi.fn().mockResolvedValue(undefined) });
  vi.clearAllMocks();
});
it('lists only the active data mode and keeps the exercise label visible', () => {
  useApp.setState({ mode: 'demonstration', incidents: [exercise, operator] });
  render(<IncidentLog map={null} />);
  expect(screen.getByText(exercise.title)).toBeVisible();
  expect(screen.queryByText(operator.title)).toBeNull();
  expect(screen.getByText('EXERCISE · DEMONSTRATION MODE')).toBeVisible();
});
it('shows open incidents by default and resolved ones on request', () => {
  const done = { ...exercise, id: 'done', title: 'Cleared road', status: 'resolved' as const };
  useApp.setState({ incidents: [exercise, done] });
  render(<IncidentLog map={null} />);
  expect(screen.queryByText('Cleared road')).toBeNull();
  fireEvent.change(screen.getByLabelText('Filter incident status'), {
    target: { value: 'resolved' },
  });
  expect(screen.getByText('Cleared road')).toBeVisible();
  expect(screen.queryByText(exercise.title)).toBeNull();
});
it('logs an exercise incident with barangay, location, and a PHT report time', async () => {
  backend();
  useApp.setState({ mode: 'demonstration' });
  render(<IncidentLog map={null} />);
  const dialog = await openNew();
  const fill = (label: string, value: string) =>
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
  fill('Incident type', 'rescue_request');
  fill('Incident severity', 'critical');
  fill('Incident title', 'Family stranded on a roof');
  fill('Barangay', 'Alibagu');
  fill('Longitude', '121.9');
  fill('Latitude', '17.12');
  fill('Reported by', 'Barangay radio');
  fill('Reported at (PHT)', '2026-01-15T14:05');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save exercise incident' }));
  await waitFor(() => expect(useApp.getState().refresh).toHaveBeenCalled());
  const { path, body } = sent('POST');
  expect(path).toBe('/incidents');
  expect(body).toMatchObject({
    mode: 'demonstration',
    type: 'rescue_request',
    severity: 'critical',
    title: 'Family stranded on a roof',
    barangay: 'Alibagu',
    longitude: 121.9,
    latitude: 17.12,
    reporter: 'Barangay radio',
    reported_at: '2026-01-15T14:05:00+08:00',
  });
});
it('offers barangay names from imported boundaries', async () => {
  backend();
  render(<IncidentLog map={null} />);
  const dialog = await openNew();
  await waitFor(() => expect(dialog.querySelectorAll('datalist option')).toHaveLength(2));
  expect(within(dialog).getByText(/2 imported barangay boundaries/)).toBeVisible();
});
it('labels barangay names as unchecked when no boundary layer is imported', async () => {
  vi.mocked(request).mockResolvedValue({
    available: false,
    names: [],
    containing: null,
    sources: [],
  });
  useApp.setState({ incidents: [{ ...exercise, barangay_validated: false }] });
  render(<IncidentLog map={null} />);
  expect(screen.getByText('UNCHECKED BARANGAY')).toBeVisible();
  await openNew();
  expect(await screen.findByText(/No barangay boundary layer imported/)).toBeVisible();
});
it('picks the location on the map and suggests the containing barangay', async () => {
  backend();
  render(<IncidentLog map={null} />);
  const first = await openNew();
  fireEvent.click(within(first).getByRole('button', { name: 'Pick location on map' }));
  expect(useApp.getState().picking).toBe(true);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  act(() =>
    useApp.getState().set({ picking: false, picked: { longitude: 121.91, latitude: 17.14 } }),
  );
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('Longitude')).toHaveValue(121.91);
  expect(within(dialog).getByLabelText('Latitude')).toHaveValue(17.14);
  await waitFor(() => expect(within(dialog).getByLabelText('Barangay')).toHaveValue('Alibagu'));
  expect(request).toHaveBeenCalledWith('/barangays?longitude=121.91&latitude=17.14');
  expect(useApp.getState().picked).toBeNull();
});
it('cancels map picking with Escape and keeps the draft', async () => {
  backend();
  render(<IncidentLog map={null} />);
  const first = await openNew();
  fireEvent.change(within(first).getByLabelText('Incident title'), {
    target: { value: 'Draft survives' },
  });
  fireEvent.click(within(first).getByRole('button', { name: 'Pick location on map' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.keyDown(window, { key: 'Escape' });
  const dialog = await screen.findByRole('dialog');
  expect(useApp.getState().picking).toBe(false);
  expect(within(dialog).getByLabelText('Incident title')).toHaveValue('Draft survives');
});
it('moves status forward only and never offers earlier steps', async () => {
  backend();
  useApp.setState({ incidents: [{ ...exercise, status: 'verified' }] });
  render(<IncidentLog map={null} />);
  const select = screen.getByLabelText(`Status of ${exercise.title}`);
  expect(within(select).getByRole('option', { name: 'Reported' })).toBeDisabled();
  fireEvent.change(select, { target: { value: 'responding' } });
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/incidents/inc-1',
      expect.objectContaining({ method: 'PATCH', body: '{"status":"responding"}' }),
    ),
  );
});
it('asks before resolving because resolved incidents cannot be reopened', async () => {
  backend();
  useApp.setState({ incidents: [exercise] });
  render(<IncidentLog map={null} />);
  fireEvent.change(screen.getByLabelText(`Status of ${exercise.title}`), {
    target: { value: 'resolved' },
  });
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm resolve' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/incidents/inc-1',
      expect.objectContaining({ method: 'PATCH', body: '{"status":"resolved"}' }),
    ),
  );
});
it('deletes only after confirmation', async () => {
  backend();
  useApp.setState({ incidents: [exercise] });
  render(<IncidentLog map={null} />);
  fireEvent.click(screen.getByRole('button', { name: `Delete ${exercise.title}` }));
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/incidents/inc-1',
      expect.objectContaining({ method: 'DELETE' }),
    ),
  );
});
it('edits an incident in its own mode and leaves an untouched report time alone', async () => {
  backend();
  useApp.setState({ mode: 'demonstration', incidents: [exercise] });
  render(<IncidentLog map={null} />);
  fireEvent.click(screen.getByRole('button', { name: `Edit ${exercise.title}` }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('Reported at (PHT)')).toHaveValue('2026-01-15T14:05');
  fireEvent.change(within(dialog).getByLabelText('Incident title'), {
    target: { value: 'Water now waist-deep' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(useApp.getState().refresh).toHaveBeenCalled());
  const { path, body } = sent('PUT');
  expect(path).toBe('/incidents/inc-1');
  expect(body).toMatchObject({
    title: 'Water now waist-deep',
    mode: 'demonstration',
    reported_at: null,
  });
});
it('keeps a saved incident saved and closes the form when the refresh afterwards fails', async () => {
  backend();
  useApp.setState({ refresh: vi.fn().mockRejectedValue(new Error('Local service unavailable')) });
  render(<IncidentLog map={null} />);
  const dialog = await openNew();
  fillRequired(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save exercise incident' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(vi.mocked(request).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  );
  expect(screen.getByText('Water over the road')).toBeVisible();
});
it('shows a saved status change even when the refresh afterwards fails', async () => {
  backend();
  useApp.setState({
    incidents: [exercise],
    refresh: vi.fn().mockRejectedValue(new Error('Local service unavailable')),
  });
  render(<IncidentLog map={null} />);
  fireEvent.change(screen.getByLabelText(`Status of ${exercise.title}`), {
    target: { value: 'verified' },
  });
  await waitFor(() =>
    expect(screen.getByLabelText(`Status of ${exercise.title}`)).toHaveValue('verified'),
  );
});
it('keeps a draft in the mode it was opened in when the data mode changes while picking', async () => {
  backend();
  useApp.setState({ mode: 'demonstration' });
  render(<IncidentLog map={null} />);
  fillRequired(await openNew());
  const dialogBefore = await screen.findByRole('dialog');
  fireEvent.click(within(dialogBefore).getByRole('button', { name: 'Pick location on map' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  act(() => useApp.setState({ mode: 'imported' }));
  act(() =>
    useApp.getState().set({ picking: false, picked: { longitude: 121.91, latitude: 17.14 } }),
  );
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('EXERCISE · DEMONSTRATION MODE')).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save exercise incident' }));
  await waitFor(() => expect(sent('POST').body.mode).toBe('demonstration'));
});
it('blocks opening another incident while a location is being picked', async () => {
  backend();
  useApp.setState({ incidents: [exercise] });
  render(<IncidentLog map={null} />);
  fireEvent.click(within(await openNew()).getByRole('button', { name: 'Pick location on map' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('button', { name: 'Log incident' })).toBeDisabled();
  expect(screen.getByRole('button', { name: `Edit ${exercise.title}` })).toBeDisabled();
});
it('saves the report time shown in a new form when it is left unchanged', async () => {
  backend();
  render(<IncidentLog map={null} />);
  const dialog = await openNew();
  fillRequired(dialog);
  const shown = (within(dialog).getByLabelText('Reported at (PHT)') as HTMLInputElement).value;
  expect(shown).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save exercise incident' }));
  await waitFor(() => expect(sent('POST').body.reported_at).toBe(`${shown}:00+08:00`));
});
it('ignores a slow boundary lookup from an earlier map pick', async () => {
  let first: (value: Barangays) => void = () => {};
  vi.mocked(request).mockImplementation(async (path: string) => {
    if (path.includes('longitude=121.91'))
      return new Promise<Barangays>((resolve) => {
        first = resolve;
      });
    if (path.includes('longitude=121.95'))
      return { ...boundaries, containing: 'San Vicente (Pob.)' };
    return boundaries;
  });
  render(<IncidentLog map={null} />);
  await openNew();
  await pickAt(121.91, 17.14);
  const dialog = await pickAt(121.95, 17.15);
  await waitFor(() =>
    expect(within(dialog).getByLabelText('Barangay')).toHaveValue('San Vicente (Pob.)'),
  );
  await act(async () => first({ ...boundaries, containing: 'Alibagu' }));
  expect(within(dialog).getByText(/lies within San Vicente/)).toBeVisible();
  expect(within(dialog).queryByText(/lies within Alibagu/)).toBeNull();
});
it('flies the map to a located incident', () => {
  const map = { flyTo: vi.fn() } as unknown as MapHandle;
  useApp.setState({ incidents: [exercise] });
  render(<IncidentLog map={map} />);
  fireEvent.click(screen.getByRole('button', { name: `Locate ${exercise.title}` }));
  expect(map.flyTo).toHaveBeenCalledWith(121.89, 17.13, 2500);
});
it('exports the incident log of the active data mode as CSV', () => {
  useApp.setState({ mode: 'imported' });
  render(<ReportsPanel map={null} />);
  fireEvent.change(screen.getByLabelText('CSV content'), { target: { value: 'incidents' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  expect(download).toHaveBeenCalledWith(
    expect.stringMatching(/^\/reports\/csv\?kind=incidents&mode=imported/),
    'AgosPH-incidents.csv',
  );
});
it('loads the incident log with the workspace', async () => {
  vi.mocked(request).mockImplementation(async (path: string) =>
    path === '/settings'
      ? {}
      : path.startsWith('/monitoring')
        ? { stations: [] }
        : path === '/incidents'
          ? [exercise]
          : [],
  );
  await useApp.getState().bootstrap();
  expect(useApp.getState().incidents).toEqual([exercise]);
});
