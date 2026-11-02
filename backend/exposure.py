"""Hazard/exposure screening on the native depth grid.

Geographic features are sampled against the raster cells, so areas, lengths, and
counts share one resolution-dependent basis and stay fast for large inventories.
"""
import threading
from collections import OrderedDict

import numpy as np
import shapely
from pyproj import CRS, Transformer
from rasterio.features import rasterize, shapes
from rasterio.warp import transform_geom
from shapely.geometry import shape, mapping, MultiPolygon

from .datasets import GEOD, unnamed, version

ROLES = ('boundaries', 'roads', 'bridges', 'facilities', 'buildings')
CLASSES = [(.01, .3, '0.01–0.3 m'), (.3, 1, '0.3–1 m'), (1, 2, '1–2 m'), (2, 3, '2–3 m'), (3, float('inf'), '≥3 m')]
WET = .01
METHOD = ('Hazard/exposure screening, not quantified risk. Wet cells have depth >0.01 m on the native result grid; areas sum geodesic '
          'WGS84 cell areas. Barangay statistics use cells whose centers fall inside each boundary. Roads and bridges are sampled '
          'along their lines at half-cell spacing; buildings and facilities are sampled at one interior point. Results depend on '
          'grid resolution: narrow or subpixel features can be missed. Duration assumes each frame persists until the next timestamp.')


def geodesic_area(geom):
    if geom.is_empty:
        return 0.
    if geom.geom_type in {'MultiPolygon', 'GeometryCollection'}:
        return sum(geodesic_area(g) for g in geom.geoms)
    if geom.geom_type == 'Polygon':
        from shapely.geometry.polygon import orient
        # RFC7946/raster edges are linear in lon/lat. Densify parallels before
        # geodesic integration so merged regions agree with separate depth bins.
        return abs(GEOD.geometry_area_perimeter(orient(geom.segmentize(.001), sign=1))[0])
    return 0.


_areas: OrderedDict = OrderedDict()


def row_areas(crs, transform, height, width):
    """Area in m² of one cell in each raster row (north-up grids)."""
    key = (str(crs), tuple(transform)[:6], height, width)
    if key in _areas:
        return _areas[key]
    crs = CRS.from_user_input(crs)
    if crs.is_geographic:
        lons = np.linspace(0, transform.a, 5)
        north = transform.f + transform.e * np.arange(height)
        areas = np.array([abs(GEOD.polygon_area_perimeter(np.concatenate([lons, lons[::-1]]), np.concatenate([np.full(5, n + transform.e), np.full(5, n)]))[0]) for n in north])
    else:
        unit = crs.axis_info[0].unit_conversion_factor or 1
        areas = np.full(height, abs(transform.a * transform.e) * unit ** 2)
    _areas[key] = areas
    if len(_areas) > 16:
        _areas.popitem(last=False)
    return areas


class Grid:
    """Native depth grid with helpers for locating WGS84 features in its cells."""

    def __init__(self, arr, transform, crs):
        self.arr, self.transform, self.crs = arr, transform, CRS.from_user_input(crs)
        self.valid = np.isfinite(arr)
        self.wet = self.valid & (arr > WET)
        self.areas = row_areas(crs, transform, *arr.shape)
        self.geographic = self.crs.is_geographic and self.crs.equals(CRS.from_epsg(4326), ignore_axis_order=True)
        self.to_native = None if self.geographic else Transformer.from_crs('EPSG:4326', self.crs, always_xy=True)

    def native(self, geometries):
        if self.to_native is None:
            return geometries
        return shapely.transform(geometries, lambda xy: np.column_stack(self.to_native.transform(xy[:, 0], xy[:, 1])))

    def cells(self, x, y):
        cols, rows = ~self.transform @ (np.asarray(x, float), np.asarray(y, float))
        rows, cols = np.floor(rows).astype(int), np.floor(cols).astype(int)
        inside = (rows >= 0) & (rows < self.arr.shape[0]) & (cols >= 0) & (cols < self.arr.shape[1])
        return np.where(inside, rows, 0), np.where(inside, cols, 0), inside

    def depth_at(self, x, y):
        rows, cols, inside = self.cells(x, y)
        depth = np.where(inside, self.arr[rows, cols], np.nan)
        return depth, rows, cols, inside

    def segments(self, geometries):
        """Half-cell segments of line geometries: owning index, midpoint cell, and geodesic length."""
        parts, owner = shapely.get_parts(geometries, return_index=True)
        if not len(parts):
            return np.array([], int), np.array([], int), np.array([], int), np.array([], bool), np.array([])
        spacing = min(abs(self.transform.a), abs(self.transform.e)) / 2
        native = self.native(parts)
        coords, part = shapely.get_coordinates(shapely.segmentize(native, spacing), return_index=True)
        same = part[1:] == part[:-1]
        start, end, part = coords[:-1][same], coords[1:][same], part[:-1][same]
        rows, cols, inside = self.cells((start[:, 0] + end[:, 0]) / 2, (start[:, 1] + end[:, 1]) / 2)
        if self.geographic:
            length = GEOD.inv(start[:, 0], start[:, 1], end[:, 0], end[:, 1])[2]
        else:
            unit = self.crs.axis_info[0].unit_conversion_factor or 1
            length = np.hypot(*(end - start).T) * unit
        return owner[part], rows, cols, inside, np.abs(length)


