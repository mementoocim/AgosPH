"""Authorized live sensor ingestion: freshness, provenance, LIVE alerts, and adapters."""
import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app

TOKEN = 'pytest-live-ingest-token-0123456789abcdef'
AUTH = {'Authorization': f'Bearer {TOKEN}'}
SOURCE = 'PYTEST FIXTURE · artificial gauge, gauge-zero datum, not a real station'
THRESHOLDS = {'watch': 2, 'warning': 3, 'critical': 4}


def utc(minutes=0.0):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).replace(microsecond=0)


def reading(**fields):
    value = {'station_id': 'gauge-1', 'name': 'Artificial gauge 1', 'timestamp': utc(-1).isoformat(), 'water_level_m': 1.25, 'units': {'water_level': 'm'}, 'source': SOURCE}
    value.update(fields)
    return {k: v for k, v in value.items() if v is not None}


def push(client, *readings, headers=AUTH):
    return client.post('/api/monitoring/ingest', json={'readings': list(readings)}, headers=headers)


def post_raw(client, body):
    return client.post('/api/monitoring/ingest', content=body, headers={**AUTH, 'Content-Type': 'application/json'})


def live_stations(client):
    return {s['id']: s for s in client.get('/api/monitoring').json()['live']['stations']}


@pytest.fixture(autouse=True)
def default_staleness(monkeypatch):
    for name in ('AGOS_LIVE_STALE_MINUTES', 'AGOS_LIVE_UNAVAILABLE_MINUTES'):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def live(tmp_path, monkeypatch):
    monkeypatch.setenv('AGOS_INGEST_TOKEN', TOKEN)
    with TestClient(create_app(tmp_path, seed=False)) as client:
        yield client


def test_ingest_is_refused_while_no_token_is_configured(tmp_path, monkeypatch):
    monkeypatch.delenv('AGOS_INGEST_TOKEN', raising=False)
    with TestClient(create_app(tmp_path, seed=False)) as client:
        for headers in ({}, {'Authorization': 'Bearer '}, AUTH):
            response = push(client, reading(), headers=headers)
            assert response.status_code == 503 and 'AGOS_INGEST_TOKEN' in response.json()['detail']
        live = client.get('/api/monitoring').json()['live']
        assert live['stations'] == [] and live['ingest']['enabled'] is False


def test_too_short_token_keeps_ingest_disabled(tmp_path, monkeypatch):
    monkeypatch.setenv('AGOS_INGEST_TOKEN', 'short-token')
    with TestClient(create_app(tmp_path, seed=False)) as client:
        assert push(client, reading(), headers={'Authorization': 'Bearer short-token'}).status_code == 503
        assert client.get('/api/monitoring').json()['live']['ingest']['enabled'] is False


@pytest.mark.parametrize('headers', [{}, {'Authorization': 'Bearer wrong-token-0123456789abcdef-0123456789'}, {'Authorization': f'Basic {TOKEN}'}, {'Authorization': TOKEN}, {'Authorization': f'Bearer {TOKEN}x'}])
def test_ingest_requires_the_configured_bearer_token(live, headers):
    response = push(live, reading(), headers=headers)
    assert response.status_code == 401 and response.headers['www-authenticate'] == 'Bearer'
    assert live_stations(live) == {}


