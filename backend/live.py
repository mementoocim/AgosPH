"""Authorized live readings: strict validation, bounded per-station storage, append-only receipts."""
import json
import math
import re
from datetime import datetime, timedelta
from pathlib import Path

from .datasets import timestamp
from .repository import JsonRepository

MAX_READINGS = 500
FIELDS = {'station_id', 'name', 'timestamp', 'water_level_m', 'rainfall_mm', 'rainfall_interval_minutes', 'units', 'longitude', 'latitude', 'source'}
# Field -> (units key, the only accepted unit, plausible range). AgosPH never converts units.
MEASUREMENTS = {'water_level_m': ('water_level', 'm', -100, 1000), 'rainfall_mm': ('rainfall', 'mm', 0, 1000)}
UNITS = {key: unit for key, unit, _, _ in MEASUREMENTS.values()}
# Lowercase only: station files must not collide on case-insensitive filesystems.
STATION_ID = re.compile(r'[a-z0-9][a-z0-9_-]{0,63}')
FUTURE_TOLERANCE = timedelta(minutes=5)
MAX_AGE = timedelta(days=30)
WINDOW = timedelta(days=7)
WINDOW_READINGS = 5000


def instant(record):
    return datetime.fromisoformat(record['timestamp'])


def number(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{name} must be a finite JSON number from {low} to {high}')
    return float(value)


def validate_live_readings(payload, now: datetime, reserved=()):
    """Every reading is checked before anything is stored; one invalid reading rejects the batch."""
    if not isinstance(payload, dict) or set(payload) != {'readings'} or not isinstance(payload['readings'], list):
        raise ValueError('Expected a JSON object {"readings": [...]} with no other fields')
    if not 1 <= len(payload['readings']) <= MAX_READINGS:
        raise ValueError(f'Send 1–{MAX_READINGS} readings per request')
    output, seen = [], set()
    for index, row in enumerate(payload['readings'], 1):
        try:
            record = validate_reading(row, now, reserved)
            key = (record['station_id'], instant(record))
            if key in seen:
                raise ValueError('duplicate station/timestamp in this batch')
        except ValueError as error:
            raise ValueError(f'Reading {index}: {error}') from None
        seen.add(key)
        output.append(record)
    return output


def validate_reading(row, now, reserved):
    if not isinstance(row, dict):
        raise ValueError('each reading must be a JSON object')
    if unknown := set(row) - FIELDS:
        raise ValueError('unsupported field(s): ' + ', '.join(sorted(unknown)))
    station = row.get('station_id')
    if not isinstance(station, str) or not STATION_ID.fullmatch(station):
        raise ValueError('station_id must be 1–64 lowercase letters, digits, "-" or "_", starting with a letter or digit')
    if station in reserved:
        raise ValueError(f'station_id {station} is reserved for demonstration fixtures')
    if not isinstance(row.get('timestamp'), str):
        raise ValueError('timestamp must be an ISO 8601 string with a UTC offset')
    observed = timestamp(row['timestamp'])
    if datetime.fromisoformat(observed) > now + FUTURE_TOLERANCE:
        raise ValueError('timestamp is more than 5 minutes in the future; check the logger clock')
    if datetime.fromisoformat(observed) < now - MAX_AGE:
        raise ValueError('timestamp is older than 30 days; import historical records through Data Center instead')
    source, name = row.get('source'), row.get('name', station)
    if not isinstance(source, str) or not source.strip():
        raise ValueError('source is required: owner, instrument, and datum of the reading')
    if not isinstance(name, str) or not name.strip():
        raise ValueError('name must be non-empty text when supplied')
    units = row.get('units')
    if not isinstance(units, dict) or not units:
        raise ValueError('units must declare every supplied measurement, e.g. {"water_level": "m"}')
    for key, unit in units.items():
        if key not in UNITS:
            raise ValueError(f'unsupported unit declaration {key!r}')
        if unit != UNITS[key]:
            raise ValueError(f'{key} must be sent in {UNITS[key]}; convert {unit!r} values before sending')
    record = {'station_id': station, 'name': name.strip()[:150], 'timestamp': observed, 'source': source.strip()[:500], 'units': {}}
    for field, (key, unit, low, high) in MEASUREMENTS.items():
        if field in row:
            if units.get(key) != unit:
                raise ValueError(f'declare units.{key} = "{unit}" for {field}')
            record[field] = number(row[field], field, low, high)
            record['units'][key] = unit
    if not any(field in record for field in MEASUREMENTS):
        raise ValueError('supply water_level_m and/or rainfall_mm')
    if 'rainfall_mm' in record:
        if 'rainfall_interval_minutes' not in row:
            raise ValueError('rainfall_mm requires rainfall_interval_minutes, the accumulation period')
        record['rainfall_interval_minutes'] = number(row['rainfall_interval_minutes'], 'rainfall_interval_minutes', 1, 1440)
    elif 'rainfall_interval_minutes' in row:
        raise ValueError('rainfall_interval_minutes requires rainfall_mm')
    if 'longitude' in row or 'latitude' in row:
        if 'longitude' not in row or 'latitude' not in row:
            raise ValueError('supply both longitude and latitude, or neither')
        record.update(longitude=number(row['longitude'], 'longitude', -180, 180), latitude=number(row['latitude'], 'latitude', -90, 90))
    return record


class LiveStore:
    """One JSON file per station holds a bounded recent window; every accepted batch is also appended to a daily receipt log."""

    def __init__(self, root: Path):
        self.repo = JsonRepository(root, 'live')
        self.receipts = self.repo.directory / 'receipts'
        self.receipts.mkdir(exist_ok=True)
        # Sockets ask for a snapshot every few seconds; reread a station file only when it changes.
        self._cache: dict[Path, tuple] = {}

    def stations(self):
        result = []
        with self.repo.lock:
            for path in sorted(self.repo.directory.glob('station-*.json')):
                stat = path.stat()
                version = (stat.st_mtime_ns, stat.st_size)
                cached = self._cache.get(path)
                if not cached or cached[0] != version:
                    cached = self._cache[path] = (version, json.loads(path.read_text(encoding='utf-8')))
                result.append(cached[1])
        return result

    def get(self, station_id):
        try:
            return self.repo.get(f'station-{station_id}')
        except KeyError:
            return {'id': station_id, 'readings': [], 'latest': None, 'longitude': None, 'latitude': None}

    def save(self, station):
        newest = instant(station['readings'][-1])
        station['readings'] = [r for r in station['readings'] if instant(r) >= newest - WINDOW][-WINDOW_READINGS:]
        self.repo.put(f"station-{station['id']}", station)

    def receipt(self, entry):
        with (self.receipts / f"{entry['received_at'][:10]}.jsonl").open('a', encoding='utf-8') as out:
            out.write(json.dumps(entry, allow_nan=False) + '\n')
