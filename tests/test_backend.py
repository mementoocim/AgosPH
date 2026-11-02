import io
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import numpy as np
import pytest
from PIL import Image
from backend.main import create_app
from backend.repository import JsonRepository
from backend.config import safe_path
from backend.reports import csv_bytes
from conftest import raster_bytes, upload_raster, upload_vector, scenario_input
from fastapi.testclient import TestClient


def test_startup_and_scientific_labels(client):
    assert client.get('/api/health').json()['database'] is False
    scenarios = client.get('/api/scenarios').json()
    assert len(scenarios) == 2
    assert all(s['mode'] == 'demonstration' and s['status'] == 'illustrative' for s in scenarios)
    assert all(len(s['frames']) == 9 for s in scenarios)
    datasets = client.get('/api/datasets').json()
    assert all(d['mode'] == 'demonstration' and d['crs'] == 'EPSG:4326' for d in datasets)


def test_playback_surfaces_and_inspection(client):
    first = client.get('/api/scenarios/demo-standard/surface.png?frame=0')
    peak = client.get('/api/scenarios/demo-standard/surface.png?frame=4')
    assert first.status_code == peak.status_code == 200
    assert first.content != peak.content
    with Image.open(io.BytesIO(peak.content)) as im:
        assert im.size == (32, 32)
    inside = client.get('/api/scenarios/demo-standard/inspect?frame=4&longitude=121.89&latitude=17.13').json()
    assert inside['inside_model'] and inside['values']['depth'] > 0
    assert inside['values']['velocity'] > 0 and inside['values']['wse'] is None
    outside = client.get('/api/scenarios/demo-standard/inspect?frame=4&longitude=0&latitude=0').json()
    assert not outside['inside_model'] and outside['values']['depth'] is None


@pytest.mark.parametrize('metric', ['velocity', 'direction', 'extent', 'maximum', 'arrival', 'duration'])
def test_available_metrics(client, metric):
    response = client.get(f'/api/scenarios/demo-standard/surface.png?frame=4&metric={metric}')
    assert response.status_code == 200 and response.content.startswith(b'\x89PNG')


def test_missing_metric_frame_and_scenario(client):
    assert client.get('/api/scenarios/demo-standard/surface.png?metric=wse').status_code == 422
    assert client.get('/api/scenarios/demo-standard/surface.png?frame=99').status_code == 422
    assert client.get('/api/scenarios/missing').status_code == 404
    assert client.get('/api/scenarios/demo-standard/inspect?longitude=999&latitude=17').status_code == 422


def test_comparison_alignment(client):
    assert client.get('/api/compare?first=demo-standard&second=demo-intense').json()['compatible']
    d = upload_raster(client).json()
    s = client.post('/api/scenarios', json=scenario_input(d['id'])).json()
    assert not client.get(f'/api/compare?first=demo-standard&second={s["id"]}').json()['compatible']


def test_geographic_import_search_and_preview(client):
    response = upload_vector(client)
    assert response.status_code == 201, response.text
    d = response.json()
    assert d['feature_count'] == 1 and d['crs'] == 'EPSG:4326'
    assert client.get(f'/api/datasets/{d["id"]}/geojson').json()['type'] == 'FeatureCollection'
    assert client.get('/api/search?q=Artificial&mode=imported').json()[0]['name'] == 'Artificial test boundary'


def test_invalid_vector_and_wrong_role(client):
    crossed = {'type': 'Polygon', 'coordinates': [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]]}
    assert upload_vector(client, geometry=crossed).status_code == 422
    assert upload_vector(client, role='roads').status_code == 422
    assert upload_vector(client, geometry={'type': 'Point', 'coordinates': [999, 17]}).status_code == 422


def test_raster_import_metadata_and_integer_analysis(client):
    response = upload_raster(client, dtype='int16')
    assert response.status_code == 201, response.text
    d = response.json()
    assert d['width'] == 2 and d['maximum'] == 3 and d['unit'] == 'm'
    s = client.post('/api/scenarios', json=scenario_input(d['id'])).json()
    result = client.get(f'/api/exposure/{s["id"]}').json()
    assert result['maximum_depth_m'] == 3 and result['wet_cells'] == 3
    assert client.get(f'/api/datasets/{d["id"]}/image.png').status_code == 200


