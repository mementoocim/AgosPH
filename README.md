# AgosPH — See the Flood Before It Arrives

A working local geospatial flood-data workbench for Ilagan, Isabela. React/TypeScript/Vite, CesiumJS 3D, MapLibre 2D, ECharts, Zustand, Tailwind, shadcn-style Radix controls, and a FastAPI/NumPy/Rasterio/Shapely/PyProj backend. No database, cloud deployment, account, or paid API is required.

**DEMONSTRATION DATA IS NOT A FLOOD FORECAST. NOT FOR OPERATIONAL FLOOD FORECASTING.**

## Run on Windows

Prerequisites: Node.js 22.12+ (Node 24 used during verification), Python 3.12+ (Python 3.12 used), and Microsoft Edge for the default Playwright configuration. Python and geospatial packages run in a project-local virtual environment. A normal 64-bit Windows Python installation supports the supplied binary wheels; no standalone GDAL, Docker, database, Redis, or Celery setup is needed.

From PowerShell:

```powershell
Set-Location 'C:\Users\Mico\Desktop\AgosPH'
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
npm.cmd run start:local
```

The setup script also detects the bundled Codex Python runtime on this computer when the Microsoft Store `python.exe` alias cannot run. You can choose a Python executable explicitly:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Python 'C:\path\to\python.exe'
```

Open [AgosPH](http://127.0.0.1:5173/) in a browser. API documentation: [FastAPI docs](http://127.0.0.1:8000/docs). `Ctrl+C` in the launcher stops both servers.

### Separate installation/start commands

```powershell
# Use your actual Python 3.12+ path if the python command is a Store alias.
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock.txt
npm.cmd ci

# Terminal 1: backend
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

# Terminal 2: frontend
npm.cmd run dev

