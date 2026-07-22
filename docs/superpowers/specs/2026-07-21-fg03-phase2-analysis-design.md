# FG03 Phase 2 Analytical Prototype Design

Date: 2026-07-21
Status: Approved design, awaiting written-spec review

## Purpose

Build the analytical prototype for **When Toronto Has to Go**. The prototype
must identify and explain Toronto areas where scheduled TTC service continues
after nearby documented public washrooms close.

The default priority policy is:

> Prioritize continuing TTC activity after nearby washrooms close. Preserve
> accessibility as a separate visible gap, but do not let it silently override
> the main after-hours ranking.

The result is an analysis package, not a public interface.

## Scope

Phase 2 will:

1. Classify geographic, time, accessibility, and information gaps at active
   TTC stops.
2. Repeat coverage at 300, 400, and 500 metres along the City Pedestrian
   Network.
3. Aggregate stops into transit-defined candidate areas.
4. Rank areas using published component metrics and deterministic sorting,
   without a weighted need score.
5. Identify areas that remain important across all three walking distances.
6. Produce a manual audit package for the leading stable areas.

Phase 2 will not:

- claim passenger demand or ridership;
- use private or crowdsourced washrooms;
- recommend construction-ready sites;
- add census, development, destination, or footfall data before TTC schedule
  activity proves sufficient for the first priority model;
- design or build the public explorer.

## Source Contract

The analysis consumes the dated Phase 1 proof at
`data/proof/fg03/2026-07-21/` and the ignored official raw snapshot at
`data/raw/fg03/`.

Required Phase 1 inputs:

- `facilities.csv`
- `facility-states.csv`
- `summary.json`

Required raw inputs:

- `completegtfs.zip`
- `pedestrian-network.gpkg`

Required processed input:

- `data/processed/toronto-boundary.geojson`

The Phase 2 builder must fail with a clear message if an input is missing, if
the requested date differs from the Phase 1 snapshot date, or if no active TTC
stops exist for a required snapshot.

## Analytical Times

The default priority analysis uses the two late snapshots:

- 10 p.m. on Tuesday, 2026-07-21
- 12:30 a.m. on the following service day

Noon and 8:30 p.m. remain available as context in gap-classification outputs,
but they do not determine the default priority order.

An active TTC stop has at least one scheduled arrival or departure within 15
minutes of the snapshot. Each GTFS stop-time row counts as one scheduled
service event. This is service activity, not ridership.

## Network Coverage

All coverage uses shortest paths on the City Pedestrian Network. Facility and
TTC stop snap offsets count toward the distance threshold.

One maximum-distance search at 500 metres is run for each facility set. A TTC
stop is covered at 300, 400, or 500 metres when its network distance plus its
snap offset is within that threshold.

The builder calculates distance to these facility sets independently:

- any documented facility, regardless of current state;
- currently open facility;
- scheduled or temporarily closed facility;
- facility with unknown hours;
- currently open and confirmed accessible facility;
- currently open facility with unknown accessibility.

## Gap Classification

Gap flags are not mutually exclusive. A stop can have more than one flag
because different interventions may be valid in the same area.

### Geographic gap

True when no documented facility of any state is within the selected walking
distance.

Likely intervention: investigate a new facility or a public-access agreement.

### Time gap

True when no facility is documented open, but a scheduled or temporarily
closed facility is within the selected walking distance.

Likely intervention: extend hours, change operations, or restore service.

### Accessibility gap

True when general open coverage exists, at least one nearby open facility is
known not accessible, and no nearby open facility is confirmed accessible.

Unknown accessibility alone never creates an accessibility gap.

Likely intervention: retrofit a known facility.

### Information gap

True when either condition applies:

- no documented open facility is within range, but a facility with unknown
  hours is within range; or
- general open coverage exists, no open facility is confirmed accessible, and
  at least one open facility has unknown accessibility.

Likely intervention: verify and publish hours or accessibility information.

Each stop record also includes `general_covered` and
`confirmed_accessible_covered` so the flags can be audited directly.

## Transit-Defined Candidate Areas

Priority areas are based on TTC place names rather than an arbitrary square or
hexagonal grid.

Area keys follow these rules:

1. A GTFS `parent_station` is one area.
2. A surface stop uses its published stop name after case and whitespace
   normalization and removal of terminal platform-side phrases such as
   `north side`, `south side`, `east side`, and `west side`.
3. Stops with the same normalized key are aggregated.
4. Leading areas with different names but centroids within 200 metres are
   listed as possible near-duplicates in the manual audit package. They are not
   merged automatically.

This method can leave two names for one large intersection. That limitation is
preferable to silently combining unrelated streets, and the leading cases are
resolved during manual audit.

Area geometry is the mean EPSG:2952 projected position of its member stops,
converted back to WGS84 for CSV, GeoJSON, and maps.

## Area Metrics

For each area, snapshot, and distance threshold, publish:

- active stop count;
- scheduled service-event count;
- distinct route count;
- uncovered active stop count;
- uncovered scheduled service-event count;
- geographic-gap stop count;
- geographic-gap scheduled service-event count;
- time-gap stop count;
- time-gap scheduled service-event count;
- accessibility-gap stop count;
- accessibility-gap scheduled service-event count;
- information-gap stop count;
- information-gap scheduled service-event count;
- general coverage percentage;
- confirmed accessible coverage percentage.

