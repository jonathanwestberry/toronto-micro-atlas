# Data Provenance

Geodata layers for the illustrated interactive map of Toronto (MapLibre GL JS, static site).
All outputs are WGS84 (EPSG:4326) GeoJSON, simplified for web use at zooms ~10-15.
Clip extents (W, S, E, N) differ by role. The interactive map clamps the camera
to the city-fit viewport at min zoom (city dead-centre, no panning) and washes
everything beyond the boundary, so street data only needs to cover the near-city
extent; the wash rectangle is what actually guarantees no bare paper on any
screen aspect.
- Streets (major, minor): near-city `-79.75, 43.45, -79.00, 43.98`.
- Lake / rail: wider `-79.85, 43.45, -78.90, 43.98` (lake must reach the min-zoom
  viewport edge on tall/wide screens or a blue/paper edge shows).
- Watercourses: Toronto + the Rouge `-79.72, 43.55, -79.08, 43.95`.
- Subject layers (ravine, ESA, parks, boundary): Toronto `-79.66, 43.56, -79.09, 43.88`.
- Outside-wash rectangle: `-79.98, 43.30, -78.72, 44.12` (larger than any
  screen's min-zoom viewport, minus the Toronto boundary).

Pipeline: `scripts/run_all.sh` (download -> convert -> process). Retrieval dates:
City of Toronto layers July 1-2, 2026; OSM context re-pulled for the GTA extent July 3, 2026.

## Licenses at a glance

| Source | License | Attribution required |
|---|---|---|
| City of Toronto Open Data | [Open Government Licence - Toronto](https://open.toronto.ca/open-data-license/) | "Contains information licensed under the Open Government Licence - Toronto." |
| OpenStreetMap | [ODbL 1.0](https://www.openstreetmap.org/copyright) | "(c) OpenStreetMap contributors" |

Both attributions must appear on the published map (MapLibre attribution control is sufficient).

---

## City of Toronto datasets

Portal: https://open.toronto.ca (CKAN API: https://ckan0.cf.opendata.inter.prod-toronto.ca).
Publisher: City of Toronto. License: Open Government Licence - Toronto. Retrieved: 2026-07-01.

### 1. Ravine & Natural Feature Protection area (RNFP)
- Dataset page: https://open.toronto.ca/dataset/ravine-natural-feature-protection-area/
- Resource downloaded: `ravine-natural-feature-protection-area-wgs84.zip` (shapefile, WGS84)
  https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/204a7e54-8963-4e35-992e-5f21544ef595/resource/bb81bb0f-f88a-4f3e-bca7-a328154ba31b/download/ravine-natural-feature-protection-area-wgs84.zip
- The by-law boundary of Toronto's protected ravine and natural feature system
  (Municipal Code Chapter 658). This is the "hidden landscape" hero layer.
- **File repairs required** (`scripts/01_download_city.sh` automates both):
  - The published `.shp` has a corrupt header (file-length field says 100 bytes);
    the correct length is patched in before processing.
  - The `.prj` uses non-standard WKT that mapshaper cannot parse; replaced with
    standard EPSG:4326 WKT. Coordinates are already WGS84; no reprojection involved.
- Transformations: 854 by-law polygons dissolved into 1 unified multipolygon,
  simplified (weighted Visvalingam, 25% of removable vertices retained,
  small rings preserved), slivers under 400 m2 removed, clipped to bbox.
  All attributes dropped except a `layer: "rnfp"` tag.
- Sanity check: processed area = 111.0 km2, ~17.6% of Toronto's 630 km2 land area,
  matching the City's published "about 17%" figure for RNFP coverage.
- Output: `processed/ravine-rnfp.geojson`

### 2. Green Spaces
- Dataset page: https://open.toronto.ca/dataset/green-spaces/
- Resource downloaded: `Green Spaces - 4326.geojson`
  https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/9a284a84-b9ff-484b-9e30-82f22c1780b9/resource/7a26629c-b642-4093-b33c-a5a21e4f3d22/download/green-spaces-4326.geojson
- Transformations: filtered to parkland-like classes
  (`Park`, `Open Green Space`, `OTHER_TRCA`, `OTHER_PROVINCIAL_FEDERAL`,
  `Hydro Field/Utility Corridor`), dropping cemeteries, traffic islands,
  boulevards, golf courses, and road-remnant classes. Properties reduced to
  `name` (from AREA_NAME) and `class` (from AREA_CLASS). Simplified (15%),
  cleaned (sliver removal), clipped to bbox, null geometries dropped.
- Output: `processed/green-spaces.geojson`

### 3. Parks
- Dataset page: https://open.toronto.ca/dataset/parks/
- Resource downloaded: `parks-wgs84.zip` (shapefile, WGS84)
  https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/2aac8903-23ff-4072-ab72-b76cac44ad89/resource/9f53c253-a47e-497f-8a07-528f7d7aad90/download/parks-wgs84.zip
- **File repair required**: `.prj` uses non-standard WKT; replaced with standard
  EPSG:4326 WKT (automated in `scripts/01_download_city.sh`).
- Transformations: properties reduced to `name` (from NAME) and `type`
  (from TYPE_DESC). Simplified (15%), cleaned, clipped, null geometries dropped.
- Output: `processed/parks-city.geojson`

### 4. Environmentally Significant Areas (ESA)
- Dataset page: https://open.toronto.ca/dataset/environmentally-significant-areas/
- Resource downloaded: `Environmentally Significant Areas - 4326.geojson`
  https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/ef5a083a-5c2a-4207-9131-dfc917917069/resource/a72afc3e-881b-48f7-9a42-0b1fe55fdf4a/download/environmentally-significant-areas-4326.geojson
- Bonus natural-areas layer (92 designated ESAs). Transformations: properties
  reduced to `name` (from ESA_NAME), simplified (30%), cleaned, clipped.
- Output: `processed/esa.geojson`

### Note: City topographic watercourse layer
The City's topographic mapping series (which includes a watercourse layer) is
not published as a downloadable resource on the open data portal, so
watercourses come from OpenStreetMap instead (below). No manual download step
is required for any layer in this pipeline.

### 11. Regional Municipal Boundary
- Dataset page: https://open.toronto.ca/dataset/regional-municipal-boundary/
- Resource downloaded: `toronto-boundary-wgs84.zip` (shapefile, WGS84)
  https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/841fb820-46d0-46ac-8dcb-d20f27e57bcc/resource/41bf97f0-da1a-46a9-ac25-5ce0078d6760/download/toronto-boundary-wgs84.zip
- The City of Toronto municipal limit (land boundary, one polygon). Drawn as the
  dashed survey-limit line and used to derive the outside-survey mask.
  Retrieved: 2026-07-02.

---

## OpenStreetMap datasets

Source: Overpass API (https://overpass-api.de/api/interpreter), queried for
bbox `43.57, -79.65, 43.87, -79.10` (S, W, N, E). Publisher: OpenStreetMap
contributors. License: ODbL 1.0. Retrieved: 2026-07-01 (OSM base timestamp
2026-07-02T03:45Z). Queries live in `scripts/02_download_osm.py`; raw
Overpass JSON is converted to GeoJSON by `scripts/03_convert_osm.py`.

### 5. Watercourses
- Query: `way["waterway"~"^(river|stream|canal|drain|ditch)$"]`
- Transformations: drains and ditches dropped in processing (mostly buried or
  utility channels); kept `river`, `stream`, `canal`. Properties: `name`,
  `tier` (`river` vs `stream`). Simplified (30%), clipped.
- Output: `processed/watercourses.geojson`

### 6. Lake Ontario shoreline polygon
- Query: relation `1206310` (`name~"Ontario"`, `natural=water`) with full
  member geometry (`out geom`).
- Transformations: all 453 `outer` member ways stitched into the lake's closed
  outer ring (50,458 points); 28 `inner` rings (islands: Toronto Islands etc.)
  near Toronto added as holes; clipped to bbox, then lightly simplified
  (interval 0.00004 deg, ~4.5 m) and cleaned. Properties: `name`, `kind`.
- Output: `processed/lake-ontario.geojson` (475.9 km2 of lake within the bbox)

### 7. Major streets
- Query: `way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$"]`
- Transformations: classified into `tier` = `motorway` (motorway/trunk + links)
  or `major` (primary/secondary + links). Simplified (25%), clipped, then
  dissolved by `tier` + `name` (same-name segments merged into one
  MultiLineString each; `ref` kept for highway shields).
- Output: `processed/streets-major.geojson`

### 8. Minor streets
- Query: `way["highway"~"^(tertiary|tertiary_link|residential|unclassified|living_street)$"]`
- Transformations: quiet context only; all attributes stripped except
  `tier: "minor"`, simplified (25%), clipped, dissolved into a single
  MultiLineString feature.
- Output: `processed/streets-minor.geojson`

### 9. Rail lines
- Query: `way["railway"="rail"]`
- Transformations: classified into `tier` = `rail` (mainline) or `spur`
  (service=spur/yard/siding), simplified (30%), clipped, dissolved by tier
  into 2 MultiLineString features.
- Output: `processed/rail.geojson`

---

## Handcrafted data

### 10. Orientation labels
- Source: handcrafted for this project (no upstream license);
  source of truth is `scripts/orientation_labels.geojson`.
- 14 point features for map orientation: Lake Ontario, Downtown, Don Valley,
  Humber River, Scarborough, Etobicoke, North York, East York, Rouge,
  Toronto Islands, High Park, Scarborough Bluffs, Yonge & Bloor,
  Yonge & Eglinton. Properties: `name`, `kind`
  (`water` | `area` | `valley` | `landmark` | `crossroad`).
- Coordinates are approximate label anchors, not surveyed locations.
- Output: `processed/orientation-labels.geojson`

---

## Derived layers

### 12. Outside-survey wash
- `04_process.sh` step 12: a rectangle (`BBOX_WASH`) minus the municipal
  boundary polygon, drawn as a 72% paper fill so the GTA context reads as a
  faint ghost and Toronto reads as the figure. No external source; inherits the
  boundary's Open Government Licence - Toronto.
- The rectangle is larger than any screen's min-zoom viewport (the camera clamps
  to that extent), so its outer edge is never reachable and it needs no soft
  feather. Output: `processed/outside-mask.geojson`.

### 13. Edge-feather rings (REMOVED)
- The old `feather-inner` / `feather-outer` rings that faded the wash to pure
  paper before a hard data rectangle are gone: with GTA data underneath and the
  camera clamped inside the wash rectangle, there is no reachable data edge to
  feather.

---

## Field Guide 02: Sidewalk Forest

### 14. Street Tree Data
- Dataset page: https://open.toronto.ca/dataset/street-tree-data/
- Resource downloaded: `Street Tree Data - 4326.geojson` (343 MB, WGS84)
  https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/6ac4569e-fd37-4cbc-ac63-db3624c5f6a2/resource/d6089672-bdf7-4857-8ea8-90da826fcfa1/download/street-tree-data-4326.geojson
- Publisher: City of Toronto, Parks, Forestry & Recreation (Urban Forestry).
  License: Open Government Licence - Toronto. Retrieved: 2026-07-12;
  portal last-refreshed 2026-06-04.
- 688,335 street trees (city-maintained trees on road allowances), each with
  BOTANICAL_NAME, COMMON_NAME, DBH_TRUNK (cm), ADDRESS, STREETNAME, WARD.
  Geometries arrive as single-position MultiPoints; unwrapped to Points.
- Known data quirks handled in processing (`scripts/11_process_trees.py`):
  lowercase 'ginkgo biloba' rows normalized; DBH values outside 1-250 cm
  treated as data-entry errors and omitted from popups; a handful of
  malformed single-value coordinates skipped.
- Pipeline (`scripts/10_download_trees.sh` -> `11_process_trees.py` ->
  `12_tile_trees.sh` -> `13_render_trees.py`; Python deps via
  `scripts/.venv`: numpy, Pillow; tiling via tippecanoe):
  - `processed/trees-tiling.ndjson`: minimized attributes (`g` genus
    category, `s` species index, `d` DBH, `a` civic address).
  - `public/tiles/trees/{z}/{x}/{y}.pbf`: z13-z14 static vector tiles,
    full density (no feature dropping), uncompressed protobuf
    (`--no-tile-compression`; static hosts send no Content-Encoding).
  - `public/data/fg02/r/*.webp`: exact-count dot renders (one dot per
    record) in Web Mercator, used as image sources below z13.2.
  - `public/data/fg02/meta.json`: species lookup, genus categories with
    validated colors, story stats. `streets.json`: street-name search index
    (centroids of per-street tree positions; streets with <3 trees dropped).
- Editorial claims in the guide and where they come from:
  - Counts (total, per-genus, Norway vs sugar maple, ginkgo, ash vs lilac,
    ward most/least, 15 singleton species) recomputed from this dataset.
  - Ward names: City of Toronto ward profiles (25-ward system).
  - Emerald ash borer first found in Toronto 2007: City of Toronto Urban
    Forestry EAB page; TRCA.
  - Norway maple invasive status: Ontario Invasive Plant Council BMP (2021).

---

## Field Guide 03: When Toronto Has to Go

Phase 1 proof retrieved and generated: 2026-07-21. All City datasets use the
Open Government Licence, Toronto. Raw downloads live in ignored
`raw/fg03/`; dated proof outputs live in `proof/fg03/2026-07-21/`.

### Facility sources

| Source | Input grain used in the proof | Official page |
|---|---:|---|
| Park Washroom Facilities | 354 facility rows | https://open.toronto.ca/dataset/washroom-facilities/ |
| Library Branch General Information | 82 branches marked as having public washrooms | https://open.toronto.ca/dataset/library-branch-general-information/ |
| CREM Portfolio Washrooms | 117 public-access washroom records consolidated into 12 buildings | https://open.toronto.ca/dataset/corporate-real-estate-management-portfolio-washrooms/ |
| Museums and Cultural Centres | 10 locations | https://open.toronto.ca/dataset/museums-and-cultural-centres/ |
| Automated Public Washrooms | 4 seasonal locations | https://open.toronto.ca/dataset/street-furniture-public-washroom/ |
| TTC station washrooms | 15 source rows consolidated into 14 station names; Vaughan Metropolitan Centre is outside Toronto, leaving 13 Toronto locations | https://www.ttc.ca/riding-the-ttc/Washrooms-at-TTC-subway-stations |

The Park Washroom Facilities extract includes washrooms in community centres,
pools, rinks, fieldhouses, and other Parks and Recreation locations. Its 354
rows should not be described as 354 standalone park buildings.

For 101 Parks and Recreation rows whose hours field links to centre hours, the
pipeline retrieves the City's facility JSON and converts its daily opening and
closing values into the same weekly schedule model. Published status values are
applied as open, partially open, or temporarily closed.

The source feed contains presentation placeholders rather than schedules on
some days. `Location` paired with `Closed` is normalized to closed.
`Permits` paired with `Only` is also closed for unrestricted general-public
access, while other explicit days on the same facility remain usable. The one
split Tuesday interval ending with `and` is joined to its second interval
before parsing. These rules moved 24 records from unknown to explicit schedule
states without changing the 10 p.m. or 12:30 a.m. open-facility counts.

The museums file does not provide coordinates. The pipeline resolves the ten
published civic addresses against the City Address Points datastore. The four
automated washrooms remain `hours unknown` because the source publishes their
season but not their daily hours.

### Activity and network sources

| Source | Role | Official page |
|---|---|---|
| Merged TTC GTFS | Scheduled stop activity within 15 minutes of each snapshot | https://open.toronto.ca/dataset/merged-gtfs-ttc-routes-and-schedules/ |
| Pedestrian Network | 400 m shortest-path catchments | https://open.toronto.ca/dataset/pedestrian-network/ |
| Regional Municipal Boundary | Toronto-only filtering | https://open.toronto.ca/dataset/regional-municipal-boundary/ |

The active-stop measure means that at least one scheduled departure or arrival
falls within the 30-minute observation window. It is a service-activity measure,
not ridership or passenger demand.

The City Pedestrian Network is optimized for topology rather than cartographic
fidelity and has documented completeness and classification limits. Facility
and TTC stop snap distances count toward the 400 m cutoff. No in-boundary
facility in this proof snapped more than 200 m from the network.

### Phase 1 consolidation and headline proof

- CREM washroom rows collapse to public-access buildings. Passenger-only VIA
  facilities are excluded.
- Same-address facility records within 100 m share an access-point cluster for
  headline counts. Their individual coordinates and schedules remain in the
  coverage calculation.
- Six cross-source pairs within 50 m were manually inspected. Decisions are in
  `fg03/nearby-pair-audit.csv`.
- Unknown hours remain a separate state and never become scheduled closure.
- The four snapshots use Tuesday, 2026-07-21 at noon, 8:30 p.m., 10 p.m., and
  12:30 a.m. on the following service day.
- Phase 1 does not rank priority areas or claim passenger demand. Distance
  sensitivity at 300 m and 500 m belongs to the Phase 2 analytical prototype.

The corrected Phase 1 headline counts are:

| Snapshot | Unrestricted open access points | Fare-paid TTC facilities | Active grouped transit points | Covered by unrestricted access |
|---|---:|---:|---:|---:|
| Noon | 324 | 13 | 8,142 | 987 |
| 8:30 p.m. | 242 | 13 | 8,007 | 623 |
| 10 p.m. | 6 | 13 | 7,994 | 18 |
| 12:30 a.m. | 1 | 13 | 7,885 | 8 |

Phase 2 also retains raw GTFS platform, event, and unique-trip metrics for
intervention analysis. Those values are separately named in the browser
manifest and must not replace the grouped Phase 1 headline denominator.

### Phase 2 network and intervention analysis

`scripts/22_build_washroom_analysis.py` builds the projected pedestrian graph
in EPSG:2952 from every source vertex, inserts stable facility and stop snaps,
and retains each perpendicular snap offset in the walking cost. It performs one
baseline multi-source search per scenario and caches one bounded candidate
search per source node. Distances of 300, 400, and 500 metres are thresholds of
the same network result, not separate Euclidean buffers.

The reviewed real-network invariants are 87,105 source features, 72,590 source
vertices, 72,592 base nodes, 95,046 base edges, and four components. Two
at-grade crossings that the source geometry leaves microscopically
disconnected are explicitly joined, and the published length anomalies for
source objects 55,757 and 60,345 use reviewed projected-geometry overrides.
The exact decisions and coordinates are in
`fg03/network-topology-exceptions.csv`. Grade-separated crossings are not
automatically planarized.

The primary opportunity universe uses Tuesday at 10 p.m. and 12:30 a.m.,
unrestricted access, observed closures, unknown information treated as
unavailable, and 400 metre walking distance. It evaluates four intervention
classes:

- extend scheduled hours;
- investigate a new-facility zone;
- verify missing hours or accessibility information;
- retrofit a confirmed inaccessible open facility.

Material gain requires at least 10 unique scheduled trips across the two late
snapshots and at least three active stops at 400 metres. Verification gains are
always labeled as potential. Ranking is repeated under 300 and 500 metre
distance, rider-conditional access, normal operations, optimistic information,
and Saturday sensitivities. New-zone candidates with at least 80 percent
effect overlap against an earlier kept candidate are removed from the frozen
candidate universe.

The manual audit inspects the top robust candidates in each available ranking
group. Decisions are valid only for the exact generated analysis hash and
record source evidence, coordinates, network context, duplication, and the
generated audit map. Four proposed new-facility zones are excluded from the
published evidence:

- Mount Dennis, because the nearby library makes it a scheduled-hours problem;
- Kennedy, Scarborough Centre, and Main Square, because severe straight-line
  versus modeled-network discrepancies make the geographic-gap claim
  unreliable without more station-area topology or entrance data.

Nine otherwise source-valid verification candidates are also excluded because
their measured primary gain fails the published trip or active-stop
materiality threshold. They remain in the proof tables with their ranks and
metrics, but they are not published as audited opportunities.

The release gate counts only audit-valid robust material opportunities. It
also requires at least five counted opportunities, at least two hours-extension
opportunities, and no source, duplication, or access-condition integrity flag.
The dated release passes with 25 counted opportunities: 10 hours extensions,
6 new-facility investigation zones, and 9 information-verification actions.
No accessibility-retrofit candidate met the audited robust material threshold.

### Phase 2 outputs and privacy

The dated analytical package is `proof/fg03/2026-07-21/phase2/`. It contains
candidate tables, sensitivity ranks, stop-gap evidence, audit evidence and
maps, a build report, and a proof-only intervention GeoJSON.

The browser contract is `public/data/fg03/2026-07-21/`:

- `manifest.json` freezes schema version 1, defaults, allowed URL values,
  sources, limitations, headline counts, gate result, and dated file URLs;
- `facilities.geojson` includes unrestricted and fare-paid point evidence;
- four `stops-*.geojson` files contain the active snapshot and the complete
  public versus rider-conditional, 300/400/500 metre coverage matrix;
- `interventions.geojson` contains only audit-valid robust opportunities with
  the complete query matrix;
- `reach-facilities.geojson` and `reach-promoted.geojson` contain clipped real
  pedestrian-network `MultiLineString` reaches.

Raw GTFS trip IDs are forbidden from every public key and string value.
Fare-paid geometry is published because the rider view needs it, but fare-paid
facilities and interventions are inactive for unrestricted public coverage.
Every individual public file must remain below 1.5 MB after gzip compression.
The build writes into temporary directories and replaces the dated proof and
public directories only after topology, schema, privacy, geometry, cross-file,
and size checks pass.

---

## Processing environment

- mapshaper 0.7.34 via `npx` (no global install), Node.js v25, and Python 3.
- FG03 dependencies are frozen in `scripts/requirements-fg03.txt` and include
  GeoPandas, NetworkX, Shapely, PyProj, Matplotlib, and the Phase 1 rendering
  dependencies. The focused synthetic tests do not require the ignored raw
  snapshot.
- Coordinate precision in outputs: 5 decimal places (~1.1 m), adequate for zoom 15.
- Simplification method: mapshaper default (weighted Visvalingam) with
  `keep-shapes` on polygon layers; percentages were tuned empirically against
  a <3 MB per-file budget. Beware: a bare number passed to `-simplify` is the
  *proportion of removable vertices retained*, not a tolerance.
- Raw downloads are kept in ignored `raw/` directories. The FG03 TTC GTFS
  archive is approximately 77 MB; it is reproducible and is not committed.
- Geofabrik Ontario extract was **not** needed; all OSM layers succeeded via
  Overpass with single-bbox queries.

---

## FG04 (shade guide) sources

Downloaded 2026-08-06. Guide four maps **shade only**, never temperature.

### Ontario lidar, GTA 2023

- Digital Surface Model and Digital Terrain Model, LiDAR-derived, 1 km tiles.
- Tile index: `https://www.publicdocs.mnr.gov.on.ca/mirb/OntarioDSM_LidarDerived_TileIndex.zip`
  (194,738 rows covering all Ontario lidar projects).
- Packages: `https://ws.gisetl.lrc.gov.on.ca/fmedatadownload/Packages/GTA2023-{DSM,DTM}-NN.zip`
  for NN in 04, 05, 08, 09, 10.
- Tiles are extracted individually by HTTP byte range against the remote zip
  central directory, so the ~31 GB of packages is never downloaded whole.
- **727 DSM tiles and 727 matching DTM tiles.** The product plan records 1031;
  that figure came from intersecting the index with Toronto's bounding box.
  Selection here is against the real municipal boundary, which drops 304 tiles
  lying in Lake Ontario, Peel and York. Same five packages either way.
- Flown April to May 2023, so **leaf-off**. This is the guide's central data
  risk and the reason `fg04_canopy` exists.
- 0.5 m, 2000 x 2000 per tile, float32.
- **CRS is EPSG:6660** (NAD83(CSRS)v6 / UTM 17N) as declared by the tiles
  themselves, not EPSG:2958 as the product plan states. The two are the same
  projection under different NAD83(CSRS) realizations and agree far below a
  centimetre, but they are not interchangeable to rasterio, so anything that
  merges or reprojects must not hardcode 2958.
- Licence: Open Government Licence Ontario. Derived products permitted with
  attribution.

### Toronto Forest and Land Cover, 2018 Tree Canopy Study

- Dataset `61642048-56bb-4050-b7c3-f569fcf94527`,
  resource `69419e11-2dfa-4bcc-bed0-43a9dd2d0973`, `landcover2018_gdb.zip`.
- 436,398,730 bytes, downloaded 2026-08-06.
- Derived from **leaf-on** imagery, 8 classes including tree canopy and
  buildings as separate classes.
- Used for two jobs: the leaf-on canopy correction, and the building versus
  tree split.
- Vintage gap: land cover is 2018, lidar is 2023. Five years of growth and
  removal sit between them, in both directions.
- The implementation plan states this has no stable direct URL and must be
  fetched by hand. It does have one, via the CKAN resource above.
- Licence: Open Government Licence Toronto.

### Neighbourhood Improvement Areas

- Dataset `3b471f62-dc01-4a96-bb76-f794e4c6b860`,
  resource `8b6a2d2a-d398-484f-99b5-f686f31f815d`,
  `neighbourhood-improvement-areas-4326.geojson`. Downloaded 2026-08-06.
- Not resource `2937a4ec-...`, which the implementation plan named. That id is
  the CKAN **datastore dump** endpoint and returns CSV regardless of the
  filename appended to it, so geopandas cannot read its geometry.
- **33 live MultiPolygon features**, EPSG:4326, no expired rows
  (every `DATE_EXPIRY` is the 3000-01-01 sentinel).
- The product plan records "31 of 140 neighbourhoods, 2011 census tracts".
  That is stale. `AREA_SHORT_CODE` reaches 141, 142, 154 and 155, which cannot
  exist in the 140-neighbourhood system, so the layer as refreshed
  2026-02-20 is published on Toronto's current **158-neighbourhood** system.
  The plan's risk of chapter 5 being cut for a lossy join does not arise.
- Licence: Open Government Licence Toronto.
