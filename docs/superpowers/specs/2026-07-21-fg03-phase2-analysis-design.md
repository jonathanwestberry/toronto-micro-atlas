# FG03 Phase 2 Analytical Prototype Design

Date: 2026-07-22
Status: Revised design, awaiting written-spec review

## Purpose

Build the analytical prototype for **When Toronto Has to Go**. The prototype
must show where scheduled TTC service continues after documented public
washroom access disappears, then measure which specific interventions would
improve that mismatch.

The default policy is:

> Prioritize continuing TTC activity after nearby washrooms close. Measure the
> effect of a proposed action directly. Keep accessibility, information, and
> conditional-access limits visible without hiding them inside one score.

The result is a dated analysis package, not a public interface.

## Core Decisions

1. Rank interventions, not abstract need areas.
2. Use unique scheduled TTC trips as the primary activity measure for an
   intervention catchment. The same trip cannot be counted twice because it
   stops twice inside one catchment.
3. Report active stops and distinct routes beside unique trips.
4. Separate unrestricted public access from fare-paid rider access.
5. Separate scheduled-hours gaps from seasonal closures and temporary service
   disruptions.
6. Test distance, access conditions, unknown hours, temporary closure status,
   and day type one variable at a time.
7. Publish every component metric. Do not create a weighted need score.

## Scope

Phase 2 will:

1. Classify geographic, scheduled-time, seasonal, temporary-service,
   accessibility, and information gaps at active TTC stops.
2. Repeat pedestrian-network coverage at 300, 400, and 500 metres.
3. Simulate four intervention classes:
   - extend a facility's scheduled hours;
   - investigate a new facility zone;
   - verify missing hours or accessibility information;
   - retrofit a facility known not accessible.
4. Measure incremental stop, unique-trip, and route coverage for every
   candidate intervention.
5. Identify opportunities whose gains survive sensitivity testing.
6. Produce a manual audit package for the leading stable opportunities.

Phase 2 will not:

- claim passenger demand or ridership;
- use private or crowdsourced washrooms;
- identify construction-ready sites;
- treat verification potential as confirmed coverage;
- add census, development, destination, or footfall data to the first
  intervention model;
- design or build the public explorer.

The resulting priority claims must be labelled **transit-service priorities**,
not citywide estimates of human need.

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
- `park-washrooms.csv`

Required processed input:

- `data/processed/toronto-boundary.geojson`

The builder must fail with a clear message when an input is missing, the
requested date differs from the Phase 1 snapshot date, or a required snapshot
contains no active Toronto TTC stops.

## Phase 1 Data Additions

The Phase 1 facility model must expose two new fields in `facilities.csv`:

- `access_condition`: `unrestricted` or `fare_paid`;
- `closure_category`: `none`, `seasonal`, `temporary`, or `construction`.

TTC station washrooms use `fare_paid`. All other included sources use
`unrestricted` because passenger-only VIA records were already excluded.

Park closure categories come from the published reason:

- `Closed for the Season` becomes `seasonal`;
- `Under Construction` becomes `construction`;
- maintenance, repairs, technical issues, and planned closures become
  `temporary`;
- no published closure reason becomes `none`.

Partial closures remain available and carry their published note. They are not
treated as completely closed.

## Dates and Times

The primary analysis uses the summer weekday service day Tuesday, 2026-07-21:

- 10 p.m.
- 12:30 a.m. on the following service day

The weekend sensitivity uses Saturday, 2026-07-25:

- 10 p.m.
- 12:30 a.m. on the following service day

Noon and 8:30 p.m. remain context outputs for the Tuesday snapshot but do not
determine the default intervention order.

The dated result is a summer weekday analysis. It cannot be described as an
all-season result. Winter analysis requires a winter facility and GTFS
snapshot and remains a later product requirement.

## TTC Activity Measures

A stop is active when at least one GTFS stop-time row falls within 15 minutes
of the snapshot.

Each active record retains:

- `stop_id`;
- `parent_station`;
- `trip_id`;
- `route_id`;
- scheduled event time;
- coordinates.

At a single stop, stop-time rows describe scheduled activity. Within an
intervention catchment, the primary activity measure is the count of unique
`trip_id` values. This prevents one vehicle from being counted repeatedly when
it serves multiple nearby stops.

Every output also publishes:

- active stop count;
- distinct route count;
- raw stop-time event count.

These are measures of scheduled service supply, not passenger demand.

## Access Modes

Calculate all baseline and intervention coverage in two modes.

### Unrestricted public access

Exclude facilities whose `access_condition` is `fare_paid`.

This is the default public-access result because a person outside a TTC station
should not be considered covered by a washroom that requires fare entry.

### Rider-conditional access

