import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import live_settings
from .datasets import now
from .live import LiveStore, instant, validate_live_readings
from .monitoring_adapters import AdapterUnavailable, AuthorizedPushAdapter, MonitoringAdapterRegistry, PagasaAdapter
from .repository import JsonRepository

# Unlocated demonstration sensors and their level offsets; live stations can never use these ids.
DEMO_STATIONS = {'test-a': 0, 'test-b': -.4, 'test-c': -.75}
RANKS = {'unavailable': -1, 'normal': 0, 'watch': 1, 'warning': 2, 'critical': 3}
LABELS = {'demonstration': 'TEST · DEMONSTRATION', 'imported': 'TEST · IMPORTED REPLAY', 'live': 'LIVE · SENSOR THRESHOLD'}
PUSH_CHANNEL = 'POST /api/monitoring/ingest'


def wake(waiter):
    if not waiter.done():
        waiter.set_result(None)


class Changes:
    """Wakes monitoring sockets as soon as readings arrive; the interval still refreshes staleness."""

    def __init__(self, interval=2.0):
        self.interval = interval
        self.waiters: set[asyncio.Future] = set()

    def notify(self):
        # Ingestion runs in the threadpool, so hand the wake-up to each socket's own loop.
        for waiter in list(self.waiters):
            try:
                waiter.get_loop().call_soon_threadsafe(wake, waiter)
            except RuntimeError:
                self.waiters.discard(waiter)

    async def wait(self):
        waiter = asyncio.get_running_loop().create_future()
        self.waiters.add(waiter)
        try:
            await asyncio.wait_for(waiter, self.interval)
        except asyncio.TimeoutError:
            pass
        finally:
            self.waiters.discard(waiter)


