# When Toronto Has to Go Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, integrate, test, and release the third Toronto Micro-Atlas guide at `/guides/when-toronto-has-to-go/`, backed by a reproducible Phase 2 intervention analysis and a dated public data contract.

**Architecture:** Extend the existing Python proof pipeline into pure transit, analysis, and intervention modules, then export a small versioned browser contract containing facilities, late-service stops, and audited intervention candidates. Build one Astro editorial route that renders its central argument and accessible intervention list as HTML, then progressively enhances it with a deferred MapLibre explorer, validated URL state, synchronized search/list/detail views, and graceful partial-failure behavior. Reuse the existing site shell, Archivo and Source Serif 4 typography, survey-document tokens, local map context layers, metadata utilities, and Cloudflare Pages workflow.

**Tech Stack:** Python 3.14, unittest, GeoPandas, NetworkX, SciPy, Astro 5, TypeScript, native Node test runner, MapLibre GL JS 5, CSS, Cloudflare Pages.

## Global Constraints

- The public route is exactly `/guides/when-toronto-has-to-go/`.
- The production URL is exactly `https://torontomicroatlas.com/guides/when-toronto-has-to-go/`.
- Existing production behavior and repository conventions take precedence over the Figma file when they conflict.
- Keep Archivo Variable for headings and interface text, and Source Serif 4 Variable for editorial prose.
- Apply the Figma system's 4 px spacing rhythm, 1,200 px content grid, flat surfaces, restrained borders, and warm-ground token discipline without importing its conflicting Bebas Neue, Barlow Condensed, or Space Mono typography.
- Reuse Astro, MapLibre GL JS, the shared `Base.astro` shell, and existing public Toronto context layers. Add no framework, state-management library, or second mapping library.
- Preserve all existing guide routes and behavior.
- Never use the visual map as the only source of important information.
- Meet WCAG 2.2 Level AA, including keyboard operation, visible focus, semantic landmarks, non-color meaning, 44 px touch targets, reduced motion, browser zoom, large text, and a synchronized accessible list.
- The first view must state the central finding without requiring interaction.
- Default analytical state is Tuesday 2026-07-21, 10 p.m., unrestricted public access, 400 metre pedestrian-network distance, observed closures, and scheduled-hours interventions.
- Publish noon, 8:30 p.m., 10 p.m., and 12:30 a.m. snapshots. Keep rider-conditional fare-paid access distinct from unrestricted access.
- Count unique `trip_id` values once per intervention catchment. Never describe scheduled TTC activity as passenger demand or ridership.
- Keep scheduled, seasonal, temporary, construction, accessibility, and information gaps distinct.
- Rank intervention classes separately. Do not create a weighted need score.
- A material gain requires at least 10 newly covered unique scheduled trips across the two late snapshots and at least 3 active stops at 400 metres.
- Do not publish a construction-ready claim. New-facility candidates are investigation zones only.
- All generated public data must be dated under `public/data/fg03/2026-07-21/` and carry schema version `1`.
- Meaningful state uses validated readable URL parameters: `time`, `access`, `walk`, `action`, `place`, and optional `map`.
- Canonical and social metadata must remain query-free and point to `torontomicroatlas.com`.
- Analytics must contain no raw search query, precise user location, pointer movement, or continuous pan data.
- No placeholder copy, avoidable console errors, or avoidable console warnings may ship.
- Never use an em dash in source copy, documentation, comments, or commit messages.
- Every new production function follows red, green, refactor. The failing test must be observed before implementation.

---

### Task 1: Make Phase 1 access and closure semantics explicit

**Files:**
- Modify: `data/scripts/fg03_proof.py`
- Modify: `data/scripts/21_build_washroom_proof.py`
- Modify: `data/scripts/tests/test_fg03_proof.py`
- Regenerate: `data/proof/fg03/2026-07-21/facilities.csv`
- Regenerate: `data/proof/fg03/2026-07-21/facility-states.csv`
- Regenerate: `data/proof/fg03/2026-07-21/summary.json`
- Modify: `data/proof/fg03/2026-07-21/README.md`

