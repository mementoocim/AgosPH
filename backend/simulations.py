import json
import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import rasterio
from filelock import FileLock
from rasterio.enums import Resampling
from rasterio.transform import from_bounds

from . import terrain_demo
from .contracts import ScenarioInput
from .datasets import DatasetService, color_image, now, version
from .repository import JsonRepository

METRICS = ('depth', 'velocity', 'direction', 'wse')
LAB_PREFIXES = ('demo-standard-', 'demo-intense-')
TERRAIN_PREFIXES = ('demo-terrain-',)
# Display images: model cells at native resolution, or a 2x bilinear-interpolated view.
CELL_LIMIT, SMOOTH_LIMIT, SMOOTH_UPSAMPLE = 2048, 1600, 2


class ScenarioService:
    def __init__(self, root: Path, datasets: DatasetService):
        self.root, self.datasets = root, datasets
        self.repo = JsonRepository(root, 'scenarios')
        self.config = JsonRepository(root, 'config')
        # Serializes fixture generation so pruning never removes rasters of a run in progress.
        self.generation = FileLock(str(root / 'config' / '.fixtures.lock'), timeout=900)
        self._images: OrderedDict = OrderedDict()
        self._images_lock = threading.Lock()

    def referenced(self):
        return {f[k] for s in self.repo.list() for f in s['frames'] for k in METRICS if f.get(k)}

    def prune(self, prefixes):
        """Delete generated demonstration rasters that no scenario references (reloads, interrupted runs)."""
        keep = self.referenced()
        for d in self.datasets.repo.list():
            if d['mode'] == 'demonstration' and d['id'] not in keep and d['name'].startswith(prefixes):
                self.datasets.delete(d)

    def read(self, dataset, preview, smooth=False):
        if preview and smooth:
            return self.datasets.raster_wgs84(dataset, SMOOTH_LIMIT, SMOOTH_UPSAMPLE, Resampling.bilinear)
        if preview:
            return self.datasets.raster_wgs84(dataset, CELL_LIMIT)
        with rasterio.open(self.datasets.path(dataset)) as src:
            return src.read(1, masked=True).astype('float32').filled(np.nan), src.transform

    def validate(self, value: ScenarioInput):
        data = value.model_dump(mode='json')
        times = [datetime.fromisoformat(f['timestamp']) for f in data['frames']]
        if any(b <= a for a, b in zip(times, times[1:])):
            raise ValueError('Frame timestamps must strictly increase')
        intervals = [(b - a).total_seconds() for a, b in zip(times, times[1:])]
        if intervals and max(intervals) - min(intervals) > 1:
            raise ValueError('Time steps must be consistent. Split irregular outputs into separate scenarios.')
        signature = None
        total_cells = 0
        for frame in data['frames']:
            for metric in ('depth', 'velocity', 'direction', 'wse'):
                if not frame.get(metric):
                    continue
                d = self.datasets.repo.get(frame[metric])
                if d['kind'] != 'raster' or d['role'] != metric:
                    raise ValueError(f'{metric} frame requires a {metric} GeoTIFF dataset')
                if data['mode'] == 'imported' and d['mode'] == 'demonstration':
                    raise ValueError('Demonstration rasters cannot be relabeled as imported model results')
                current = (d['crs'], d['width'], d['height'], tuple(d['transform']))
                if signature is None:
                    signature = current
                if current != signature:
                    raise ValueError('All frame rasters must have identical CRS, dimensions, resolution, and alignment')
                total_cells += d['width'] * d['height']
        if total_cells > 40_000_000:
            raise ValueError('Local scenario limit is 40 million raster cells across all referenced frames. Subset or resample model exports.')
        data['time_step_seconds'] = intervals[0] if intervals else None
        data['crs'] = signature[0] if signature else None
        data['bounds'] = self.datasets.repo.get(data['frames'][0]['depth'])['bounds'] if data['frames'] else None
        data['format_validation'] = 'Aligned georeferenced temporal rasters' if data['frames'] else 'Awaiting model outputs'
        data['validation_label'] = 'User-asserted validation; not independently verified' if data['status'] == 'validated' else data['status']
        return data

    def create(self, value: ScenarioInput, identifier=None):
        data = self.validate(value)
        data.update(id=identifier or uuid.uuid4().hex, updated_at=now())
        return self.repo.put(data['id'], data)

    def update(self, identifier, value):
        self.repo.get(identifier)
        return self.create(value, identifier)

    def export(self, identifier):
        scenario = self.repo.get(identifier)
        return {field: scenario[field] for field in ScenarioInput.model_fields}

    def surface_png(self, identifier, frame_index=0, metric='depth', smooth=False):
        """Colored display image of one frame, cached per scenario version."""
        scenario = self.repo.get(identifier)
        key = (identifier, scenario.get('updated_at'), frame_index, metric, smooth)
        with self._images_lock:
            if key in self._images:
                self._images.move_to_end(key)
                return self._images[key]
        arr, *_ = self.surface(identifier, frame_index, metric, preview=True, smooth=smooth)
        image = color_image(arr, metric)
        with self._images_lock:
            self._images[key] = image
            while len(self._images) > 160:
                self._images.popitem(last=False)
        return image

    def surface(self, identifier, frame_index=0, metric='depth', preview=False, smooth=False):
        # Averaging angles across 0/360 degrees would invent directions, so direction is never interpolated.
        smooth = smooth and preview and metric != 'direction'
        scenario = self.repo.get(identifier)
        frames = scenario['frames']
        if not frames:
            raise ValueError('Scenario is awaiting model results')
        if frame_index < 0 or frame_index >= len(frames):
            raise ValueError('Frame index is outside the scenario timeline')
        selected = frames[frame_index]
        base = self.datasets.repo.get(frames[0]['depth'])
        if metric in {'maximum', 'arrival', 'duration'}:
            arrays = []
            for frame in frames:
                arr, transform = self.read(self.datasets.repo.get(frame['depth']), preview, smooth)
                arrays.append(arr)
            stack = np.stack(arrays)
            valid = np.isfinite(stack).any(axis=0)
            wet = np.isfinite(stack) & (stack > .01)
            if metric == 'maximum':
                arr = np.max(np.where(np.isfinite(stack), stack, -np.inf), axis=0)
            elif metric == 'arrival':
                minutes = np.array([(datetime.fromisoformat(f['timestamp']) - datetime.fromisoformat(frames[0]['timestamp'])).total_seconds() / 60 for f in frames])
                arr = np.where(wet.any(axis=0), minutes[np.argmax(wet, axis=0)], np.nan)
            else:
                steps = np.array([(datetime.fromisoformat(b['timestamp']) - datetime.fromisoformat(a['timestamp'])).total_seconds() / 60 for a, b in zip(frames, frames[1:])] + [0])
                arr = np.sum(wet * steps[:, None, None], axis=0).astype('float32')
            arr = np.where(valid, arr, np.nan).astype('float32')
        else:
            field = 'depth' if metric == 'extent' else metric
            if not selected.get(field):
                raise ValueError(f'{metric} is unavailable for this frame')
            base = self.datasets.repo.get(selected[field])
            arr, transform = self.read(base, preview, smooth)
            if metric in {'velocity', 'direction', 'wse'}:
                # Flow variables are only meaningful where the same frame is wet.
                depth, _ = self.read(self.datasets.repo.get(selected['depth']), preview, smooth)
                arr = np.where(np.isfinite(depth) & (depth > .01), arr, np.nan).astype('float32')
        return arr, transform, base, scenario

    def inspect(self, identifier, index, lon, lat):
        scenario = self.repo.get(identifier)
        frames = scenario['frames']
        if not frames or not 0 <= index < len(frames):
            raise ValueError('No frame at the requested time')
        frame = frames[index]
        values = {metric: self.datasets.sample(self.datasets.repo.get(frame[metric]), lon, lat) if frame.get(metric) else None for metric in METRICS}
        depths = [values['depth'] if i == index else self.datasets.sample(self.datasets.repo.get(f['depth']), lon, lat) for i, f in enumerate(frames)]
        start = datetime.fromisoformat(frames[0]['timestamp'])
        wet = [i for i, depth in enumerate(depths) if depth is not None and depth > .01]
        known = [(depth, i) for i, depth in enumerate(depths) if depth is not None]
        peak = max(known, key=lambda item: (item[0], -item[1])) if known else None
        return {
            'longitude': lon, 'latitude': lat, 'timestamp': frame['timestamp'], 'scenario': scenario['name'], 'mode': scenario['mode'],
            'source': scenario['source'], 'validation_status': scenario['validation_label'], 'values': values, 'inside_model': values['depth'] is not None,
            'arrival_minutes': (datetime.fromisoformat(frames[wet[0]]['timestamp']) - start).total_seconds() / 60 if wet else None,
            'peak_depth_m': peak[0] if peak else None,
            'peak_timestamp': frames[peak[1]]['timestamp'] if peak and peak[0] > .01 else None,
        }

    def compatible(self, first, second):
        a, b = self.repo.get(first), self.repo.get(second)
        if not a['frames'] or not b['frames']:
            return {'compatible': False, 'reason': 'Both scenarios need result frames'}
        x = self.datasets.repo.get(a['frames'][0]['depth'])
        y = self.datasets.repo.get(b['frames'][0]['depth'])
        same = all(x[key] == y[key] for key in ('crs', 'width', 'height', 'transform'))
        durations_a = [(datetime.fromisoformat(f['timestamp']) - datetime.fromisoformat(a['frames'][0]['timestamp'])).total_seconds() for f in a['frames']]
        durations_b = [(datetime.fromisoformat(f['timestamp']) - datetime.fromisoformat(b['frames'][0]['timestamp'])).total_seconds() for f in b['frames']]
        same = same and durations_a == durations_b
        return {'compatible': same, 'reason': 'Aligned grids and matching elapsed time steps' if same else 'Grid alignment and elapsed timeline must match', 'time_alignment': 'elapsed time from each scenario start'}

    def seed_demo(self, force=False):
        """A rectangular, synthetic test field. This is deliberately not a hydraulic solver."""
        with self.generation:
            if force or not (self.root / 'config' / 'demo-v1.json').exists():
                self._seed_lab()
                self.config.put('demo-v1', {'seeded_at': now(), 'version': 1})
            # Also clears rasters leaked by interrupted runs or earlier versions.
            self.prune(LAB_PREFIXES)

    def terrain_inputs(self):
        datasets = self.datasets.repo.list()
        terrain = sorted((d for d in datasets if d['role'] == 'terrain' and d['kind'] == 'raster' and d['mode'] == 'imported'), key=lambda d: d['created_at'])
        rivers = [d for d in datasets if d['role'] == 'rivers' and d['kind'] == 'vector' and d['mode'] == 'imported']
        return (terrain[0] if terrain else None), rivers

    def seed_terrain_demo(self, force=False):
        """Illustrative scenarios on imported terrain and river lines; regenerated when those inputs change."""
        terrain, rivers = self.terrain_inputs()
        if not terrain or not rivers:
            if force:
                raise ValueError('The terrain demonstration needs an imported terrain DEM and imported river lines. Import both in Data Center first.')
            return []
        inputs = json.loads(json.dumps({'terrain': version(terrain), 'rivers': sorted(version(d) for d in rivers), 'version': terrain_demo.VERSION}))
        with self.generation:
            try:
                marker = self.config.get('demo-terrain-v1')
            except KeyError:
                marker = None
            existing = {s['id'] for s in self.repo.list()}
            if not force and marker and marker.get('inputs') == inputs and all(i in existing for i, _, _ in terrain_demo.SCENARIOS):
                return []
            created = terrain_demo.generate(self, terrain, rivers)
            self.prune(TERRAIN_PREFIXES)
            self.config.put('demo-terrain-v1', {'generated_at': now(), 'inputs': inputs})
        return created

    def _seed_lab(self):
        bounds = [121.875, 17.115, 121.905, 17.145]
        transform = from_bounds(*bounds, 32, 32)
        yy, xx = np.mgrid[:32, :32]
        grid = ((xx // 4 + yy // 4) % 2) * .18 + np.maximum(0, 1 - np.sqrt(((xx - 16) / 19)**2 + ((yy - 16) / 19)**2))
        start = datetime(2026, 1, 15, 0, 0, tzinfo=timezone.utc)
        for scenario_id, name, multiplier in [('demo-standard', 'Playback laboratory · A', 1.), ('demo-intense', 'Playback laboratory · B', 1.5)]:
            frames = []
            for index, phase in enumerate([.05, .25, .5, .8, 1., .9, .65, .35, .1]):
                frame = {'timestamp': (start + timedelta(minutes=index * 30)).isoformat()}
                depth = np.maximum(0, (grid * phase * multiplier * 4) - .35).astype('float32')
                for metric, arr in [('depth', depth), ('velocity', np.where(depth > .01, depth * .35, 0).astype('float32')), ('direction', (xx * 360 / 32).astype('float32'))]:
                    path = self.root / 'uploads' / f'{scenario_id}-{index}-{metric}.tif'
                    with rasterio.open(path, 'w', driver='GTiff', width=32, height=32, count=1, dtype='float32', crs='EPSG:4326', transform=transform, nodata=np.nan) as dst:
                        dst.write(arr, 1)
                    d = self.datasets.ingest(path, path.name, metric, 'AgosPH deterministic synthetic test grid v1. No observed topography, river alignment, or hydraulic calibration. Arbitrary test vectors only.', 'demonstration', 'm/s' if metric == 'velocity' else 'degrees' if metric == 'direction' else 'm')
                    frame[metric] = d['id']
                frames.append(frame)
            self.create(ScenarioInput(name=name, description='Georeferenced synthetic grid for testing playback, inspection, derived metrics, and comparison. Rectangular test domain near Ilagan; it does not represent flood hazard at these locations. Sensors are unlocated test devices.', mode='demonstration', status='illustrative', source='AgosPH synthetic test fixture v1 · 32 × 32 cells · EPSG:4326', model='Illustrative test arrays; no hydraulic model', assumptions={'test_amplitude': multiplier, 'meaning': 'Changing assumptions does not recompute outputs.'}, frames=frames), scenario_id)