@pytest.mark.parametrize('case', ['no_crs', 'negative', 'bad_units', 'bad_file'])
def test_raster_validation_errors(client, case):
    if case == 'no_crs':
        response = upload_raster(client, crs=None)
    elif case == 'negative':
        response = upload_raster(client, [[-1, 1], [2, 3]])
    elif case == 'bad_units':
        response = client.post('/api/datasets', files={'file': ('x.tif', raster_bytes())}, data={'role': 'depth', 'source': 'test', 'unit': 'feet'})
    else:
        response = client.post('/api/datasets', files={'file': ('x.tif', b'invalid')}, data={'role': 'depth', 'source': 'test', 'unit': 'm'})
    assert response.status_code == 422, response.text


def test_temporal_alignment_and_consistency(client):
    a, b = upload_raster(client).json(), upload_raster(client, [[1, 2, 3], [1, 2, 3]]).json()
    data = scenario_input(a['id'], [{'timestamp': '2026-01-15T00:00:00Z', 'depth': a['id']}, {'timestamp': '2026-01-15T00:30:00Z', 'depth': b['id']}])
    assert 'identical' in client.post('/api/scenarios', json=data).json()['detail']
    data['frames'][1]['depth'] = a['id']
    data['frames'].append({'timestamp': '2026-01-15T01:15:00Z', 'depth': a['id']})
    assert 'consistent' in client.post('/api/scenarios', json=data).json()['detail']
    data['frames'][1]['timestamp'] = data['frames'][0]['timestamp']
    assert client.post('/api/scenarios', json=data).status_code == 422


def test_reject_demonstration_relabel_and_unsubstantiated_validation(client):
    demo = client.get('/api/scenarios/demo-standard').json()
    data = scenario_input(demo['frames'][0]['depth'])
    assert 'relabeled' in client.post('/api/scenarios', json=data).json()['detail']
    data.update(status='validated', validation_notes='')
    assert client.post('/api/scenarios', json=data).status_code == 422
    data.update(status='pending')
    assert client.post('/api/scenarios', json=data).status_code == 422


def test_scenario_crud_export_and_persistence(client):
    pending = {'name': 'Model pending', 'source': 'Test source', 'mode': 'imported', 'status': 'pending', 'frames': [], 'assumptions': {'rainfall_mm': 100}}
    s = client.post('/api/scenarios', json=pending).json()
    assert s['frames'] == []
    assert client.patch(f'/api/scenarios/{s["id"]}/rename', json={'name': 'Renamed'}).json()['name'] == 'Renamed'
    duplicate = client.post(f'/api/scenarios/{s["id"]}/duplicate').json()
    exported = client.get(f'/api/scenarios/{s["id"]}/export').json()
    assert 'id' not in exported and exported['assumptions']['rainfall_mm'] == 100
    assert client.post('/api/scenarios', json=exported).status_code == 201
    assert client.delete(f'/api/scenarios/{duplicate["id"]}').status_code == 200
    assert client.get(f'/api/scenarios/{duplicate["id"]}').status_code == 404
    assert client.get(f'/api/scenarios/{s["id"]}/surface.png').status_code == 422


def test_exposure_with_real_geometry_operations_and_missing_inputs(client):
    d = upload_raster(client).json()
    assert upload_vector(client).status_code == 201
    road = {'type': 'LineString', 'coordinates': [[121.875, 17.12], [121.905, 17.12]]}
    assert upload_vector(client, 'roads', road, 'Artificial road fixture').status_code == 201
    point = {'type': 'Point', 'coordinates': [121.9, 17.12]}
    assert upload_vector(client, 'facilities', point, 'Artificial facility fixture').status_code == 201
    s = client.post('/api/scenarios', json=scenario_input(d['id'])).json()
    result = client.get(f'/api/exposure/{s["id"]}').json()
    assert result['counts']['boundaries'] == 1 and result['counts']['roads'] == 1 and result['counts']['facilities'] == 1
    assert result['counts']['bridges'] is None
    assert result['inundation_area_m2'] > 0 and result['maximum_depth_m'] == 3
    assert next(r for r in result['features'] if r['role'] == 'roads')['inundated_length_m'] > 0
    assert any('Population' in x for x in result['unavailable'])
    assert abs(sum(c['area_m2'] for c in result['categories']) - result['inundation_area_m2']) < 1
    demo = client.get('/api/exposure/demo-standard?frame=4').json()
    assert demo['counts']['boundaries'] is None  # Never mix imported boundaries with synthetic hazard.