# Open after both services are ready
Start-Process 'http://127.0.0.1:5173/'
```

The first backend start creates the clearly labeled demonstration GeoTIFFs and two compatible scenario manifests automatically. To seed without starting the server:

```powershell
npm.cmd run seed
```

To explicitly reload the demonstration fixture scenarios after deleting them:

```powershell
Invoke-RestMethod -Method Post 'http://127.0.0.1:8000/api/demo/load'
```

This restores demonstration scenario definitions; it never creates operational readings or predictions. Existing imported data and alert history remain in place. Rasters left by older or interrupted fixture runs are pruned on startup.

The terrain demonstrations are generated in the background on startup (about 15 seconds) whenever an imported terrain DEM and imported river lines exist, and regenerated when those inputs change. To regenerate them explicitly:

```powershell
Invoke-RestMethod -Method Post 'http://127.0.0.1:8000/api/demo/terrain'
```

## Prototype evaluation walkthrough

1. Open Command. The map is centered near Ilagan with genuine OpenStreetMap reference tiles. When an imported DEM exists (the prepared Copernicus GLO-30 DSM), it drives the 3D terrain automatically; the map notice states the source and that heights stay in the DEM's vertical datum. Without a DEM the flat **ellipsoid reference** is labeled instead. Imported rivers, barangays, roads, bridges and facilities are drawn in both data modes; the Cagayan, Pinacanauan de Ilagan ("Ilagan River" in OSM), Abuan and Bintacan rivers are emphasized and labeled.
2. Switch to **DEMO MODE** and open Simulation. Select **Terrain demonstration · moderate river rise** or **· high river rise** (generated automatically in the background on startup from the imported DEM and OSM river lines, or with **Regenerate terrain demonstration** in Scenarios). Play, pause, stop, restart, select a frame, set the speed, or choose a time window. Water spreads from the river channels into connected low-lying terrain over 36 hours. These are clearly labeled illustrative scenarios with assumed river stages — not forecasts. The synthetic 32×32 **Playback laboratory A/B** grids remain as test fixtures.
3. Click the map to inspect depth, velocity, flow direction, **arrival time**, **peak depth** and peak time, with source and validation label. Outside the raster or on NoData, the inspector reports **OUTSIDE MODEL**.
4. Choose the other scenario and click **Compare side by side**. Grid and elapsed-time compatibility are checked. Primary camera movement synchronizes the comparison map. Use 2D/3D controls to switch renderers.
5. Open Monitoring. Replay or step readings through watch/warning/critical thresholds. Test a disconnect and reconnect. Open the bell to filter, acknowledge, and resolve local **TEST** alerts. Nothing is transmitted as a public warning. The **Live telemetry** list above the replay shows only readings received through [authorized ingestion](#live-sensor-ingestion-authorized-sources-only), with **LIVE**, **STALE**, or **UNAVAILABLE** badges, receipt time, and source. Replay stations are badged **DEMO** or **REPLAY**.
6. In Command, use **Incident log → Log incident** to record a field report: type (flooding, landslide, road closure, rescue request, evacuation, other), severity, title, details, who reported it, and the report time in PHT. Type the barangay (it is matched against the imported barangay boundaries, accepting forms like "Brgy. San Vicente" or "Abuan", and saved **unchecked** when no boundary layer exists), then **Pick location on map** and click the map; the barangay containing the point is suggested. The incident appears in the panel and as a severity-colored diamond on the map (resolved ones gray). Move it forward with the status selector: reported → verified → responding → resolved; steps may be skipped, never reversed, and resolving asks for confirmation. In DEMO MODE every record is saved and drawn as an **EXERCISE**; in imported-data mode it is an **OPERATOR LOG · USER-ENTERED** report, and "verified" is the operator's own confirmation. No incidents are ever seeded, and nothing is transmitted.
7. Open Rainfall. Choose a station, change the demonstration rainfall series, compare the two test series, choose a time range, and replay the cursor. Imported rainfall GeoTIFFs with observation timestamps support geographic layer animation. This does not change the flood arrays or generate a forecast.
8. Import legitimate GeoJSON, monitoring/rainfall CSV/JSON, HEC-HMS discharge CSV, or georeferenced GeoTIFF through Data Center. Required provenance and format/coordinate checks run before storage. Inspect metadata and the actual processed preview. Uploaded layers become available immediately in imported-data mode.
9. Create an imported scenario: first upload depth GeoTIFF(s), then create a scenario with **Imported · unvalidated** status and attach regularly spaced timestamped frames. Optional velocity, direction, and WSE must share the exact grid. A pending scenario may document assumptions without computed results.
10. Import actual boundaries, roads, bridges, buildings, and facilities with source metadata. Exposure summarizes each barangay (inundated area and share, maximum depth, flooded building footprints, flooded road length) plus roads, bridges and facilities, sampled on the native depth grid, and lists unavailable inputs. Terrain demonstrations may be intersected with imported reference geography and are bannered **ILLUSTRATIVE HAZARD × REAL GEOGRAPHY · NOT AN IMPACT ASSESSMENT**; synthetic test grids never are. No population, casualties, households, or economic losses are invented.
11. Import a real DEM as `terrain` with meter units; Settings defaults to **Automatic · first imported DEM** and can select a specific DEM or **None**. Alternatively configure an authorized Cesium quantized-mesh endpoint. DEM coverage, vertical datum and ellipsoid fallback are labeled. Optional licensed satellite XYZ imagery can be configured with attribution.
12. Save camera views and visualization settings. Create, edit, rename, duplicate, delete, import, or export scenario manifests.
13. Reports exports actual PDF, CSV, inundation GeoJSON, and PNG map capture. Reports include provenance and data-mode limitations. The PDF lists the incident log of the report's data mode, and **CSV content → Exercise/Operator incident log** exports it with status history; exercise records and operator reports are never exported together. Scenarios, settings, data mode, imports, replay state, test alerts, and incidents survive restarting the application.

Keyboard shortcuts: **Space** play/pause; **←/→** step; **Home** rewind; **Esc** pause both replays; **L** layers; **/** geographic search. Search supports imported feature names, datasets, saved cameras, station locations when supplied, and `latitude, longitude`.

## Live sensor ingestion (authorized sources only)

A reading is shown as **LIVE** only when an authorized sensor, logger, or gateway pushes it to `POST /api/monitoring/ingest` with the bearer token configured for the backend. Demonstration fixtures (**DEMO**) and imported history (**REPLAY**) never become live. Without a token the endpoint refuses every request (`503`) and Monitoring shows **INGEST OFF**. PAGASA is listed as a disabled adapter until an authorized endpoint, credentials, and a documented field mapping exist. AgosPH does not scrape PAGASA or any other website.

```powershell
# Once: generate a token. Keep it secret and give it only to the gateway or logger operator.
$env:AGOS_INGEST_TOKEN = .\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"
# Start the backend from the same window so it inherits the token.
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

For an ingestion drill, open a second PowerShell window and set the same `$env:AGOS_INGEST_TOKEN` there:

```powershell
# 1. The operator saves station thresholds. Live stations never get default thresholds.
Invoke-RestMethod -Method Put 'http://127.0.0.1:8000/api/monitoring/drill-gauge/thresholds' -ContentType 'application/json' -Body '{"watch": 2, "warning": 3, "critical": 4}'
# 2. Push a reading above the warning threshold.
.\.venv\Scripts\python.exe scripts\push_live_reading.py --station drill-gauge --name 'Drill gauge' --water-level 3.2 --source 'INGESTION DRILL - typed by CDRRMO staff, not a measurement'
```

What to expect:

- Within seconds the reading appears in Command and Monitoring with a **LIVE** badge, its receipt time, and its source.
- The bell shows a **LIVE · SENSOR THRESHOLD** alert, not a TEST alert.
- With no newer observation it turns **STALE** after 30 minutes (`AGOS_LIVE_STALE_MINUTES`) and **UNAVAILABLE** after 6 hours (`AGOS_LIVE_UNAVAILABLE_MINUTES`).

Drill readings are stored like any other authorized reading. Resolve drill alerts afterwards, or run drills against a separate `$env:AGOS_DATA_DIR`.

