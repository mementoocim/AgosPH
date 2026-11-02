"""Atomic, cross-process locked JSON repositories; replaceable persistence boundary."""
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from filelock import FileLock


class JsonRepository:
    def __init__(self, root: Path, collection: str):
        self.directory = root / collection
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = FileLock(str(self.directory / '.lock'), timeout=15)

    @contextmanager
    def transaction(self):
        with self.lock:
            yield self

    def path(self, key: str) -> Path:
        if not key or not all(c.isalnum() or c in '-_' for c in key) or len(key) > 100:
            raise ValueError('Invalid record identifier')
        return self.directory / f'{key}.json'

    def get(self, key: str):
        path = self.path(key)
        with self.lock:
            if not path.exists():
                raise KeyError(key)
            return json.loads(path.read_text(encoding='utf-8'))

    def list(self):
        with self.lock:
            return [json.loads(p.read_text(encoding='utf-8')) for p in sorted(self.directory.glob('*.json'))]

    def put(self, key: str, value: dict):
        target = self.path(key)
        with self.lock:
            fd, temp = tempfile.mkstemp(prefix='.write-', suffix='.tmp', dir=self.directory)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as out:
                    json.dump(value, out, indent=2, allow_nan=False)
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temp, target)
            finally:
                if os.path.exists(temp):
                    os.unlink(temp)
        return value

    def delete(self, key: str):
        with self.lock:
            target = self.path(key)
            if not target.exists():
                raise KeyError(key)
            target.unlink()
