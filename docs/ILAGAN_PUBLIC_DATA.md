# Ilagan public reference data acquired for AgosPH

The files are stored under `data/public/ilagan/` and imported into the local
FastAPI catalog in **Imported Data** mode. They contain actual sourced geometry
and historical raster values. No flood-depth predictions or sensor observations
were generated to fill missing inputs.

| Layer | Prepared content | Limits |
| --- | --- | --- |
| Barangay boundaries | 91 polygons; source NAMRIA/PSA shapefile dated 2023-11-06; no additional simplification | Public mirror of older agency data, not certified current/legal LGU boundaries |
| Rivers / waterways | 1,006 OSM line features | Includes tagged streams, canals, and drains; source labels retained; not a surveyed hydrological network |
| Roads | 3,124 OSM line features | Feature/segment count, not unique named roads; community mapping can be incomplete |
| Bridges | 50 bridge-tagged road features | Derived from explicit OSM bridge tags on highway ways; not a complete bridge-site inventory |
| Buildings | 41,420 OSM footprints, split into three importable files | **PARTIAL COVERAGE:** 2 of 6 spatial queries completed; source snapshot 2026-07-15; standalone relation-only multipolygons not included |
| Facility-tagged footprints | 8 explicitly amenity/healthcare-tagged footprints | **PARTIAL COVERAGE:** selected from the downloaded building area; no standalone POIs, verified operating status, or complete facility-site inventory |
| Elevation | Copernicus GLO-30 DSM, 2,062 × 1,080 cells, meter elevations | Approximately 30 m surface model, including vegetation/buildings; EGM2008 orthometric heights, not a bare-earth LiDAR DTM |
| Rainfall maps | Three CHIRPS v3 FINAL `sat` daily rasters for 2025-11-01 through 2025-11-03 | Historical gridded estimates, approximately 5 km spacing; not live observations or forecasts |
| Rainfall chart series | Three area-weighted Ilagan means from those rainfall rasters | Explicitly named **NOT a gauge**; a derived series identifier, without fabricated station coordinates |

The river and road OSM base timestamps are 2026-11-01. Individual tiled source
timestamps and retrieval times are retained in `acquisition.json`. The boundary
and source-query footprint can limit features near the city edge. Original OSM
IDs, tags, source dates, and attribution are kept with the features.

## Use in AgosPH

1. Refresh [the local application](http://127.0.0.1:5173/). **Imported Data** mode
   has been saved in workspace settings.
2. Open **Layers**. Available geographic layers can be enabled individually.
   Rivers, boundaries, bridges, and the limited facility layer are enabled by
   default. The large building layers are initially off.
3. Open **Data Center** to inspect each source, bounds, validation, and quality
   warnings. The app stores independent copies of the prepared uploads.
4. Enable **DEM Elevation Colors** to inspect the imported elevation raster.
   The unconverted orthometric DEM is intentionally **not** selected as a
   Cesium ellipsoidal terrain provider. No geoid correction was fabricated.
5. Open **Rainfall** for the historical area-mean chart and timestamped raster
   playback. The nominal raster timestamp marks the end of its UTC-labeled day;
   this is not a uniform observation window for every contributing station.

Changing data mode does not turn these files into calibrated flood results. In
Imported Data mode there is no flood scenario until genuine model outputs are
supplied.

## Sources and attribution

- **Boundaries:** © NAMRIA and Philippine Statistics Authority, source shapefile
  version 2023-11-06, publicly mirrored by
  [altcoder/philippines-psgc-shapefiles](https://github.com/altcoder/philippines-psgc-shapefiles/tree/main/data/2023/BgySubMuns).
  DBF/index source hashes are verified where the source uses Git LFS. Only
  relevant geometry byte ranges were read; the entire national geometry hash
  was not recomputed. Agency/source use conditions and attribution remain
  applicable. A coarser community fallback was investigated but was superseded
  before import.
- **OSM:** © [OpenStreetMap contributors, ODbL 1.0](https://www.openstreetmap.org/copyright).
  Raw responses and per-tile source timestamps are retained. The data was
  retrieved through documented public Overpass services; this is not an
  agreement to provide a live service or a guarantee of inventory completeness.
- **Elevation:** [Copernicus DEM GLO-30 Public](https://registry.opendata.aws/copernicus-dem/),
  © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, under the
  Copernicus DEM license. Native elevation samples were cropped/mosaicked;
  EGM2008 orthometric heights in meters were retained. See the
  [official product description](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM).
- **Rainfall:** [UCSB Climate Hazards Center, CHIRPS v3](https://www.chc.ucsb.edu/data/chirps3),
  public-domain data with source acknowledgment retained. The daily FINAL `sat`
  product disaggregates pentadal rainfall using NASA IMERG Late V07. Follow the
  [daily-product documentation](https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/readme.txt)
  when interpreting temporal precision. No rainfall field was converted into
  flood depth.

## Still unavailable

- **Calibrated inundation, flood-depth, and velocity outputs:** no suitable
  georeferenced temporal outputs were publicly downloadable during acquisition.
  The [official Ilagan hazard page](https://cityofilagan.gov.ph/index.php/hazard-map-2/)
  links return-period hazard references, but these are not temporal hydraulic
  outputs. The direct city-page download returned HTTP 403, LiPAD endpoints
  timed out, and the MGB catalog requires a token. No access barrier was bypassed
  and no map image was traced into invented model results.
- **Surveyed bare-earth LiDAR terrain:** requires checking coverage and
  requesting the data through [UP LiPAD](https://lipad.dream.upd.edu.ph/).
- **Actual station observations:** request authorized rainfall/water-level
  measurements from their owners. CHIRPS area means are not station readings.
- **Complete building/facility inventories:** remaining query areas and
  authoritative LGU/agency inventories are needed. Do not treat partial feature
  counts as total assets in Ilagan.

`data/public/ilagan/acquisition.json` lists every active prepared file, its
SHA-256, source/processing notes, source dates, coverage limitations, and local
dataset ID. `verification.json` records the local API and browser checks.

## Reproduce or extend acquisition

Use the project Python environment. The optional original-shapefile extraction
helper needs `pip install -r scripts/requirements-data.txt`.

```powershell
# Inspect public source metadata and fetch the original boundary components.
.\.venv\Scripts\python.exe scripts/fetch_ilagan_data.py catalog
.\.venv\Scripts\python.exe scripts/fetch_ilagan_data.py original-catalog
.\.venv\Scripts\python.exe scripts/fetch_ilagan_data.py original-files
.\.venv\Scripts\python.exe scripts/fetch_ilagan_data.py prepare-original

# Downloads are cached. Public services may be unavailable or rate limited.
.\.venv\Scripts\python.exe scripts/fetch_ilagan_data.py osm
.\.venv\Scripts\python.exe scripts/fetch_ilagan_data.py terrain
.\.venv\Scripts\python.exe scripts/fetch_ilagan_data.py rainfall
.\.venv\Scripts\python.exe scripts/fetch_ilagan_data.py rainfall-summary
.\.venv\Scripts\python.exe scripts/fetch_ilagan_data.py facility-subset

# Requires the local backend to be running.
.\.venv\Scripts\python.exe scripts/fetch_ilagan_data.py import
node scripts/verify_public_data.mjs
```

The helper retains successful partial responses and labels missing query tiles;
it does not silently claim full coverage. Respect provider rate limits and
source licensing. No database or paid API was introduced.