def test_authorized_reading_appears_live_with_its_provenance(live):
    observed = utc(-2)
    gauge = reading(timestamp=observed.isoformat(), longitude=121.89, latitude=17.13, units={'water_level': 'm', 'rainfall': 'mm'})
    rain = reading(station_id='rain-1', name='Artificial rain gauge', water_level_m=None, rainfall_mm=4.5, rainfall_interval_minutes=15, units={'rainfall': 'mm'})
    response = push(live, gauge, rain)
    assert response.status_code == 200, response.text
    assert (response.json()['accepted'], response.json()['duplicates']) == (2, 0)
    stations = live_stations(live)
    station = stations['gauge-1']
    assert (station['data_class'], station['freshness'], station['connected']) == ('live', 'live', True)
    assert station['latest']['water_level_m'] == 1.25 and station['latest']['timestamp'] == observed.isoformat()
    assert station['source'] == station['latest']['source'] == SOURCE
    assert station['latest']['channel'] == 'POST /api/monitoring/ingest'
    assert abs(datetime.fromisoformat(station['received_at']) - datetime.now(timezone.utc)) < timedelta(minutes=1)
    assert (station['longitude'], station['latitude']) == (121.89, 17.13)
    assert 100 <= station['age_seconds'] <= 180
    rain = stations['rain-1']
    assert (rain['latest']['rainfall_mm'], rain['latest']['rainfall_interval_minutes']) == (4.5, 15)
    assert rain['severity'] == 'unavailable' and rain['longitude'] is None


def test_replay_and_demonstration_stations_are_never_labeled_live(live):
    assert push(live, reading()).status_code == 200
    demo = live.get('/api/monitoring?mode=demonstration').json()
    assert {s['data_class'] for s in demo['stations']} == {'demonstration'}
    assert all(s['id'] != 'gauge-1' for s in demo['stations'])
    raw = b'timestamp,station_id,water_level_m,rainfall_mm\n2026-01-15T00:00:00Z,gauge-1,1.2,4\n'
    live.post('/api/datasets', files={'file': ('station.csv', raw)}, data={'role': 'monitoring', 'source': 'Artificial history for the same station id'})
    imported = live.get('/api/monitoring?mode=imported').json()
    assert [(s['id'], s['data_class']) for s in imported['stations']] == [('gauge-1', 'replay')]
    assert [(s['id'], s['data_class']) for s in imported['live']['stations']] == [('gauge-1', 'live')]


def test_live_reading_turns_stale_then_unavailable_as_it_ages(live):
    observed = utc(-1)
    push(live, reading(timestamp=observed.isoformat()))
    monitoring = live.app.state.monitoring
    for minutes, freshness in [(30, 'live'), (31, 'stale'), (360, 'stale'), (361, 'unavailable')]:
        monitoring.clock = lambda minutes=minutes: observed + timedelta(minutes=minutes)
        station = live_stations(live)['gauge-1']
        assert (station['freshness'], station['age_seconds']) == (freshness, minutes * 60)
    assert station['connected'] is False and station['severity'] == 'unavailable'
    assert station['latest']['water_level_m'] == 1.25


def test_staleness_age_comes_from_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv('AGOS_INGEST_TOKEN', TOKEN)
    monkeypatch.setenv('AGOS_LIVE_STALE_MINUTES', '5')
    with TestClient(create_app(tmp_path, seed=False)) as client:
        push(client, reading(timestamp=utc(-10).isoformat()))
        live = client.get('/api/monitoring').json()['live']
        assert live['stale_after_minutes'] == 5 and live['stations'][0]['freshness'] == 'stale'


@pytest.mark.parametrize('stale, unavailable', [('0', '60'), ('90', '60'), ('soon', '60')])
def test_invalid_staleness_configuration_stops_startup(tmp_path, monkeypatch, stale, unavailable):
    monkeypatch.setenv('AGOS_LIVE_STALE_MINUTES', stale)
    monkeypatch.setenv('AGOS_LIVE_UNAVAILABLE_MINUTES', unavailable)
    with pytest.raises(ValueError):
        create_app(tmp_path, seed=False)


