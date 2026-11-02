# Scientific data contracts

AgosPH is a local interchange, visualization, replay, and exposure-screening application. It does not execute a hydraulic or weather solver. Format validation never establishes source accuracy, calibration, forecast skill, or operational suitability.

## Data modes

`demonstration`: illustrative scenarios and unlocated test sensors. Every generated alert is TEST. Two kinds of illustrative scenario exist: the synthetic 32 × 32 playback laboratory grids, and terrain demonstrations derived from imported terrain and river lines (see below). No synthetic river network, terrain, building footprint, administrative boundary, or infrastructure inventory is supplied.

`imported`: user-supplied geographic and time-series files with required provenance. Imported hydraulic outputs can be `unvalidated` or user-asserted `validated`; the latter requires evidence notes and is never presented as independent validation. Monitoring is historical replay, never actual live telemetry.

`live`: readings pushed by an authorized sensor, logger, or gateway through `POST /api/monitoring/ingest` (see [Live monitoring ingestion](#live-monitoring-ingestion)). They are shown in both data modes, in a separate list, with **LIVE**, **STALE**, or **UNAVAILABLE** status. Demonstration fixtures (**DEMO**) and imported history (**REPLAY**) can never become live.

Missing data stays unavailable. Imported geography is reference data and is drawn and searchable in both modes; demonstration layers are never drawn in imported mode. Exposure uses geography of the scenario's own mode, except that a demonstration scenario whose manifest sets `settings.reference_geography = "imported"` (the terrain demonstrations) may intersect imported reference geography; such results carry `reference_geography: "imported"` and are labeled as an illustrative hazard, not an impact assessment. Imported scenarios never use demonstration geography. A basemap is reference cartography, not a source of surveyed terrain or authoritative administrative boundaries.

## Terrain demonstration method

`POST /api/demo/terrain` (and a background run on startup when inputs exist or change) builds `demo-terrain-moderate` and `demo-terrain-high` from the first imported `terrain` raster and imported `rivers` lines (`waterway=river` when tagged). It is a geographic visualization aid, not a hydraulic model:

- The DEM is average-resampled only as far as needed to stay under the local cell limit (about 60 m for the prepared GLO-30 DSM). River lines are rasterized; each river cell's reference level is the lowest neighbouring river value.
- An assumed stage hydrograph rises from 0.5 m to a peak of +4 m (moderate) or +7 m (high) above the terrain model's river surface at 12 h, then recedes; 19 frames at 2-hour steps.
- A cell is wet when it connects to a river cell through terrain lower than that river's level plus the stage (a connectivity-constrained, HAND-style bathtub). Water may only reach cells at most 1 m below the source river's level, so a high reach never fills a valley that drains to another channel. Depth = river level + stage − elevation.
- Velocity is a Manning-type illustration, (1/n)·h^(2/3)·√S, with n = 0.035 within one cell of a channel and 0.06 elsewhere, S the slope of the river levels smoothed over about 1 km (4 km where that surface is flat), clamped to 5·10⁻⁵–0.005 and capped at 3 m/s. Direction is the downslope azimuth of the same surface; where it is level, direction is NoData.
- Ignored: rainfall-runoff, channel conveyance and storage, levees, culverts, drainage, roughness mapping, and calibration. A surface model includes vegetation and buildings.

## Raster ingestion

POST `/api/datasets` with multipart fields `file`, `role`, `source`, and `unit`.

Optional `observation_timestamp` is an ISO 8601 timestamp with offset. Supply it for rainfall GeoTIFF frames to make them available in the Rainfall module's timestamp selector and animated layer playback. Untimestamped rainfall rasters remain static overlays.

- Formats: single-band, north-up GeoTIFF/COG; maximum 64 MiB upload and 25 million cells.
- Explicit CRS, valid affine transform, finite unmasked values, and declared NoData are required. Reproject rotated rasters before import. Rasters with no valid cells are rejected.
- Roles/units: `depth` (m), `velocity` (m/s), `direction` (degrees clockwise from north), `wse` (m), `terrain` (m), `rainfall` (mm per declared interval).
- Depth, speed, and rainfall must be nonnegative outside declared NoData. Convert feet, ft/s, cm, etc. before ingestion. Direction must be 0–360 degrees.
- Provenance must document vertical datum for DEM and WSE, time represented, source model, model version, horizontal CRS, and relevant licenses. AgosPH does not infer vertical datum or convert between vertical datums.
- Original georeferencing is preserved. WGS84 PNG previews are capped at 768 pixels on the longest side and use nearest-neighbor reprojection. Analysis and point sampling read native raster values. PNGs are visualization products, not replacement hydraulic outputs.
- A local terrain heightmap provider resamples a genuine imported DEM bilinearly at 65 × 65 tile-edge samples. Outside DEM coverage the viewer uses a labeled zero/ellipsoid fallback. No elevation is reported from this fallback. Horizontal and vertical reference compatibility remains the provider's responsibility. With settings `terrain_auto` (default `true`) and no explicit `terrain_dataset` or `terrain_url`, the first imported DEM drives 3D terrain; heights are rendered in the DEM's own vertical datum without geoid conversion.

## Vector ingestion

RFC 7946 GeoJSON `FeatureCollection`, EPSG:4326 longitude/latitude, 1–50,000 valid features. Required role determines geometry: `boundaries`, `buildings`, `inundation` require polygons; `roads`, `rivers` require lines. `bridges` and `facilities` support supplied valid geometry. Optional `properties.name` is used for search and exposure tables. Feature text is rendered as plain text.

No authoritative Ilagan geography is bundled. Priority river overlays are Pinacanauan de Ilagan, Abuan, Bintacan, and relevant Cagayan sections. Supply legitimate, licensed datasets and retain source metadata. `boundaries` should represent actual barangay boundaries when the outputs are interpreted as barangay summaries.

## Time series

UTF-8 CSV header or JSON object `{"records":[...]}`. Maximum 100,000 rows. Timestamps must be ISO 8601 with explicit UTC offset; station/timestamp pairs must be unique within a file. Observations are sorted by instant.

Monitoring:

```csv
timestamp,station_id,name,water_level_m,rainfall_mm,longitude,latitude
2026-01-15T00:00:00+08:00,my-station,My sourced station,1.2,4,121.89,17.13
```

This row illustrates the schema, not a real station or observation. Coordinates are optional. Omit them when unknown. Do not use example coordinates as a geographic source.

Rainfall: `timestamp,station_id,rainfall_mm`; optional `name,longitude,latitude`. Each rainfall value represents a non-overlapping interval accumulation. Intensity divides accumulation by elapsed hours; the first interval uses the next available spacing, so imported series must document interval conventions.

HEC-HMS hydrograph: `timestamp,station_id,discharge_m3s`; optional `name`. This is an import/inspection contract, not HEC-HMS execution or automatic flood-depth generation.

## Live monitoring ingestion

Live readings exist only when an authorized source pushes them to `POST /api/monitoring/ingest`. Nothing is fetched from PAGASA or any public website, and fixtures or imported files are never labeled live.

Configuration lives in the backend process environment. Invalid staleness values stop startup.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGOS_INGEST_TOKEN` | unset | Bearer token of at least 32 characters. If it is unset or shorter, the endpoint answers `503` and accepts nothing. |
| `AGOS_LIVE_STALE_MINUTES` | `30` | A station is `stale` once its newest observation is older than this. |
| `AGOS_LIVE_UNAVAILABLE_MINUTES` | `360` | Beyond this age a station is `unavailable`: its values and threshold state are hidden. |

Requests carry `Authorization: Bearer <token>` and a JSON body of at most 1 MiB with 1–500 readings:

```json
{"readings": [{
  "station_id": "ilagan-bridge-gauge",
  "name": "Ilagan bridge gauge",
  "timestamp": "2026-11-01T20:05:00+08:00",
  "water_level_m": 3.2,
  "rainfall_mm": 4.5,
  "rainfall_interval_minutes": 15,
  "units": {"water_level": "m", "rainfall": "mm"},
  "longitude": 121.89,
  "latitude": 17.13,
  "source": "Gauge owner, instrument, and datum (for example gauge zero)"
}]}
```

This example illustrates the schema, not a real station, location, or observation.

If any reading fails validation, the whole batch is rejected with `422` and the message names the failing reading (`Reading 2: …`). Nothing is stored. The rules:

- `station_id`: 1–64 lowercase letters, digits, `-`, or `_`. The demonstration ids `test-a`, `test-b`, and `test-c` are reserved.
- `timestamp`: ISO 8601 with a UTC offset, at most 5 minutes in the future and at most 30 days old. Older history belongs in the CSV/JSON import.
- Supply at least one of `water_level_m` (−100 to 1000 m) and `rainfall_mm` (0–1000 mm per interval). Both must be finite JSON numbers, not strings or booleans.
- `units` must declare every supplied value: `water_level` is `m` and `rainfall` is `mm`. AgosPH never converts units, so convert cm, ft, or inches before sending.
- `rainfall_mm` requires `rainfall_interval_minutes` (1–1440), the accumulation period.
- `longitude` and `latitude` (WGS84) go together or not at all. Supply only the station's actual location.
- `source` is required and should name the owner, instrument, and datum. `name` is optional.
- Unknown fields are rejected, so a misspelled field never silently drops a value.

Responses:

- `200` returns `accepted`, `duplicates`, `stations`, `alerts` (the LIVE alerts this batch raised), and `received_at`.
- `401` (with `WWW-Authenticate: Bearer`) means the token is missing or wrong.
- `503` means ingestion is not configured.
- `413` means the body exceeds 1 MiB, and `422` means invalid JSON or readings.

A reading whose station and observation instant are already stored counts as a duplicate and is never overwritten, so loggers can retry safely.

Storage: `data/live/station-<id>.json` keeps each station's newest seven days of readings, at most 5,000. `data/live/receipts/YYYY-MM-DD.jsonl` appends every accepted batch with its receipt time, channel, and client address. Each stored reading keeps `source`, `units`, `received_at`, and `channel`.

Freshness is measured from the observation `timestamp`, not from the receipt time, so a backfilled old reading is `stale` on arrival. `GET /api/monitoring` (in either data mode) returns live stations in a separate `live` block, each with `freshness` (`live`, `stale`, or `unavailable`), `age_seconds`, and `received_at`. Replay stations carry `data_class: demonstration` or `replay`. Between snapshots the browser keeps ageing live readings, so a stopped backend never leaves a LIVE badge on screen. `/api/ws/monitoring` pushes a snapshot as soon as readings are ingested, and at least every 2 seconds so that staleness changes appear without new data.

Live alerts:

- Live stations have no default thresholds. Until an operator saves station thresholds with `PUT /api/monitoring/{station_id}/thresholds`, live readings raise no alerts and show no threshold state. Thresholds are stored by station id, so replay data with the same id shares them.
- With thresholds saved, a fresh reading that becomes the station's newest observation and crosses watch, warning, or critical upward creates an alert with `mode: "live"` and the label `LIVE · SENSOR THRESHOLD`.
- After a gap longer than the stale age, the first fresh reading counts as a crossing. An unresolved live alert of the same severity is not duplicated.
- Exercise alerts keep their `TEST ·` labels and `demonstration`/`imported` modes, and `POST /api/alerts/test` cannot create live alerts.
- Every alert is a local dashboard notification. Nothing is sent to the public, to SMS, or to government systems.

Adapters: `backend/monitoring_adapters.py` registers the sources, which `GET /api/models/adapters` lists under `monitoring`.

- `Authorized sensor push` is enabled while a valid token is configured.
- `PAGASA` is a disabled stub. It needs an authorized endpoint and credentials issued by PAGASA (for example under a data-sharing agreement) plus a documented field mapping. No endpoint is assumed and no website is scraped.
- A future pull adapter returns readings in this contract, and `MonitoringService.poll()` passes them through the same validation, storage, and alerting as push.

Examples. The PowerShell example assumes `$env:AGOS_INGEST_TOKEN` holds the backend's token. Values typed by hand are drills, so say so in `source`:

```powershell
.\.venv\Scripts\python.exe scripts\push_live_reading.py --station drill-gauge --name 'Drill gauge' --water-level 3.2 --source 'INGESTION DRILL - typed value, not a measurement'

$body = @{ readings = @(@{ station_id = 'drill-gauge'; timestamp = (Get-Date).ToString('o'); water_level_m = 3.2; units = @{ water_level = 'm' }; source = 'INGESTION DRILL - PowerShell' }) } | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post 'http://127.0.0.1:8000/api/monitoring/ingest' -Headers @{ Authorization = "Bearer $env:AGOS_INGEST_TOKEN" } -ContentType 'application/json' -Body $body
```

```bash
curl -X POST http://127.0.0.1:8000/api/monitoring/ingest \
  -H "Authorization: Bearer $AGOS_INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"readings":[{"station_id":"drill-gauge","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","water_level_m":3.2,"units":{"water_level":"m"},"source":"INGESTION DRILL - curl"}]}'
```

Network posture: the backend stays bound to 127.0.0.1 and accepts only localhost Host headers. A field logger must deliver through a gateway on the same machine, or through a tunnel or TLS reverse proxy that you configure. Exposing the backend directly to a network is not supported.

## Scenario manifest v1

Scenario JSON references local dataset identifiers, never arbitrary filesystem paths. All referenced outputs must share exact CRS, width, height, affine transform, and regular time spacing. Timestamps strictly increase. At most 1,000 frames and 40 million raster cells across all referenced metric frames. Comparison requires identical grids and matching elapsed time offsets.

```json
{
  "name": "My exported HEC-RAS run",
  "description": "User-supplied georeferenced model results",
  "mode": "imported",
  "status": "unvalidated",
  "source": "Model owner, export date, calibration limitations, license",
  "model": "HEC-RAS 2D",
  "model_version": "Declared version",
  "validation_notes": "Document datum, calibration, boundary conditions, and review",
  "assumptions": {"rainfall_mm": 100},
  "frames": [
    {
      "timestamp": "2026-01-15T00:00:00+08:00",
      "depth": "LOCAL_DEPTH_DATASET_ID",
      "velocity": null,
      "direction": null,
      "wse": null
    }
  ],
  "settings": {"opacity": 0.72, "layers": {}}
}
```

`pending` manifests must have empty frames. `demonstration` scenarios must be `illustrative`. Changing assumptions never recomputes outputs. Exported manifests contain references, not copies of raster files; move the entire data directory to retain references.

## HEC-RAS adapter policy

The supported adapter consumes properly exported, georeferenced RAS Mapper GeoTIFFs, with timestamps and model metadata supplied by the manifest. Raw HDF5 is opened only to inspect a version attribute, then rejected explicitly. No undocumented HDF paths or guessed hydraulic values are interpreted. `backend/adapters.py` defines a registry/protocol for future, documented version-specific adapters. New adapters need versioned fixtures, units/CRS/NoData checks, and comparisons against known model exports.

References: [HEC-RAS results maps](https://www.hec.usace.army.mil/confluence/rasdocs/rmum/6.1/mapping-results/managing-results-maps), [RAS Mapper visualization](https://www.hec.usace.army.mil/confluence/rasdocs/r2dum/6.5/viewing-2d-or-1d-2d-output-using-hec-ras-mapper/adding-results-map-layers-for-visualization), [Rasterio reprojection](https://rasterio.readthedocs.io/en/stable/topics/reproject.html), [Cesium offline deployment](https://github.com/CesiumGS/cesium/blob/main/Documentation/OfflineGuide/README.md).

## Derived hazard/exposure methods

- Inundation: native-resolution valid depth cells >0.01 m. The GeoJSON export polygonizes them and transforms to WGS84.
- Area: sum of geodesic WGS84 areas of wet cells. Classification: (0.01,0.3), [0.3,1), [1,2), [2,3), [3,∞) m. Area is a grid-based approximation and depends on resolution.
- Barangay summary: boundaries are rasterized onto the depth grid (cell centers). Each affected boundary reports inundated area, share of its geodesic area, maximum depth, flooded building footprints, and flooded road length within it.
- Roads and bridges: lines are split into half-cell segments; a segment is flooded when the cell under its midpoint is wet, and flooded lengths are geodesic. Named roads are aggregated by name; OSM-identifier fallback names are grouped as unnamed segments.
- Buildings and facilities: one interior point per feature is sampled; a feature counts as flooded when that cell is wet. Footprints smaller than a cell are approximated by that point. Building footprints are summarized per barangay, not listed.
- Counts report flooded features out of the features considered. Duplicate inventories can double-count and should be deduplicated before import.
- Inspection: depth, velocity, direction, and WSE at the selected frame; arrival as elapsed minutes from the first frame to the first frame with depth >0.01 m; peak depth and its first timestamp. Velocity, direction, and WSE surfaces are drawn only where the same frame is wet.
- Maximum-depth surface: maximum supplied depth per valid cell across the entire scenario.
- Arrival: elapsed minutes from the first frame to the first wet frame. Never-wet cells are transparent/unavailable. Temporal resolution limits arrival precision.
- Duration: sum of left-step intervals in which each cell is wet. The final frame has no known following interval and contributes zero additional duration. Unknown samples are not treated as wet.
- Velocity/direction/WSE: unavailable unless supplied. Direction is a scalar azimuth visualization; not an inferred flow field.
- Population, household counts, casualties, losses, and vulnerability are unavailable. The product performs hazard and exposure screening; it does not quantify actual disaster risk.
- Map display: `GET /api/scenarios/{id}/surface.png?frame=&metric=&smooth=` colors one frame for the map. With `smooth=1` (the viewer's default "Smooth flood display") the image is bilinearly upsampled 2× so cell edges blend; this is display only, and direction is never interpolated. Turning the option off shows one square per model cell. Inspection, exposure, reports, and exports always use the model cells. Passing the scenario's `updated_at` as `v` makes the image cacheable for a day.

## Incident log

Operator-entered field reports stored in `data/incidents/`. Nothing is seeded, inferred from model output, received from, or sent to an external system.

- `POST /api/incidents` fields: `type` (`flooding`, `landslide`, `road_closure`, `rescue_request`, `evacuation`, `other`), `title` (1–120 characters), `description` (≤3000), `severity` (`low`, `moderate`, `high`, `critical`), `barangay` (optional), `longitude` and `latitude` (WGS84, both or neither), `reporter` (required report source), `reported_at` (ISO 8601 with UTC offset, not in the future and not before 2000; defaults to the logging time, while the form sends the time it shows), and `mode`. Unknown fields such as `status` or `label` are rejected.
- `mode` defaults to `demonstration`. Demonstration records are labeled `EXERCISE · DEMONSTRATION MODE`; imported-mode records `OPERATOR LOG · USER-ENTERED`. `PUT /api/incidents/{id}` edits details but cannot change the mode, status, or history.
- When imported `boundaries` exist, the barangay must resolve to one of their names; it is stored under the official name with `barangay_validated: true`. Matching ignores case, accents, punctuation, spacing, "and"/"&", a leading "Brgy."/"Barangay", Sta./Sto. abbreviations, and Roman-numeral or ordinal numbers ("Marana 1" for "Marana I", "Allinguigan 1" for "Allinguigan 1st"), and accepts the name before or inside parentheses (e.g. "Abuan" for "Cabeseria 27 (Abuan)") only when that part is unique. Unknown names are rejected with close suggestions. Without a boundary layer the typed name is kept with `barangay_validated: false` and shown as unchecked. An edit that leaves the barangay text unchanged keeps its original check, so a boundary layer imported later never blocks other edits. `GET /api/barangays?longitude=&latitude=` lists the names and the boundary containing a point.
- `PATCH /api/incidents/{id}` with `{"status": ...}` moves forward only through `reported → verified → responding → resolved`; steps may be skipped, and resolved records cannot be reopened. Every change is appended to `history` with a UTC timestamp. "Verified" is the operator's assertion, not independent confirmation.
- `GET /api/incidents` filters by `status`, `severity`, `barangay`, and `mode` and lists the latest report first. `DELETE /api/incidents/{id}` removes a record permanently.
- Reports: `GET /api/reports/csv?kind=incidents&mode=` and the scenario PDF include only incidents of one data mode, so exercise records never appear beside operator reports. The PDF section is titled "Exercise incident log" or "Operator incident log", and its label row repeats with the column headers on every page.

## Filesystem and APIs

JSON repositories use per-collection cross-process file locks and flushed temporary writes followed by atomic replacement. Original dataset paths are generated server-side. User input cannot choose arbitrary source paths. Individual records are atomic; importing or replacing several files is not a multi-file database transaction. Keep a backup before bulk changes; do not concurrently edit files by hand while the service runs.

Dataset replacement preserves identifier, type, and raster alignment; referenced datasets cannot be deleted. Local reports retain mode, sources, timestamps, missing-data notes, and the operational disclaimer. CSV strings are protected against spreadsheet formula execution. The API is localhost-only and rejects foreign browser write origins. Apart from the bearer-token live ingestion endpoint it is intentionally unauthenticated, and it must not be exposed to a network.
