import { beforeEach, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useApp } from '../store';
import { RainfallRasterPlayer } from './RainfallRasterPlayer';
import type { Dataset } from '../types';
beforeEach(() => useApp.setState(useApp.getInitialState(), true));
it('lists imported rainfall rasters in demonstration mode, as the map draws them', () => {
  useApp.setState({
    mode: 'demonstration',
    datasets: [
      {
        id: 'rain-1',
        name: 'CHIRPS day 1',
        role: 'rainfall',
        kind: 'raster',
        mode: 'imported',
        observation_timestamp: '2025-11-01T00:00:00Z',
        source: 'CHIRPS fixture',
      } as Dataset,
    ],
  });
  render(<RainfallRasterPlayer />);
  expect(screen.getByRole('option', { name: /CHIRPS day 1/ })).toBeInTheDocument();
});
