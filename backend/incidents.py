"""Operator incident log. Records are user-entered field reports: never seeded, inferred, or forecast."""
import difflib
import re
import unicodedata
import uuid
from datetime import datetime

import shapely

from .datasets import now
from .repository import JsonRepository

STATUSES = ('reported', 'verified', 'responding', 'resolved')
COLUMNS = ('id', 'label', 'mode', 'status', 'type', 'severity', 'title', 'barangay', 'barangay_validated', 'longitude', 'latitude',
           'reporter', 'description', 'reported_at', 'history', 'created_at', 'updated_at')
LABELS = {'demonstration': 'EXERCISE · DEMONSTRATION MODE', 'imported': 'OPERATOR LOG · USER-ENTERED'}
ABBREVIATIONS = {'sta': 'santa', 'sto': 'santo', 'i': '1', 'ii': '2', 'iii': '3', 'iv': '4', '1st': '1', '2nd': '2', '3rd': '3', '4th': '4'}


def normalize(name):
    """Comparable barangay text. Ignores accents, case, punctuation, spacing, "and"/"&", a leading "Brgy.", and
    Sta./Sto., Roman-numeral and ordinal spellings ("Marana I" = "Marana 1", "Allinguigan 1st" = "Allinguigan 1")."""
    text = ''.join(c for c in unicodedata.normalize('NFKD', name) if not unicodedata.combining(c)).casefold()
    words = [ABBREVIATIONS.get(w, w) for w in re.sub(r'[^0-9a-z]+', ' ', text).split() if w != 'and']
    if words and words[0] in {'barangay', 'brgy', 'bgy'}:
        words = words[1:]
    # Words join without spaces ("Rang-ayan" = "Rangayan"), but adjacent numbers keep one ("6 & 24" is not "624").
    return ''.join(f' {w}' if i and w.isdigit() and words[i - 1].isdigit() else w for i, w in enumerate(words))


def aliases(name):
    """Official names often carry a former name or a (Pob.) suffix in parentheses; either part may be typed alone."""
    base, _, rest = name.partition('(')
    return {normalize(base), normalize(rest)} - {''}


def match_barangay(typed, names):
    key = normalize(typed)
    exact = [n for n in names if normalize(n) == key]
    if exact:
        return exact[0]
    candidates = sorted({n for n in names if key in aliases(n)})
    if len(candidates) == 1:
        return candidates[0]
    if candidates:
        raise ValueError(f'"{typed}" matches several barangays: {", ".join(candidates)}. Enter the full name.')
    forms = {}
    for n in names:
        for form in {normalize(n)} | aliases(n):
            forms.setdefault(form, n)
    close = list(dict.fromkeys(forms[f] for f in difflib.get_close_matches(key, list(forms), n=5, cutoff=.6)))[:3]
    hint = f' Did you mean: {", ".join(close)}?' if close else ' Check the spelling or leave the barangay blank.'
    raise ValueError(f'Barangay "{typed}" is not in the imported boundary layer.{hint}')


class IncidentService:
    def __init__(self, root, datasets):
        self.repo = JsonRepository(root, 'incidents')
        self.datasets = datasets

    def boundaries(self):
        return [d for d in self.datasets.repo.list() if d['role'] == 'boundaries' and d['kind'] == 'vector' and d['mode'] == 'imported']

    def barangays(self, longitude=None, latitude=None):
        """Names from imported boundary layers, and the boundary containing a point when one is given."""
        names, containing, layers = set(), None, self.boundaries()
        for d in layers:
            layer = self.datasets.features(d)
            names.update(n for n in layer['names'] if n)
            if containing is None and longitude is not None and latitude is not None:
                hits = shapely.intersects_xy(layer['geometries'], longitude, latitude)
                containing = next((layer['names'][i] for i in hits.nonzero()[0] if layer['names'][i]), None)
        return {'available': bool(names), 'names': sorted(names, key=str.casefold), 'containing': containing, 'sources': [d['source'] for d in layers]}

    def details(self, value, current=None):
        barangay, validated = value.barangay, False
        if current is not None and barangay == current['barangay']:
            # An unchanged name keeps its original check, so a later boundary import never blocks other edits.
            validated = current['barangay_validated']
        elif barangay:
            names = self.barangays()['names']
            if names:
                barangay, validated = match_barangay(barangay, names), True
        return {'type': value.type, 'severity': value.severity, 'title': value.title, 'barangay': barangay, 'barangay_validated': validated,
                'longitude': value.longitude, 'latitude': value.latitude, 'reporter': value.reporter, 'description': value.description}

    def create(self, value):
        identifier, created = uuid.uuid4().hex, now()
        record = {'id': identifier, 'label': LABELS[value.mode], 'mode': value.mode, 'status': 'reported', **self.details(value),
                  'reported_at': value.reported_at.isoformat() if value.reported_at else created,
                  'history': [{'status': 'reported', 'at': created}], 'created_at': created, 'updated_at': created}
        return self.repo.put(identifier, record)

    def update(self, identifier, value):
        with self.repo.transaction():
            record = self.repo.get(identifier)
            if value.mode != record['mode']:
                raise ValueError('Exercise records and operator reports cannot be relabeled as each other. Log a new incident instead.')
            record.update(self.details(value, record), updated_at=now())
            if value.reported_at:
                record['reported_at'] = value.reported_at.isoformat()
            return self.repo.put(identifier, record)

    def transition(self, identifier, status):
        with self.repo.transaction():
            record = self.repo.get(identifier)
            if record['status'] == 'resolved':
                raise ValueError('Resolved incidents cannot be reopened. Log a new incident instead.')
            if STATUSES.index(status) <= STATUSES.index(record['status']):
                raise ValueError(f"Incident is already {record['status']}. Status only moves forward: reported → verified → responding → resolved.")
            changed = now()
            record.update(status=status, updated_at=changed)
            record['history'].append({'status': status, 'at': changed})
            return self.repo.put(identifier, record)

    def list(self, status=None, severity=None, barangay=None, mode=None):
        key = normalize(barangay) if barangay else None
        rows = [r for r in self.repo.list() if (not status or r['status'] == status) and (not severity or r['severity'] == severity)
                and (not mode or r['mode'] == mode) and (key is None or normalize(r['barangay']) == key)]
        # Offsets differ between entries, so order by instant rather than by text.
        return sorted(rows, key=lambda r: (datetime.fromisoformat(r['reported_at']), r['created_at']), reverse=True)
