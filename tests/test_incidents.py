from datetime import datetime, timedelta, timezone
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.incidents import match_barangay, normalize
from backend.reports import pht
from conftest import upload_vector

# Real NAMRIA/PSA 2023 names from Ilagan, chosen for punctuation, numbering and parenthesized forms.
ILAGAN_NAMES = ['Cabeseria 14 and 16 (Casilagan)', 'Cabeseria 6 & 24 (Villa Marcos*)', 'Cabeseria 9 and 11 (Capogotan)', 'Cabeseria 2 (Dappat)',
                'Cabeseria 22 (Sablang)', 'Santa Maria (Cabeseria 8)', 'Rang-ayan (Bintacan)', 'Marana I', 'Marana II', 'Marana III', 'Allinguigan 1st',
                'Allinguigan 2nd', 'Allinguigan 3rd', 'San Vicente (Pob.)', 'Baculod (Pob.)', 'Centro - San Antonio', 'Centro Poblacion', 'Gayong-Gayong Norte']


def incident(**overrides):
    value = {'type': 'flooding', 'title': 'Knee-deep water on the national road', 'description': 'Water rising near the school.', 'severity': 'high', 'barangay': '', 'longitude': 121.89, 'latitude': 17.13, 'reporter': 'PYTEST FIXTURE · artificial radio report', 'mode': 'demonstration'}
    value.update(overrides)
    return value


def square(lon, lat, size=.02):
    return {'type': 'Polygon', 'coordinates': [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]]}


def ids(client, query=''):
    return [r['id'] for r in client.get('/api/incidents' + query).json()]


def test_incidents_are_never_seeded(client):
    assert client.get('/api/incidents').json() == []
    assert client.post('/api/demo/load').status_code == 200
    assert client.get('/api/incidents').json() == []


def test_demonstration_incident_is_an_exercise_record(client):
    response = client.post('/api/incidents', json=incident())
    assert response.status_code == 201, response.text
    record = response.json()
    assert record['mode'] == 'demonstration' and 'EXERCISE' in record['label']
    assert record['status'] == 'reported' and [h['status'] for h in record['history']] == ['reported']
    for key in ('created_at', 'updated_at', 'reported_at'):
        assert datetime.fromisoformat(record[key]).utcoffset() is not None
    assert record['reported_at'] == record['created_at']
    assert client.get('/api/incidents').json() == [record]


def test_imported_mode_incident_is_labeled_user_entered_not_exercise(client):
    record = client.post('/api/incidents', json=incident(mode='imported')).json()
    assert 'EXERCISE' not in record['label'] and 'USER-ENTERED' in record['label']


def test_records_without_a_mode_default_to_exercise(client):
    value = incident()
    del value['mode']
    assert 'EXERCISE' in client.post('/api/incidents', json=value).json()['label']


def test_clients_cannot_preset_workflow_status_or_label(client):
    assert client.post('/api/incidents', json=incident(status='verified')).status_code == 422
    assert client.post('/api/incidents', json=incident(label='VERIFIED OPERATIONAL REPORT')).status_code == 422


@pytest.mark.parametrize('field', ['title', 'reporter'])
def test_required_text_cannot_be_blank(client, field):
    assert client.post('/api/incidents', json=incident(**{field: '   '})).status_code == 422


@pytest.mark.parametrize('field', ['type', 'severity'])
def test_type_and_severity_use_a_closed_vocabulary(client, field):
    assert client.post('/api/incidents', json=incident(**{field: 'unlisted-value'})).status_code == 422


def test_reported_time_keeps_its_offset_and_must_not_be_naive_or_future(client):
    record = client.post('/api/incidents', json=incident(reported_at='2026-01-15T14:05:00+08:00')).json()
    assert record['reported_at'] == '2026-01-15T14:05:00+08:00'
    assert client.post('/api/incidents', json=incident(reported_at='2026-01-15T14:05:00')).status_code == 422
    future = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    assert client.post('/api/incidents', json=incident(reported_at=future)).status_code == 422


@pytest.mark.parametrize('location', [
    {'longitude': 121.89, 'latitude': None},
    {'longitude': None, 'latitude': 17.13},
    {'longitude': 200, 'latitude': 17.13},
    {'longitude': 17.13, 'latitude': 121.89},  # swapped axes
])
def test_partial_or_invalid_locations_are_rejected(client, location):
    assert client.post('/api/incidents', json=incident(**location)).status_code == 422