The full contract, validation rules, and curl examples are in the [data contracts](docs/DATA_CONTRACTS.md#live-monitoring-ingestion). The backend stays bound to 127.0.0.1, so a field logger must deliver through a gateway on the same machine or through a tunnel or TLS proxy you configure.

## Tests and production build

```powershell
npm.cmd test
npm.cmd run test:backend
npm.cmd run test:e2e
npm.cmd run build
```

Playwright runs isolated services on frontend port 5174 and backend port 8011, using `data/e2e/`. It uses the installed Edge browser. To use Playwright Chromium instead:

```powershell
npx.cmd playwright install chromium
$env:PLAYWRIGHT_CHANNEL = 'chromium'
npm.cmd run test:e2e
```

The build writes `frontend/dist/`. Vite's development proxy connects `/api` and WebSockets to port 8000. A different backend URL can be supplied with `$env:AGOS_BACKEND_URL`. A production static host must provide an equivalent `/api` reverse proxy; `vite preview` alone does not start the backend.

The 3D renderer is a substantial dependency (~4.2 MB JavaScript minified before compression). It is split into its own bundle and Cesium's Workers/Assets/Widgets/ThirdParty files are copied locally. The 2D renderer's MapLibre web worker is copied the same way to `/maplibre/`; without it the 2D map draws basemap tiles but no data layers. Online OpenStreetMap tiles require internet; local imports and reports continue to work without them. For an offline basemap, configure an appropriately licensed localhost XYZ provider. Provider failures are visible and do not create substitute geographic information.

## Storage and source layout

```text
frontend/src/components/   map, operational panels, reusable Radix controls
frontend/e2e/             browser acceptance tests
backend/                  repositories, import/validation, simulation, monitoring,
                          adapter registry, exposure, reporting, FastAPI/WebSockets
tests/                    backend fixtures and integration tests
scripts/                  Windows setup and two-service launcher
docs/DATA_CONTRACTS.md     schemas, scientific methods, limitations, adapter policy
data/geographic/          original imported files and synthetic test rasters
data/terrain/             imported DEMs
data/datasets/            provenance/validation manifests
data/scenarios/           local scenario definitions
data/alerts/              persisted TEST alert records
data/incidents/           operator incident log (EXERCISE records in demo mode)
data/live/                authorized live readings (7-day window per station) and daily receipt logs
data/config/              settings and monitoring replay state
data/reports/             generated PDF/CSV/GeoJSON reports
```

Mutable data is outside frontend source and ignored by Git. Override its location with `$env:AGOS_DATA_DIR = 'C:\path\to\local-data'` before starting FastAPI. Stop the app and copy the entire data directory for backup or migration. JSON repositories use atomic writes and cross-process file locking; repository/service interfaces isolate persistence for later PostGIS integration.

See [data contracts and scientific limitations](docs/DATA_CONTRACTS.md) for required fields, CRS/units/NoData handling, analysis definitions, file limits, and supported HEC-RAS interchange.

Prepared public Ilagan reference data is documented in [the acquisition notes](docs/ILAGAN_PUBLIC_DATA.md), including source dates, coverage limits, attribution, and local import instructions.

## Explicit limitations

- No calibrated model run or live PAGASA/sensor feed is bundled. Live readings appear only after an authorized source pushes them, and the PAGASA adapter stays disabled without an authorized endpoint and credentials. The prepared public reference layers (Copernicus GLO-30 DSM, OSM rivers/roads/bridges/buildings, NAMRIA/PSA barangays, CHIRPS rainfall) are imported data with documented limits; see [the acquisition notes](docs/ILAGAN_PUBLIC_DATA.md).
- Terrain demonstrations are a connectivity-constrained, HAND-style approximation with assumed river stages and Manning-type illustrative velocities. They ignore rainfall-runoff, channel hydraulics, levees, culverts and drainage, use a surface model that includes vegetation and buildings, and are never forecasts.
- The DEM is rendered in its own vertical datum (EGM2008 orthometric for GLO-30); no geoid-to-ellipsoid conversion is applied.
- Persistence is local JSON files, not PostgreSQL/PostGIS, and there is no Docker Compose deployment yet; the repository/service boundary is where a PostGIS implementation would plug in.
- HEC-RAS support is for exported, georeferenced GeoTIFF results and manifests. Raw HDF version attributes are inspected and unsupported structures are rejected. No raw HDF hydraulic extraction is claimed.
- HEC-HMS readiness covers exported hydrograph import/inspection, not model execution or automatic rainfall-to-depth conversion.
- Validation checks alignment and file structure. Scientific validation remains the model owner's responsibility; user assertions are labeled accordingly.
- Exposure is resolution-dependent geographic screening, not a calibrated risk/loss model. Missing inputs remain unavailable.
- Local single-user prototype only: keep the backend bound to 127.0.0.1. Only live ingestion is authenticated (bearer token); every other endpoint is unauthenticated. There is no cloud publishing or public alert delivery.
- The incident log is a local, typed operator record. It neither receives reports from nor sends them to any hotline, SMS, radio, or NDRRMC/OCD system, records no operator identity, and its "verified" status is the operator's own assertion. Barangay matching uses the imported 2023 NAMRIA/PSA names, not certified current boundaries.

Reference cartography: [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). No API key is needed for the default map.