class MonitoringService:
    def __init__(self, root: Path, datasets, live=None, clock=None):
        self.config = JsonRepository(root, 'config')
        self.alerts = JsonRepository(root, 'alerts')
        self.datasets = datasets
        self.live = live or live_settings()
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.store = LiveStore(root)
        self.changes = Changes()
        self.adapters = MonitoringAdapterRegistry()
        self.adapters.register(AuthorizedPushAdapter(self.live))
        self.adapters.register(PagasaAdapter())
        try:
            self.config.get('monitoring')
        except KeyError:
            self.config.put('monitoring', {'demo_index': 0, 'imported_index': 0, 'thresholds': {}, 'connections': {}, 'rainfall_scenario': 'steady'})

    def history(self, mode='demonstration', rainfall_scenario='steady'):
        if mode == 'imported':
            records = []
            for dataset in self.datasets.repo.list():
                if dataset['kind'] == 'timeseries' and dataset['mode'] == 'imported' and dataset['role'] in {'monitoring', 'rainfall'}:
                    records.extend([{**r, 'source': dataset['source'], 'dataset_id': dataset['id']} for r in dataset['records']])
            # Multiple rainfall/level uploads can share timestamps: preserve source identities.
            return sorted(records, key=lambda r: (datetime.fromisoformat(r['timestamp']), r['station_id']))
        start = datetime(2026, 1, 15, 0, 0, tzinfo=timezone.utc)
        result = []
        levels = [1.1, 1.35, 1.8, 2.2, 2.7, 3.25, 4.1, 3.6, 2.8, 2.0, 1.5, 1.2]
        rain = [1, 2, 4, 7, 12, 16, 13, 9, 6, 3, 1, 0]
        for index, level in enumerate(levels):
            for station, offset in DEMO_STATIONS.items():
                result.append({'timestamp': (start + timedelta(minutes=index * 15)).isoformat(), 'station_id': station, 'name': f'Test sensor {station[-1].upper()}', 'water_level_m': round(level + offset, 2), 'rainfall_mm': rain[index] * (1.7 if rainfall_scenario == 'intense' else 1), 'source': 'DEMONSTRATION DATA · deterministic replay fixture; station has no geographic location'})
        return result

    def snapshot(self, mode='demonstration'):
        """Replay stations of the selected data mode, plus live stations that only authorized ingestion creates."""
        return {**self.replay(mode), 'live': self.live_snapshot(), 'adapters': self.adapters.capabilities()}

    def replay(self, mode='demonstration'):
        config = self.config.get('monitoring')
        history = self.history(mode, config.get('rainfall_scenario', 'steady'))
        times = sorted(set(r['timestamp'] for r in history), key=datetime.fromisoformat)
        index = min(config['demo_index' if mode == 'demonstration' else 'imported_index'], max(0, len(times) - 1))
        current = times[index] if times else None
        stations = []
        for station_id in sorted(set(r['station_id'] for r in history)):
            rows = [r for r in history if r['station_id'] == station_id]
            available = [r for r in rows if datetime.fromisoformat(r['timestamp']) <= datetime.fromisoformat(current)] if current else []
            latest = available[-1] if available else None
            thresholds = config['thresholds'].get(station_id, {'watch': 2., 'warning': 3., 'critical': 4.})
            connected = config['connections'].get(station_id, True)
            if not connected:
                latest = config.get('frozen_readings', {}).get(station_id, latest)
            severity = self.severity(latest.get('water_level_m'), thresholds) if latest and connected else 'unavailable'
            stations.append({'id': station_id, 'name': rows[0]['name'], 'data_class': 'demonstration' if mode == 'demonstration' else 'replay', 'latest': latest, 'thresholds': thresholds, 'connected': connected, 'severity': severity, 'history': rows, 'longitude': rows[0].get('longitude'), 'latitude': rows[0].get('latitude'), 'source': rows[0]['source']})
        return {'mode': mode, 'label': 'DEMONSTRATION DATA' if mode == 'demonstration' else 'IMPORTED DATA · HISTORICAL REPLAY', 'index': index, 'steps': len(times), 'timestamp': current, 'stations': stations, 'rainfall_scenario': config.get('rainfall_scenario', 'steady'), 'updated_at': now()}

    def live_snapshot(self):
        current = self.clock()
        thresholds = self.config.get('monitoring')['thresholds']
        problem = self.live.problem
        return {'ingest': {'enabled': not problem, 'endpoint': '/api/monitoring/ingest', 'detail': problem or 'Accepting authorized readings (bearer token).'}, 'stale_after_minutes': self.live.stale_minutes, 'unavailable_after_minutes': self.live.unavailable_minutes, 'evaluated_at': current.isoformat(), 'stations': [self.live_station(s, thresholds.get(s['id']), current) for s in self.store.stations()]}

    def freshness(self, age_seconds):
        """Freshness follows the observation time, so a late backfill never looks live."""
        if age_seconds <= self.live.stale_minutes * 60:
            return 'live'
        return 'stale' if age_seconds <= self.live.unavailable_minutes * 60 else 'unavailable'

    def live_station(self, state, thresholds, current):
        latest = state['latest']
        age = (current - instant(latest)).total_seconds()
        freshness = self.freshness(age)
        # Live stations get no default thresholds: alerts need station-specific values saved by an operator.
        severity = self.severity(latest.get('water_level_m'), thresholds) if thresholds and freshness != 'unavailable' else 'unavailable'
        horizon = instant(latest) - timedelta(hours=24)
        return {'id': state['id'], 'name': state['name'], 'data_class': 'live', 'freshness': freshness, 'latest': latest, 'received_at': latest['received_at'], 'age_seconds': age, 'thresholds': thresholds, 'connected': freshness == 'live', 'severity': severity, 'history': [r for r in state['readings'] if instant(r) >= horizon][-500:], 'longitude': state['longitude'], 'latitude': state['latitude'], 'source': state['source']}

    def ingest(self, payload, channel=PUSH_CHANNEL, client=None):
        """Single entry point for live readings, pushed or polled: validate all, persist, then evaluate thresholds."""
        current = self.clock()
        records = validate_live_readings(payload, current, DEMO_STATIONS)
        # Read thresholds before taking the live lock: step() holds the config lock while reading stations.
        thresholds = self.config.get('monitoring')['thresholds']
        received = current.isoformat()
        accepted, duplicates, crossings = [], 0, []
        with self.store.repo.transaction():
            for station_id in dict.fromkeys(r['station_id'] for r in records):
                state = self.store.get(station_id)
                known = {instant(r) for r in state['readings']}
                for record in sorted((r for r in records if r['station_id'] == station_id), key=instant):
                    if instant(record) in known:
                        duplicates += 1
                        continue
                    record = {**record, 'received_at': received, 'channel': channel}
                    known.add(instant(record))
                    state['readings'].append(record)
                    accepted.append(record)
                    previous = state['latest']
                    if previous is None or instant(record) > instant(previous):
                        state.update(latest=record, name=record['name'], source=record['source'])
                        if 'longitude' in record:
                            state.update(longitude=record['longitude'], latitude=record['latitude'])
                        crossings.append(({**state}, previous))
                if any(r['station_id'] == station_id for r in accepted):
                    state['readings'].sort(key=instant)
                    self.store.save(state)
            if accepted:
                self.store.receipt({'received_at': received, 'channel': channel, 'client': client, 'readings': accepted})
            alerts = [alert for station, previous in crossings if (alert := self.live_alert(station, previous, thresholds.get(station['id']), current))]
        if accepted:
            self.changes.notify()
        return {'accepted': len(accepted), 'duplicates': duplicates, 'stations': sorted({r['station_id'] for r in accepted}), 'alerts': alerts, 'received_at': received}

    def live_alert(self, station, previous, thresholds, current):
        """A fresh reading that becomes the newest observation alerts when it crosses a configured threshold upward."""
        latest = station['latest']
        stale_after = timedelta(minutes=self.live.stale_minutes)
        if not thresholds or latest.get('water_level_m') is None or current - instant(latest) > stale_after:
            return None
        severity = self.severity(latest['water_level_m'], thresholds)
        # After a data gap the operator had no current picture, so the first fresh reading counts as a crossing.
        prior = 0
        if previous and previous.get('water_level_m') is not None and instant(latest) - instant(previous) <= stale_after:
            prior = max(0, RANKS[self.severity(previous['water_level_m'], thresholds)])
        if RANKS[severity] <= prior or self.unresolved(station['id'], severity, 'live'):
            return None
        return self.generate({**station, 'severity': severity, 'thresholds': thresholds}, 'live')

    def poll(self, name):
        """Pull adapters share the push path's validation, provenance, and alerting."""
        adapter = self.adapters.get(name)
        capability = adapter.capability()
        if not capability['enabled']:
            raise AdapterUnavailable(capability['detail'])
        return self.ingest({'readings': adapter.poll()}, channel=adapter.name)

    @staticmethod
    def severity(value, thresholds):
        if value is None:
            return 'unavailable'
        for level in ('critical', 'warning', 'watch'):
            if value >= thresholds[level]:
                return level
        return 'normal'

    def step(self, mode, rainfall_scenario='steady', reset=False):
        with self.config.transaction():
            previous = self.replay(mode)
            config = self.config.get('monitoring')
            key = 'demo_index' if mode == 'demonstration' else 'imported_index'
            config[key] = 0 if reset else min(config[key] + 1, max(previous['steps'] - 1, 0))
            config['rainfall_scenario'] = rainfall_scenario
            self.config.put('monitoring', config)
            current = self.replay(mode)
            if not reset:
                old = {s['id']: s for s in previous['stations']}
                for station in current['stations']:
                    prev = old.get(station['id'])
                    if station['connected'] and station['latest'] and prev and station['latest']['timestamp'] != (prev['latest'] or {}).get('timestamp') and RANKS[station['severity']] > max(0, RANKS[prev['severity']]):
                        self.generate(station, mode)
        return self.snapshot(mode)

    def unresolved(self, station_id, severity, mode):
        return [a for a in self.alerts.list() if a['station_id'] == station_id and a['severity'] == severity and a['status'] != 'resolved' and a['mode'] == mode]

    def generate(self, station, mode='demonstration', force=False):
        with self.alerts.transaction():
            active = self.unresolved(station['id'], station['severity'], mode)
            if active and not force:
                return active[0]
            identifier = uuid.uuid4().hex
            latest = station['latest'] or {}
            severity = station['severity'] if station['severity'] in {'watch', 'warning', 'critical'} else 'watch'
            alert = {'id': identifier, 'station_id': station['id'], 'station_name': station['name'], 'severity': severity, 'status': 'active', 'mode': mode, 'label': LABELS[mode], 'message': f"{station['name']} threshold exercise. Local test notification only.", 'water_level_m': latest.get('water_level_m'), 'measurement_timestamp': latest.get('timestamp'), 'created_at': now(), 'updated_at': now(), 'source': station['source']}
            if mode == 'live':
                threshold = station['thresholds'][severity]
                alert.update(message=f"{station['name']}: water level {latest['water_level_m']:.2f} m reached the {severity} threshold ({threshold:.2f} m). Authorized live reading; local dashboard notification only. No public warning is sent.", threshold_m=threshold, received_at=latest['received_at'], channel=latest['channel'])
            return self.alerts.put(identifier, alert)

    def thresholds(self, station_id, value):
        with self.config.transaction():
            config = self.config.get('monitoring')
            config['thresholds'][station_id] = value
            self.config.put('monitoring', config)
        return value

    def connection(self, station_id, connected):
        with self.config.transaction():
            config = self.config.get('monitoring')
            station = next((s for s in self.replay('demonstration')['stations'] + self.replay('imported')['stations'] if s['id'] == station_id), None)
            if station is None:
                raise ValueError('Test disconnects apply only to replay stations; live availability follows authorized ingestion.')
            if not connected:
                config.setdefault('frozen_readings', {})[station_id] = station['latest']
            config['connections'][station_id] = connected
            self.config.put('monitoring', config)
        return {'station_id': station_id, 'connected': connected}