Include both unrestricted and fare-paid facilities.

This describes access available to someone already inside the TTC fare system.
It is published beside, never substituted for, unrestricted coverage.

## Availability Scenarios

### Default observed scenario

- Unknown hours count as unavailable.
- Seasonal, temporary, and construction closures count as unavailable.
- Partial closures remain available with a warning.
- TTC washrooms are excluded from unrestricted mode and included in
  rider-conditional mode.

### Normal-operations sensitivity

Ignore `temporary` closure overrides while retaining scheduled hours,
`seasonal`, and `construction` closures.

This tests whether a priority exists because of normal operating policy or a
short-lived disruption.

### Optimistic-information sensitivity

Treat facilities with unknown hours as potentially open. Results are labelled
potential coverage and cannot replace the default observed result.

This measures the value of resolving missing information.

## Pedestrian-Network Coverage

All coverage uses shortest paths on the City Pedestrian Network. Facility and
TTC stop snap offsets count toward the walking threshold.

For each facility set, run one maximum-distance search at 500 metres and
evaluate the result at 300, 400, and 500 metres.

The analysis calculates distance to these facility sets independently:

- any documented unrestricted facility;
- any documented facility including fare-paid TTC washrooms;
- currently open unrestricted facility;
- currently open facility including fare-paid TTC washrooms;
- scheduled closed facility;
- seasonal closed facility;
- temporarily unavailable facility;
- facility under construction;
- facility with unknown hours;
- currently open and confirmed accessible facility;
- currently open facility with unknown accessibility;
- currently open facility known not accessible.

## Gap Classification

Gap flags can coexist because different actions may be valid in the same
place.

### Geographic gap

No documented unrestricted facility of any state is within the selected
walking distance.

Potential action: investigate a new facility or public-access agreement.

### Scheduled-time gap

No unrestricted facility is open, but a facility closed by its regular weekly
schedule is within range.

Potential action: extend scheduled hours.

### Seasonal gap

No unrestricted facility is open, but a facility marked seasonally closed is
within range.

Potential action: review the operating season. Do not label this an hours-only
fix.

### Temporary-service gap

No unrestricted facility is open, but a facility closed for maintenance,
technical issues, planned work, or construction is within range.

Potential action: restore service or communicate the disruption. Do not rank
this as an hours-extension opportunity.

### Accessibility gap

General open coverage exists, at least one nearby open facility is known not
accessible, and no nearby open facility is confirmed accessible.

Unknown accessibility alone never becomes known inaccessibility.

Potential action: retrofit a known facility.

### Information gap

Either condition applies:

- no unrestricted facility is documented open, but a facility with unknown
  hours is within range; or
- general open coverage exists, no open facility is confirmed accessible, and
  at least one open facility has unknown accessibility.

Potential action: verify and publish missing information.

Every stop record includes the underlying coverage booleans and nearest
facility evidence so each flag can be reproduced.

## Intervention A: Extend Scheduled Hours

Each facility that is closed only because of its regular weekly schedule at a
late snapshot becomes a candidate. Seasonal, temporary, construction, and
unknown-hours facilities are excluded.

Simulate opening that facility without changing any other state. At each
distance and access mode, publish:

- newly covered active stops;
- newly covered unique TTC trips;
- newly covered distinct routes;
- total facility catchment stops, trips, and routes;
- late snapshots with positive gain;
- confirmed accessibility and access condition;
- current published hours.

Rank candidates lexicographically by:

1. late snapshots with positive incremental unique-trip coverage, descending;
2. combined incremental unique trips, descending;
3. combined incremental distinct routes, descending;
4. combined incremental active stops, descending;
5. facility name, ascending.

## Intervention B: New-Facility Investigation Zones

Create a candidate at the snapped pedestrian-network node of every uncovered
active TTC stop. The candidate represents an investigation zone, not a literal
construction site.

Simulate an unrestricted, always-open facility at each candidate node. Measure
newly covered unique trips, routes, and stops.

Remove redundant candidates deterministically:

1. Sort by incremental unique trips, routes, stops, then stop ID.
2. Keep the leading candidate.
3. Skip a later candidate when at least 80 percent of its newly covered unique
   trips are already covered by a kept candidate.
4. Continue until all candidates are considered.

This groups candidates by their actual intervention effect rather than by TTC
stop spelling or an arbitrary map grid.

Rank the kept candidates lexicographically by:

1. late snapshots with positive incremental unique-trip coverage, descending;
2. combined incremental unique trips, descending;
3. combined incremental distinct routes, descending;
4. combined incremental active stops, descending;
5. candidate stop ID, ascending.

Candidate labels use the nearest parent-station name or published surface-stop
name. Different labels within 200 metres are flagged for manual review but do
not define the grouping.