def test_non_finite_coordinates_are_rejected(client):
    raw = '{"type":"flooding","title":"NaN test","severity":"low","reporter":"PYTEST","longitude":NaN,"latitude":17.13}'
    assert client.post('/api/incidents', content=raw, headers={'content-type': 'application/json'}).status_code == 422
    assert client.get('/api/incidents').json() == []


def test_implausibly_old_report_times_are_rejected(client):
    for value in ('0026-01-15T14:05:00+08:00', '1999-12-31T23:59:00+00:00'):
        assert client.post('/api/incidents', json=incident(reported_at=value)).status_code == 422
    assert client.post('/api/incidents', json=incident(reported_at='2000-01-01T08:00:00+08:00')).status_code == 201


def test_report_time_formatting_survives_out_of_range_stored_values():
    assert pht('2026-01-15T06:05:00+00:00') == '2026-01-15 14:05 PHT'
    assert pht('0001-01-01T00:00:00+08:00') == '0001-01-01T00:00:00+08:00'


def test_map_location_is_optional(client):
    record = client.post('/api/incidents', json=incident(longitude=None, latitude=None)).json()
    assert record['longitude'] is None and record['latitude'] is None


def test_barangay_without_a_boundary_layer_is_stored_but_marked_unchecked(client):
    record = client.post('/api/incidents', json=incident(barangay='  Alibagu  ')).json()
    assert record['barangay'] == 'Alibagu' and record['barangay_validated'] is False


@pytest.mark.parametrize('typed,canonical', [
    ('san vicente (pob.)', 'San Vicente (Pob.)'),
    ('Brgy. San Vicente', 'San Vicente (Pob.)'),
    ('Abuan', 'Cabeseria 27 (Abuan)'),
    ('Osmena', 'Osmeña (Sinippil)'),
    ('Sta. Barbara', 'Santa Barbara (Pob.)'),
])
def test_barangay_resolves_to_the_imported_boundary_name(client, typed, canonical):
    for i, name in enumerate(['San Vicente (Pob.)', 'Cabeseria 27 (Abuan)', 'Osmeña (Sinippil)', 'Santa Barbara (Pob.)']):
        assert upload_vector(client, geometry=square(121.8 + i * .03, 17.2), name=name).status_code == 201
    record = client.post('/api/incidents', json=incident(barangay=typed)).json()
    assert record['barangay'] == canonical and record['barangay_validated'] is True


def test_unknown_barangay_is_rejected_with_a_suggestion(client):
    upload_vector(client, name='San Vicente (Pob.)')
    response = client.post('/api/incidents', json=incident(barangay='San Vicnte'))
    assert response.status_code == 422 and 'San Vicente (Pob.)' in response.json()['detail']
    assert client.get('/api/incidents').json() == []


@pytest.mark.parametrize('typed,canonical', [
    ('Cabeseria 14 & 16', 'Cabeseria 14 and 16 (Casilagan)'),
    ('Cabeseria 6 and 24', 'Cabeseria 6 & 24 (Villa Marcos*)'),
    ('Cabeseria 2', 'Cabeseria 2 (Dappat)'),
    ('Cabeseria 22', 'Cabeseria 22 (Sablang)'),
    ('Cabeseria 8', 'Santa Maria (Cabeseria 8)'),
    ('Rangayan', 'Rang-ayan (Bintacan)'),
    ('Marana 1', 'Marana I'),
    ('Marana 3', 'Marana III'),
    ('Allinguigan 2', 'Allinguigan 2nd'),
    ('Gayong Gayong Norte', 'Gayong-Gayong Norte'),
])
def test_barangay_matching_accepts_common_spelling_variants(typed, canonical):
    assert match_barangay(typed, ILAGAN_NAMES) == canonical


def test_distinct_barangay_names_stay_distinct_after_normalizing():
    assert len({normalize(name) for name in ILAGAN_NAMES}) == len(ILAGAN_NAMES)
    for typed in ('Cabeseria 911', 'Centro', 'Marana'):
        with pytest.raises(ValueError):
            match_barangay(typed, ILAGAN_NAMES)