**Interfaces:**
- Consumes: existing `Facility`, source loaders, schedule parser, and dated raw park/TTC records.
- Produces: `Facility.access_condition: Literal["unrestricted", "fare_paid"]`, `Facility.closure_category: Literal["none", "seasonal", "temporary", "construction"]`, CSV columns with those exact names, and a `--raw-dir` builder option so isolated worktrees can use the authoritative ignored snapshot without copying it.

- [ ] **Step 1: Write failing source-semantics tests**

Add focused tests proving TTC facilities use `fare_paid`, all other included sources use `unrestricted`, `"Closed for the Season"` maps to `seasonal`, `"Under Construction"` maps to `construction`, repairs and technical issues map to `temporary`, and blank notes map to `none`.

```python
def test_closure_reason_maps_to_distinct_policy_category(self):
    self.assertEqual(classify_closure_category("Closed for the Season"), "seasonal")
    self.assertEqual(classify_closure_category("Under Construction"), "construction")
    self.assertEqual(classify_closure_category("Maintenance/Repairs"), "temporary")
    self.assertEqual(classify_closure_category(""), "none")
```

- [ ] **Step 2: Run the targeted test and observe the expected failure**

Run:

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest \
  data.scripts.tests.test_fg03_proof.SourceConsolidationTests -v
```

Expected: fail because `classify_closure_category` and the new dataclass fields do not exist.

- [ ] **Step 3: Add the minimal semantic model**

Implement:

```python
AccessCondition = Literal["unrestricted", "fare_paid"]
ClosureCategory = Literal["none", "seasonal", "temporary", "construction"]

def classify_closure_category(reason: str) -> ClosureCategory:
    value = (reason or "").lower()
    if "closed for the season" in value:
        return "seasonal"
    if "under construction" in value:
        return "construction"
    if any(term in value for term in (
        "maintenance", "repair", "technical", "planned closure", "planned work"
    )):
        return "temporary"
    return "none"
```

Set source defaults at construction time, not in the exporter. Preserve partial closures as available with their note.

- [ ] **Step 4: Export and validate the new columns**

Update the Phase 1 CSV writer and JSON serialization. Add assertions that every row contains an allowed value and every TTC row is `fare_paid`.

- [ ] **Step 5: Run all FG03 tests and regenerate Phase 1**

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover \
  -s data/scripts/tests -p 'test_fg03*.py' -v
data/scripts/.venv/bin/python data/scripts/21_build_washroom_proof.py
```

Expected: all tests pass, 475 Toronto facilities remain, and generated outputs document the new semantics.

In the isolated worktree, run the builder as:

```bash
data/scripts/.venv/bin/python data/scripts/21_build_washroom_proof.py \
  --raw-dir /Users/jonathanwestberry/Projects/toronto-micro-atlas/data/raw/fg03
```

- [ ] **Step 6: Commit**

```bash
git add data/scripts/fg03_proof.py data/scripts/21_build_washroom_proof.py \
  data/scripts/tests/test_fg03_proof.py data/proof/fg03/2026-07-21
git commit -m "feat: classify FG03 access and closure conditions"
```

### Task 2: Extract reusable GTFS activity with service-day correctness

**Files:**
- Create: `data/scripts/fg03_transit.py`
- Create: `data/scripts/tests/test_fg03_transit.py`
- Modify: `data/scripts/21_build_washroom_proof.py`

**Interfaces:**
- Consumes: a GTFS zip path, an ISO service date, snapshot minute, and window minutes.
- Produces: `ActiveStopEvent(stop_id, parent_station, stop_name, trip_id, route_id, event_minute, lon, lat)`; `resolve_service_ids(zip_path, service_date) -> set[str]`; `active_stop_events(...) -> list[ActiveStopEvent]`; `aggregate_catchment(events, stop_ids) -> ActivityMetrics`.

- [ ] **Step 1: Write failing transit tests**

Cover `HH:MM:SS` values beyond 24 hours, `calendar.txt` plus `calendar_dates.txt` exceptions, 12:30 a.m. as minute 1470 on the prior service day, retained parent-station metadata, and catchment trip deduplication.

```python
def test_one_trip_stopping_twice_counts_once(self):
    metrics = aggregate_catchment(self.events, {"stop-a", "stop-b"})
    self.assertEqual(metrics.unique_trips, 1)
    self.assertEqual(metrics.active_stops, 2)
    self.assertEqual(metrics.stop_time_events, 2)
```

