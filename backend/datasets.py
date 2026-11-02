"""Validated local uploads and georeferenced, map-ready derivatives. No network reads."""
import csv
import io
import json
import math
import uuid
from datetime import datetime, timezone
from pathlib import Path

import threading
from collections import OrderedDict

import numpy as np
import rasterio
import shapely
from PIL import Image
from pyproj import Geod
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import calculate_default_transform, reproject, transform_bounds
from shapely.geometry import shape
from shapely import get_coordinates

from .config import MAX_RASTER_CELLS, safe_path
from .repository import JsonRepository

ROLES = {'boundaries', 'rivers', 'roads', 'bridges', 'buildings', 'facilities', 'inundation', 'depth', 'velocity', 'direction', 'wse', 'terrain', 'rainfall', 'monitoring', 'hydrograph'}
VECTOR_ROLES = {'boundaries', 'rivers', 'roads', 'bridges', 'buildings', 'facilities', 'inundation', 'rainfall'}
GEOD = Geod(ellps='WGS84')


def now():
    return datetime.now(timezone.utc).isoformat()


def timestamp(value):
    dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('Timestamps require a UTC offset')
    return dt.isoformat()


def version(dataset: dict):
    return dataset['id'], dataset.get('replaced_at') or dataset['created_at']


def unnamed(name):
    """Prepared OSM layers label unnamed objects with their OSM identifier."""
    return not name or any(f'OSM {kind}/' in name for kind in ('way', 'relation', 'node'))


