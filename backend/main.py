import json
import logging
import tempfile
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import numpy as np
import rasterio
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field
from rasterio.errors import RasterioError
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling
from starlette.concurrency import run_in_threadpool

from .config import DATA_ROOT, MAX_UPLOAD_BYTES, initialize
from .contracts import ScenarioInput, Thresholds, AlertUpdate, ReplayStep, ConnectionInput, SettingsInput, AlertExercise, Metric, Mode
from .datasets import DatasetService, now
from .contracts import IncidentInput, IncidentSeverity, IncidentStatus, IncidentUpdate
from .exposure import ExposureService
from .incidents import COLUMNS as INCIDENT_COLUMNS, IncidentService
from .ingest import ingest_router
from .monitoring import MonitoringService
from .reports import csv_bytes, pdf_report
from .repository import JsonRepository
from .simulations import ScenarioService


class Rename(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class PdfInput(BaseModel):
    scenario_id: str
    frame: int = Field(default=0, ge=0)
    screenshot: str | None = Field(default=None, max_length=12_000_000)


def create_app(root: Path = DATA_ROOT, seed=True):
    root = root.resolve()
    initialize(root)
    datasets = DatasetService(root)
    scenarios = ScenarioService(root, datasets)
    monitoring = MonitoringService(root, datasets)
    exposure = ExposureService(scenarios, datasets)
    incidents = IncidentService(root, datasets)
    config = JsonRepository(root, 'config')

    def seed_terrain():
        try:
            scenarios.seed_terrain_demo()
        except Exception:
            logging.exception('Terrain demonstration generation failed; synthetic test grids remain available')

    @asynccontextmanager
    async def lifespan(app):
        if seed:
            await run_in_threadpool(scenarios.seed_demo)
            # Derived from imported terrain; can take a while, so it never blocks startup.
            threading.Thread(target=seed_terrain, name='terrain-demo', daemon=True).start()
        yield

    app = FastAPI(title='AgosPH local geospatial workbench', version='1.0.0', lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', 'testserver', '[::1]'])
    app.state.datasets, app.state.scenarios, app.state.monitoring = datasets, scenarios, monitoring
    app.include_router(ingest_router(monitoring))

    @app.middleware('http')
    async def local_writes(request: Request, call_next):
        origin = request.headers.get('origin')
        if request.method not in {'GET', 'HEAD', 'OPTIONS'} and origin:
            from urllib.parse import urlparse
            if urlparse(origin).hostname not in {'127.0.0.1', 'localhost', '::1'}:
                return JSONResponse({'detail': 'Local application writes require a localhost origin'}, status_code=403)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.exception_handler(KeyError)
    async def missing(request, exc):
        return JSONResponse({'detail': f'Required record or field unavailable: {str(exc)[:150]}'}, status_code=404)

    @app.exception_handler(ValueError)
    async def invalid(request, exc):
        return JSONResponse({'detail': str(exc)[:3000]}, status_code=422)

    @app.exception_handler(RasterioError)
    async def raster_error(request, exc):
        return JSONResponse({'detail': 'Unable to read raster. Supply a valid, georeferenced single-band GeoTIFF.'}, status_code=422)

    @app.exception_handler(Exception)
    async def unexpected(request, exc):
        logging.exception('AgosPH local service error')
        return JSONResponse({'detail': 'Local processing failed. Check backend logs; no operational data was substituted.'}, status_code=500)

    @app.get('/api/health')
    def health():
        return {'status': 'ok', 'storage': 'local filesystem', 'data_directory': str(root), 'database': False, 'timestamp': now(), 'capabilities': {'geotiff': True, 'geopandas': True, 'hdf_direct': False, 'operational_monitoring': False, 'live_ingest': not monitoring.live.problem, 'hydraulic_solver': False}}

    @app.get('/api/models/adapters')
    def model_adapters():
        from .adapters import registry
        return {'hydraulic': registry.capabilities(), 'hydrologic': {'name': 'HEC-HMS exported discharge CSV', 'fields': ['timestamp', 'station_id', 'discharge_m3s'], 'model_execution': False}, 'monitoring': monitoring.adapters.capabilities()}

    @app.post('/api/demo/load')
    def load_demo():
        scenarios.seed_demo(force=True)
        return {'status': 'ready', 'scenarios': scenarios.repo.list()}

    @app.post('/api/demo/terrain')
    def load_terrain_demo():
        return {'status': 'ready', 'scenarios': scenarios.seed_terrain_demo(force=True)}

    @app.get('/api/settings')
    def settings():
        try:
            return {**SettingsInput().model_dump(), **config.get('settings')}
        except KeyError:
            return SettingsInput().model_dump()

    @app.put('/api/settings')
    def save_settings(value: SettingsInput):
        if value.terrain_dataset:
            dataset = datasets.repo.get(value.terrain_dataset)
            if dataset['role'] != 'terrain':
                raise ValueError('Terrain provider requires an imported DEM')
        return config.put('settings', value.model_dump())

    @app.get('/api/datasets')
    def list_datasets():
        # Time-series payloads are fetched on inspection, not on every index refresh.
        return [{k: v for k, v in d.items() if k != 'records'} for d in datasets.repo.list()]

    @app.get('/api/search')
    def search(q: str = Query(default='', max_length=150), mode: Mode = 'imported'):
        # Imported reference geography is searchable in both modes; demo layers only in demo mode.
        return datasets.search(q, {'imported', mode})

    async def receive(file, role, source, unit, observation_timestamp=''):
        descriptor, name = tempfile.mkstemp(dir=root / 'uploads', suffix=Path(file.filename or '').suffix[:10])
        import os
        total = 0
        temp = Path(name)
        try:
            with os.fdopen(descriptor, 'wb') as out:
                while chunk := await file.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, 'File exceeds the 64 MiB local upload limit')
                    out.write(chunk)
            if not total:
                raise ValueError('Upload is empty')
            return await run_in_threadpool(datasets.ingest, temp, file.filename or 'upload', role, source, 'imported', unit, observation_timestamp)
        finally:
            temp.unlink(missing_ok=True)
            await file.close()

    @app.post('/api/datasets', status_code=201)
    async def import_dataset(file: UploadFile = File(...), role: str = Form(...), source: str = Form(...), unit: str = Form(''), observation_timestamp: str = Form('')):
        return await receive(file, role, source, unit, observation_timestamp)

    @app.get('/api/datasets/{identifier}')
    def dataset(identifier: str):
        return datasets.repo.get(identifier)

    @app.get('/api/datasets/{identifier}/geojson')
    def vector(identifier: str):
        d = datasets.repo.get(identifier)
        if d['kind'] != 'vector':
            raise ValueError('Dataset is not a vector layer')
        return json.loads(datasets.path(d).read_text(encoding='utf-8-sig'))

    @app.get('/api/datasets/{identifier}/image.png')
    def raster_image(identifier: str):
        d = datasets.repo.get(identifier)
        if d['kind'] != 'raster':
            raise ValueError('Dataset is not a raster')
        return Response(datasets.image(d), media_type='image/png')

    @app.get('/api/datasets/{identifier}/sample')
    def raster_sample(identifier: str, longitude: float = Query(ge=-180, le=180), latitude: float = Query(ge=-90, le=90)):
        d = datasets.repo.get(identifier)
        if d['kind'] != 'raster':
            raise ValueError('Dataset is not a raster')
        return {'value': datasets.sample(d, longitude, latitude), 'unit': d.get('unit'), 'source': d['source'], 'mode': d['mode']}

    @app.delete('/api/datasets/{identifier}')
    def remove_dataset(identifier: str):
        for scenario in scenarios.repo.list():
            if any(identifier == f.get(key) for f in scenario['frames'] for key in ('depth', 'velocity', 'direction', 'wse')):
                raise HTTPException(409, 'Dataset is referenced by a scenario. Remove that scenario first.')
        if settings().get('terrain_dataset') == identifier:
            raise HTTPException(409, 'Dataset is the active terrain provider. Unselect it in Settings first.')
        datasets.delete(datasets.repo.get(identifier))
        return {'deleted': identifier}

    @app.put('/api/datasets/{identifier}/replace')
    async def replace_dataset(identifier: str, file: UploadFile = File(...), source: str = Form(...), unit: str = Form('')):
        old = datasets.repo.get(identifier)
        if old['mode'] == 'demonstration':
            raise ValueError('Demonstration fixtures cannot be relabeled through replacement; import a separate dataset')
        new = await receive(file, old['role'], source, unit, old.get('observation_timestamp', ''))
        if old['kind'] != new['kind'] or (old['kind'] == 'raster' and any(old[k] != new[k] for k in ('crs', 'width', 'height', 'transform'))):
            datasets.repo.delete(new['id'])
            datasets.path(new).unlink(missing_ok=True)
            raise ValueError('Replacement must preserve type and raster alignment. Import a new dataset for a different grid.')
        datasets.repo.put(identifier, {**new, 'id': identifier, 'replaced_at': now()})
        datasets.repo.delete(new['id'])
        datasets.path(old).unlink(missing_ok=True)
        datasets.evict(identifier)
        return datasets.repo.get(identifier)

    @app.get('/api/terrain/{identifier}/{level}/{x}/{y}')
    def terrain_tile(identifier: str, level: int, x: int, y: int):
        # Cesium keeps refining while the camera nears the ground; deep levels interpolate the DEM.
        if not 0 <= level <= 24 or not 0 <= x < 2 ** (level + 1) or not 0 <= y < 2 ** level:
            raise ValueError('Invalid geographic terrain tile')
        d = datasets.repo.get(identifier)
        if d['role'] != 'terrain' or d['mode'] != 'imported':
            raise ValueError('Terrain requires a genuine imported DEM')
        west = -180 + 360 * x / 2 ** (level + 1)
        east = -180 + 360 * (x + 1) / 2 ** (level + 1)
        north = 90 - 180 * y / 2 ** level
        south = 90 - 180 * (y + 1) / 2 ** level
        # Heightmap samples lie on tile edges, not pixel centers.
        dx, dy = (east - west) / 64, (north - south) / 64
        tile_transform = from_bounds(west - dx / 2, south - dy / 2, east + dx / 2, north + dy / 2, 65, 65)
        heights = np.full((65, 65), np.nan, dtype='float32')
        with rasterio.open(datasets.path(d)) as src:
            reproject(rasterio.band(src, 1), heights, src_transform=src.transform, src_crs=src.crs, src_nodata=src.nodata, dst_transform=tile_transform, dst_crs='EPSG:4326', dst_nodata=np.nan, resampling=Resampling.bilinear)
        return {'heights': np.nan_to_num(heights, nan=0.).ravel().tolist(), 'valid_samples': int(np.isfinite(heights).sum()), 'warning': 'Zero/ellipsoid fallback outside DEM coverage; those elevations are unavailable.'}

    @app.get('/api/scenarios')
    def list_scenarios():
        return scenarios.repo.list()

    @app.post('/api/scenarios', status_code=201)
    def create_scenario(value: ScenarioInput):
        return scenarios.create(value)

    @app.get('/api/scenarios/{identifier}')
    def get_scenario(identifier: str):
        return scenarios.repo.get(identifier)

    @app.put('/api/scenarios/{identifier}')
    def update_scenario(identifier: str, value: ScenarioInput):
        return scenarios.update(identifier, value)

    @app.patch('/api/scenarios/{identifier}/rename')
    def rename_scenario(identifier: str, value: Rename):
        data = scenarios.export(identifier)
        data['name'] = value.name
        return scenarios.update(identifier, ScenarioInput(**data))

    @app.post('/api/scenarios/{identifier}/duplicate', status_code=201)
    def duplicate_scenario(identifier: str):
        data = scenarios.export(identifier)
        data['name'] = (data['name'][:90] + ' · copy')
        return scenarios.create(ScenarioInput(**data))

    @app.get('/api/scenarios/{identifier}/export')
    def export_scenario(identifier: str):
        return Response(json.dumps(scenarios.export(identifier), indent=2), media_type='application/json', headers={'Content-Disposition': f'attachment; filename="scenario-{identifier}.json"'})

    @app.delete('/api/scenarios/{identifier}')
    def delete_scenario(identifier: str):
        scenarios.repo.delete(identifier)
        return {'deleted': identifier}

    @app.get('/api/scenarios/{identifier}/surface.png')
    def surface(identifier: str, frame: int = Query(default=0, ge=0), metric: Metric = 'depth', smooth: bool = False, v: str = Query(default='', max_length=64)):
        # `v` is the scenario version; a versioned URL never changes content, so browsers may cache it.
        headers = {'Cache-Control': 'private, max-age=86400'} if v else {}
        return Response(scenarios.surface_png(identifier, frame, metric, smooth), media_type='image/png', headers=headers)

    @app.get('/api/scenarios/{identifier}/inspect')
    def inspect(identifier: str, frame: int = Query(default=0, ge=0), longitude: float = Query(ge=-180, le=180), latitude: float = Query(ge=-90, le=90)):
        return scenarios.inspect(identifier, frame, longitude, latitude)

    @app.get('/api/compare')
    def compare(first: str, second: str):
        return scenarios.compatible(first, second)

    @app.get('/api/exposure/{identifier}')
    def calculate_exposure(identifier: str, frame: int = Query(default=0, ge=0)):
        return exposure.calculate(identifier, frame)

    @app.get('/api/monitoring')
    def get_monitoring(mode: Mode = 'demonstration'):
        return monitoring.snapshot(mode)

    @app.post('/api/monitoring/step')
    def step_monitoring(value: ReplayStep):
        return monitoring.step(value.mode, value.rainfall_scenario)

    @app.post('/api/monitoring/reset')
    def reset_monitoring(value: ReplayStep):
        return monitoring.step(value.mode, value.rainfall_scenario, reset=True)

    @app.put('/api/monitoring/{station_id}/thresholds')
    def update_thresholds(station_id: str, value: Thresholds):
        return monitoring.thresholds(station_id, value.model_dump())

    @app.put('/api/monitoring/connection')
    def update_connection(value: ConnectionInput):
        return monitoring.connection(value.station_id, value.connected)

    @app.websocket('/api/ws/monitoring')
    async def monitor_socket(socket: WebSocket):
        from urllib.parse import urlparse
        origin = socket.headers.get('origin')
        if origin and urlparse(origin).hostname not in {'localhost', '127.0.0.1', '::1'}:
            await socket.close(code=1008)
            return
        await socket.accept()
        mode = socket.query_params.get('mode', 'demonstration')
        if mode not in {'demonstration', 'imported'}:
            await socket.close(code=1008)
            return
        try:
            while True:
                snapshot = await run_in_threadpool(monitoring.snapshot, mode)
                alerts = await run_in_threadpool(monitoring.alerts.list)
                await socket.send_json({'type': 'snapshot', 'monitoring': snapshot, 'alerts': alerts})
                await monitoring.changes.wait()
        except (WebSocketDisconnect, RuntimeError):
            pass

    @app.get('/api/alerts')
    def list_alerts(status: str | None = None, severity: str | None = None):
        return [a for a in monitoring.alerts.list() if (not status or a['status'] == status) and (not severity or a['severity'] == severity)]

    @app.patch('/api/alerts/{identifier}')
    def change_alert(identifier: str, value: AlertUpdate):
        with monitoring.alerts.transaction():
            alert = monitoring.alerts.get(identifier)
            if alert['status'] == 'resolved':
                raise ValueError('Resolved alerts cannot be reopened or acknowledged')
            alert.update(status=value.status, updated_at=now())
            return monitoring.alerts.put(identifier, alert)

    @app.post('/api/alerts/test')
    def test_alert(value: AlertExercise | None = None):
        mode = value.mode if value else 'demonstration'
        stations = monitoring.snapshot(mode)['stations']
        if not stations:
            raise ValueError('No monitoring stations are available in this data mode. Import monitoring data first.')
        station = next((s for s in stations if (s['latest'] or {}).get('water_level_m') is not None), stations[0])
        return monitoring.generate(station, mode, force=True)

    @app.get('/api/barangays')
    def barangays(longitude: float | None = Query(default=None, ge=-180, le=180), latitude: float | None = Query(default=None, ge=-90, le=90)):
        return incidents.barangays(longitude, latitude)

    @app.get('/api/incidents')
    def list_incidents(status: IncidentStatus | None = None, severity: IncidentSeverity | None = None, barangay: str | None = Query(default=None, max_length=100), mode: Mode | None = None):
        return incidents.list(status, severity, barangay, mode)

    @app.post('/api/incidents', status_code=201)
    def create_incident(value: IncidentInput):
        return incidents.create(value)

    @app.put('/api/incidents/{identifier}')
    def edit_incident(identifier: str, value: IncidentInput):
        return incidents.update(identifier, value)

    @app.patch('/api/incidents/{identifier}')
    def change_incident(identifier: str, value: IncidentUpdate):
        return incidents.transition(identifier, value.status)

    @app.delete('/api/incidents/{identifier}')
    def delete_incident(identifier: str):
        incidents.repo.delete(identifier)
        return {'deleted': identifier}

    @app.post('/api/reports/pdf')
    def report_pdf(value: PdfInput):
        scenario = scenarios.repo.get(value.scenario_id)
        result = exposure.calculate(value.scenario_id, value.frame) if scenario['frames'] else None
        raw = pdf_report(scenario, result, monitoring.snapshot(scenario['mode']), monitoring.alerts.list(), value.screenshot, incidents.list(mode=scenario['mode']))
        path = root / 'reports' / f'report-{uuid.uuid4().hex}.pdf'
        path.write_bytes(raw)
        return Response(raw, media_type='application/pdf', headers={'Content-Disposition': 'attachment; filename="AgosPH-scenario-report.pdf"'})

    @app.get('/api/reports/csv')
    def report_csv(kind: Literal['monitoring', 'alerts', 'exposure', 'metadata', 'incidents'] = 'monitoring', scenario_id: str | None = None, frame: int = Query(default=0, ge=0), mode: Mode = 'demonstration'):
        if kind == 'alerts':
            rows = monitoring.alerts.list()
        elif kind == 'incidents':
            # Exercise records and operator reports are never exported together.
            rows = incidents.list(mode=mode)
        elif kind == 'monitoring':
            rows = [{**row, 'mode': mode, 'label': 'DEMONSTRATION DATA' if mode == 'demonstration' else 'IMPORTED REPLAY'} for row in monitoring.history(mode)]
        elif scenario_id and kind == 'exposure':
            result = exposure.calculate(scenario_id, frame)
            rows = [{**row, 'scenario': result['scenario_name'], 'source': result['source'], 'timestamp': result['timestamp'], 'mode': result['mode']} for row in result['features']]
            if not rows:
                rows = [{'scenario': result['scenario_name'], 'source': result['source'], 'timestamp': result['timestamp'], 'mode': result['mode'], 'inundation_area_m2': result['inundation_area_m2'], 'maximum_depth_m': result['maximum_depth_m'], 'unavailable': result['unavailable']}]
        elif scenario_id:
            scenario = scenarios.repo.get(scenario_id)
            rows = [{**f, 'scenario': scenario['name'], 'source': scenario['source'], 'mode': scenario['mode'], 'validation': scenario['validation_label']} for f in scenario['frames']]
        else:
            raise ValueError('Scenario is required for exposure/metadata export')
        raw = csv_bytes(rows, INCIDENT_COLUMNS if kind == 'incidents' else ())
        (root / 'reports' / f'{kind}-{uuid.uuid4().hex}.csv').write_bytes(raw)
        return Response(raw, media_type='text/csv', headers={'Content-Disposition': f'attachment; filename="AgosPH-{kind}.csv"'})

    @app.get('/api/reports/geojson')
    def report_geojson(scenario_id: str, frame: int = Query(default=0, ge=0)):
        data = exposure.extent_geojson(scenario_id, frame)
        (root / 'reports' / f'extent-{uuid.uuid4().hex}.geojson').write_text(json.dumps(data), encoding='utf-8')
        return Response(json.dumps(data), media_type='application/geo+json', headers={'Content-Disposition': 'attachment; filename="AgosPH-inundation.geojson"'})

    return app


app = create_app()