INVALID = {
    'timestamp without offset': lambda: [reading(timestamp='2026-11-01T08:00:00')],
    'timestamp in the future': lambda: [reading(timestamp=utc(10).isoformat())],
    'timestamp older than 30 days': lambda: [reading(timestamp=utc(-31 * 24 * 60).isoformat())],
    'path-like station id': lambda: [reading(station_id='../escape')],
    'station id with spaces': lambda: [reading(station_id='gauge 1')],
    'demonstration fixture id': lambda: [reading(station_id='test-a')],
    'blank source': lambda: [reading(source='  ')],
    'misspelled field': lambda: [reading(water_level=2.0)],
    'undeclared units': lambda: [reading(units=None)],
    'centimeters': lambda: [reading(units={'water_level': 'cm'})],
    'numeric string': lambda: [reading(water_level_m='1.25')],
    'boolean': lambda: [reading(water_level_m=True)],
    'implausible level': lambda: [reading(water_level_m=5000)],
    'negative rainfall': lambda: [reading(water_level_m=None, rainfall_mm=-1, rainfall_interval_minutes=15, units={'rainfall': 'mm'})],
    'rainfall without interval': lambda: [reading(water_level_m=None, rainfall_mm=2, units={'rainfall': 'mm'})],
    'no measurement': lambda: [reading(water_level_m=None)],
    'longitude without latitude': lambda: [reading(longitude=121.89)],
    'longitude out of range': lambda: [reading(longitude=190, latitude=17.13)],
    'duplicate in batch': lambda: (lambda r: [r, dict(r)])(reading()),
    'empty batch': lambda: [],
    'more than 500 readings': lambda: [reading(timestamp=utc(-1 - i / 60).isoformat()) for i in range(501)],
}


@pytest.mark.parametrize('case', list(INVALID))
def test_invalid_readings_are_rejected_and_nothing_is_stored(live, case):
    response = push(live, *INVALID[case]())
    assert response.status_code == 422, response.text
    assert live_stations(live) == {}


def test_one_invalid_reading_rejects_the_whole_batch_and_names_it(live):
    response = push(live, reading(station_id='gauge-ok'), reading(station_id='gauge-bad', units={'water_level': 'ft'}))
    assert response.status_code == 422 and response.json()['detail'].startswith('Reading 2')
    assert live_stations(live) == {}


@pytest.mark.parametrize('body', [
    lambda: b'not json',
    lambda: b'[]',
    lambda: b'{"readings": {}}',
    lambda: json.dumps({'readings': [reading()], 'station': 'gauge-1'}),
    lambda: json.dumps({'readings': [reading(water_level_m=float('nan'))]}),
])
def test_malformed_and_non_finite_bodies_are_rejected(live, body):
    assert post_raw(live, body()).status_code == 422
    assert live_stations(live) == {}


def test_oversized_bodies_are_rejected(live):
    assert post_raw(live, b'{"readings": [' + b' ' * (1024 * 1024) + b']}').status_code == 413


def test_a_retried_reading_counts_as_duplicate_and_is_stored_once(live):
    observed = utc(-1).isoformat()
    first = push(live, reading(timestamp=observed)).json()
    retry = push(live, reading(timestamp=observed, water_level_m=9.9)).json()
    assert (first['accepted'], retry['accepted'], retry['duplicates']) == (1, 0, 1)
    assert [r['water_level_m'] for r in live_stations(live)['gauge-1']['history']] == [1.25]


def test_a_late_older_reading_joins_history_without_replacing_latest(live):
    push(live, reading(timestamp=utc(-5).isoformat(), water_level_m=1.5))
    push(live, reading(timestamp=utc(-20).isoformat(), water_level_m=1.1))
    station = live_stations(live)['gauge-1']
    assert station['latest']['water_level_m'] == 1.5
    assert [r['water_level_m'] for r in station['history']] == [1.1, 1.5]


def test_live_threshold_crossings_raise_live_not_test_alerts(live):
    assert live.put('/api/monitoring/gauge-1/thresholds', json=THRESHOLDS).status_code == 200
    first = push(live, reading(timestamp=utc(-15).isoformat(), water_level_m=3.2)).json()
    [alert] = first['alerts']
    assert (alert['mode'], alert['severity'], alert['status'], alert['station_id']) == ('live', 'warning', 'active', 'gauge-1')
    assert 'LIVE' in alert['label'] and 'TEST' not in alert['label'] and 'TEST' not in alert['message']
    assert alert['source'] == SOURCE and alert['water_level_m'] == 3.2
    assert push(live, reading(timestamp=utc(-10).isoformat(), water_level_m=3.4)).json()['alerts'] == []
    escalation = push(live, reading(timestamp=utc(-5).isoformat(), water_level_m=4.3)).json()['alerts']
    assert [a['severity'] for a in escalation] == ['critical']
    assert sorted((a['severity'], a['mode']) for a in live.get('/api/alerts').json()) == [('critical', 'live'), ('warning', 'live')]
    assert live_stations(live)['gauge-1']['severity'] == 'critical'
    assert live.post('/api/alerts/test', json={'mode': 'live'}).status_code == 422


