import json

import numpy as np
import pytest
from conftest import raster_bytes

BOUNDS = (121.875, 17.115, 121.905, 17.145)
CELL = (BOUNDS[2] - BOUNDS[0]) / 60
RIVER_COLUMN, RIDGE, BASIN = 20, (34, 36), 37


def valley_dem():
    """Artificial test valley: river along one column, a ridge, and a lower basin cut off by it."""
    y, x = np.mgrid[:60, :60]
    elevation = 50 - .02 * y + .3 * np.abs(x - RIVER_COLUMN)
    elevation = np.where((x >= RIDGE[0]) & (x <= RIDGE[1]), 75., elevation)
    elevation = np.where(x >= BASIN, 44., elevation)
    return elevation.astype('float32')


def lon(column):
    return BOUNDS[0] + (column + .5) * CELL


def lat(row):
    return BOUNDS[3] - (row + .5) * CELL


@pytest.fixture
def terrain_client(client):
    dem = client.post('/api/datasets', files={'file': ('valley.tif', raster_bytes(valley_dem()))}, data={'role': 'terrain', 'unit': 'm', 'source': 'TEST FIXTURE · artificial valley DEM'})
    assert dem.status_code == 201, dem.text
    river = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [[lon(RIVER_COLUMN), BOUNDS[3] - CELL / 4], [lon(RIVER_COLUMN), BOUNDS[1] + CELL / 4]]}, 'properties': {'name': 'Artificial test river', 'waterway': 'river'}}]}
    response = client.post('/api/datasets', files={'file': ('river.geojson', json.dumps(river).encode())}, data={'role': 'rivers', 'source': 'TEST FIXTURE · artificial river line'})
    assert response.status_code == 201, response.text
    return client


def generate(client):
    response = client.post('/api/demo/terrain')
    assert response.status_code == 200, response.text
    return {s['id']: s for s in response.json()['scenarios']}


def inspect(client, scenario_id, frame, column, row=30):
    return client.get(f'/api/scenarios/{scenario_id}/inspect?frame={frame}&longitude={lon(column)}&latitude={lat(row)}').json()


def test_terrain_demo_requires_imported_terrain_and_rivers(client):
    response = client.post('/api/demo/terrain')
    assert response.status_code == 422 and 'terrain' in response.json()['detail']


def test_terrain_demo_is_labeled_illustrative_and_uses_reference_geography(terrain_client):
    scenarios = generate(terrain_client)
    assert set(scenarios) == {'demo-terrain-moderate', 'demo-terrain-high'}
    for s in scenarios.values():
        assert s['mode'] == 'demonstration' and s['status'] == 'illustrative'
        assert s['settings']['reference_geography'] == 'imported'
        assert 'NOT' in s['model'] and 'hydrodynamic' in s['model']
        assert len(s['frames']) == 19 and all(f['velocity'] and f['direction'] for f in s['frames'])
    assert terrain_client.get('/api/compare?first=demo-terrain-moderate&second=demo-terrain-high').json()['compatible']


def test_terrain_demo_floods_from_the_river_and_respects_ridges(terrain_client):
    scenarios = generate(terrain_client)
    frames = scenarios['demo-terrain-moderate']['frames']
    peak = max(range(len(frames)), key=lambda i: inspect(terrain_client, 'demo-terrain-moderate', i, RIVER_COLUMN)['values']['depth'])
    river = inspect(terrain_client, 'demo-terrain-moderate', peak, RIVER_COLUMN)
    assert river['values']['depth'] == pytest.approx(4.5, abs=.1)
    floodplain = inspect(terrain_client, 'demo-terrain-moderate', peak, RIVER_COLUMN + 8)
    assert 0 < floodplain['values']['depth'] < river['values']['depth']
    assert floodplain['arrival_minutes'] > river['arrival_minutes']
    assert 0 < floodplain['values']['velocity'] <= 5 and 0 <= floodplain['values']['direction'] <= 360
    high = scenarios['demo-terrain-high']['frames']
    for scenario_id, count in (('demo-terrain-moderate', len(frames)), ('demo-terrain-high', len(high))):
        for frame in range(count):
            # The basin is lower than the flooded river but separated by a higher ridge.
            assert not inspect(terrain_client, scenario_id, frame, BASIN + 5)['values']['depth']
    first = terrain_client.get('/api/exposure/demo-terrain-moderate?frame=0').json()
    top = terrain_client.get(f'/api/exposure/demo-terrain-moderate?frame={peak}').json()
    assert 0 < first['inundation_area_m2'] < top['inundation_area_m2']


