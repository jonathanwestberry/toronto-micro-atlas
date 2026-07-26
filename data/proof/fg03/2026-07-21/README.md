# Field Guide 03 data proof

Snapshot date: 2026-07-21 (Tuesday service day)

## Result

Documented unrestricted open access points fall from 324 at noon to 6 at 10 p.m., a 98.1% contraction. At 12:30 a.m., 7,885 TTC stops still show scheduled activity within the 30-minute observation window, while only 1 unrestricted public washroom access point remains reliably open. Fare-paid TTC washrooms are reported separately and do not seed public walking coverage.

This is the temporal-pattern layer of the proof. It deliberately does not rank priority areas or test 300 m and 500 m sensitivity. The audited Phase 2 package in `phase2/` performs those analyses without changing these headline counts.

## Snapshot summary

| Time | Unrestricted open access points | Unrestricted open records | Fare-paid open records | Unknown unrestricted hours | Active TTC stops | TTC stops covered by unrestricted facilities |
|---|---:|---:|---:|---:|---:|---:|
| Noon | 324 | 332 | 13 | 56 | 8,142 | 987 (12.1%) |
| 8:30 p.m. | 242 | 247 | 13 | 56 | 8,007 | 623 (7.8%) |
| 10 p.m. | 6 | 6 | 13 | 56 | 7,994 | 18 (0.2%) |
| 12:30 a.m. next day | 1 | 1 | 13 | 56 | 7,885 | 8 (0.1%) |

## Facility audit

- 475 in-boundary facility locations after source-specific consolidation.
- 582 underlying source records.
- Out-of-boundary facility locations excluded: 1.
- 6 cross-source pairs within 50 m are listed in `nearby-cross-source-pairs.csv`.
- Manual decisions for those pairs are recorded in `data/fg03/nearby-pair-audit.csv`.
- Same-address records within 100 m share one access-point cluster. Distinct addresses remain separate even when nearby.
- `access_condition` distinguishes unrestricted public access from TTC facilities in fare-paid areas; every TTC record is marked `fare_paid`.
- `closure_category` records the Parks reason when published: seasonal, temporary, construction, or none. Partial closures remain available with their source note and flag.
- Automated public washrooms remain information gaps because the official source publishes the season but not daily hours.
- Library accessibility remains unknown because the source confirms public washrooms but does not publish washroom-level accessibility.

## Method

1. Consolidate Parks, libraries, CREM buildings, museums and cultural centres, automated public washrooms, and TTC washroom stations.
2. Normalize published weekly hours. Keep unknown hours distinct from scheduled closure.
3. Apply live Parks closure status. Partial closures remain available with a flag.
4. Exclude fare-paid TTC washrooms from unrestricted public coverage and report their open count separately.
5. Snap unrestricted open facilities and scheduled TTC stops to the City Pedestrian Network.
6. Run a multi-source 400 m shortest-path search with the facility-to-network snap offset included.
7. Count a TTC stop as covered only when its network distance plus stop snap distance is at most 400 m.

The City describes the pedestrian network as topologically focused and notes known completeness and classification limitations. These maps show documented scheduled access, not guaranteed real-time availability or passenger demand.