def test_live_station_without_configured_thresholds_raises_no_alerts(live):
    assert push(live, reading(water_level_m=50)).json()['alerts'] == []
    station = live_stations(live)['gauge-1']
    assert station['thresholds'] is None and station['severity'] == 'unavailable'
    assert live.get('/api/alerts').json() == []


def test_stale_backfill_is_stored_without_alerting(live):
    live.put('/api/monitoring/gauge-1/thresholds', json=THRESHOLDS)
    response = push(live, reading(timestamp=utc(-120).isoformat(), water_level_m=4.5)).json()
    assert response['accepted'] == 1 and response['alerts'] == []
    station = live_stations(live)['gauge-1']
    assert (station['freshness'], station['severity']) == ('stale', 'critical')


def test_first_fresh_reading_after_a_data_gap_alerts_again(live):
    live.put('/api/monitoring/gauge-1/thresholds', json=THRESHOLDS)
    push(live, reading(timestamp=utc(-180).isoformat(), water_level_m=3.5))
    response = push(live, reading(timestamp=utc(-1).isoformat(), water_level_m=3.5)).json()
    assert [a['severity'] for a in response['alerts']] == ['warning']


def test_test_disconnect_is_refused_for_live_only_stations(live):
    push(live, reading())
    assert live.put('/api/monitoring/connection', json={'station_id': 'gauge-1', 'connected': False}).status_code == 422
    assert live_stations(live)['gauge-1']['connected'] is True
    assert live.put('/api/monitoring/connection', json={'station_id': 'test-a', 'connected': False}).status_code == 200


def test_websocket_pushes_ingested_readings_without_waiting_for_the_timer(live):
    live.app.state.monitoring.changes.interval = 30
    with live.websocket_connect('/api/ws/monitoring?mode=demonstration') as socket:
        assert socket.receive_json()['monitoring']['live']['stations'] == []
        started = time.monotonic()
        assert push(live, reading()).status_code == 200
        message = socket.receive_json()
        assert time.monotonic() - started < 10
        assert [s['id'] for s in message['monitoring']['live']['stations']] == ['gauge-1']


def test_live_readings_and_receipts_survive_a_restart(live):
    push(live, reading())
    root = live.app.state.datasets.root
    with TestClient(create_app(root, seed=False)) as restarted:
        assert live_stations(restarted)['gauge-1']['latest']['source'] == SOURCE
    [receipt] = (root / 'live' / 'receipts').glob('*.jsonl')
    [line] = receipt.read_text(encoding='utf-8').splitlines()
    entry = json.loads(line)
    assert entry['channel'] == 'POST /api/monitoring/ingest' and entry['readings'][0]['station_id'] == 'gauge-1'


def test_adapter_registry_reports_pagasa_disabled_until_authorized(live):
    adapters = {a['name']: a for a in live.get('/api/models/adapters').json()['monitoring']}
    pagasa = adapters['PAGASA']
    assert pagasa['enabled'] is False and pagasa['transport'] == 'pull'
    assert 'authorized endpoint' in pagasa['detail'] and 'credentials' in pagasa['detail']
    assert adapters['Authorized sensor push']['enabled'] is True
    assert live.get('/api/health').json()['capabilities']['live_ingest'] is True
    snapshot = {a['name']: a['enabled'] for a in live.get('/api/monitoring').json()['adapters']}
    assert snapshot == {'Authorized sensor push': True, 'PAGASA': False}