## Intervention C: Verify Missing Information

Create candidates for:

- facilities with unknown hours; and
- open facilities with unknown accessibility.

For unknown hours, simulate the facility as open and measure potential newly
covered trips, routes, and stops. For unknown accessibility, simulate confirmed
accessibility and measure potential newly confirmed-accessible coverage.

All gains are labelled `potential_if_verified`. They are not added to baseline
coverage and do not become claims that the facility is open or accessible.

Hours-verification and accessibility-verification candidates receive separate
rankings. Each ranking uses late snapshots with positive potential gain,
combined potential unique trips, combined routes, combined stops, and facility
name in that lexicographic order.

## Intervention D: Retrofit Accessibility

Create candidates only for facilities explicitly known not accessible. A blank
or missing accessibility field is an information candidate, not a retrofit
candidate.

Simulate each candidate as confirmed accessible and measure newly covered
unique trips, routes, and stops in confirmed-accessibility mode.

Rank retrofit candidates by late snapshots with positive incremental
unique-trip coverage, combined incremental unique trips, combined routes,
combined stops, and facility name in that lexicographic order.

## Priority and Sensitivity

There is no cross-class master score. Each intervention class has its own
published ranking because extending hours, verifying data, retrofitting, and
investigating a new facility are different policy decisions.

The primary ranking uses:

- Tuesday service;
- 10 p.m. and 12:30 a.m.;
- unrestricted access;
- observed closures;
- unknown hours unavailable;
- 400-metre walking distance.

Run these one-variable sensitivities against the primary ranking:

1. 300-metre distance;
2. 500-metre distance;
3. rider-conditional access;
4. normal operations without temporary closure overrides;
5. optimistic unknown-hour potential;
6. Saturday service.

For every candidate, publish its rank and component metrics under each
applicable scenario.

Scenario applicability is explicit:

| Intervention class | 300 m | 500 m | Rider conditional | Normal operations | Optimistic information | Saturday |
|---|---:|---:|---:|---:|---:|---:|
| Extend scheduled hours | Yes | Yes | Yes | Yes | No | Yes |
| New-facility zone | Yes | Yes | Yes | Yes | Yes | Yes |
| Verify missing information | Yes | Yes | Yes | Yes | No | Yes |
| Retrofit accessibility | Yes | Yes | Yes | Yes | Yes | Yes |

### Stability categories

- `robust`: top 20 in the primary ranking and at least five applicable
  sensitivity rankings;
- `mostly robust`: top 20 in the primary ranking and three or four applicable
  sensitivity rankings;
- `sensitive`: top 20 in the primary ranking and zero to two applicable
  sensitivity rankings;
- `not prioritized`: outside the primary top 20.

A scenario that does not apply to an intervention class is recorded as `not
applicable` and excluded from that candidate's denominator.

Publish top-20 overlap counts for every primary-to-sensitivity comparison.

## Material Gain and Product Gate

An opportunity has material late-service gain at 400 metres when it adds both:

- coverage for at least 10 unique scheduled TTC trips across the two late
  snapshots; and
- coverage for at least 3 active TTC stops.

These thresholds are policy rules, not empirical estimates of passenger need,
and must appear in the methodology.

Combined unique trips use `(snapshot, trip_id)` as the key so trips from two
observation windows remain distinct while repeated stops inside one catchment
do not inflate the result.

The Phase 2 product-build gate passes only when manual audit confirms:

1. at least five `robust` opportunities across the four intervention classes;
2. every counted opportunity meets the material-gain rule;
3. at least two counted opportunities are scheduled-hours extensions, so the
   core closing-time argument supports a real operating intervention;
4. no counted opportunity depends on a source error, duplicated candidate, or
   misclassified access condition.

If any condition fails, publish the analytical result but revise the product
claim before interface design.

## Manual Audit

Audit the ten highest-ranked robust candidates in each intervention class, or
all robust candidates when fewer than ten exist.

Each audit row includes:

- intervention class and candidate ID;
- facility or investigation-zone name;
- coordinates;
- primary and sensitivity ranks;
- incremental unique trips, routes, and stops at all three distances;
- unrestricted and rider-conditional results;
- current hours, closure category, access condition, and accessibility;
- nearest relevant facilities and pedestrian-network distance;
- possible duplicate candidate;
- inferred action;
- audit result: `valid`, `merge review`, `source review`, or `exclude`;
- concise evidence note.

Automated checks may assign review flags. Final `valid` and `exclude` decisions
require inspection of source records and generated maps. The audit cannot
claim utilities, ownership, safety, visibility, maintenance feasibility, or
construction suitability.

## Outputs

Write outputs to `data/proof/fg03/2026-07-21/phase2/`:

- `README.md`: findings, policy rules, methods, limits, and gate decision;
- `summary.json`: machine-readable totals and sensitivity results;
- `stop-gaps.csv`: stop-level classifications and nearest evidence;
- `extend-hours.csv`: hours-extension candidates and gains;
- `new-facility-zones.csv`: deduplicated investigation zones and gains;
- `information-opportunities.csv`: verification candidates and potential gains;
- `accessibility-retrofits.csv`: known-barrier candidates and gains;
- `interventions.geojson`: all candidate geometries and headline properties;
- `scenario-sensitivity.csv`: ranks and component metrics by scenario;
- `manual-audit.csv`: leading candidate evidence and decisions;
- `access-conditions.png`: unrestricted versus rider-conditional coverage;
- `gap-types-2200.png`: 10 p.m. gap classifications;
- `gap-types-0030.png`: after-midnight gap classifications;
- `extend-hours-opportunities.png`: scheduled-hours candidates;
- `new-facility-zones.png`: geographic investigation zones;
- `intervention-contact-sheet.png`: four intervention classes;
- `sensitivity-contact-sheet.png`: primary and sensitivity comparisons.

## Code Structure

### `data/scripts/fg03_analysis.py`

Pure functions and dataclasses for:

- availability and gap classification;
- access-mode filtering;
- stop-level coverage records;
- component metrics;
- deterministic rankings;
- sensitivity categories;
- material-gain rules;
- audit-status inference.

### `data/scripts/fg03_transit.py`

Reusable GTFS functions for:

- service-calendar resolution;
- GTFS time parsing;
- active stop events retaining trips, routes, and parent stations;
- catchment aggregation with unique-trip deduplication.

The Phase 1 builder will use this module so service-day interpretation has one
implementation.

### `data/scripts/fg03_interventions.py`

Pure intervention simulation for:

- scheduled-hours extensions;
- new-facility candidate generation and effect-based deduplication;
- information-verification potential;
- accessibility-retrofit potential.

### `data/scripts/22_build_washroom_analysis.py`

Orchestration only:

- validate dated inputs;
- load facility, state, closure, and access-condition data;
- load pedestrian graph and TTC activity;
- build baseline scenarios;
- run intervention simulations and sensitivity scenarios;
- write tables, GeoJSON, maps, and methodology.

### Tests

- `data/scripts/tests/test_fg03_analysis.py`
- `data/scripts/tests/test_fg03_transit.py`
- `data/scripts/tests/test_fg03_interventions.py`
- existing FG03 tests remain green after shared-code extraction.

## Testing Strategy

Use test-driven development for every new production function.

Synthetic tests must prove:

1. unrestricted mode excludes fare-paid facilities;
2. rider-conditional mode includes fare-paid facilities;
3. scheduled, seasonal, temporary, and construction gaps remain distinct;
4. unknown accessibility never becomes known inaccessibility;
5. one TTC trip stopping twice inside a catchment counts once;
6. overnight GTFS events use the intended service day;
7. opening a scheduled-closed facility reports only incremental coverage;
8. temporary and seasonal facilities are not hours-extension candidates;
9. redundant new-facility candidates are removed by the 80-percent impact
   overlap rule;
10. information scenarios remain labelled potential;
11. only explicit accessibility barriers become retrofit candidates;
12. rankings follow their published lexicographic rules;
13. stability categories ignore non-applicable scenarios correctly;
14. material-gain and product-gate rules produce deterministic results;
15. facility and stop snap offsets count toward every distance threshold;
16. missing or mismatched inputs produce clear failures;
17. output schemas contain every documented field.

## Verification

Final verification must:

1. run all FG03 unit tests;
2. regenerate Phase 1 and Phase 2 from the dated source snapshot;
3. validate required files, row counts, unique IDs, and output schemas;
4. confirm that fare-paid facilities never enter unrestricted coverage;
5. confirm that unique trips are not duplicated inside catchments;
6. visually inspect every generated map;
7. manually resolve the leading audit rows;
8. run the existing Astro production build;
9. update the repository provenance and Obsidian project record with the gate
   result.

## Acceptance Criteria

The analytical prototype is complete when:

- access eligibility is explicit in every relevant output;
- closure causes map to the correct intervention class;
- every candidate reports incremental, not merely nearby, coverage;
- unique trips, routes, and stops remain separate component metrics;
- 300-, 400-, and 500-metre results use pedestrian-network distance;
- the primary ranking and every sensitivity are reproducible;
- leading robust candidates have completed manual audit rows;
- the product gate follows the published material-gain rules;
- all tests, regeneration checks, integrity checks, map inspections, and the
  site build pass;
- the product plan and proof notes state whether the build gate passed and what
  claims remain out of scope.
