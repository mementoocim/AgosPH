import { beforeEach, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useSurfaceDisplay } from '../surface';
import { SurfaceDisplayToggle } from './SurfaceDisplayToggle';

beforeEach(() => useSurfaceDisplay.setState({ smooth: true }));

it('switches between the smooth display and the model cells', () => {
  render(<SurfaceDisplayToggle />);
  const toggle = screen.getByRole('checkbox', { name: 'Smooth flood display' });
  expect(toggle).toBeChecked();
  expect(screen.getByText(/Display only/)).toBeVisible();
  fireEvent.click(toggle);
  expect(useSurfaceDisplay.getState().smooth).toBe(false);
  expect(screen.getByText(/model cells/)).toBeVisible();
});
