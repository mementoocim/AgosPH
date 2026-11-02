"""Terrain-grounded ILLUSTRATIVE inundation fixtures.

An assumed river-stage hydrograph raises water along imported river lines. Water
spreads only into cells connected to a river through terrain lower than the
water surface (a HAND-style, connectivity-constrained bathtub). Velocity and
direction are Manning-type illustrations from depth and the reference water
surface slope. This is a geographic visualization aid, NOT a hydrodynamic model
result or a forecast.
"""
import math
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import rasterio
import shapely
from pyproj import CRS, Transformer
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import Affine

from .contracts import ScenarioInput

VERSION = 1
SCENARIOS = (
    ('demo-terrain-moderate', 'Terrain demonstration · moderate river rise', 4.0),
    ('demo-terrain-high', 'Terrain demonstration · high river rise', 7.0),
)
BASE_STAGE_M = .5
HOURS = tuple(range(0, 37, 2))
PEAK_HOUR = 12
SHAPE_K = 2.5
MANNING_CHANNEL, MANNING_FLOODPLAIN = .035, .06
SLOPE_RANGE = (5e-5, .005)
MAX_VELOCITY = 3.  # conservative cap for an illustrative layer
# Water reaches cells at most this far below the level of the river it spreads from.
# Lower terrain drains toward another channel; a high reach must not fill a valley.
DEPRESSION_M = 1.
CELL_BUDGET = 36_000_000  # stays below the 40 million cell local scenario limit
START = datetime(2026, 1, 15, 0, 0, tzinfo=timezone.utc)
SOURCE = 'AgosPH terrain-based ILLUSTRATIVE inundation v1 from imported terrain and river lines. Assumed river stages; NOT a forecast or hydraulic model result.'
SHIFTS = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx]


def stages(peak):
    t = np.array(HOURS, dtype=float) / PEAK_HOUR
    rise = np.where(t > 0, t ** SHAPE_K * np.exp(SHAPE_K * (1 - t)), 0.)
    return BASE_STAGE_M + peak * rise


