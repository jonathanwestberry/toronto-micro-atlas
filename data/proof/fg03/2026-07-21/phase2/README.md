# FG03 Phase 2 dated analysis

Snapshot date: 2026-07-21

This package measures scheduled TTC service supply near documented washroom access. It does not measure passenger demand or ridership and does not identify construction-ready sites.

## Product gate

- Result: pass
- Reason: all product-gate conditions passed
- Audited analysis hash: `97ac6d0224b911eaa71cd915487814e5995b70310a753ede2eb32087ac5c9084`

## Policy rules

- The primary candidate universe is frozen from Tuesday 10 p.m. and 12:30 a.m., unrestricted public access, observed closures, and 400 metre walking distance.
- Material gain requires at least 10 unique scheduled trips across the two late snapshots and at least 3 active stops at 400 metres.
- Public and fare-paid rider-conditional access remain separate.
- Scheduled closure, seasonal closure, temporary service, construction, accessibility, and missing information remain separate evidence categories.
- All reaches use clipped pedestrian-network geometry. They are not Euclidean circles.

## Limits

- Results describe one summer weekday source snapshot plus named sensitivities.
- Verification candidates describe potential gains only.
- Network and source limitations remain documented in the root provenance file.