def is_line(geometries):
    return np.isin(shapely.get_type_id(geometries), [1, 2, 5])  # LineString, LinearRing, MultiLineString


class ExposureService:
    def __init__(self, scenarios, datasets):
        self.scenarios, self.datasets = scenarios, datasets
        self._cache: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def reference_modes(scenario):
        """Imported scenarios use imported geography. Terrain-derived demonstrations may
        intersect imported reference geography; synthetic test grids never do."""
        modes = {scenario['mode']}
        if scenario['mode'] == 'demonstration' and (scenario.get('settings') or {}).get('reference_geography') == 'imported':
            modes.add('imported')
        return modes

    def calculate(self, scenario_id, index):
        scenario = self.scenarios.repo.get(scenario_id)
        modes = self.reference_modes(scenario)
        references = [d for d in self.datasets.repo.list() if d['role'] in ROLES and d['kind'] == 'vector' and d['mode'] in modes]
        key = (scenario_id, scenario.get('updated_at'), index, tuple(sorted(version(d) for d in references)))
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        result = self._calculate(scenario_id, index, references, modes)
        with self._lock:
            self._cache[key] = result
            while len(self._cache) > 96:
                self._cache.popitem(last=False)
        return result

    def _calculate(self, scenario_id, index, references, modes):
        arr, transform, base, scenario = self.scenarios.surface(scenario_id, index)
        grid = Grid(arr, transform, base['crs'])
        rows_wet = np.nonzero(grid.wet)[0]
        total_area = float(grid.areas[rows_wet].sum())
        categories = []
        for low, high, label in CLASSES:
            category = grid.wet & (arr >= low) & (arr < high)
            categories.append({'label': label, 'area_m2': float(grid.areas[np.nonzero(category)[0]].sum()), 'cells': int(category.sum())})
        by_role = {role: [d for d in references if d['role'] == role] for role in ROLES}
        rows, unavailable, counts, totals, sources = [], [], {}, {}, []
        for role, datasets in by_role.items():
            if not datasets:
                unavailable.append(f'{role}: no matching geographic dataset imported')
                counts[role] = totals[role] = None
            for d in datasets:
                sources.append({'name': d['name'], 'source': d['source'], 'mode': d['mode']})
        boundaries = self._boundaries(grid, by_role['boundaries'])
        for role in ('roads', 'bridges', 'facilities', 'buildings'):
            if by_role[role]:
                counts[role], totals[role], role_rows = self._features(grid, role, by_role[role], boundaries)
                rows.extend(role_rows)
        if boundaries:
            counts['boundaries'], totals['boundaries'] = boundaries['count'], boundaries['total']
            rows = self._boundary_rows(boundaries) + rows
        return {
            'scenario_id': scenario_id, 'scenario_name': scenario['name'], 'mode': scenario['mode'],
            'reference_geography': 'imported' if 'imported' in modes else 'demonstration',
            'source': scenario['source'], 'timestamp': scenario['frames'][index]['timestamp'], 'frame': index,
            'inundation_area_m2': total_area, 'maximum_depth_m': float(arr[grid.valid].max()) if grid.valid.any() else None,
            'wet_cells': int(grid.wet.sum()), 'valid_cells': int(grid.valid.sum()), 'counts': counts, 'totals': totals,
            'features': rows, 'categories': categories,
            'unavailable': unavailable + ['Population, households, casualties, economic losses: suitable authoritative exposure/vulnerability inputs unavailable.'],
            'method': METHOD, 'sources': sources,
        }

    def _boundaries(self, grid, datasets):
        if not datasets:
            return None
        names, owners, geometries = [], [], []
        for d in datasets:
            layer = self.datasets.features(d)
            geometries.extend(layer['geometries'])
            names.extend(layer['names'])
            owners.extend([d['name']] * len(layer['names']))
        geometries = np.array(geometries, dtype=object)
        native = grid.native(geometries)
        ids = rasterize(((mapping(g), i + 1) for i, g in enumerate(native)), out_shape=grid.arr.shape, transform=grid.transform, fill=0, dtype='int32')
        wet_rows, wet_cols = np.nonzero(grid.wet)
        owner = ids[wet_rows, wet_cols]
        size = len(geometries) + 1
        area = np.bincount(owner, weights=grid.areas[wet_rows], minlength=size)
        maximum = np.full(size, -np.inf)
        np.maximum.at(maximum, owner, grid.arr[wet_rows, wet_cols])
        flooded = [i for i in range(1, size) if area[i] > 0]
        return {'ids': ids, 'flooded': flooded, 'names': names, 'owners': owners, 'geometries': geometries, 'area': area, 'maximum': maximum,
                'buildings': None, 'roads': None, 'count': len(flooded), 'total': len(geometries)}

    def _features(self, grid, role, datasets, boundaries):
        count, total = 0, 0
        per_boundary = np.zeros(len(boundaries['geometries']) + 1) if boundaries else None
        aggregate: dict = {}
        for d in datasets:
            layer = self.datasets.features(d)
            geometries = layer['geometries']
            total += len(geometries)
            lines = is_line(geometries)
            maximum = np.full(len(geometries), np.nan)
            length = np.zeros(len(geometries))
            if lines.any():
                owner, r, c, inside, seg_length = grid.segments(geometries[lines])
                depth = np.where(inside, grid.arr[r, c], np.nan)
                wet = inside & np.isfinite(depth) & (depth > WET)
                line_index = np.nonzero(lines)[0][owner]
                np.fmax.at(maximum, line_index[wet], depth[wet])
                np.add.at(length, line_index[wet], seg_length[wet])
                if boundaries:
                    np.add.at(per_boundary, boundaries['ids'][r[wet], c[wet]], seg_length[wet])
            points = ~lines
            if points.any():
                xs, ys = layer['lon'][points], layer['lat'][points]
                if grid.to_native is not None:
                    xs, ys = grid.to_native.transform(xs, ys)
                depth, r, c, inside = grid.depth_at(xs, ys)
                maximum[points] = np.where(np.isfinite(depth) & (depth > WET), depth, np.nan)
                if boundaries:
                    hit = np.isfinite(maximum[points])
                    np.add.at(per_boundary, boundaries['ids'][r[hit], c[hit]], 1)
            flooded = np.nonzero(np.isfinite(maximum))[0]
            count += len(flooded)
            if role == 'buildings':
                continue  # Thousands of footprints are summarized per boundary, not listed.
            for i in flooded:
                name = layer['names'][i]
                if role == 'roads' and unnamed(name):
                    name = 'Unnamed road segments'
                group = aggregate.setdefault((d['name'], name if role == 'roads' else i), {'dataset': d['name'], 'role': role, 'name': name or f'{role.capitalize()} feature {i + 1}', 'maximum_depth_m': 0., 'inundation_area_m2': None, 'inundated_length_m': 0. if lines[i] else None})
                group['maximum_depth_m'] = max(group['maximum_depth_m'], float(maximum[i]))
                if lines[i]:
                    group['inundated_length_m'] += float(length[i])
        if boundaries and role in ('buildings', 'roads'):
            boundaries[role] = per_boundary
        return count, total, sorted(aggregate.values(), key=lambda r: -(r['inundated_length_m'] or r['maximum_depth_m']))

    @staticmethod
    def _boundary_rows(boundaries):
        rows = []
        for i in boundaries['flooded']:
            geom = boundaries['geometries'][i - 1]
            area = float(boundaries['area'][i])
            rows.append({
                'dataset': boundaries['owners'][i - 1], 'role': 'boundaries', 'name': boundaries['names'][i - 1] or f'Boundary {i}',
                'inundation_area_m2': area, 'inundated_share': min(1., area / max(geodesic_area(geom), 1.)),
                'maximum_depth_m': float(boundaries['maximum'][i]), 'inundated_length_m': None,
                'flooded_buildings': int(boundaries['buildings'][i]) if boundaries['buildings'] is not None else None,
                'flooded_road_length_m': float(boundaries['roads'][i]) if boundaries['roads'] is not None else None,
            })
        return sorted(rows, key=lambda r: -r['inundation_area_m2'])

    def extent_geojson(self, scenario_id, index):
        arr, transform, base, scenario = self.scenarios.surface(scenario_id, index)
        wet = np.isfinite(arr) & (arr > WET)
        polygons = [shape(transform_geom(base['crs'], 'EPSG:4326', geom)) for geom, value in shapes(wet.astype('uint8'), mask=wet, transform=transform) if value == 1]
        properties = {'scenario': scenario['name'], 'mode': scenario['mode'], 'timestamp': scenario['frames'][index]['timestamp'], 'source': scenario['source'], 'depth_threshold_m': WET}
        return {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'geometry': mapping(MultiPolygon(polygons)), 'properties': properties}] if polygons else []}