def test_replay_thresholds_alert_lifecycle_and_disconnect(client):
    assert client.post('/api/monitoring/reset', json={}).status_code == 200
    assert client.put('/api/monitoring/test-a/thresholds', json={'watch': 1.2, 'warning': 2, 'critical': 3}).status_code == 200
    client.post('/api/monitoring/step', json={})
    alerts = client.get('/api/alerts').json()
    alert = next(a for a in alerts if a['station_id'] == 'test-a')
    assert alert['status'] == 'active' and alert['label'].startswith('TEST')
    assert client.patch(f'/api/alerts/{alert["id"]}', json={'status': 'acknowledged'}).json()['status'] == 'acknowledged'
    assert client.patch(f'/api/alerts/{alert["id"]}', json={'status': 'resolved'}).json()['status'] == 'resolved'
    assert client.patch(f'/api/alerts/{alert["id"]}', json={'status': 'acknowledged'}).status_code == 422
    before = client.get('/api/monitoring').json()['stations'][0]['latest']
    client.put('/api/monitoring/connection', json={'station_id': 'test-a', 'connected': False})
    client.post('/api/monitoring/step', json={})
    station = client.get('/api/monitoring').json()['stations'][0]
    assert not station['connected'] and station['latest'] == before and station['severity'] == 'unavailable'
    assert client.put('/api/monitoring/test-a/thresholds', json={'watch': 3, 'warning': 2, 'critical': 1}).status_code == 422


def test_imported_monitoring_rainfall_hydrographs_and_empty_mode(client):
    assert client.get('/api/monitoring?mode=imported').json()['stations'] == []
    raw = b'timestamp,station_id,water_level_m,rainfall_mm,longitude,latitude\n2026-01-15T00:00:00Z,fixture-station,1.2,4,121.89,17.13\n2026-01-15T00:15:00Z,fixture-station,3.4,8,121.89,17.13\n'
    response = client.post('/api/datasets', files={'file': ('station.csv', raw)}, data={'role': 'monitoring', 'source': 'Artificial test station with test-only coordinates'})
    assert response.status_code == 201, response.text
    snapshot = client.get('/api/monitoring?mode=imported').json()
    assert len(snapshot['stations']) == 1 and 'REPLAY' in snapshot['label']
    client.post('/api/monitoring/step', json={'mode': 'imported'})
    assert client.get('/api/alerts').json()[0]['label'] == 'TEST · IMPORTED REPLAY'
    hydro = b'timestamp,station_id,discharge_m3s\n2026-01-15T00:00:00Z,test,15\n'
    response = client.post('/api/datasets', files={'file': ('hms.csv', hydro)}, data={'role': 'hydrograph', 'source': 'Test HEC-HMS exported hydrograph'})
    assert response.status_code == 201 and response.json()['records'][0]['discharge_m3s'] == 15
    rain = {'records': [{'timestamp': '2026-01-15T00:00:00Z', 'station_id': 'rain-only', 'rainfall_mm': 12}]}
    assert client.post('/api/datasets', files={'file': ('rain.json', json.dumps(rain))}, data={'role': 'rainfall', 'source': 'Test rain'}).status_code == 201


def test_bad_time_series(client):
    for raw in [b'timestamp,station_id,rainfall_mm\n2026-01-15T00:00:00,test,1', b'timestamp,station_id,rainfall_mm\n2026-01-15T00:00:00Z,test,-1', b'timestamp,station_id,rainfall_mm\n2026-01-15T00:00:00Z,test,NaN']:
        assert client.post('/api/datasets', files={'file': ('rain.csv', raw)}, data={'role': 'rainfall', 'source': 'test'}).status_code == 422


