import io
import json
import sys
from pathlib import Path
import numpy as np
import pytest
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        yield client


def raster_bytes(values=None, crs='EPSG:4326', bounds=(121.875, 17.115, 121.905, 17.145), dtype='float32', nodata=-9999):
    values = np.array(values if values is not None else [[0, 1], [2, 3]], dtype=dtype)
    with MemoryFile() as mem:
        with mem.open(driver='GTiff', width=values.shape[1], height=values.shape[0], count=1, dtype=dtype, crs=crs, transform=from_bounds(*bounds, values.shape[1], values.shape[0]), nodata=nodata) as dst:
            dst.write(values, 1)
        return mem.read()


def upload_raster(client, values=None, role='depth', **kwargs):
    unit = 'm/s' if role == 'velocity' else 'degrees' if role == 'direction' else 'mm' if role == 'rainfall' else 'm'
    return client.post('/api/datasets', files={'file': ('test.tif', raster_bytes(values, **kwargs), 'image/tiff')}, data={'role': role, 'source': 'TEST FIXTURE · artificial grid, no operational meaning', 'unit': unit})


def upload_vector(client, role='boundaries', geometry=None, name='Artificial test boundary'):
    geometry = geometry or {'type': 'Polygon', 'coordinates': [[[121.875, 17.115], [121.905, 17.115], [121.905, 17.145], [121.875, 17.145], [121.875, 17.115]]]}
    value = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'geometry': geometry, 'properties': {'name': name}}]}
    return client.post('/api/datasets', files={'file': ('test.geojson', json.dumps(value).encode(), 'application/geo+json')}, data={'role': role, 'source': 'TEST FIXTURE · not a real administrative boundary'})


def scenario_input(depth_id, frames=None):
    return {'name': 'Imported test run', 'description': 'Test-only array values', 'source': 'PYTEST FIXTURE · not a forecast', 'mode': 'imported', 'status': 'unvalidated', 'frames': frames or [{'timestamp': '2026-01-15T00:00:00Z', 'depth': depth_id}]}