def load_terrain(path, rasters):
    with rasterio.open(path) as src:
        factor = 1
        while (src.width // factor) * (src.height // factor) * rasters > CELL_BUDGET:
            factor += 1
        width, height = max(1, src.width // factor), max(1, src.height // factor)
        data = src.read(1, out_shape=(height, width), resampling=Resampling.average, masked=True)
        transform = src.transform @ Affine.scale(src.width / width, src.height / height)
        return data.astype('float32').filled(np.nan), transform, src.crs


def river_lines(layers):
    chosen = []
    for layer in layers:
        lines = np.isin(shapely.get_type_id(layer['geometries']), [1, 2, 5])
        rivers = lines & np.array([p.get('waterway') == 'river' for p in layer['properties']], dtype=bool)
        chosen.append(layer['geometries'][rivers if rivers.any() else lines])
    return np.concatenate(chosen) if chosen else np.array([], dtype=object)


def neighbourhood(arr, reducer, fill):
    """3 × 3 minimum/maximum filter."""
    h, w = arr.shape
    padded = np.pad(arr, 1, constant_values=fill)
    out = arr.copy()
    for dy in range(3):
        for dx in range(3):
            out = reducer(out, padded[dy:dy + h, dx:dx + w])
    return out


def box_mean(values, radius):
    """NaN-aware moving average over a (2r + 1)² window, using summed-area tables."""
    known = np.isfinite(values)
    size = 2 * radius + 1

    def window_sum(arr):
        table = np.pad(arr, ((radius + 1, radius), (radius + 1, radius))).cumsum(0).cumsum(1)
        return table[size:, size:] - table[:-size, size:] - table[size:, :-size] + table[:-size, :-size]
    count = window_sum(known.astype('float64'))
    return np.where(count > 0, window_sum(np.where(known, values, 0.).astype('float64')) / np.maximum(count, 1), np.nan)


def spans(offset, size):
    """Target and source slices for a one-cell shift."""
    if offset > 0:
        return slice(offset, size), slice(0, size - offset)
    if offset < 0:
        return slice(0, size + offset), slice(-offset, size)
    return slice(0, size), slice(0, size)


def required_stage(elevation, river, ceiling):
    """Minimum river stage connecting each cell to a river through lower terrain, and that river's level."""
    finite = np.isfinite(elevation)
    # The lowest neighboring river value limits bank vegetation in a surface model.
    reference = neighbourhood(np.where(river & finite, elevation, np.inf), np.fmin, np.inf)
    seeds = river & finite & np.isfinite(reference)
    spill = np.where(seeds, elevation, np.inf).astype('float32')
    level = np.where(seeds, reference, np.nan).astype('float32')
    cost = np.where(seeds, elevation - reference, np.inf).astype('float32')
    h, w = elevation.shape
    for _ in range(20_000):
        changed = False
        for dy, dx in SHIFTS:
            (ty, sy), (tx, sx) = spans(dy, h), spans(dx, w)
            target = elevation[ty, tx]
            candidate_spill = np.maximum(target, spill[sy, sx])
            candidate_cost = candidate_spill - level[sy, sx]
            better = (candidate_cost < cost[ty, tx] - 1e-4) & (candidate_cost <= ceiling) & (target >= level[sy, sx] - DEPRESSION_M)
            if better.any():
                source_level = level[sy, sx][better]
                spill[ty, tx][better] = candidate_spill[better]
                level[ty, tx][better] = source_level
                cost[ty, tx][better] = candidate_cost[better]
                changed = True
        if not changed:
            break
    return cost, level


def cell_size_m(transform, crs, shape_):
    if crs.is_geographic:
        latitude = transform.f + transform.e * shape_[0] / 2
        return abs(transform.a) * 111_320 * math.cos(math.radians(latitude)), abs(transform.e) * 110_574
    unit = crs.axis_info[0].unit_conversion_factor or 1
    return abs(transform.a) * unit, abs(transform.e) * unit


def water_surface_slope(level, transform, crs):
    """Slope magnitude and downslope azimuth (degrees clockwise from north) of the smoothed river levels.

    Levels are copied from individual river cells, so they are smoothed over about 2 km to
    recover the down-valley water-surface gradient rather than reach-to-reach steps.
    """
    dx, dy = cell_size_m(transform, crs, level.shape)
    radius = max(3, round(1000 / ((dx + dy) / 2)))
    slope = azimuth = None
    # Terrain models flatten long river reaches; where the ~1 km surface is level, use ~4 km.
    for scale in (radius, radius * 4):
        by_row, by_col = np.gradient(box_mean(level, scale), dy, dx)
        north, east = -by_row, by_col
        magnitude = np.hypot(north, east)
        # A level water surface has no defined flow direction.
        direction = np.where(magnitude > 1e-7, (np.degrees(np.arctan2(-east, -north)) + 360) % 360, np.nan)
        if slope is None:
            slope, azimuth = magnitude, direction
        else:
            missing = ~np.isfinite(azimuth)
            slope, azimuth = np.where(missing, magnitude, slope), np.where(missing, direction, azimuth)
    return slope, azimuth


def write(path, arr, transform, crs):
    with rasterio.open(path, 'w', driver='GTiff', width=arr.shape[1], height=arr.shape[0], count=1, dtype='float32', crs=crs, transform=transform, nodata=np.nan, compress='deflate', predictor=3) as dst:
        dst.write(arr.astype('float32'), 1)


def generate(service, terrain, rivers):
    """Create the illustrative scenarios on the imported terrain grid. Returns the scenario records."""
    rasters = len(HOURS) * 3
    elevation, transform, crs = load_terrain(service.datasets.path(terrain), rasters)
    crs = CRS.from_user_input(crs)
    lines = river_lines([service.datasets.features(d) for d in rivers])
    if not len(lines):
        raise ValueError('Imported river datasets contain no line geometries for the terrain demonstration.')
    if not crs.equals(CRS.from_epsg(4326), ignore_axis_order=True):
        project = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
        lines = shapely.transform(lines, lambda xy: np.column_stack(project.transform(xy[:, 0], xy[:, 1])))
    river = rasterize(((g, 1) for g in lines), out_shape=elevation.shape, transform=transform, all_touched=True, dtype='uint8').astype(bool)
    river &= np.isfinite(elevation)
    if not river.any():
        raise ValueError('Imported river lines do not overlap the imported terrain.')
    ceiling = BASE_STAGE_M + max(peak for _, _, peak in SCENARIOS)
    cost, level = required_stage(elevation, river, ceiling)
    reached = np.isfinite(cost)
    rows, cols = np.nonzero(reached)
    top, bottom = max(rows.min() - 3, 0), min(rows.max() + 4, elevation.shape[0])
    left, right = max(cols.min() - 3, 0), min(cols.max() + 4, elevation.shape[1])
    window = (slice(top, bottom), slice(left, right))
    elevation, cost, level, river = elevation[window], cost[window], level[window], river[window]
    transform = transform @ Affine.translation(left, top)
    slope, azimuth = water_surface_slope(level, transform, crs)
    slope = np.clip(np.nan_to_num(slope, nan=SLOPE_RANGE[0]), *SLOPE_RANGE)
    channel = neighbourhood(river.astype('uint8'), np.maximum, 0).astype(bool)
    roughness = np.where(channel, MANNING_CHANNEL, MANNING_FLOODPLAIN)
    finite = np.isfinite(elevation)
    cell = cell_size_m(transform, crs, elevation.shape)
    created = []
    for scenario_id, name, peak in SCENARIOS:
        frames = []
        for index, (hour, stage) in enumerate(zip(HOURS, stages(peak))):
            wet = finite & (cost < stage)
            depth = np.where(wet, np.maximum(level + stage - elevation, 0), 0).astype('float32')
            depth[~finite] = np.nan
            velocity = np.where(depth > .01, np.minimum(np.power(np.nan_to_num(depth), 2 / 3) * np.sqrt(slope) / roughness, MAX_VELOCITY), 0).astype('float32')
            velocity[~finite] = np.nan
            direction = np.where(depth > .01, azimuth, np.nan).astype('float32')
            frame = {'timestamp': (START + timedelta(hours=hour)).isoformat()}
            for metric, arr, unit in (('depth', depth, 'm'), ('velocity', velocity, 'm/s'), ('direction', direction, 'degrees')):
                if not np.isfinite(arr).any():
                    continue  # e.g. no defined flow direction: the frame records it as unavailable
                temp = Path(service.root) / 'uploads' / f'terrain-demo-{uuid.uuid4().hex}.tif'
                try:
                    write(temp, arr, transform, crs)
                    dataset = service.datasets.ingest(temp, f'{scenario_id}-{index:02d}-{metric}.tif', metric, f'{SOURCE} Peak +{peak:g} m stage at {PEAK_HOUR} h.', 'demonstration', unit)
                finally:
                    temp.unlink(missing_ok=True)
                frame[metric] = dataset['id']
            frames.append(frame)
        description = (f'Illustrative inundation on imported terrain "{terrain["name"]}" for an assumed river rise peaking {peak:g} m above the '
                       f'terrain model river surface after {PEAK_HOUR} h. Water spreads from imported river lines only into connected terrain '
                       'below the assumed water surface. No rainfall-runoff, channel hydraulics, levees, culverts, drainage, or calibration. '
                       'Surface models include vegetation and buildings. Velocity and direction are Manning-type illustrations. NOT A FORECAST.')
        value = ScenarioInput(
            name=name, description=description, mode='demonstration', status='illustrative',
            source=f'{SOURCE} Terrain: {terrain["name"]}. Rivers: {", ".join(d["name"] for d in rivers)}.'[:1000],
            model='Connectivity-constrained HAND-style bathtub with an assumed stage hydrograph — NOT a hydrodynamic model',
            model_version=f'AgosPH terrain demonstration v{VERSION}',
            assumptions={
                'peak_stage_above_river_surface_m': peak, 'base_stage_m': BASE_STAGE_M, 'time_to_peak_h': PEAK_HOUR,
                'manning_n_channel': MANNING_CHANNEL, 'manning_n_floodplain': MANNING_FLOODPLAIN,
                'grid_cell_m': [round(cell[0], 1), round(cell[1], 1)], 'river_cells': int(river.sum()),
                'meaning': 'Assumed stages for visualization. They are not derived from rainfall, discharge, or observations.',
            },
            frames=frames, settings={'reference_geography': 'imported', 'featured': True},
        )
        created.append(service.create(value, scenario_id))
    return created
