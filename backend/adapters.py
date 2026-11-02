"""Explicit extension boundary for supported scientific model interchange.

Exported georeferenced rasters are supported. No undocumented HDF path is
interpreted. Register a version-specific implementation only with documented
field mapping, units, CRS, NoData, test fixtures, and reference comparisons.
"""
from pathlib import Path
from typing import Protocol
import h5py


class HydraulicModelAdapter(Protocol):
    name: str
    supported_versions: tuple[str, ...]

    def inspect(self, path: Path) -> dict: ...


class HecRasExportAdapter:
    name = 'HEC-RAS georeferenced RAS Mapper export'
    supported_versions = ('version-independent GeoTIFF interchange',)

    def inspect(self, path: Path):
        import rasterio
        with rasterio.open(path) as src:
            return {'adapter': self.name, 'crs': src.crs.to_string() if src.crs else None, 'dimensions': [src.width, src.height], 'bands': src.count, 'tags': src.tags(), 'requirements': 'North-up single band; explicit units and NoData; timestamps and model provenance supplied by manifest. File format checks are not hydraulic calibration.'}

    @staticmethod
    def reject_unverified_hdf(path: Path):
        with h5py.File(path, 'r') as hdf:
            version = str(hdf.attrs.get('File Version', hdf.attrs.get('Version', 'unknown')))
        raise ValueError(f'HEC-RAS HDF structure/version {version} is not supported by a verified adapter. Export georeferenced depth/velocity GeoTIFFs through RAS Mapper, then attach timestamped frames. No HDF values were interpreted.')


class AdapterRegistry:
    def __init__(self):
        self.adapters: dict[str, HydraulicModelAdapter] = {}

    def register(self, adapter: HydraulicModelAdapter):
        if adapter.name in self.adapters:
            raise ValueError('Adapter already registered')
        self.adapters[adapter.name] = adapter

    def capabilities(self):
        return [{'name': a.name, 'supported_versions': a.supported_versions, 'raw_hdf_supported': False} for a in self.adapters.values()]


registry = AdapterRegistry()
registry.register(HecRasExportAdapter())
