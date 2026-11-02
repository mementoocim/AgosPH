import math
import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = Path(os.environ.get('AGOS_DATA_DIR', ROOT / 'data')).resolve()
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_RASTER_CELLS = 25_000_000
DISCLAIMER = 'NOT FOR OPERATIONAL FLOOD FORECASTING'
INGEST_TOKEN_MIN_LENGTH = 32


@dataclass(frozen=True)
class LiveSettings:
    """Live ingestion is configured only through the backend process environment."""
    token: str
    stale_minutes: float
    unavailable_minutes: float

    @property
    def problem(self):
        if not self.token:
            return 'Live ingestion is disabled: set AGOS_INGEST_TOKEN for the backend process to accept authorized sensor readings.'
        if len(self.token) < INGEST_TOKEN_MIN_LENGTH:
            return f'Live ingestion is disabled: AGOS_INGEST_TOKEN must contain at least {INGEST_TOKEN_MIN_LENGTH} characters.'
        return None


def live_settings(environ=os.environ):
    def minutes(name, default):
        try:
            return float(environ.get(name) or default)
        except ValueError:
            raise ValueError(f'{name} must be a number of minutes') from None
    stale, unavailable = minutes('AGOS_LIVE_STALE_MINUTES', 30), minutes('AGOS_LIVE_UNAVAILABLE_MINUTES', 360)
    if not (math.isfinite(unavailable) and 0 < stale < unavailable):
        raise ValueError('Live staleness requires 0 < AGOS_LIVE_STALE_MINUTES < AGOS_LIVE_UNAVAILABLE_MINUTES')
    return LiveSettings(environ.get('AGOS_INGEST_TOKEN', '').strip(), stale, unavailable)


def initialize(root: Path = DATA_ROOT):
    for folder in ('geographic', 'terrain', 'monitoring', 'simulations', 'scenarios', 'alerts', 'reports', 'config', 'datasets', 'uploads', 'live'):
        (root / folder).mkdir(parents=True, exist_ok=True)


def safe_path(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Path escapes the local data directory')
    return path