- [ ] **Step 2: Run the new test and observe the expected import failure**

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest \
  data.scripts.tests.test_fg03_transit -v
```

- [ ] **Step 3: Implement immutable transit records and pure parsers**

Use frozen dataclasses and set-based trip/route aggregation. Keep raw event count separate. Validate missing GTFS members with a message naming the missing file.

- [ ] **Step 4: Move Phase 1 GTFS interpretation onto the shared module**

Replace duplicated calendar, time, and stop-event logic in the builder. Preserve the existing four Phase 1 snapshot totals within documented tolerances.

- [ ] **Step 5: Run transit tests, all FG03 tests, and regenerate Phase 1**

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover \
  -s data/scripts/tests -p 'test_fg03*.py' -v
data/scripts/.venv/bin/python data/scripts/21_build_washroom_proof.py
```

Pass the same absolute `--raw-dir` shown in Task 1 when running inside the isolated worktree.

- [ ] **Step 6: Commit**

```bash
git add data/scripts/fg03_transit.py data/scripts/21_build_washroom_proof.py \
  data/scripts/tests/test_fg03_transit.py data/proof/fg03/2026-07-21
git commit -m "refactor: share FG03 transit activity logic"
```

### Task 3: Implement pure gap, ranking, intervention, and gate logic

**Files:**
- Create: `data/scripts/fg03_analysis.py`
- Create: `data/scripts/fg03_interventions.py`
- Create: `data/scripts/tests/test_fg03_analysis.py`
- Create: `data/scripts/tests/test_fg03_interventions.py`

**Interfaces:**
- Consumes: Phase 1 facility states, active stop events, pedestrian-network distances, and explicit scenario settings.
- Produces: `Scenario`, `GapEvidence`, `ActivityMetrics`, `CandidateGain`, `classify_gap`, `rank_candidates`, `stability_category`, `has_material_gain`, `evaluate_product_gate`, `simulate_hours_extensions`, `simulate_new_facility_zones`, `simulate_information_verification`, and `simulate_accessibility_retrofits`.

- [ ] **Step 1: Write failing analysis tests**

Test access filtering, coexisting gap flags, unknown accessibility, lexicographic ranking, non-applicable sensitivity handling, material gain, and the four-condition product gate.

```python
def test_unrestricted_mode_excludes_fare_paid(self):
    available = eligible_facilities(self.facilities, access_mode="public")
    self.assertEqual([item.facility_id for item in available], ["library:1"])
```

- [ ] **Step 2: Run analysis tests and observe the expected import failure**

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest \
  data.scripts.tests.test_fg03_analysis -v
```

- [ ] **Step 3: Implement analysis dataclasses and pure rules**

Represent each gap as a boolean field with nearest supporting facility and network distance. Use tuple sort keys rather than a score. Count combined late trips by `(snapshot, trip_id)`.

- [ ] **Step 4: Write failing intervention tests**

Prove incremental coverage only, hours-candidate exclusions, 80 percent effect-overlap deduplication, potential labels for information candidates, and explicit barriers for retrofit candidates.

- [ ] **Step 5: Run intervention tests and observe the expected import failure**

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest \
  data.scripts.tests.test_fg03_interventions -v
```

- [ ] **Step 6: Implement the four intervention simulations**

All simulators return flat `CandidateGain` records with stable IDs, coordinates, class, facility evidence, per-snapshot metrics, combined metrics, primary rank, sensitivity ranks, stability, and material-gain flag.

- [ ] **Step 7: Run all FG03 tests**

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover \
  -s data/scripts/tests -p 'test_fg03*.py' -v
```

- [ ] **Step 8: Commit**

```bash
git add data/scripts/fg03_analysis.py data/scripts/fg03_interventions.py \
  data/scripts/tests/test_fg03_analysis.py data/scripts/tests/test_fg03_interventions.py