def test_ambiguous_barangay_alias_is_rejected(client):
    upload_vector(client, geometry=square(121.8, 17.2), name='Baculod (Pob.)')
    upload_vector(client, geometry=square(121.85, 17.2), name='San Vicente (Pob.)')
    assert client.post('/api/incidents', json=incident(barangay='Pob.')).status_code == 422


def test_barangay_names_and_point_lookup_come_from_imported_boundaries(client):
    empty = client.get('/api/barangays').json()
    assert empty['available'] is False and empty['names'] == [] and empty['containing'] is None
    upload_vector(client, name='Artificial barangay B')
    upload_vector(client, geometry=square(121.8, 17.2), name='Artificial barangay A')
    found = client.get('/api/barangays?longitude=121.89&latitude=17.13').json()
    assert found['available'] is True and found['names'] == ['Artificial barangay A', 'Artificial barangay B']
    assert found['containing'] == 'Artificial barangay B'
    assert client.get('/api/barangays?longitude=121.0&latitude=17.0').json()['containing'] is None


def test_status_moves_forward_through_the_response_workflow(client):
    record = client.post('/api/incidents', json=incident()).json()
    for status in ('verified', 'responding', 'resolved'):
        response = client.patch(f"/api/incidents/{record['id']}", json={'status': status})
        assert response.status_code == 200 and response.json()['status'] == status
    history = response.json()['history']
    assert [h['status'] for h in history] == ['reported', 'verified', 'responding', 'resolved']
    assert all(datetime.fromisoformat(h['at']).utcoffset() is not None for h in history)


def test_status_never_moves_backward_repeats_or_reopens(client):
    url = f"/api/incidents/{client.post('/api/incidents', json=incident()).json()['id']}"
    assert client.patch(url, json={'status': 'responding'}).status_code == 200
    assert client.patch(url, json={'status': 'verified'}).status_code == 422
    assert client.patch(url, json={'status': 'responding'}).status_code == 422
    assert client.patch(url, json={'status': 'resolved'}).status_code == 200
    assert client.patch(url, json={'status': 'reported'}).status_code == 422
    assert client.patch(url, json={'status': 'acknowledged'}).status_code == 422
    assert [h['status'] for h in client.get('/api/incidents').json()[0]['history']] == ['reported', 'responding', 'resolved']


def test_a_false_report_can_be_closed_without_being_marked_verified(client):
    record = client.post('/api/incidents', json=incident()).json()
    closed = client.patch(f"/api/incidents/{record['id']}", json={'status': 'resolved'}).json()
    assert [h['status'] for h in closed['history']] == ['reported', 'resolved']


def test_editing_updates_details_but_keeps_workflow_state(client):
    record = client.post('/api/incidents', json=incident(reported_at='2026-01-15T14:05:00+08:00')).json()
    url = f"/api/incidents/{record['id']}"
    client.patch(url, json={'status': 'verified'})
    edited = client.put(url, json=incident(title='Waist-deep water on the national road', severity='critical'))
    assert edited.status_code == 200, edited.text
    edited = edited.json()
    assert edited['title'] == 'Waist-deep water on the national road' and edited['severity'] == 'critical'
    assert edited['status'] == 'verified' and len(edited['history']) == 2
    assert edited['id'] == record['id'] and edited['created_at'] == record['created_at']
    assert edited['reported_at'] == '2026-01-15T14:05:00+08:00'


def test_editing_other_fields_keeps_a_barangay_recorded_before_boundaries_existed(client):
    record = client.post('/api/incidents', json=incident(barangay='Sitio Old Name')).json()
    upload_vector(client, name='Alibagu')
    url = f"/api/incidents/{record['id']}"
    edited = client.put(url, json=incident(barangay='Sitio Old Name', severity='critical'))
    assert edited.status_code == 200, edited.text
    assert edited.json()['barangay'] == 'Sitio Old Name' and edited.json()['barangay_validated'] is False
    assert client.put(url, json=incident(barangay='Unknown place')).status_code == 422


def test_exercise_records_cannot_be_relabeled_as_operator_reports(client):
    record = client.post('/api/incidents', json=incident()).json()
    assert client.put(f"/api/incidents/{record['id']}", json=incident(mode='imported')).status_code == 422
    assert 'EXERCISE' in client.get('/api/incidents').json()[0]['label']