def test_terrain_demo_exposure_intersects_imported_reference_geography(terrain_client):
    boundary = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [[[BOUNDS[0], BOUNDS[1]], [BOUNDS[2], BOUNDS[1]], [BOUNDS[2], BOUNDS[3]], [BOUNDS[0], BOUNDS[3]], [BOUNDS[0], BOUNDS[1]]]]}, 'properties': {'name': 'Artificial test barangay'}}]}
    terrain_client.post('/api/datasets', files={'file': ('b.geojson', json.dumps(boundary).encode())}, data={'role': 'boundaries', 'source': 'TEST FIXTURE · artificial boundary'})
    generate(terrain_client)
    result = terrain_client.get('/api/exposure/demo-terrain-high?frame=6').json()
    assert result['mode'] == 'demonstration' and result['reference_geography'] == 'imported'
    assert result['counts']['boundaries'] == 1
    lab = terrain_client.get('/api/exposure/demo-standard?frame=4').json()
    assert lab['counts']['boundaries'] is None


def test_mountain_stream_levels_never_spill_downhill_into_the_valley(client):
    """A high river reach must not raise water over lower terrain draining elsewhere."""
    y, x = np.mgrid[:60, :60]
    # Valley rising 0.5 m per cell from its river (column 10); a 1 m per cell mountain slope carries a stream at column 50.
    elevation = np.where(x < 30, 50 + .5 * np.abs(x - 10), 60 + (x - 30) * 1.).astype('float32')
    client.post('/api/datasets', files={'file': ('slope.tif', raster_bytes(elevation))}, data={'role': 'terrain', 'unit': 'm', 'source': 'TEST FIXTURE · valley below a steep slope'})
    lines = [[[lon(column), BOUNDS[3] - CELL / 4], [lon(column), BOUNDS[1] + CELL / 4]] for column in (10, 50)]
    rivers = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': c}, 'properties': {'waterway': 'river'}} for c in lines]}
    client.post('/api/datasets', files={'file': ('rivers.geojson', json.dumps(rivers).encode())}, data={'role': 'rivers', 'source': 'TEST FIXTURE · valley river and mountain stream'})
    scenarios = generate(client)
    deepest = max(client.get(f'/api/datasets/{f["depth"]}').json()['maximum'] for f in scenarios['demo-terrain-high']['frames'])
    assert deepest <= 7.5 + 1.1
    assert not inspect(client, 'demo-terrain-high', 6, 28)['values']['depth']  # 9 m above its own river, 20 m below the stream


def test_flow_direction_follows_the_valley_across_flat_reach_patches():
    from pyproj import CRS
    from rasterio.transform import from_origin
    from backend import terrain_demo
    # Levels copied from river cells form flat 10-row steps, falling 1 m per step southward.
    level = np.repeat(np.arange(50., 40., -1.), 10)[:, None] * np.ones((1, 30))
    slope, azimuth = terrain_demo.water_surface_slope(level.astype('float32'), from_origin(121.8, 17.2, .0005, .0005), CRS.from_epsg(4326))
    defined = np.isfinite(azimuth)
    assert defined.mean() > .95
    assert np.all(np.abs(azimuth[defined] - 180) < 1)
    assert 1e-3 < np.median(slope) < 3e-3


def test_terrain_demo_regeneration_does_not_leak_rasters(terrain_client):
    generate(terrain_client)
    generate(terrain_client)
    datasets = terrain_client.get('/api/datasets').json()
    referenced = {f[k] for s in terrain_client.get('/api/scenarios').json() for f in s['frames'] for k in ('depth', 'velocity', 'direction') if f.get(k)}
    demonstration = {d['id'] for d in datasets if d['mode'] == 'demonstration'}
    assert demonstration == referenced
