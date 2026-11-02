"""Push one reading to an AgosPH backend through the authorized live ingestion endpoint.

Use it to connect a gateway or to run an ingestion drill. A pushed reading is shown as LIVE
because it arrived through authorized ingestion, so --source must say exactly what it is:
owner, instrument and datum, or "INGESTION DRILL" for a typed test value. The bearer token is
read from AGOS_INGEST_TOKEN, never from the command line. The backend validates everything.

Example (PowerShell):
    $env:AGOS_INGEST_TOKEN = '<token configured for the backend>'
    .\\.venv\\Scripts\\python.exe scripts\\push_live_reading.py --station ilagan-bridge `
        --name 'Ilagan bridge gauge' --water-level 3.2 --source 'INGESTION DRILL · typed by CDRRMO staff'
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone


def main(argv=None):
    parser = argparse.ArgumentParser(description='Push one reading to POST /api/monitoring/ingest.')
    parser.add_argument('--url', default='http://127.0.0.1:8000', help='backend base URL')
    parser.add_argument('--station', required=True, help='lowercase station id, e.g. ilagan-bridge')
    parser.add_argument('--name', help='station display name')
    parser.add_argument('--source', required=True, help='provenance: owner, instrument, datum, or INGESTION DRILL')
    parser.add_argument('--water-level', type=float, help='water level in meters')
    parser.add_argument('--rainfall', type=float, help='rainfall accumulation in millimeters')
    parser.add_argument('--interval', type=float, help='rainfall accumulation period in minutes')
    parser.add_argument('--timestamp', help='observation time, ISO 8601 with UTC offset (default: now)')
    parser.add_argument('--longitude', type=float, help='actual station longitude (WGS84)')
    parser.add_argument('--latitude', type=float, help='actual station latitude (WGS84)')
    args = parser.parse_args(argv)
    token = os.environ.get('AGOS_INGEST_TOKEN', '').strip()
    if not token:
        parser.error('set AGOS_INGEST_TOKEN to the token configured for the backend')
    reading = {'station_id': args.station, 'timestamp': args.timestamp or datetime.now(timezone.utc).replace(microsecond=0).isoformat(), 'source': args.source, 'units': {}}
    optional = {'name': args.name, 'water_level_m': args.water_level, 'rainfall_mm': args.rainfall, 'rainfall_interval_minutes': args.interval, 'longitude': args.longitude, 'latitude': args.latitude}
    reading.update({k: v for k, v in optional.items() if v is not None})
    if args.water_level is not None:
        reading['units']['water_level'] = 'm'
    if args.rainfall is not None:
        reading['units']['rainfall'] = 'mm'
    request = urllib.request.Request(args.url.rstrip('/') + '/api/monitoring/ingest', data=json.dumps({'readings': [reading]}).encode(), method='POST',
                                     headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            print(json.dumps(json.load(response), indent=2, ensure_ascii=False))
            return 0
    except urllib.error.HTTPError as error:
        print(f'HTTP {error.code}: {error.read().decode(errors="replace")}', file=sys.stderr)
    except urllib.error.URLError as error:
        print(f'Backend unreachable at {args.url}: {error.reason}', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
