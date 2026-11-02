"""Acquire public, attributed Ilagan reference datasets; never create flood outputs.

Run using the project virtual environment. Raw downloads, prepared files, and
provenance live under data/public/ilagan. Only read queries go to public services.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import math
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
OUT = ROOT / 'data' / 'public' / 'ilagan'
RAW = OUT / 'raw'
PREPARED = OUT / 'prepared'
GEORISK = 'https://portal.georisk.gov.ph/arcgis/rest/services/PSA/Barangay/MapServer/4'
UA = 'AgosPH-local-research/1.0 (public-data acquisition; no live warning service)'


def log(message):
    print(message, flush=True)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.part')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    temp.replace(path)


def download(client, url, path, params=None, max_bytes=180_000_000):
    if path.exists() and path.stat().st_size:
        return path
    temp = path.with_suffix(path.suffix + '.part')
    total = 0
    try:
        with client.stream('GET', url, params=params) as response:
            response.raise_for_status()
            with temp.open('wb') as out:
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError('Download exceeds the bounded public-data limit')
                    out.write(chunk)
        temp.replace(path)
        log(f'Downloaded {path.name}: {total:,} bytes')
        return path
    finally:
        temp.unlink(missing_ok=True)


def probe(client):
    for label, url, params in [
        ('Barangay service metadata', GEORISK, {'f': 'pjson'}),
        ('Ilagan barangay attributes', GEORISK + '/query', {'f': 'json', 'where': "UPPER(city_name) LIKE '%ILAGAN%' AND UPPER(prov_name) = 'ISABELA'", 'outFields': 'city_name,brgy_name,city_code,brgy_code', 'returnGeometry': 'false'}),
    ]:
        response = client.get(url, params=params)
        response.raise_for_status()
        value = response.json()
        write_json(RAW / (label.lower().replace(' ', '-') + '.json'), value)
        if 'features' in value:
            log(json.dumps({'label': label, 'count': len(value['features']), 'sample': value['features'][:3]}, ensure_ascii=False))
        else:
            log(json.dumps({'label': label, 'name': value.get('name'), 'fields': [f['name'] for f in value.get('fields', [])], 'error': value.get('error')}, ensure_ascii=False))


def catalog(client):
    from concurrent.futures import ThreadPoolExecutor, as_completed
    urls = {
        'boundary-mirror': 'https://api.github.com/repos/bendlikeabamboo/barangay-boundaries-repository/releases/latest',
        'rainfall-index': 'https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/sat/2025/',
        'georisk-catalog': 'https://portal.georisk.gov.ph/arcgis/rest/services?f=pjson',
        'hdx-boundary-metadata': 'https://data.humdata.org/api/3/action/package_show?id=cod-ab-phl',
    }
    def fetch(item):
        key, url = item
        response = client.get(url, timeout=30)
        response.raise_for_status()
        path = RAW / (key + ('.html' if key == 'rainfall-index' else '.json'))
        path.write_bytes(response.content)
        if key == 'boundary-mirror':
            data = response.json()
            return {'source': key, 'tag': data.get('tag_name'), 'assets': [{'name': a['name'], 'size': a['size'], 'url': a['browser_download_url']} for a in data.get('assets', [])]}
        if key == 'georisk-catalog':
            return {'source': key, 'catalog': response.json()}
        if key == 'hdx-boundary-metadata':
            data = response.json()
            return {'source': key, 'success': data.get('success'), 'resources': [{'name': r.get('name'), 'url': r.get('url'), 'format': r.get('format')} for r in data.get('result', {}).get('resources', [])]}
        import re
        return {'source': key, 'files': re.findall(r'href="([^"]*2025\.11\.0[123][^"]*)"', response.text)}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(fetch, item): item[0] for item in urls.items()}
        for future in as_completed(futures):
            try:
                log(json.dumps(future.result(), ensure_ascii=False))
            except Exception as exc:
                log(f'{futures[future]}: {type(exc).__name__}: {exc}')


def boundary_mirror(client):
    import zipfile
    catalog_data = json.loads((RAW / 'boundary-mirror.json').read_text(encoding='utf-8'))
    asset = next(a for a in catalog_data['assets'] if a['name'].endswith('hierarchical.zip'))
    path = download(client, asset['browser_download_url'], RAW / asset['name'])
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        write_json(RAW / 'boundary-archive-index.json', names)
        matches = [n for n in names if 'ilagan' in n.lower() or '023114' in n]
        log(json.dumps({'zip_entries': len(names), 'matches': matches, 'sample': names[:15]}))
        for name in matches[:3]:
            info = archive.getinfo(name)
            if info.file_size > 20_000_000:
                raise ValueError('Unexpectedly large local boundary entry')
            content = archive.read(name)
            if name.endswith('.geojson') or name.endswith('.json'):
                value = json.loads(content)
                log(json.dumps({'entry': name, 'type': value.get('type'), 'keys': list(value)[:10], 'sample_properties': [f.get('properties') for f in value.get('features', [])[:2]]}, ensure_ascii=False))
                (RAW / 'ilagan-mirror-entry.json').write_bytes(content)


def prepare_mirror(client):
    import zipfile
    from shapely.geometry import shape, mapping
    from shapely import make_valid
    path = RAW / 'barangay-boundaries-2023-10-24-hierarchical.zip'
    with zipfile.ZipFile(path) as archive:
        value = json.loads(archive.read('barangays.geojson'))
    features, repairs = [], 0
    for feature in value['features']:
        props = feature['properties']
        if props.get('ADM3_PCODE') != 'PH0203114' or props.get('ADM2_EN') != 'Isabela':
            continue
        geom = shape(feature['geometry'])
        if not geom.is_valid:
            geom = make_valid(geom)
            repairs += 1
        if geom.geom_type not in {'Polygon', 'MultiPolygon'} or geom.is_empty:
            raise ValueError('Mirror boundary is not a valid polygon')
        features.append({'type': 'Feature', 'geometry': mapping(geom), 'properties': {**props, 'name': props['ADM4_EN'], 'source': 'Community NAMRIA/PSA-derived extract, not a direct agency delivery', 'source_geometry_vintage': 'NAMRIA 2023-11-06 / PSGC snapshot 2023-10-24', 'source_simplification_degrees': .005, 'reference_only': True}})
    if not features:
        raise ValueError('No Ilagan barangays found in the published archive')
    prepared = PREPARED / 'ilagan-barangays-NAMRIA-PSA-derived-2023-simplified.geojson'
    write_json(prepared, {'type': 'FeatureCollection', 'features': features})
    record('boundaries', prepared, 'NAMRIA/PSA-derived community reference extract by bendlikeabamboo/barangay-boundaries-repository, release v2026.4.13.0; underlying NAMRIA geometry version 2023-11-06 and PSGC snapshot 2023-10-24. https://github.com/bendlikeabamboo/barangay-boundaries-repository . Source simplified with Douglas-Peucker tolerance 0.005 degrees (roughly 550 m). Not a current surveyed/legal boundary. © NAMRIA / PSA; repository code MIT; retain original data attribution.', ['REFERENCE ONLY: source geometry was simplified at 0.005 degrees (roughly 550 m); unsuitable for parcel-scale or precise barangay exposure calculation.', 'This is a community conversion of older NAMRIA/PSA sources, not a direct current LGU or agency boundary delivery.', f'Local geometry validity repairs: {repairs}. Full archive retained.', 'Direct GeoRisk geometry queries timed out; acquire higher-resolution, current boundaries from Ilagan LGU before operational analysis.'], role='boundaries', feature_count=len(features), source_urls=['https://github.com/bendlikeabamboo/barangay-boundaries-repository/releases/tag/v2026.4.13.0'], license='Retain NAMRIA/PSA attribution and original source terms; repository code MIT', simplification_degrees=.005)


def query_probe(client):
    response = client.post(GEORISK + '/query', data={'f': 'json', 'where': "city_code = '023114000'", 'returnCountOnly': 'true'}, timeout=20)
    response.raise_for_status()
    log(response.text[:1000])


def original_catalog(client):
    from concurrent.futures import ThreadPoolExecutor, as_completed
    urls = {'itos': 'https://codgis.itos.uga.edu/arcgis/rest/services/COD_External?f=pjson', 'namria-source-mirror': 'https://api.github.com/repos/altcoder/philippines-psgc-shapefiles/contents/data/2023'}
    def fetch(item):
        key, url = item
        response = client.get(url, timeout=25)
        response.raise_for_status()
        value = response.json()
        write_json(RAW / (key + '.json'), value)
        if isinstance(value, list):
            return {'source': key, 'entries': [{'name': v['name'], 'size': v['size'], 'url': v.get('download_url'), 'api': v.get('url')} for v in value]}
        return {'source': key, 'services': [s for s in value.get('services', []) if 'PHL' in s['name']]}
    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = {pool.submit(fetch, item): item[0] for item in urls.items()}
        for future in as_completed(tasks):
            try:
                log(json.dumps(future.result()))
            except Exception as exc:
                log(f'{tasks[future]}: {type(exc).__name__}: {exc}')


def original_files(client):
    index = json.loads((RAW / 'namria-source-mirror.json').read_text(encoding='utf-8'))
    folder = next(e for e in index if e['name'] == 'BgySubMuns')
    response = client.get(folder['url'], timeout=25)
    response.raise_for_status()
    value = response.json()
    write_json(RAW / 'namria-barangay-source-files.json', value)
    log(json.dumps([{'name': e['name'], 'size': e['size'], 'url': e.get('download_url')} for e in value]))


def prepare_original(client):
    import io
    import re
    import shapefile
    from shapely.geometry import shape, mapping
    from shapely import make_valid
    from pyproj import CRS

    files = json.loads((RAW / 'namria-barangay-source-files.json').read_text(encoding='utf-8'))
    selected = {Path(e['name']).suffix: e for e in files if Path(e['name']).suffix in {'.dbf', '.shp', '.shx', '.prj', '.cpg'}}
    fetched, lfs = {}, {}
    for suffix, entry in selected.items():
        response = client.get(entry['download_url'], timeout=30)
        response.raise_for_status()
        content = response.content
        if content.startswith(b'version https://git-lfs.github.com/spec/v1'):
            text = content.decode()
            lfs[suffix] = {'oid': re.search(r'oid sha256:([a-f0-9]+)', text).group(1), 'size': int(re.search(r'size (\d+)', text).group(1))}
        else:
            fetched[suffix] = content
            (RAW / entry['name']).write_bytes(content)
    if not CRS.from_wkt(fetched['.prj'].decode()).equals(CRS.from_epsg(4326), ignore_axis_order=True):
        raise ValueError('Source CRS is not WGS84; conversion must be explicit')
    response = client.post('https://github.com/altcoder/philippines-psgc-shapefiles.git/info/lfs/objects/batch', json={'operation': 'download', 'transfers': ['basic'], 'objects': list(lfs.values())}, headers={'Accept': 'application/vnd.git-lfs+json'}, timeout=30)
    response.raise_for_status()
    objects = {item['oid']: item for item in response.json()['objects']}
    for suffix, item in lfs.items():
        obj = objects[item['oid']]
        if obj.get('error'):
            raise ValueError('Public source file unavailable: ' + str(obj['error']))
        item['url'] = obj['actions']['download']['href']  # signed public artifact URL kept in memory only
        if suffix != '.shp':
            response = client.get(item['url'], timeout=60)
            response.raise_for_status()
            fetched[suffix] = response.content
            if hashlib.sha256(fetched[suffix]).hexdigest() != item['oid']:
                raise ValueError('Source attribute/index checksum mismatch')
            (RAW / selected[suffix]['name']).write_bytes(fetched[suffix])

    class RangeReader(io.RawIOBase):
        def __init__(self, url, size):
            self.url, self.size, self.position, self.cache = url, size, 0, {}
            self.bytes_fetched = 0
        def readable(self): return True
        def seekable(self): return True
        def tell(self): return self.position
        def seek(self, offset, whence=0):
            self.position = offset if whence == 0 else self.position + offset if whence == 1 else self.size + offset
            if self.position < 0: raise ValueError('Negative source seek')
            return self.position
        def read(self, count=-1):
            if count < 0: count = self.size - self.position
            end = min(self.size, self.position + count)
            result = bytearray()
            block_size = 1024 * 1024
            while self.position < end:
                block = self.position // block_size
                if block not in self.cache:
                    start, stop = block * block_size, min(self.size, (block + 1) * block_size) - 1
                    with client.stream('GET', self.url, headers={'Range': f'bytes={start}-{stop}'}, timeout=60) as chunk:
                        if chunk.status_code != 206:
                            raise ValueError(f'Source server did not honor byte-range access ({chunk.status_code}); refusing a full national geometry download')
                        self.cache[block] = chunk.read()
                    if len(self.cache[block]) != stop - start + 1:
                        raise ValueError('Incomplete source byte range')
                    self.bytes_fetched += len(self.cache[block])
                buffer = self.cache[block]
                offset = self.position % block_size
                n = min(end - self.position, len(buffer) - offset)
                if n <= 0: raise ValueError('Unexpected source range boundary')
                result.extend(buffer[offset:offset + n])
                self.position += n
            return bytes(result)

    shp = RangeReader(lfs['.shp']['url'], lfs['.shp']['size']) if '.shp' in lfs else io.BytesIO(fetched['.shp'])
    reader = shapefile.Reader(shp=shp, shx=io.BytesIO(fetched['.shx']), dbf=io.BytesIO(fetched['.dbf']), encoding=fetched.get('.cpg', b'UTF-8').decode().strip())
    fields = [field[0] for field in reader.fields[1:]]
    features, repairs = [], 0
    for index, row in enumerate(reader.iterRecords()):
        props = dict(zip(fields, row))
        if props.get('ADM3_PCODE') != 'PH0203114' or props.get('ADM2_EN') != 'Isabela':
            continue
        geom = shape(reader.shape(index).__geo_interface__)
        if not geom.is_valid:
            geom = make_valid(geom)
            repairs += 1
        if geom.is_empty or geom.geom_type not in {'Polygon', 'MultiPolygon'}:
            raise ValueError('Source polygon cannot be represented as a valid area')
        for key, value in list(props.items()):
            if hasattr(value, 'isoformat'): props[key] = value.isoformat()
        props.update(name=props['ADM4_EN'], source='NAMRIA/PSA original-resolution 2023 shapefile through public altcoder mirror', geometry_simplified=False)
        features.append({'type': 'Feature', 'geometry': mapping(geom), 'properties': props})
    if len(features) != 91:
        raise ValueError(f'Expected 91 sourced Ilagan barangays; got {len(features)}. Inspect source coverage.')
    prepared = PREPARED / 'ilagan-barangays-NAMRIA-PSA-2023-original-resolution.geojson'
    write_json(prepared, {'type': 'FeatureCollection', 'features': features})
    record('boundaries', prepared, '© NAMRIA and Philippine Statistics Authority, administrative boundary shapefile version 2023-11-06; original geometry copied without simplification from the public altcoder/philippines-psgc-shapefiles mirror. https://github.com/altcoder/philippines-psgc-shapefiles/tree/main/data/2023/BgySubMuns . Ilagan ADM3_PCODE PH0203114, Isabela. Not independently surveyed or certified as current legal boundaries.', ['Older source geography: 2023-11-06. Confirm current legal boundaries with Ilagan LGU.', f'No geometric simplification applied. Invalid polygons repaired using Shapely make_valid: {repairs}; source coordinates otherwise retained.', 'Source attributes/index files verified against their public LFS SHA-256 when applicable. Only relevant geometry byte ranges downloaded; full national geometry hash not recomputed.'], role='boundaries', feature_count=len(features), source_urls=[e['download_url'] for e in selected.values()], source_lfs={suffix: {'oid': v['oid'], 'size': v['size']} for suffix, v in lfs.items()}, license='NAMRIA/PSA attribution and source COD terms; source metadata retained', simplification_degrees=0, geometry_bytes_downloaded=getattr(shp, 'bytes_fetched', len(fetched.get('.shp', b''))))


def hazard_catalog(client):
    for folder in ('Hosted', 'MGB', 'PAGASA'):
        response = client.get(f'https://portal.georisk.gov.ph/arcgis/rest/services/{folder}', params={'f': 'pjson'}, timeout=25)
        response.raise_for_status()
        value = response.json()
        write_json(RAW / f'georisk-{folder}.json', value)
        log(json.dumps({'folder': folder, 'services': value.get('services'), 'error': value.get('error')}))


def provenance_path():
    return OUT / 'acquisition.json'


def record(key, path, source, warnings, **details):
    from filelock import FileLock
    with FileLock(str(OUT / '.acquisition.lock')):
        manifest = json.loads(provenance_path().read_text(encoding='utf-8')) if provenance_path().exists() else {'datasets': {}, 'unavailable': {}}
        manifest['retrieved_at'] = datetime.now(timezone.utc).isoformat()
        previous = manifest['datasets'].get(key, {})
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        entry = {'file': str(path.relative_to(ROOT)), 'sha256': digest, 'source': source, 'warnings': warnings, **details}
        if previous.get('dataset_id'):
            entry['dataset_id' if previous.get('sha256') == digest else 'supersedes_id'] = previous['dataset_id']
        manifest['datasets'][key] = entry
        manifest['unavailable'].pop(key, None)
        write_json(provenance_path(), manifest)
    log(f'Prepared {key}: {details}')


def unavailable(key, reason):
    from filelock import FileLock
    with FileLock(str(OUT / '.acquisition.lock')):
        manifest = json.loads(provenance_path().read_text(encoding='utf-8')) if provenance_path().exists() else {'datasets': {}, 'unavailable': {}}
        manifest['unavailable'][key] = {'reason': reason, 'checked_at': datetime.now(timezone.utc).isoformat()}
        write_json(provenance_path(), manifest)
    log(f'Unavailable {key}: {reason}')


def boundaries(client):
    from shapely.geometry import shape, mapping
    from shapely import make_valid
    path = RAW / 'psa-ilagan-barangays.geojson'
    download(client, GEORISK + '/query', path, {'f': 'geojson', 'where': "city_code = '023114000'", 'outFields': 'objectid,reg_name,prov_name,city_name,brgy_name,reg_code,prov_code,city_code,brgy_code,psgc_10d', 'outSR': '4326', 'returnGeometry': 'true', 'resultRecordCount': 1000})
    value = json.loads(path.read_text(encoding='utf-8'))
    if value.get('error') or not value.get('features'):
        raise ValueError(f'Boundary service did not return Ilagan features: {str(value)[:400]}')
    if value.get('exceededTransferLimit') or value.get('properties', {}).get('exceededTransferLimit'):
        raise ValueError('Boundary response truncated; refusing incomplete administrative coverage')
    output, repairs = [], 0
    for feature in value['features']:
        props = feature['properties']
        if 'ILAGAN' not in props['city_name'].upper() or props['prov_name'].upper() != 'ISABELA':
            raise ValueError('Unexpected locality in boundary response')
        geom = shape(feature['geometry'])
        if not geom.is_valid:
            geom = make_valid(geom)
            repairs += 1
        if geom.geom_type not in {'Polygon', 'MultiPolygon'}:
            raise ValueError('Boundary repair did not produce a polygon')
        output.append({'type': 'Feature', 'geometry': mapping(geom), 'properties': {**props, 'name': props['brgy_name'], 'source': 'Philippine Statistics Authority via GeoRisk', 'boundary_vintage': 'Indicative boundaries as of June 2016 per service metadata', 'not_surveyed_legal_boundary': True}})
    prepared = PREPARED / 'ilagan-barangays-PSA-indicative-2016.geojson'
    write_json(prepared, {'type': 'FeatureCollection', 'features': output})
    record('boundaries', prepared, f'PSA indicative barangay boundaries via GeoRisk public service: {GEORISK}; city_code=023114000. Service metadata states June 2016 indicative geography based on 2015 census. Acknowledge PSA. Retrieved {datetime.now(timezone.utc).date()}.', ['Indicative June 2016 boundaries; not current surveyed/legal barangay boundaries. Verify against Ilagan LGU records.', f'Geometry validity repairs using Shapely make_valid: {repairs}. Original service response retained.'], role='boundaries', feature_count=len(output), license='Acknowledge Philippine Statistics Authority; service does not declare a broader redistribution license')


def city_geometry():
    from shapely.geometry import shape
    from shapely.ops import unary_union
    manifest = json.loads(provenance_path().read_text(encoding='utf-8'))
    value = json.loads((ROOT / manifest['datasets']['boundaries']['file']).read_text(encoding='utf-8'))
    return unary_union([shape(f['geometry']) for f in value['features']])


def osm(client, only_role=None, provider='coffee'):
    from shapely.geometry import LineString, Point, Polygon, mapping
    from shapely import make_valid
    from shapely.prepared import prep
    city = city_geometry()
    city_index = prep(city)
    west, south, east, north = city.bounds
    bbox = f'{south},{west},{north},{east}'
    groups = {
        'rivers': f'way["waterway"~"^(river|stream|canal|drain)$"]({bbox});',
        'roads': f'way["highway"]["area"!="yes"]({bbox});',
        'bridges': f'way["bridge"]["bridge"!="no"]({bbox});',
        'buildings': f'way["building"]["building"!="no"]({bbox});',
        'facilities': f'node["amenity"~"^(hospital|clinic|doctors|school|college|university|fire_station|police|townhall|community_centre|shelter)$"]({bbox});way["amenity"~"^(hospital|clinic|doctors|school|college|university|fire_station|police|townhall|community_centre|shelter)$"]({bbox});node["emergency"="shelter"]({bbox});',
    }
    for role, selectors in groups.items():
        if only_role and role != only_role:
            continue
        raw = RAW / f'osm-ilagan-{role}.json'
        if role == 'bridges' and not raw.exists() and (RAW / 'osm-ilagan-roads.json').exists():
            roads = json.loads((RAW / 'osm-ilagan-roads.json').read_text(encoding='utf-8'))
            derived = {**roads, 'elements': [e for e in roads['elements'] if e.get('tags', {}).get('bridge', 'no') != 'no'], '_selection': 'Bridge-tagged highway ways from the already downloaded OSM road query; not a separate bridge inventory'}
            write_json(raw, derived)
        needs_completion = raw.exists() and bool(json.loads(raw.read_text(encoding='utf-8')).get('_failed_tiles'))
        if not raw.exists() or needs_completion:
            endpoint = {'coffee': 'https://overpass.private.coffee/api/interpreter', 'main': 'https://overpass-api.de/api/interpreter', 'vk': 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'}[provider]
            if role in {'buildings', 'facilities'}:
                elements = {}
                tile_stamps = []
                failed_tiles = []
                for row in range(2):
                    for col in range(3):
                        part = RAW / f'osm-{role}-tile-{row}-{col}.json'
                        b = f'{south + (north-south)*row/2},{west + (east-west)*col/3},{south + (north-south)*(row+1)/2},{west + (east-west)*(col+1)/3}'
                        if part.exists():
                            result = json.loads(part.read_text(encoding='utf-8'))
                        else:
                            query = f'[out:json][timeout:25];({selectors.replace(bbox, b)});out geom;'
                            try:
                                response = client.get(endpoint, params={'data': query}, timeout=35)
                                response.raise_for_status()
                                result = response.json()
                                if result.get('remark'):
                                    raise ValueError('Incomplete Overpass tile: ' + result['remark'])
                            except (httpx.HTTPError, ValueError) as exc:
                                if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in {403, 429}:
                                    raise ValueError('Public OSM service restricted/rate-limited the request; stop and retry later') from None
                                failed_tiles.append([row, col])
                                log(f'OSM {role} tile {row+1}/{col+1} unavailable: {type(exc).__name__}')
                                continue
                            write_json(part, result)
                            time.sleep(1)
                        for e in result.get('elements', []):
                            elements[(e['type'], e['id'])] = e
                        tile_stamps.append(result.get('osm3s', {}).get('timestamp_osm_base'))
                        log(f'OSM {role} tile {row+1}/{col+1}: {len(result.get("elements", []))} source objects')
                if not tile_stamps:
                    unavailable(role, 'Public Overpass queries did not complete; no synthetic features substituted.')
                    continue
                data = {'elements': list(elements.values()), 'osm3s': {'timestamp_osm_base': max(s for s in tile_stamps if s)}, '_tile_snapshots': tile_stamps, '_failed_tiles': failed_tiles, '_completed_tiles': 6-len(failed_tiles)}
            else:
                query = f'[out:json][timeout:120];({selectors});out geom;'
                response = client.post(endpoint, data={'data': query}, timeout=150)
                response.raise_for_status()
                data = response.json()
                if data.get('remark'):
                    raise ValueError(f'Overpass returned incomplete results: {data["remark"]}')
            data['_source_endpoint'] = endpoint
            write_json(raw, data)
            time.sleep(1)
        data = json.loads(raw.read_text(encoding='utf-8'))
        features, excluded = [], 0
        for element in data.get('elements', []):
            tags = element.get('tags', {})
            if element['type'] == 'node':
                geom = Point(element['lon'], element['lat'])
            else:
                coords = [(p['lon'], p['lat']) for p in element.get('geometry', []) if 'lon' in p and 'lat' in p]
                if len(coords) < 2:
                    excluded += 1
                    continue
                if role == 'buildings' or (role == 'facilities' and len(coords) >= 4 and coords[0] == coords[-1]):
                    if len(coords) < 4 or coords[0] != coords[-1]:
                        excluded += 1
                        continue
                    geom = Polygon(coords)
                    if not geom.is_valid:
                        geom = make_valid(geom)
                else:
                    geom = LineString(coords)
            if geom.is_empty or not geom.is_valid or not city_index.intersects(geom):
                continue
            if not city_index.contains(geom):
                geom = geom.intersection(city)
            if role in {'roads', 'rivers'} and geom.geom_type not in {'LineString', 'MultiLineString'}:
                excluded += 1
                continue
            if role == 'buildings' and geom.geom_type not in {'Polygon', 'MultiPolygon'}:
                excluded += 1
                continue
            if geom.is_empty or not geom.is_valid:
                excluded += 1
                continue
            osm_id = f'{element["type"]}/{element["id"]}'
            features.append({'type': 'Feature', 'geometry': mapping(geom), 'properties': {**tags, 'name': tags.get('name') or tags.get('ref') or f'{role.title()} · OSM {osm_id}', 'osm_id': osm_id, 'osm_url': 'https://www.openstreetmap.org/' + osm_id, 'attribution': '© OpenStreetMap contributors', 'clipped_to': 'Sourced Ilagan barangay union; see acquisition boundary vintage/quality notes'}})
        if not features:
            unavailable(role, 'No suitable OpenStreetMap features returned for the indicative Ilagan extent; no substitute geometries generated.')
            continue
        snapshot = data.get('osm3s', {}).get('timestamp_osm_base', 'not supplied')
        for offset in range(0, len(features), 20000):
            part = features[offset:offset + 20000]
            suffix = '' if len(features) <= 20000 else f'-part-{offset // 20000 + 1}'
            partial = '-PARTIAL-COVERAGE' if data.get('_failed_tiles') else ''
            prepared = PREPARED / f'ilagan-{role}-OpenStreetMap{partial}{suffix}.geojson'
            write_json(prepared, {'type': 'FeatureCollection', 'features': part})
            record(role + suffix, prepared, f'© OpenStreetMap contributors, ODbL 1.0; https://www.openstreetmap.org/copyright . Overpass public read query {data.get("_source_endpoint", "https://overpass-api.de/api/interpreter")} ; latest tile OSM timestamp {snapshot}. Clipped to sourced Ilagan geography; see boundary vintage and precision notes. Not a surveyed inventory.' + (f' PARTIAL SOURCE COVERAGE: {data["_completed_tiles"]} of 6 geographic queries completed.' if data.get('_failed_tiles') else ''), ['Community-maintained mapping; completeness, currency, and position accuracy vary. Not an authoritative infrastructure inventory.', 'Only tagged OSM nodes/ways are extracted; relation-only multipolygons are not included.', 'Bridge layer selects bridge-tagged highway ways from the road extract; it does not imply a complete surveyed bridge inventory.' if role == 'bridges' else 'Geographic clipping inherits boundary precision; source-query coverage can omit nearby features outside the reference footprint.', f'Unsupported/open/invalid geometry exclusions: {excluded}. Raw OSM response retained.'] + ([f'PARTIAL SOURCE COVERAGE: {data["_completed_tiles"]} of 6 query tiles completed. Failed tiles: {data["_failed_tiles"]}. Do not interpret counts as a complete city inventory.'] if data.get('_failed_tiles') else []) + ([f'Multi-query source timestamps: {sorted(set(s for s in data["_tile_snapshots"] if s))}; snapshots can differ between tiles/providers.'] if data.get('_tile_snapshots') else []), role=role, feature_count=len(part), osm_timestamp=snapshot, tile_timestamps=data.get('_tile_snapshots'), license='ODbL 1.0; ©OpenStreetMap contributors', coverage='partial' if data.get('_failed_tiles') else 'queried reference extent; mapping itself may be incomplete')


def terrain(client):
    import rasterio
    import numpy as np
    from rasterio.merge import merge
    city = city_geometry()
    west, south, east, north = city.bounds
    bounds = (west - .01, south - .01, east + .01, north + .01)
    tiles = []
    urls = []
    for lat in range(math.floor(bounds[1]), math.ceil(bounds[3])):
        for lon in range(math.floor(bounds[0]), math.ceil(bounds[2])):
            tile = f'Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM'
            url = f'https://copernicus-dem-30m.s3.amazonaws.com/{tile}/{tile}.tif'
            urls.append(url)
            tiles.append(download(client, url, RAW / f'{tile}.tif'))
    sources = [rasterio.open(path) for path in tiles]
    try:
        array, transform = merge(sources, bounds=bounds, nodata=-9999, dtype='float32')
        if array.shape[1] * array.shape[2] > 25_000_000:
            raise ValueError('Prepared DEM exceeds the application cell limit')
        prepared = PREPARED / 'ilagan-Copernicus-GLO30-DSM-EGM2008.tif'
        profile = sources[0].profile.copy()
        profile.update(driver='GTiff', width=array.shape[2], height=array.shape[1], count=1, transform=transform, crs='EPSG:4326', dtype='float32', nodata=-9999, compress='deflate', predictor=3, tiled=True)
        with rasterio.open(prepared, 'w', **profile) as dst:
            dst.write(array)
            dst.update_tags(source='Copernicus DEM GLO-30 public / European Union / Airbus', vertical_datum='EGM2008 orthometric heights, EPSG:3855', unit='m', processing='Mosaic/crop only; native samples retained; no geoid correction', reference='https://registry.opendata.aws/copernicus-dem/')
        record('terrain', prepared, 'Copernicus DEM GLO-30 Public, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018; provided under the Copernicus DEM license. https://registry.opendata.aws/copernicus-dem/ . Approximately 30 m DSM, WGS84 horizontal, EGM2008 orthometric heights in meters. Cropped/mosaicked from public COGs; no vertical datum conversion.', ['A DSM includes vegetation/buildings; not a surveyed bare-earth DTM or calibrated hydraulic terrain.', 'EGM2008 orthometric elevations are retained. Not automatically selected as Cesium ellipsoidal terrain because no geoid-height conversion was applied.', 'Rectangular context coverage extends beyond the indicative city boundary; it is not an administrative boundary.'], role='terrain', dimensions=list(array.shape[1:]), source_urls=urls, vertical_datum='EGM2008 / EPSG:3855', license='Copernicus DEM public license; see source registry', bounds=list(bounds))
    finally:
        for src in sources:
            src.close()


def rainfall(client):
    import rasterio
    from rasterio.windows import from_bounds, Window
    from datetime import timedelta
    bounds = city_geometry().bounds
    for day in (1, 2, 3):
        date = f'2025.11.{day:02d}'
        url = f'https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/sat/2025/chirps-v3.0.sat.{date}.tif'
        path = download(client, url, RAW / f'chirps-v3.0.sat.{date}.tif')
        prepared = PREPARED / f'ilagan-CHIRPSv3-sat-rainfall-{date}.tif'
        with rasterio.open(path) as src:
            window = from_bounds(bounds[0] - .05, bounds[1] - .05, bounds[2] + .05, bounds[3] + .05, src.transform)
            window = Window(math.floor(window.col_off), math.floor(window.row_off), math.ceil(window.width) + 1, math.ceil(window.height) + 1)
            arr = src.read(1, window=window)
            profile = src.profile.copy()
            profile.update(driver='GTiff', width=arr.shape[1], height=arr.shape[0], count=1, transform=src.window_transform(window), compress='deflate')
            with rasterio.open(prepared, 'w', **profile) as dst:
                dst.write(arr, 1)
                dst.update_tags(source='UCSB Climate Hazards Center CHIRPS v3 daily final sat', unit='mm', date_utc=date, temporal_method='CHIRPS pentadal totals disaggregated using IMERG Late v07; historical estimates, not station observations or forecast')
        observation = (datetime(2025, 11, day, tzinfo=timezone.utc) + timedelta(days=1)).isoformat()
        record(f'rainfall-{date}', prepared, f'UCSB Climate Hazards Center, CHIRPS v3.0 daily FINAL sat product for {date.replace(".", "-")} UTC calendar day; mm/day accumulation, 0.05-degree grid. {url} . Daily values disaggregate CHIRPS pentadal amounts using NASA IMERG Late V07. Historical gridded estimate, not a local gauge reading or forecast. https://www.chc.ucsb.edu/data/chirps3', ['Approximately 5 km grid; daily timing uses resampled IMERG and is not independent daily station validation.', 'Calendar-day label follows UTC disaggregation; station observation windows contributing to pentadal totals vary. Timestamp marks the nominal interval end.', 'No spatial upsampling or rainfall-to-flood conversion performed.'], role='rainfall', observation_timestamp=observation, source_urls=[url], license='CHIRPS public-domain data; acknowledge UCSB Climate Hazards Center')


def rainfall_summary(client):
    import csv
    import rasterio
    from shapely.geometry import box
    from backend.exposure import geodesic_area
    city = city_geometry()
    manifest = json.loads(provenance_path().read_text(encoding='utf-8'))
    records = []
    for key, entry in sorted(manifest['datasets'].items()):
        if not key.startswith('rainfall-') or entry.get('role') != 'rainfall' or not entry['file'].endswith('.tif'):
            continue
        weighted, weights = 0., 0.
        with rasterio.open(ROOT / entry['file']) as src:
            data = src.read(1, masked=True)
            for row in range(src.height):
                for col in range(src.width):
                    value = data[row, col]
                    import numpy as np
                    if np.ma.is_masked(value) or not np.isfinite(value):
                        continue
                    x0, y0 = src.transform * (col, row)
                    x1, y1 = src.transform * (col + 1, row + 1)
                    intersection = city.intersection(box(x0, y1, x1, y0))
                    area = geodesic_area(intersection)
                    weighted += float(value) * area
                    weights += area
        if weights:
            records.append({'timestamp': entry['observation_timestamp'], 'station_id': 'chirps-ilagan-area-mean-NOT-A-GAUGE', 'name': 'CHIRPS Ilagan area mean (NOT a gauge)', 'rainfall_mm': round(weighted / weights, 5)})
    if not records:
        raise ValueError('No rainfall rasters available for an area mean')
    prepared = PREPARED / 'ilagan-CHIRPSv3-area-mean-NOT-A-GAUGE.csv'
    with prepared.open('w', newline='', encoding='utf-8') as out:
        writer = csv.DictWriter(out, fieldnames=list(records[0]))
        writer.writeheader()
        writer.writerows(records)
    record('rainfall-area-mean', prepared, 'Derived area-weighted mean of the downloaded UCSB CHIRPS v3.0 FINAL sat daily precipitation grids within the sourced NAMRIA/PSA Ilagan boundary. Geodesic cell/polygon overlap weights; original mm per UTC-labeled daily interval. This is a HISTORICAL GRIDDED ESTIMATE, NOT a gauge or physical monitoring station. No station coordinates are assigned. https://www.chc.ucsb.edu/data/chirps3', ['Not a sensor observation or forecast. station_id is an application series key, not a physical station.', 'Daily values inherit CHIRPS pentadal-disaggregation and approximately 5 km spatial-resolution limitations.', 'Area weights depend on the older boundary geometry; no rainfall-to-flood-depth conversion.'], role='rainfall', record_count=len(records), method='Geodesic cell-overlap area-weighted mean', data_kind='derived historical gridded rainfall estimate')


def facility_subset(client):
    manifest = json.loads(provenance_path().read_text(encoding='utf-8'))
    kinds = {'hospital', 'clinic', 'doctors', 'school', 'college', 'university', 'fire_station', 'police', 'townhall', 'community_centre', 'shelter'}
    features = []
    for key, entry in manifest['datasets'].items():
        if entry.get('role') != 'buildings':
            continue
        data = json.loads((ROOT / entry['file']).read_text(encoding='utf-8'))
        for feature in data['features']:
            props = feature['properties']
            if props.get('amenity') in kinds or props.get('healthcare') in {'hospital', 'clinic', 'doctor'}:
                feature['properties'] = {**props, 'facility_selection': 'Explicit OSM amenity/healthcare tag on a mapped building footprint; not inferred from building=school alone', 'coverage': 'Partial: only facility-tagged building footprints in the completed building-source tiles; standalone POI queries unavailable'}
                features.append(feature)
    if not features:
        unavailable('facilities', 'Dedicated public facility queries timed out and no explicit facility-tagged building footprints were present.')
        return
    prepared = PREPARED / 'ilagan-facility-tagged-footprints-OSM-PARTIAL-COVERAGE.geojson'
    write_json(prepared, {'type': 'FeatureCollection', 'features': features})
    record('facilities', prepared, '© OpenStreetMap contributors, ODbL 1.0. Explicit amenity/healthcare-tagged footprints selected from the downloaded Ilagan OSM building data, source snapshot 2026-07-15. https://www.openstreetmap.org/copyright . PARTIAL COVERAGE: standalone facilities/POI queries did not complete; this is not an authoritative or comprehensive critical-facility inventory.', ['PARTIAL COVERAGE: only explicitly facility-tagged building footprints in the completed western-area source tiles. No standalone POIs or relation-only campuses are included.', 'Footprints can represent components of a facility; counts are feature counts, not verified unique operational sites.', 'No facility name, coordinate, or function was invented. OSM tags and geometry are preserved; current operating status is unverified.'], role='facilities', feature_count=len(features), coverage='partial', license='ODbL 1.0; ©OpenStreetMap contributors')
    log('Named facility footprints: ' + ', '.join(f['properties']['name'] for f in features))


def hazard_references(client):
    import re
    url = 'https://cityofilagan.gov.ph/index.php/hazard-map-2/'
    response = client.get(url, timeout=30)
    if response.status_code == 403:
        links = ['https://lipad-fmc.dream.upd.edu.ph/layers/geonode:ph023114000_fh5yr_10m', 'https://lipad-fmc.dream.upd.edu.ph/layers/geonode:pinacanauan_de_ilagan_fh5yr_10m']
        status = 'Direct file retrieval returned HTTP 403; no access bypass attempted. Links were verified from the official city page using the available web reader.'
    else:
        response.raise_for_status()
        (RAW / 'ilagan-official-hazard-source-page.html').write_bytes(response.content)
        links = list(dict.fromkeys(re.findall(r'https?://lipad-fmc\.dream\.upd\.edu\.ph/[^"\s<>]+', response.text)))
        status = 'Official public source page downloaded.'
    write_json(OUT / 'hazard-reference-links.json', {'source': url, 'links': links, 'access_status': status, 'note': 'Official city page links reference 5-, 25-, and 100-year flood hazard products. Web maps/images are not timestamped flood-depth simulation data.'})
    unavailable('inundation', 'No georeferenced hydraulic inundation/depth outputs were available for local ingestion. The official Ilagan page links LiPAD return-period hazard references; the LiPAD geometry/download endpoints timed out. MGB catalog requires an authorization token. No map-image tracing, invented depth, or access-control bypass performed. See hazard-reference-links.json.')
    unavailable('surveyed-lidar-terrain', 'LiPAD high-resolution DTM/LiDAR requires a formal request and coverage verification. Copernicus GLO-30 DSM is supplied separately as coarse reference elevation.')
    unavailable('observed-monitoring', 'Authorized station observations/PAGASA raw station data require a provider request. Downloaded CHIRPS fields are historical gridded estimates, not station readings.')


def import_prepared(client):
    manifest = json.loads(provenance_path().read_text(encoding='utf-8'))
    response = client.get('http://127.0.0.1:8000/api/datasets')
    response.raise_for_status()
    existing = {d['id'] for d in response.json()}
    for key, entry in manifest['datasets'].items():
        if entry.get('dataset_id') in existing:
            log(f'Already imported: {key}')
            continue
        path = ROOT / entry['file']
        replacement = entry.get('supersedes_id') if entry.get('supersedes_id') in existing else None
        with path.open('rb') as stream:
            response = client.request('PUT' if replacement else 'POST', 'http://127.0.0.1:8000/api/datasets' + (f'/{replacement}/replace' if replacement else ''), files={'file': (path.name, stream)}, data={'role': entry['role'], 'source': entry['source'], 'unit': 'mm' if entry['role'] == 'rainfall' else 'm', 'observation_timestamp': entry.get('observation_timestamp', '')})
        response.raise_for_status()
        dataset = response.json()
        # Preserve structured acquisition metadata through the same locked repository.
        from backend.config import DATA_ROOT
        from backend.repository import JsonRepository
        repo = JsonRepository(DATA_ROOT, 'datasets')
        with repo.transaction():
            saved = repo.get(dataset['id'])
            saved.update(warnings=saved['warnings'] + entry['warnings'], provenance=entry)
            repo.put(saved['id'], saved)
        entry['dataset_id'] = dataset['id']
        existing.add(dataset['id'])
        from filelock import FileLock
        with FileLock(str(OUT / '.acquisition.lock')):
            latest = json.loads(provenance_path().read_text(encoding='utf-8'))
            latest['datasets'][key]['dataset_id'] = dataset['id']
            latest['datasets'][key].pop('supersedes_id', None)
            write_json(provenance_path(), latest)
        log(f'Imported {key}: {dataset["id"]}')
    settings = client.get('http://127.0.0.1:8000/api/settings').json()
    settings.update(data_mode='imported', active_scenario='')
    layers = settings.setdefault('layers', {})
    for role in ('boundaries', 'rivers', 'roads', 'bridges', 'buildings', 'facilities', 'terrain', 'rainfall'):
        layers[role] = {'visible': role in {'rivers', 'boundaries', 'bridges', 'facilities'}, 'opacity': .65 if role == 'boundaries' else .8}
    response = client.put('http://127.0.0.1:8000/api/settings', json=settings)
    response.raise_for_status()
    log('Imported-data mode saved. Genuine layers enabled; no synthetic flood scenario substituted.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=['probe', 'catalog', 'original-catalog', 'original-files', 'prepare-original', 'boundary-mirror', 'prepare-mirror', 'query-probe', 'hazard-catalog', 'hazard-references', 'boundaries', 'osm', 'terrain', 'rainfall', 'rainfall-summary', 'facility-subset', 'import'])
    parser.add_argument('--role', choices=['rivers', 'roads', 'bridges', 'buildings', 'facilities'])
    parser.add_argument('--provider', choices=['coffee', 'main', 'vk'], default='coffee')
    args = parser.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)
    PREPARED.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=httpx.Timeout(180, connect=25), follow_redirects=True, headers={'User-Agent': UA}) as client:
        if args.stage == 'osm':
            osm(client, args.role, args.provider)
            return
        {'probe': probe, 'catalog': catalog, 'original-catalog': original_catalog, 'original-files': original_files, 'prepare-original': prepare_original, 'boundary-mirror': boundary_mirror, 'prepare-mirror': prepare_mirror, 'query-probe': query_probe, 'hazard-catalog': hazard_catalog, 'hazard-references': hazard_references, 'boundaries': boundaries, 'osm': osm, 'terrain': terrain, 'rainfall': rainfall, 'rainfall-summary': rainfall_summary, 'facility-subset': facility_subset, 'import': import_prepared}[args.stage](client)


if __name__ == '__main__':
    main()