def test_rainfall_raster_timestamps_and_hdf_adapter_rejection(client):
    response = client.post('/api/datasets', files={'file': ('rain.tif', raster_bytes())}, data={'role': 'rainfall', 'source': 'Timestamped artificial rainfall test grid', 'unit': 'mm', 'observation_timestamp': '2026-01-15T00:00:00+08:00'})
    assert response.status_code == 201 and response.json()['observation_timestamp'].endswith('+08:00')
    bad = client.post('/api/datasets', files={'file': ('rain.tif', raster_bytes())}, data={'role': 'rainfall', 'source': 'test', 'unit': 'mm', 'observation_timestamp': '2026-01-15'})
    assert bad.status_code == 422
    import h5py
    buffer = io.BytesIO()
    with h5py.File(buffer, 'w') as hdf:
        hdf.attrs['File Version'] = 'unsupported-test-version'
    response = client.post('/api/datasets', files={'file': ('model.hdf', buffer.getvalue())}, data={'role': 'depth', 'source': 'Test unsupported HDF'})
    assert response.status_code == 422 and 'No HDF values were interpreted' in response.json()['detail']
    assert client.get('/api/models/adapters').json()['hydraulic'][0]['raw_hdf_supported'] is False


def test_websocket_snapshots(client):
    with client.websocket_connect('/api/ws/monitoring?mode=demonstration') as socket:
        message = socket.receive_json()
        assert message['type'] == 'snapshot' and message['monitoring']['mode'] == 'demonstration'


def test_reports_are_actual_files_and_carry_provenance(client):
    pdf = client.post('/api/reports/pdf', json={'scenario_id': 'demo-standard', 'frame': 4})
    assert pdf.status_code == 200 and pdf.content.startswith(b'%PDF')
    for kind in ('monitoring', 'alerts', 'exposure', 'metadata'):
        response = client.get(f'/api/reports/csv?kind={kind}&scenario_id=demo-standard&frame=4')
        assert response.status_code == 200 and response.headers['content-type'].startswith('text/csv')
        if kind != 'alerts':
            assert b'demonstration' in response.content
    geo = client.get('/api/reports/geojson?scenario_id=demo-standard&frame=4').json()
    assert geo['type'] == 'FeatureCollection' and geo['features'][0]['properties']['mode'] == 'demonstration'
    assert client.post('/api/reports/pdf', json={'scenario_id': 'demo-standard', 'screenshot': 'not a png'}).status_code == 422


def test_replacement_and_reference_protection(client):
    d = upload_raster(client).json()
    s = client.post('/api/scenarios', json=scenario_input(d['id'])).json()
    assert client.delete(f'/api/datasets/{d["id"]}').status_code == 409
    replaced = client.put(f'/api/datasets/{d["id"]}/replace', files={'file': ('new.tif', raster_bytes([[0, 2], [4, 6]]))}, data={'source': 'Replacement test', 'unit': 'm'})
    assert replaced.status_code == 200 and replaced.json()['id'] == d['id']
    assert client.get(f'/api/exposure/{s["id"]}').json()['maximum_depth_m'] == 6
    client.delete(f'/api/scenarios/{s["id"]}')
    assert client.delete(f'/api/datasets/{d["id"]}').status_code == 200


def test_terrain_provider_and_elevation(client):
    d = upload_raster(client, [[10, 11], [12, 13]], role='terrain').json()
    assert client.get(f'/api/datasets/{d["id"]}/sample?longitude=121.89&latitude=17.13').json()['value'] is not None
    tile = client.get(f'/api/terrain/{d["id"]}/10/1717/414')
    assert tile.status_code == 200 and len(tile.json()['heights']) == 65 * 65
    assert client.get(f'/api/terrain/{d["id"]}/100/0/0').status_code == 422


def test_settings_alerts_and_scenarios_survive_restart(client):
    root = client.app.state.datasets.root
    settings = client.get('/api/settings').json()
    settings.update(opacity=.42, active_scenario='demo-standard', layers={'rivers': {'visible': False, 'opacity': .5}})
    assert client.put('/api/settings', json=settings).status_code == 200
    test_alert = client.post('/api/alerts/test').json()
    with TestClient(create_app(root)) as second:
        assert second.get('/api/settings').json()['opacity'] == .42
        assert any(a['id'] == test_alert['id'] for a in second.get('/api/alerts').json())
        assert len(second.get('/api/scenarios').json()) == 2