The two late snapshots also receive combined metrics. A scheduled event is
counted once in each observation window in which it occurs. Combined distinct
routes means the union of route IDs across the two late snapshots.

## Default Priority Order

There is no weighted need score.

At each distance threshold, areas are sorted lexicographically by:

1. number of late snapshots with at least one active time-gap stop,
   descending;
2. combined scheduled service events at time-gap stops, descending;
3. number of late snapshots with at least one uncovered active stop,
   descending;
4. combined uncovered scheduled service events, descending;
5. combined distinct routes, descending;
6. combined uncovered active stops, descending;
7. normalized area name, ascending.

This makes the policy visible. Persistent closing-time mismatch comes first,
general uncovered activity comes next, and route diversity breaks meaningful
ties.

Accessibility and information metrics are displayed beside the default rank
but do not alter it.

## Distance Sensitivity

Rank every area independently at 300, 400, and 500 metres. Publish rank and
component metrics at all three distances.

Sensitivity categories use the top 20 areas at each distance:

- `stable`: appears in the top 20 at all three distances;
- `mostly stable`: appears in the top 20 at two distances;
- `distance sensitive`: appears in the top 20 at one distance;
- `not prioritized`: appears in no top-20 list.

Also publish top-20 overlap counts and Spearman rank correlation for the union
of top-20 areas between each distance pair. An area absent from one top-20 list
receives rank 21 for that pairwise calculation.

The priority-area gate passes only when at least five areas are `stable` and at
least five remain valid after manual audit. Otherwise the prototype reports
that the ranking is too sensitive for a public top-area claim.

## Manual Audit

Audit the ten highest-ranked stable areas at 400 metres. If fewer than ten
stable areas exist, audit all stable areas.

The audit table includes:

- area name and coordinates;
- 300-, 400-, and 500-metre ranks;
- late scheduled service events and distinct routes;
- gap-type counts;
- nearest open, closed, and unknown-hours facilities with network distance;
- published hours and current status of the nearest relevant facilities;
- possible area-name duplicate within 200 metres;
- inferred intervention type;
- audit result: `valid`, `merge review`, `source review`, or `exclude`;
- concise audit note.

Automated checks may assign `merge review` or `source review`. Final `valid`
and `exclude` decisions require inspection of the generated records and map.
The prototype must not claim street-level site feasibility.

## Outputs

Write outputs to `data/proof/fg03/2026-07-21/phase2/`:

- `README.md`: result, policy, method, limits, and gate decision;
- `summary.json`: machine-readable totals and sensitivity measures;
- `stop-gaps.csv`: one row per stop, snapshot, and distance;
- `priority-areas.csv`: area metrics and ranks;
- `priority-areas.geojson`: candidate area geometry and headline properties;
- `sensitivity.csv`: ranks and stability categories;
- `manual-audit.csv`: leading-area evidence and decisions;
- `priority-map-400m.png`: 400-metre late-priority map;
- `gap-types-2200.png`: 10 p.m. gap-type map;
- `gap-types-0030.png`: after-midnight gap-type map;
- `sensitivity-contact-sheet.png`: 300-, 400-, and 500-metre comparison.

## Code Structure

### `data/scripts/fg03_analysis.py`

Pure analytical functions and dataclasses for:

- gap classification;
- stop-name normalization and area keys;
- area aggregation;
- deterministic ranking;
- sensitivity categorization;
- audit-status inference.

### `data/scripts/fg03_transit.py`

Reusable GTFS functions for:

- service-calendar resolution;
- GTFS time parsing;
- active stop events with routes and parent stations.

The Phase 1 builder will use this module so the service-day interpretation has
one implementation.

### `data/scripts/22_build_washroom_analysis.py`

Orchestration only:

- validate inputs;
- load Phase 1 facility and state tables;
- load the pedestrian graph and enriched transit events;
- calculate facility-set distance maps;
- build stop and area outputs;
- render analytical maps and write documentation.

### Tests

- `data/scripts/tests/test_fg03_analysis.py`
- `data/scripts/tests/test_fg03_transit.py`
- existing FG03 test files remain unchanged unless shared-code extraction
  requires import updates.

## Testing Strategy

Use test-driven development for every new production function.

Synthetic tests must prove:

1. each gap flag, including cases where flags coexist;
2. unknown accessibility is not labelled inaccessible;
3. overnight GTFS service uses the intended service day;
4. event and distinct-route counts aggregate correctly;
5. parent stations and normalized surface-stop names create stable area keys;
6. lexicographic ranking follows the published policy;
7. stability categories respond correctly to three rank lists;
8. snap offsets count toward every distance threshold;
9. missing or mismatched Phase 1 inputs produce clear failures;
10. output schemas contain the documented fields.

The final verification runs all FG03 unit tests, regenerates Phase 1 and Phase
2 from the dated snapshot, validates row counts and required files, visually
inspects every map, and runs the existing Astro production build.

## Acceptance Criteria

The analytical prototype is complete when:

- all four gap types are reproducibly classified;
- 300-, 400-, and 500-metre outputs use pedestrian-network distance;
- every priority rank can be explained from published component columns;
- accessibility remains separate from the default after-hours rank;
- leading stable areas have completed audit rows;
- the gate decision follows the documented five-area rule;
- all tests, regeneration checks, output-integrity checks, and the site build
  pass;
- the product plan and Phase 1 proof note link to the Phase 2 result and state
  whether the product build gate passed.