def test_delete_removes_an_incident(client):
    record = client.post('/api/incidents', json=incident()).json()
    assert client.delete(f"/api/incidents/{record['id']}").status_code == 200
    assert client.get('/api/incidents').json() == []
    assert client.delete(f"/api/incidents/{record['id']}").status_code == 404
    assert client.patch(f"/api/incidents/{record['id']}", json={'status': 'verified'}).status_code == 404
    assert client.put(f"/api/incidents/{record['id']}", json=incident()).status_code == 404


def test_list_filters_by_status_severity_barangay_and_mode(client):
    a = client.post('/api/incidents', json=incident(severity='critical', barangay='Alibagu')).json()
    b = client.post('/api/incidents', json=incident(severity='low', barangay='Bigao', mode='imported')).json()
    client.patch(f"/api/incidents/{b['id']}", json={'status': 'verified'})
    assert ids(client, '?severity=critical') == [a['id']]
    assert ids(client, '?status=verified') == [b['id']]
    assert ids(client, '?barangay=alibagu') == [a['id']]
    assert ids(client, '?mode=imported') == [b['id']]
    assert client.get('/api/incidents?status=unknown').status_code == 422


def test_incidents_are_listed_newest_report_first_across_offsets(client):
    earlier = client.post('/api/incidents', json=incident(reported_at='2026-01-15T09:00:00+08:00')).json()  # 01:00 UTC
    later = client.post('/api/incidents', json=incident(reported_at='2026-01-15T01:30:00+00:00')).json()
    assert ids(client) == [later['id'], earlier['id']]


def test_incidents_survive_restart(client):
    record = client.post('/api/incidents', json=incident()).json()
    with TestClient(create_app(client.app.state.datasets.root)) as second:
        assert second.get('/api/incidents').json() == [record]


def test_incident_csv_export_is_scoped_to_the_data_mode(client):
    client.post('/api/incidents', json=incident(title='=HYPERLINK("bad") exercise entry'))
    client.post('/api/incidents', json=incident(title='Operator entry', mode='imported'))
    demo = client.get('/api/reports/csv?kind=incidents&mode=demonstration')
    assert demo.status_code == 200 and demo.headers['content-type'].startswith('text/csv')
    text = demo.content.decode('utf-8-sig')
    assert 'EXERCISE' in text and "'=HYPERLINK" in text and 'Operator entry' not in text
    imported = client.get('/api/reports/csv?kind=incidents&mode=imported').content.decode('utf-8-sig')
    assert 'Operator entry' in imported and 'EXERCISE' not in imported


def test_empty_incident_export_still_has_the_incident_columns(client):
    header = client.get('/api/reports/csv?kind=incidents&mode=imported').content.decode('utf-8-sig').splitlines()[0]
    assert {'label', 'status', 'title', 'barangay', 'reported_at'} <= set(header.split(','))


def test_every_pdf_page_with_exercise_incidents_carries_the_exercise_label(client, monkeypatch):
    from reportlab import rl_config
    monkeypatch.setattr(rl_config, 'pageCompression', 0)
    for i in range(30):
        client.post('/api/incidents', json=incident(title=f'Drill-row-{i:02d}', description='MMMM ' * 50))
    raw = client.post('/api/reports/pdf', json={'scenario_id': 'demo-standard', 'frame': 4}).content
    pages = [stream for stream in raw.split(b'endstream') if b'Drill-row-' in stream]
    assert len(pages) > 1
    assert all(b'EXERCISE' in page for page in pages)
    assert b'Operator incident log' not in raw


def test_pdf_report_lists_incidents_of_the_report_mode(client, monkeypatch):
    from reportlab import rl_config
    monkeypatch.setattr(rl_config, 'pageCompression', 0)
    client.post('/api/incidents', json=incident(title='Exercise-flood-A', description='MMMM ' * 599))  # taller than a page if not shortened
    client.post('/api/incidents', json=incident(title='Operator-entry-B', mode='imported'))
    pdf = client.post('/api/reports/pdf', json={'scenario_id': 'demo-standard', 'frame': 4})
    assert pdf.status_code == 200 and pdf.content.startswith(b'%PDF')
    assert b'Exercise-flood-A' in pdf.content and b'EXERCISE' in pdf.content
    assert b'Operator-entry-B' not in pdf.content