def test_security_paths_origin_and_file_limits(client, tmp_path, monkeypatch):
    with pytest.raises(ValueError):
        safe_path(tmp_path, '../outside')
    with pytest.raises(ValueError):
        JsonRepository(tmp_path, 'safety').get('../../outside')
    assert client.post('/api/alerts/test', headers={'origin': 'https://attacker.invalid'}).status_code == 403
    assert client.get('/api/health', headers={'host': 'attacker.invalid'}).status_code == 400
    import backend.main as main
    monkeypatch.setattr(main, 'MAX_UPLOAD_BYTES', 8)
    assert client.post('/api/datasets', files={'file': ('x.json', b'123456789')}, data={'role': 'boundaries', 'source': 'test'}).status_code == 413
    assert list((client.app.state.datasets.root / 'uploads').glob('*')) == []


def demonstration_ids(client):
    return {d['id'] for d in client.get('/api/datasets').json() if d['mode'] == 'demonstration'}


def referenced_ids(client):
    return {f[k] for s in client.get('/api/scenarios').json() for f in s['frames'] for k in ('depth', 'velocity', 'direction', 'wse') if f.get(k)}


def test_demo_reload_keeps_a_single_set_of_fixture_rasters(client):
    root = client.app.state.datasets.root
    assert len(demonstration_ids(client)) == 54
    for _ in range(2):
        assert client.post('/api/demo/load').status_code == 200
    assert demonstration_ids(client) == referenced_ids(client)
    assert len(demonstration_ids(client)) == 54
    assert len(list((root / 'geographic').glob('*.tif'))) == 54


def test_demo_reload_removes_interrupted_fixture_leftovers_but_keeps_user_copies(client):
    datasets = client.app.state.datasets
    fixture = next(d for d in client.get('/api/datasets').json() if d['mode'] == 'demonstration')
    leftover = datasets.root / 'uploads' / 'leftover.tif'
    leftover.write_bytes(datasets.path(fixture).read_bytes())
    orphan = datasets.ingest(leftover, 'demo-standard-0-depth.tif', 'depth', fixture['source'], 'demonstration', 'm')
    copy = client.post('/api/scenarios/demo-standard/duplicate').json()
    assert client.post('/api/demo/load').status_code == 200
    assert client.get(f'/api/datasets/{orphan["id"]}').status_code == 404
    assert all(client.get(f'/api/datasets/{f["depth"]}').status_code == 200 for f in copy['frames'])


def test_startup_removes_fixture_rasters_leaked_by_earlier_versions(client):
    datasets = client.app.state.datasets
    fixture = next(d for d in client.get('/api/datasets').json() if d['mode'] == 'demonstration')
    leftover = datasets.root / 'uploads' / 'leftover.tif'
    leftover.write_bytes(datasets.path(fixture).read_bytes())
    orphan = datasets.ingest(leftover, 'demo-intense-3-velocity.tif', 'velocity', fixture['source'], 'demonstration', 'm/s')
    with TestClient(create_app(datasets.root)) as restarted:
        assert restarted.get(f'/api/datasets/{orphan["id"]}').status_code == 404
        assert len(restarted.get('/api/scenarios').json()) == 2


def test_generated_test_alert_uses_the_selected_data_mode(client):
    assert client.post('/api/alerts/test', json={'mode': 'imported'}).status_code == 422
    raw = b'timestamp,station_id,water_level_m,rainfall_mm\n2026-01-15T00:00:00Z,fixture-station,1.2,4\n'
    client.post('/api/datasets', files={'file': ('station.csv', raw)}, data={'role': 'monitoring', 'source': 'Artificial test station'})
    alert = client.post('/api/alerts/test', json={'mode': 'imported'}).json()
    assert alert['mode'] == 'imported' and alert['station_id'] == 'fixture-station'
    assert alert['label'] == 'TEST · IMPORTED REPLAY'
    assert client.post('/api/alerts/test').json()['mode'] == 'demonstration'


def test_search_covers_reference_geography_in_both_modes_and_tracks_deletion(client):
    d = upload_vector(client, name='Artificial searchable boundary').json()
    for mode in ('imported', 'demonstration'):
        results = client.get(f'/api/search?q=searchable&mode={mode}').json()
        assert [(r['name'], r['mode'], r['role']) for r in results] == [('Artificial searchable boundary', 'imported', 'boundaries')]
    assert client.delete(f'/api/datasets/{d["id"]}').status_code == 200
    assert client.get('/api/search?q=searchable&mode=imported').json() == []
    segments = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [[121.88 + i * .001, 17.12], [121.881 + i * .001, 17.12]]}, 'properties': {'name': 'Artificial segmented river'}} for i in range(3)]}
    client.post('/api/datasets', files={'file': ('r.geojson', json.dumps(segments).encode())}, data={'role': 'rivers', 'source': 'TEST FIXTURE'})
    assert len(client.get('/api/search?q=segmented&mode=imported').json()) == 1