def test_pagasa_stub_never_polls_and_registry_names_are_unique():
    from backend.monitoring_adapters import AdapterUnavailable, MonitoringAdapterRegistry, PagasaAdapter
    for adapter in (PagasaAdapter(), PagasaAdapter(endpoint='https://example.invalid/feed', credentials='supplied')):
        assert adapter.capability()['enabled'] is False
        with pytest.raises(AdapterUnavailable, match='authorized'):
            adapter.poll()
    registry = MonitoringAdapterRegistry()
    registry.register(PagasaAdapter())
    with pytest.raises(ValueError):
        registry.register(PagasaAdapter())


def test_pdf_report_lists_live_readings_and_does_not_call_live_alerts_tests(live, monkeypatch):
    from reportlab import rl_config
    from backend.reports import pdf_report
    monkeypatch.setattr(rl_config, 'pageCompression', 0)  # keep report text searchable in the bytes
    live.put('/api/monitoring/gauge-1/thresholds', json=THRESHOLDS)
    push(live, reading(water_level_m=3.2))
    monitoring = live.app.state.monitoring
    scenario = {'name': 'Pending test run', 'mode': 'imported', 'validation_label': 'pending', 'source': 'Test', 'model': 'None', 'model_version': '', 'validation_notes': '', 'description': '', 'assumptions': {}, 'frames': []}
    raw = pdf_report(scenario, None, monitoring.snapshot('imported'), monitoring.alerts.list())
    assert b'Live telemetry' in raw and b'LIVE | Artificial gauge 1' in raw
    assert b'TEST exercises and LIVE threshold alerts' in raw and b'Local test alert history' not in raw


def load_push_script():
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parents[1] / 'scripts' / 'push_live_reading.py'
    spec = importlib.util.spec_from_file_location('push_live_reading', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_push_script_delivers_a_reading_that_appears_live(tmp_path, monkeypatch, capsys):
    import socket
    import threading
    import uvicorn
    monkeypatch.setenv('AGOS_INGEST_TOKEN', TOKEN)
    app = create_app(tmp_path, seed=False)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='warning'))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 15
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        script = load_push_script()
        args = ['--url', f'http://127.0.0.1:{port}', '--station', 'drill-1', '--name', 'Drill gauge', '--water-level', '2.5', '--source', 'INGESTION DRILL · pytest']
        assert script.main(args) == 0
        assert json.loads(capsys.readouterr().out)['accepted'] == 1
        [station] = app.state.monitoring.live_snapshot()['stations']
        assert (station['id'], station['freshness'], station['source']) == ('drill-1', 'live', 'INGESTION DRILL · pytest')
        monkeypatch.delenv('AGOS_INGEST_TOKEN')
        with pytest.raises(SystemExit):
            script.main(args)
    finally:
        server.should_exit = True
        thread.join(10)


class ScriptedLogger:
    transport = 'pull'

    def __init__(self, name, readings):
        self.name, self.readings = name, readings

    def capability(self):
        return {'name': self.name, 'transport': self.transport, 'enabled': True, 'detail': 'Pytest double returning scripted readings'}

    def poll(self):
        return self.readings


def test_pull_adapter_readings_share_validation_and_provenance(live):
    from backend.monitoring_adapters import AdapterUnavailable
    monitoring = live.app.state.monitoring
    monitoring.adapters.register(ScriptedLogger('Scripted logger', [reading(station_id='pulled-1')]))
    assert monitoring.poll('Scripted logger')['accepted'] == 1
    assert live_stations(live)['pulled-1']['latest']['channel'] == 'Scripted logger'
    monitoring.adapters.register(ScriptedLogger('Faulty logger', [reading(station_id='pulled-2', units={'water_level': 'cm'})]))
    with pytest.raises(ValueError):
        monitoring.poll('Faulty logger')
    assert 'pulled-2' not in live_stations(live)
    with pytest.raises(AdapterUnavailable):
        monitoring.poll('PAGASA')