git commit -m "feat: model FG03 gaps and intervention gains"
```

### Task 4: Build, audit, and export the dated Phase 2 browser contract

**Files:**
- Create: `data/scripts/fg03_network.py`
- Create: `data/scripts/22_build_washroom_analysis.py`
- Create: `data/scripts/tests/test_fg03_network.py`
- Create: `data/scripts/tests/test_fg03_analysis_build.py`
- Create: `data/fg03/network-topology-exceptions.csv`
- Create: `data/fg03/phase2-audit-decisions.csv`
- Create: `data/proof/fg03/2026-07-21/phase2/README.md`
- Generate: `data/proof/fg03/2026-07-21/phase2/*`
- Generate: `public/data/fg03/2026-07-21/manifest.json`
- Generate: `public/data/fg03/2026-07-21/facilities.geojson`
- Generate: `public/data/fg03/2026-07-21/interventions.geojson`
- Generate: `public/data/fg03/2026-07-21/reach-facilities.geojson`
- Generate: `public/data/fg03/2026-07-21/reach-promoted.geojson`
- Generate: `public/data/fg03/2026-07-21/stops-1200.geojson`
- Generate: `public/data/fg03/2026-07-21/stops-2030.geojson`
- Generate: `public/data/fg03/2026-07-21/stops-2200.geojson`
- Generate: `public/data/fg03/2026-07-21/stops-0030.geojson`
- Modify: `data/README.md`
- Modify: `data/provenance.md`

**Interfaces:**
- Consumes: Tasks 1 to 3, `completegtfs.zip`, `pedestrian-network.gpkg`, the dated Phase 1 proof, and Toronto boundary.
- Produces: the complete Phase 2 proof package from the analytical spec plus a public schema-v1 contract. `manifest.json` includes `schemaVersion`, `snapshotDate`, `generatedAt`, `defaultState`, `snapshots`, `actions`, `gate`, `sources`, `limitations`, and file URLs.

- [ ] **Step 1: Write failing build-contract tests**

Use a temporary synthetic input fixture. Verify clear missing/mismatched input errors, required output filenames, deterministic bytes with a fixed clock, unique IDs, allowed enum values, GeoJSON validity, query-facing property names, fare-paid exclusion in public coverage, no public trip IDs, gzip limits, cross-file counts, and schema version `1`.

Add network tests for a T-junction through an interior source vertex, a long-edge midpoint snap, an unresolved at-grade crossing that fails, and a reviewed grade-separated crossing that remains disconnected.

- [ ] **Step 2: Run the build test and observe the expected failure**

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest \
  data.scripts.tests.test_fg03_analysis_build -v
```

- [ ] **Step 3: Implement orchestration without duplicating analytical rules**

The script validates inputs, loads the network once, snaps facilities and stops once, computes a 500 metre maximum search, evaluates 300/400/500 metre thresholds, runs primary and sensitivity scenarios, writes analytical tables and maps, and exports browser files with only UI-required fields.

Build the pedestrian graph from every source vertex, not only each line's first and last coordinate. Snap to the nearest source edge and batch-insert stable projected nodes while preserving perpendicular snap offsets. Detect non-endpoint intersections in EPSG:2952. Every crossing must become a source node or have a reviewed entry in `network-topology-exceptions.csv`; do not automatically planarize grade-separated crossings. Validate positive finite weights, geometry-length conservation, component counts, and incident links. Record explicit reviewed overrides for source `OBJECTID` 55757 and 60345 if their published `LENGTH` field remains inconsistent with projected geometry.

Use one baseline multi-source search per scenario and one lazy bounded candidate search per unique source node. Derive 300, 400, and 500 metre coverage by thresholding the cached distance with both source and stop snap offsets. Do not rerun Dijkstra for each distance.

The public intervention contract must carry a complete time by access by walk query matrix so the three independent controls never substitute a one-variable sensitivity for a combined state. Keep the primary audited materiality and stability facts distinct from query-cell activity metrics.

- [ ] **Step 4: Generate the real dated analysis**

```bash
data/scripts/.venv/bin/python data/scripts/22_build_washroom_analysis.py \
  --snapshot-date 2026-07-21 \
  --proof-dir data/proof/fg03/2026-07-21 \
  --raw-dir /Users/jonathanwestberry/Projects/toronto-micro-atlas/data/raw/fg03 \
  --public-dir public/data/fg03/2026-07-21
```

- [ ] **Step 5: Inspect and resolve the manual audit**

Generate `phase2/manual-audit.csv` separately from curated `data/fg03/phase2-audit-decisions.csv`. Include an analysis hash, exact source references, all applicable ranks, public and rider metrics at 300/400/500 metres, nearest evidence, canonical network node, duplicate flag, and audit-map path.

Inspect the top ten robust candidates in five ranking groups: extend, new, verify-hours, verify-accessibility, and retrofit. Check source rows, coordinates, nearest facilities, generated maps, access conditions, closure class, and duplicate flags. Record only `valid`, `merge review`, `source review`, or `exclude`, with reviewer, timestamp, and concise evidence note. Any unresolved status, missing decision, or stale analysis hash blocks the audited gate. Never edit rank or metric values manually. Re-run the builder so the gate reads the resolved audit.

- [ ] **Step 6: Enforce the release gate in product copy**

If the gate passes, permit the hours-extension claim and publish the exact audited opportunity count. If it fails, keep the temporal mismatch story but remove any claim that the analysis proved a sufficient intervention set. The browser manifest must carry the gate result and reason either way.

- [ ] **Step 7: Validate file size and integrity**

Require valid geometry, unique stable IDs, no non-finite numbers, no fare-paid facility in public-open sets, no raw trip ID in any public key or string leaf, and no individual public data file above 1.5 MB gzip.

Export real 300/400/500 metre clipped `MultiLineString` pedestrian-network reaches for public facilities and audit-valid robust interventions. Keep stops and unaudited candidates point-only. Never substitute a Euclidean circle for network reach.

Write `phase2/build-report.json` with elapsed time, peak memory, topology metrics, snap distributions, activity counts, baseline and candidate search counts, cache hits, candidate counts before and after deduplication, audit totals, and raw and gzip output sizes. Build into temporary directories and publish only after every integrity check passes.

- [ ] **Step 8: Run all data tests and commit**

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover \
  -s data/scripts/tests -p 'test_fg03*.py' -v
git add data/scripts data/fg03 data/proof/fg03/2026-07-21/phase2 \
  public/data/fg03/2026-07-21 data/README.md data/provenance.md
git commit -m "feat: publish audited FG03 intervention data"
```

### Task 5: Implement tested URL state, filtering, and privacy-safe events

**Files:**
- Create: `src/scripts/fg03-state.mjs`
- Create: `src/scripts/atlas-events.mjs`
- Create: `tests/fg03-state.test.mjs`
- Create: `tests/atlas-events.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: browser `URLSearchParams`, manifest enum values, and optional `window.plausible`.
- Produces: `DEFAULT_FG03_STATE`, `parseFg03State(search, validPlaceIds)`, `serializeFg03State(state)`, `stateEquals(a, b)`, and `trackAtlasEvent(name, properties)`.

- [ ] **Step 1: Write failing URL-state tests**

Test defaults, allowed enum values, invalid-value removal, stable readable serialization order, safe place IDs, bounded map coordinates, reset behavior, and round trips.

```javascript
test('invalid values return the useful default state', () => {
  assert.deepEqual(
    parseFg03State('?time=nope&walk=12&place=%3Cscript%3E', new Set()),
    DEFAULT_FG03_STATE,
  );
});
```

- [ ] **Step 2: Run the state test and observe the expected module-not-found failure**

```bash
node --test tests/fg03-state.test.mjs
```

- [ ] **Step 3: Implement the minimal pure state module**

Use exact parameter order `time`, `access`, `walk`, `action`, `place`, `map`. Serialize the default state as an empty query. Round map coordinates to five decimals and zoom to two decimals.

- [ ] **Step 4: Write and run failing event tests**

Allow only named events and allowlisted coarse properties. Drop `query`, raw coordinates, and unknown keys.

- [ ] **Step 5: Implement the analytics bridge**

Allow these exact event names: `fg03_entry`, `fg03_engage`, `fg03_time_change`, `fg03_access_change`, `fg03_walk_change`, `fg03_action_change`, `fg03_search_use`, `fg03_feature_select`, `fg03_method_view`, `fg03_data_download`, `fg03_share`, `fg03_series_navigation`, `fg03_error`, and `fg03_journey_complete`. Dispatch a `tma:analytics` `CustomEvent` for testability and call `window.plausible(name, { props })` only when that existing-compatible global is available. Do not add a tracker token or external script.

- [ ] **Step 6: Add package scripts and run tests**

```json
{
  "scripts": {
    "check": "astro check",
    "test:web": "node --test tests/*.test.mjs"
  }
}
```

Run:

```bash
npm run test:web
npm run check
```

- [ ] **Step 7: Commit**

```bash
git add src/scripts/fg03-state.mjs src/scripts/atlas-events.mjs tests package.json package-lock.json
git commit -m "feat: add shareable FG03 state"
```

### Task 6: Build the editorial route and synchronized accessible explorer

**Files:**
- Create: `src/pages/guides/when-toronto-has-to-go/index.astro`
- Create: `src/scripts/fg03-map.ts`
- Create: `src/styles/fg03.css`
- Create: `src/content/guides/when-toronto-has-to-go.md`
- Create: `tests/fg03-contract.test.mjs`

**Interfaces:**
- Consumes: Task 4 manifest/GeoJSON, Task 5 state/events, shared Base layout, and public Toronto context GeoJSON.
- Produces: static editorial HTML plus `initWhenTorontoHasToGo(): Promise<() => void>` for progressive enhancement and cleanup.

- [ ] **Step 1: Write a failing rendered-contract test**

Build the site and assert that the generated route contains one `h1`, series label `Guide 03`, the central late-night finding, map loading/failure regions, accessible current-results list, methodology, limitations, sources, share/reset controls, links to both earlier guides, no placeholder language, query-free canonical URL, and the expected social image.

- [ ] **Step 2: Run the contract test and observe the missing-route failure**

```bash
npm run build
node --test tests/fg03-contract.test.mjs
```

- [ ] **Step 3: Render the editorial journey as usable HTML**

Build these sections in order:

1. Breadcrumb and visible `Guide 03 of 03` label.
2. Hero stating that TTC service continues after unrestricted washroom access collapses.
3. Four-time evidence strip that distinguishes unrestricted from fare-paid access.
4. Short explanation of why fare gates matter.
5. Audited intervention framing, conditioned on the product gate.
6. Interactive explorer.
7. Synchronized accessible results and detail region.
8. Method, definitions, sources, limitations, data download, share, and series navigation.

The no-JavaScript page must still communicate all headline counts and list leading audited interventions.

- [ ] **Step 4: Implement the map as progressive enhancement**

Defer `import('maplibre-gl')` until the explorer enters or nears the viewport. Load the manifest first, then fetch facilities, the selected snapshot, and interventions independently with `Promise.allSettled`. Preserve the shell and accessible list when one layer fails. Use local Toronto boundary, street, rail, water, and lake files, with visible OpenStreetMap and City attribution.

- [ ] **Step 5: Implement only user-meaningful controls**

Provide four time buttons, public/rider access toggle, 300/400/500 metre distance, five action views (`open`, `extend`, `new`, `verify`, `retrofit`), facility/action-area search, reset, retry, share, zoom, and a scale control. Do not add a north arrow.

- [ ] **Step 6: Synchronize visual and accessible representations**

Every filter updates map layers, summary, count, ranked list, URL, and live status. Selecting from either map or list updates the same detail panel. List rows expose action type, access condition, current hours/closure evidence, unique trips, routes, stops, stability, audit status, and source link. Move focus to the detail heading only after an explicit keyboard or pointer selection, and restore it on close.

- [ ] **Step 7: Implement responsive and resilient states**

Desktop uses a sticky map beside controls/results. Mobile uses normal document flow with a minimum 52svh map and no scroll lock. Include intentional loading, partial loading, empty, no-search-result, offline, failed request, WebGL unavailable, selected, focused, disabled, stale-data, reduced-motion, forced-colors, large-text, landscape, and 200 percent zoom states.

- [ ] **Step 8: Apply the cartographic hierarchy**

Display in Web Mercator through MapLibre while keeping all walking calculations in EPSG:2952. Limit the camera to the Toronto region, use a measured city-fitting minimum zoom and a street-detail maximum zoom, and interrupt transitions on user input. Use a warm low-contrast local basemap; quiet active TTC stops; clear open-facility symbols that differ by unrestricted/fare-paid shape as well as color; action-specific intervention symbols; selected halos; scale-dependent labels; 300/400/500 metre network-reach rings only for the selected item; and explicit unknown/missing styling. Avoid choropleths and area comparisons.

- [ ] **Step 9: Run state tests, contract tests, Astro check, and build**

```bash
npm run test:web
npm run check
npm run build
```

- [ ] **Step 10: Commit**

```bash
git add src/pages/guides/when-toronto-has-to-go src/scripts/fg03-map.ts \
  src/styles/fg03.css src/content/guides/when-toronto-has-to-go.md tests/fg03-contract.test.mjs
git commit -m "feat: build the third Toronto Micro-Atlas guide"
```

### Task 7: Integrate series discovery, metadata, social art, CI, and maintainer docs

**Files:**
- Modify: `src/layouts/Base.astro`
- Modify: `src/pages/index.astro`
- Modify: `src/pages/about.astro`
- Create: `public/social/og-when-toronto-has-to-go.jpg`
- Modify: `public/_headers`
- Modify: `.github/workflows/deploy.yml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/content.config.ts`
- Modify: `README.md`
- Create: `docs/fg03-maintenance.md`
- Modify: `tests/fg03-contract.test.mjs`

**Interfaces:**
- Consumes: the complete route and public contract.
- Produces: global discovery links, newest-guide homepage feature, social card, cache/security policy, CI quality gate, and exact update/deploy instructions.

- [ ] **Step 1: Extend the failing integration contract**

Assert that built header/footer/home/about HTML links to all three guides, the new guide is the newest homepage feature, the social image is 1200 by 630, `README.md` names Cloudflare Pages, and CI runs web/data tests, Astro check, and build before deploy.

- [ ] **Step 2: Run the contract and observe the expected failures**

```bash
npm run build
node --test tests/fg03-contract.test.mjs
```

- [ ] **Step 3: Integrate the third guide across the shared shell**

Add `03 · When Toronto Has to Go` to the header dropdown and footer, add a purpose-built newest feature to the homepage, and update About so all three published guides are represented. Preserve existing URLs and copy.

- [ ] **Step 4: Create the social image from actual project evidence**

Compose a 1200 by 630 JPEG from the verified 10 p.m. map output, survey-paper ground, atlas masthead, guide number, title, and one concise finding. Keep all text inside platform-safe margins and verify it at thumbnail size.

- [ ] **Step 5: Add metadata and structured data**

Extend `Base.astro` with optional article publication/update dates and JSON-LD while preserving defaults for existing pages. FG03 emits author, publication date, updated date, canonical URL, description, and its own Open Graph/Twitter card.

- [ ] **Step 6: Add production cache and security headers**

Keep the `pages.dev` noindex rule. Add immutable caching for dated FG03 data and fingerprinted Astro assets, revalidation for HTML/manifest, and security headers compatible with MapLibre/WebGL and existing fonts. Do not add a policy that blocks current site behavior.

- [ ] **Step 7: Strengthen CI without requiring raw data**

Add Python setup, install `requirements-fg03.txt`, run synthetic FG03 tests, run Node tests, run `astro check`, then build. Deployment remains the final job step and uses the existing Cloudflare secrets.

- [ ] **Step 8: Upgrade Astro to the current patched release**

Upgrade Astro from 5.x to exactly `7.1.3`, keep Node at `22.12.0` or newer, and use the official Astro 6 and 7 migration guidance. Convert both Markdown collections in `src/content.config.ts` to `glob()` loaders before removing legacy collection syntax. Preserve static output, `ClientRouter`, `getStaticPaths()` routes, sitemap generation, and canonical metadata. Run the complete build and route contract before and after the upgrade, then run `npm audit --omit=dev`; document any advisory that remains and its actual static-site exposure.

- [ ] **Step 9: Document maintenance**

Document architecture, sources, transformations, data refresh order, raw snapshot placement, public schema, styling, copy, URL state, analytics event names, accessibility contract, local development, all test commands, build, Cloudflare deployment, production verification, and limitations.

- [ ] **Step 10: Run the full automated suite and commit**

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover \
  -s data/scripts/tests -p 'test_fg03*.py' -v
npm run test:web
npm run check
npm run build
git diff --check
git add src/layouts/Base.astro src/pages/index.astro src/pages/about.astro \
  public/social/og-when-toronto-has-to-go.jpg public/_headers \
  .github/workflows/deploy.yml package.json package-lock.json src/content.config.ts \
  README.md docs/fg03-maintenance.md tests/fg03-contract.test.mjs
git commit -m "feat: integrate and release FG03"
```

### Task 8: Perform full browser, accessibility, performance, and production verification

**Files:**
- Modify only files required by test-first defect fixes.
- Create: `docs/fg03-release-audit.md`
- Modify: `03 Spaces/Projects/Toronto Micro-Atlas/Field Guide 03 -- Phase 1 Data Proof.md` in the z-brain vault after repository verification.

**Interfaces:**
- Consumes: complete branch, local preview server, Cloudflare deployment workflow, and production domain.
- Produces: evidence-backed release audit, verified live URL when credentials permit, and updated project record.

- [ ] **Step 1: Start the production preview and test direct routes**

Run `npm run build` and `npm run preview -- --host 127.0.0.1`. Verify `/`, both existing guides, the FG03 route, direct refresh, invalid queries, valid shared state, and 404 behavior.

- [ ] **Step 2: Test representative customer journeys**

At desktop, tablet, small mobile, and landscape mobile sizes, verify entry from home, immediate comprehension, time change, access comparison, distance/action filter, search, feature selection, accessible list, share/revisit, reset, methodology, download, prior-guide navigation, and empty/error recovery. Exercise representative current Chrome, Safari, Firefox, Edge, Mobile Safari, and Chrome on Android environments where available, and document any environment that cannot be exercised locally.

- [ ] **Step 3: Test accessibility**

Verify skip links, landmarks, heading order, labels, keyboard-only operation, browser back/forward, focus restoration, live announcements, 200 percent zoom, large text, reduced motion, forced colors, non-color symbols, touch targets, and a representative VoiceOver workflow. Run automated accessibility checks where available, then manually verify map/list equivalence.

- [ ] **Step 4: Test resilience and console cleanliness**

Block each FG03 data request individually and verify useful partial states. Simulate offline, WebGL failure, stale data, and no results. Read console logs on all three guide routes and resolve avoidable errors or warnings with a failing regression test first.

- [ ] **Step 5: Test performance and asset delivery**

Measure useful HTML before map initialization, deferred MapLibre loading, compressed data sizes, layout shift, interaction response, mobile memory behavior, and production caching. Confirm no public data file exceeds the Task 4 budget without documented justification.

- [ ] **Step 6: Request task and whole-branch reviews**

Run the subagent-driven review package workflow. Fix every Critical or Important finding, and re-run the covering tests.

- [ ] **Step 7: Run fresh final verification**

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover \
  -s data/scripts/tests -p 'test_fg03*.py' -v
npm run test:web
npm run check
npm run build
git diff --check
git status --short
```

- [ ] **Step 8: Deploy through the established workflow**

Push the reviewed branch, merge to `main` only after the branch-finishing gate, push `main`, and monitor the `Deploy to Cloudflare Pages` workflow. Required secrets are `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

- [ ] **Step 9: Verify production**

Verify `https://torontomicroatlas.com/guides/when-toronto-has-to-go/` over HTTPS, direct refresh, assets, data, canonical/social metadata, cache headers, navigation, shared query state, analytics bridge, mobile layout, keyboard flow, console, and the two existing guides. Do not claim deployment until this URL is live and checked.

- [ ] **Step 10: Record the evidence**

Write `docs/fg03-release-audit.md` with commands, results, production URL, unresolved access-dependent action if any, and known limitations. Update the vault project note with the Phase 2 gate and release status, without duplicating tasks outside `03 Spaces/Tasks/Tasks.md`.

- [ ] **Step 11: Commit final test-backed fixes and audit**

```bash
git add docs/fg03-release-audit.md
git commit -m "docs: record FG03 release verification"
```
