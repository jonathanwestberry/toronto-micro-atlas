# Data Provenance

Geodata layers for the illustrated interactive map of Toronto (MapLibre GL JS, static site).
All outputs are WGS84 (EPSG:4326) GeoJSON, clipped to the Toronto extent
`-79.66, 43.56, -79.09, 43.88` (W, S, E, N) and simplified for web use at zooms ~10-15.

Pipeline: `scripts/run_all.sh` (download -> convert -> process). Retrieval dates: July 1-2, 2026.

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

### 12. Outside-survey mask
- Derived in `04_process.sh` step 12: a padded rectangle (-80.00, 43.35, -78.75, 44.05)
  minus the municipal boundary polygon. The rectangle exceeds the map's
  maxBounds with margin so the pan/zoom limits never expose bare paper.
  No external source; inherits the boundary's Open Government Licence - Toronto.
- Drawn as a 78% paper-color wash so OSM context outside Toronto reads as
  context rather than subject.

### 13. Edge-feather rings
- Derived in `04_process.sh` step 12b: two rectangle rings (minus the
  municipal boundary) stacked above the outside-mask at 42% and 100% paper,
  stepping the ghosted context down 22% -> 13% -> 0% before the clipped
  data extent so no zoom level exposes a hard data rectangle.
- Outputs: `processed/feather-inner.geojson`, `processed/feather-outer.geojson`.

---

## Processing environment

- mapshaper 0.7.34 via `npx` (no global install), Node.js v25, Python 3 (stdlib only).
- Coordinate precision in outputs: 5 decimal places (~1.1 m), adequate for zoom 15.
- Simplification method: mapshaper default (weighted Visvalingam) with
  `keep-shapes` on polygon layers; percentages were tuned empirically against
  a <3 MB per-file budget. Beware: a bare number passed to `-simplify` is the
  *proportion of removable vertices retained*, not a tolerance.
- Raw downloads are kept in `raw/` (largest is ~36 MB; nothing exceeded the
  100 MB threshold that would have required deletion after processing).
- Geofabrik Ontario extract was **not** needed; all OSM layers succeeded via
  Overpass with single-bbox queries.