class DatasetService:
    def __init__(self, root: Path):
        self.root = root
        self.repo = JsonRepository(root, 'datasets')
        # Parsed vector layers are reused across exposure and search requests.
        self._features: OrderedDict = OrderedDict()
        self._features_lock = threading.Lock()

    def path(self, dataset: dict):
        return safe_path(self.root, dataset['path'])

    def delete(self, dataset: dict):
        self.repo.delete(dataset['id'])
        self.path(dataset).unlink(missing_ok=True)
        self.evict(dataset['id'])

    def evict(self, identifier: str):
        with self._features_lock:
            for key in [k for k in self._features if k[0] == identifier]:
                del self._features[key]

    def features(self, dataset: dict):
        """Shapely geometries and properties of a vector dataset, cached by dataset version."""
        key = version(dataset)
        with self._features_lock:
            if key in self._features:
                self._features.move_to_end(key)
                return self._features[key]
        collection = json.loads(self.path(dataset).read_text(encoding='utf-8-sig'))
        properties = [f.get('properties') or {} for f in collection['features']]
        geometries = shapely.from_geojson([json.dumps(f['geometry']) for f in collection['features']])
        names = [str(p.get('name') or '') for p in properties]
        points = shapely.point_on_surface(geometries)
        value = {'geometries': geometries, 'properties': properties, 'names': names, 'lon': shapely.get_x(points), 'lat': shapely.get_y(points)}
        with self._features_lock:
            self.evict_stale(dataset['id'], key)
            self._features[key] = value
            while len(self._features) > 24:
                self._features.popitem(last=False)
        return value

    def evict_stale(self, identifier, key):
        for stale in [k for k in self._features if k[0] == identifier and k != key]:
            del self._features[stale]

    def search(self, query: str, modes: set, limit=30):
        needle, results = query.casefold(), []
        for dataset in self.repo.list():
            if dataset['kind'] != 'vector' or dataset['mode'] not in modes:
                continue
            layer, seen = self.features(dataset), set()
            for name, lon, lat in zip(layer['names'], layer['lon'], layer['lat']):
                # A named river or road is often split into many segments; list it once.
                if not unnamed(name) and needle in name.casefold() and name not in seen:
                    seen.add(name)
                    results.append({'name': name, 'longitude': float(lon), 'latitude': float(lat), 'source': dataset['source'], 'mode': dataset['mode'], 'role': dataset['role']})
                    if len(results) >= limit:
                        return results
        return results

    def ingest(self, temp: Path, filename: str, role: str, source: str, mode='imported', unit: str = '', observation_timestamp: str = ''):
        if role not in ROLES:
            raise ValueError('Unsupported dataset role')
        if not source.strip():
            raise ValueError('A source/provenance description is required')
        suffix = Path(filename).suffix.lower()
        identifier = uuid.uuid4().hex
        directory = self.root / ('terrain' if role == 'terrain' else 'geographic')
        path = directory / f'{identifier}{suffix}'
        metadata = {'id': identifier, 'name': Path(filename.replace('\\', '/')).name[:150], 'role': role, 'source': source[:2000], 'mode': mode, 'created_at': now(), 'path': str(path.relative_to(self.root)), 'status': 'validated-format', 'warnings': ['Format validation does not establish scientific accuracy.'], 'size_bytes': temp.stat().st_size}
        if observation_timestamp:
            metadata['observation_timestamp'] = timestamp(observation_timestamp)
        if suffix in {'.tif', '.tiff'}:
            if role not in {'depth', 'velocity', 'direction', 'wse', 'terrain', 'rainfall'}:
                raise ValueError('Select a raster role for GeoTIFF files')
            if unit != ('degrees' if role == 'direction' else 'mm' if role == 'rainfall' else 'm/s' if role == 'velocity' else 'm'):
                raise ValueError('Declare raster units: m for depth/elevation, m/s for velocity, degrees for direction, mm for rainfall. Convert other units before import.')
            with rasterio.open(temp) as src:
                if not src.crs:
                    raise ValueError('GeoTIFF has no coordinate reference system')
                if src.count != 1 or src.width * src.height > MAX_RASTER_CELLS:
                    raise ValueError('Use a single-band raster with at most 25 million cells')
                if src.transform.is_identity or not src.transform.is_rectilinear:
                    raise ValueError('Provide a north-up, georeferenced raster (warp rotated rasters before import)')
                if src.transform.a <= 0 or src.transform.e >= 0:
                    raise ValueError('Raster must use a north-up affine transform')
                arr = src.read(1, masked=True)
                valid = arr.compressed()
                if not len(valid) or not np.isfinite(valid).all():
                    raise ValueError('Raster has no valid cells or contains undeclared NaN/Infinity values')
                if role in {'depth', 'velocity', 'rainfall'} and np.min(valid) < 0:
                    raise ValueError('Negative depth/velocity/rainfall values must be declared NoData or converted')
                if role == 'direction' and (np.min(valid) < 0 or np.max(valid) > 360):
                    raise ValueError('Direction must be degrees clockwise from north in [0,360]')
                bounds = list(transform_bounds(src.crs, 'EPSG:4326', *src.bounds, densify_pts=21))
                if not all(math.isfinite(x) for x in bounds) or not (-180 <= bounds[0] < bounds[2] <= 180 and -90 <= bounds[1] < bounds[3] <= 90):
                    raise ValueError('Raster has invalid geographic bounds')
                metadata.update(kind='raster', crs=src.crs.to_string(), bounds=bounds, width=src.width, height=src.height, transform=list(src.transform)[:6], nodata=src.nodata if src.nodata is not None and math.isfinite(src.nodata) else None, minimum=float(valid.min()), maximum=float(valid.max()), unit=unit)
            if bounds[2] < 121 or bounds[0] > 123 or bounds[3] < 16 or bounds[1] > 18:
                metadata['warnings'].append('Dataset lies outside the Ilagan region. Use Zoom to dataset to inspect it.')
        elif suffix in {'.geojson', '.json'}:
            value = json.loads(temp.read_text(encoding='utf-8-sig'))
            if not isinstance(value, dict):
                raise ValueError('JSON dataset must be an object containing a FeatureCollection or records array')
            if value.get('type') == 'FeatureCollection':
                if role not in VECTOR_ROLES:
                    raise ValueError('Select a vector layer role for GeoJSON')
                features = value.get('features', [])
                if not features or len(features) > 50000:
                    raise ValueError('GeoJSON must contain 1–50,000 features')
                if 'crs' in value and '4326' not in json.dumps(value['crs']) and 'CRS84' not in json.dumps(value['crs']):
                    raise ValueError('Convert GeoJSON to RFC 7946 WGS84 longitude/latitude first')
                bounds = [180., 90., -180., -90.]
                for index, feature in enumerate(features):
                    geom = shape(feature['geometry'])
                    if geom.is_empty or not geom.is_valid:
                        raise ValueError(f'Invalid or empty geometry at feature {index}')
                    coords = get_coordinates(geom)
                    if not np.isfinite(coords).all() or np.any(np.abs(coords[:, 0]) > 180) or np.any(np.abs(coords[:, 1]) > 90):
                        raise ValueError('GeoJSON coordinates must be WGS84 longitude/latitude')
                    if role in {'boundaries', 'buildings', 'inundation'} and geom.geom_type not in {'Polygon', 'MultiPolygon'}:
                        raise ValueError(f'{role} requires polygon geometries')
                    if role in {'rivers', 'roads'} and geom.geom_type not in {'LineString', 'MultiLineString'}:
                        raise ValueError(f'{role} requires line geometries')
                    b = geom.bounds
                    bounds = [min(bounds[0], b[0]), min(bounds[1], b[1]), max(bounds[2], b[2]), max(bounds[3], b[3])]
                    feature['properties'] = feature.get('properties') or {}
                metadata.update(kind='vector', crs='EPSG:4326', bounds=bounds, feature_count=len(features))
            elif isinstance(value.get('records'), list) and role in {'monitoring', 'rainfall', 'hydrograph'}:
                metadata.update(self.validate_records(value['records'], role))
            else:
                raise ValueError('Expected a GeoJSON FeatureCollection or {"records":[...]} time series. Scenario manifests use the scenario importer.')
        elif suffix == '.csv':
            if role not in {'monitoring', 'rainfall', 'hydrograph'}:
                raise ValueError('CSV supports monitoring, rainfall, or HEC-HMS hydrographs')
            with temp.open(encoding='utf-8-sig', newline='') as stream:
                metadata.update(self.validate_records(list(csv.DictReader(stream)), role))
        elif suffix in {'.hdf', '.h5', '.hdf5'}:
            from .adapters import HecRasExportAdapter
            HecRasExportAdapter.reject_unverified_hdf(temp)
        else:
            raise ValueError('Supported formats: GeoJSON, CSV, JSON time series, single-band GeoTIFF. Raw HDF is inspected then explicitly rejected.')
        temp.replace(path)
        return self.repo.put(identifier, metadata)

    @staticmethod
    def validate_records(records, role):
        if not records or len(records) > 100000:
            raise ValueError('Time series requires 1–100,000 records')
        output, seen = [], set()
        for row in records:
            if not isinstance(row, dict):
                raise ValueError('Each time-series record must be an object')
            required = {'timestamp', 'discharge_m3s'} if role == 'hydrograph' else {'timestamp', 'rainfall_mm'} if role == 'rainfall' else {'timestamp', 'water_level_m', 'rainfall_mm'}
            if not required.issubset(row):
                raise ValueError('Missing time-series fields: ' + ', '.join(sorted(required - row.keys())))
            record = {'timestamp': timestamp(row['timestamp']), 'station_id': str(row.get('station_id', 'imported-station'))[:100]}
            dt = datetime.fromisoformat(record['timestamp'])
            key = (record['station_id'], dt)
            if key in seen:
                raise ValueError('Duplicate station/timestamp record')
            seen.add(key)
            fields = ['discharge_m3s'] if role == 'hydrograph' else ['rainfall_mm'] if role == 'rainfall' else ['water_level_m', 'rainfall_mm']
            for field in fields:
                v = float(row[field])
                if not math.isfinite(v) or (field != 'water_level_m' and v < 0):
                    raise ValueError(f'Invalid {field}')
                record[field] = v
            record['name'] = str(row.get('name') or record['station_id'])[:150]
            if row.get('longitude') not in (None, '') or row.get('latitude') not in (None, ''):
                lon, lat = float(row['longitude']), float(row['latitude'])
                if not math.isfinite(lon + lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
                    raise ValueError('Invalid station coordinates')
                record.update(longitude=lon, latitude=lat)
            output.append(record)
        output.sort(key=lambda x: datetime.fromisoformat(x['timestamp']))
        return {'kind': 'timeseries', 'records': output, 'record_count': len(output), 'crs': 'EPSG:4326' if any('longitude' in r for r in output) else None, 'bounds': None, 'start': output[0]['timestamp'], 'end': output[-1]['timestamp'], 'warnings': ['Imported historical data. Replay is not a live observation service.', 'rainfall_mm is an interval accumulation, not an intensity.']}

    def raster_wgs84(self, dataset, limit=768, upsample=1, resampling=Resampling.nearest):
        """WGS84 display grid: optionally upsampled (for interpolated display), capped at `limit` pixels."""
        with rasterio.open(self.path(dataset)) as src:
            transform, w, h = calculate_default_transform(src.crs, 'EPSG:4326', src.width, src.height, *src.bounds)
            w, h = w * upsample, h * upsample
            scale = max(1, w / limit, h / limit)
            w, h = max(1, round(w / scale)), max(1, round(h / scale))
            bounds = dataset['bounds']
            transform = from_bounds(*bounds, w, h)
            dst = np.full((h, w), np.nan, dtype='float32')
            reproject(source=rasterio.band(src, 1), destination=dst, src_transform=src.transform, src_crs=src.crs, src_nodata=src.nodata, dst_transform=transform, dst_crs='EPSG:4326', dst_nodata=np.nan, resampling=resampling)
            return dst, transform

    def image(self, dataset, metric=None):
        arr, _ = self.raster_wgs84(dataset)
        return color_image(arr, metric or dataset['role'])

    def sample(self, dataset, lon, lat):
        from rasterio.warp import transform
        with rasterio.open(self.path(dataset)) as src:
            x, y = transform('EPSG:4326', src.crs, [lon], [lat])
            row, col = src.index(x[0], y[0])
            if row < 0 or col < 0 or row >= src.height or col >= src.width:
                return None
            value = src.read(1, window=((row, row + 1), (col, col + 1)), masked=True)[0, 0]
            return None if np.ma.is_masked(value) or not np.isfinite(value) else float(value)


def color_image(arr, metric):
    rgba = np.zeros((*arr.shape, 4), dtype='uint8')
    valid = np.isfinite(arr)
    if metric == 'extent':
        rgba[valid & (arr > .01)] = (61, 179, 221, 215)
    elif metric in {'depth', 'maximum'}:
        colors = [(114, 223, 230), (61, 179, 221), (43, 116, 202), (60, 69, 165), (137, 66, 158)]
        categories = np.digitize(np.nan_to_num(arr), [.3, 1, 2, 3])
        for i, c in enumerate(colors):
            rgba[categories == i, :3] = c
        rgba[valid & (arr > .01), 3] = 225
    else:
        if metric == 'velocity':
            ratio = np.clip(arr / 3, 0, 1)
        elif metric == 'direction':
            ratio = np.mod(arr, 360) / 360
        else:
            lo = float(np.nanmin(arr)) if valid.any() else 0
            hi = float(np.nanmax(arr)) if valid.any() else 1
            ratio = np.clip((arr - lo) / max(hi - lo, .001), 0, 1)
        ratio = np.nan_to_num(ratio)
        rgba[:, :, 0] = (50 + 195 * ratio).astype('uint8')
        rgba[:, :, 1] = (205 - 130 * ratio).astype('uint8')
        rgba[:, :, 2] = (215 - 110 * ratio).astype('uint8')
        rgba[valid, 3] = 220
        if metric == 'duration':
            # Never-wet cells have zero duration; leave them transparent.
            rgba[~valid | (np.nan_to_num(arr) <= 0), 3] = 0
    buffer = io.BytesIO()
    Image.fromarray(rgba).save(buffer, format='PNG')
    return buffer.getvalue()