def test_inspection_reports_arrival_and_peak_depth(client):
    point = 'longitude=121.89&latitude=17.13'
    scenario = client.get('/api/scenarios/demo-standard').json()
    depths = [client.get(f'/api/scenarios/demo-standard/inspect?frame={i}&{point}').json()['values']['depth'] for i in range(9)]
    result = client.get(f'/api/scenarios/demo-standard/inspect?frame=0&{point}').json()
    first_wet = next(i for i, depth in enumerate(depths) if depth > .01)
    assert result['arrival_minutes'] == first_wet * 30
    assert result['peak_depth_m'] == pytest.approx(max(depths))
    assert result['peak_timestamp'] == scenario['frames'][int(np.argmax(depths))]['timestamp']
    outside = client.get('/api/scenarios/demo-standard/inspect?frame=0&longitude=0&latitude=0').json()
    assert outside['arrival_minutes'] is None and outside['peak_depth_m'] is None


def opaque(response):
    with Image.open(io.BytesIO(response.content)) as im:
        rgba = np.array(im.convert('RGBA'))
    return rgba[rgba[..., 3] > 0][:, :3], int((rgba[..., 3] > 0).sum())


def test_metric_surfaces_hide_dry_cells(client):
    def surface(metric, frame=2):
        return opaque(client.get(f'/api/scenarios/demo-standard/surface.png?frame={frame}&metric={metric}'))
    _, wet = surface('depth')
    assert 0 < wet < 32 * 32
    assert surface('direction')[1] == wet and surface('velocity')[1] == wet
    colors, extent = surface('extent')
    assert extent == wet and len(np.unique(colors, axis=0)) == 1
    assert surface('duration')[1] == surface('maximum')[1] < 32 * 32


def test_exposure_summarizes_barangays_buildings_and_valid_cells(client):
    d = upload_raster(client).json()
    upload_vector(client, name='Artificial barangay')

    def square(lon, lat, size=.001):
        return {'type': 'Polygon', 'coordinates': [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]]}
    buildings = {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': square(121.878, 17.140), 'properties': {}},  # NW cell, dry
        {'type': 'Feature', 'geometry': square(121.900, 17.140), 'properties': {}},  # NE cell, 1 m
        {'type': 'Feature', 'geometry': square(121.900, 17.120), 'properties': {}},  # SE cell, 3 m
    ]}
    client.post('/api/datasets', files={'file': ('buildings.geojson', json.dumps(buildings).encode())}, data={'role': 'buildings', 'source': 'TEST FIXTURE · artificial footprints'})
    s = client.post('/api/scenarios', json=scenario_input(d['id'])).json()
    result = client.get(f'/api/exposure/{s["id"]}').json()
    assert result['valid_cells'] == 4 and result['wet_cells'] == 3
    assert result['counts']['buildings'] == 2
    barangay = next(r for r in result['features'] if r['role'] == 'boundaries')
    assert barangay['flooded_buildings'] == 2 and barangay['maximum_depth_m'] == 3
    assert 0.7 < barangay['inundated_share'] < 0.8
    assert not any(r['role'] == 'buildings' for r in result['features'])


def test_terrain_settings_round_trip(client):
    settings = client.get('/api/settings').json()
    assert settings['terrain_auto'] is True
    settings['terrain_auto'] = False
    assert client.put('/api/settings', json=settings).json()['terrain_auto'] is False


def test_atomic_repository_parallel_writes_and_csv_formula_safety(tmp_path):
    repo = JsonRepository(tmp_path, 'concurrent')
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: repo.put('settings', {'value': i, 'nested': {'ok': True}}), range(50)))
    assert repo.get('settings')['nested']['ok'] is True
    assert not list(repo.directory.glob('*.tmp'))
    assert b"'=HYPERLINK" in csv_bytes([{'value': '=HYPERLINK("bad")'}])
