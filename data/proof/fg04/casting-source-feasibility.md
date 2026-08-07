# FG04 casting-source feasibility

Date: 2026-08-07

## Finding

The model can identify a controlling obstruction from its source height
surface, but the shipped static artifact cannot. Supporting arbitrary points
requires a material new attribution pyramid or a new query service. The v3
shade tile alone cannot name a building, canopy, or height.

This is a scope finding, not a recommendation to infer the source from the
visible map. An unsupported source label would defeat the checkability reason
for the feature.

## What v3 proves, and what it does not

Each v3 pixel carries exactly three bytes:

- Red: shaded-frame count.
- Green: mask bits 8 to 14.
- Blue: mask bits 0 to 7.

The count is redundant with the mask at native zoom. No byte identifies the
source cell, source class, distance, or height. Multiple scenes with different
buildings and canopy can produce the same fifteen-bit mask at a target point.
Source identity is therefore not recoverable from v3, even in principle.

The planned classification tiles do not solve this. They distinguish ground,
non-ground, missing coverage and ground under canopy at the selected point.
They do not describe an obstruction tens or thousands of metres toward the
sun.

## Point tracing is supportable when the source surface is present

`fg04_attribution.trace_caster` follows the same rounded solar offsets and ray
rise as `fg04_shadow.cast_shadow`. It returns the source cell with the greatest
apparent altitude above the selected point. That cell controls when direct sun
clears the local horizon.

Six synthetic tests pin a known obstacle, competing obstacles, a clear ray,
agreement with the existing shadow sweep, invalid inputs, and the below-horizon
case.

One real v3 proof point was traced against the existing 2 m DSM-minus-DTM
surface:

| Clock hour | Point state | Source distance | Source height | Land-cover class | Trace time after read |
|---|---|---:|---:|---|---:|
| 13:00 | shaded | 30 m | 79.40 m | building | 3.263 ms |
| 20:00 | shaded | 70 m | 74.37 m | building | 4.054 ms |

The 8.8 km source window was 4,401 by 4,401 pixels and took 2.317 seconds to
read from the local mosaics. This shows the split clearly. The ray calculation
is cheap. Getting enough source data to the calculation is the feature.

## The 06:00 exception is unavoidable

The 06:00 frame is shaded everywhere because its 0.38° sun sits below the
model's 0.5° cutoff. `cast_shadow` returns an all-true mask without reading the
surface. There is no building or canopy to name for that frame.

Any supportable interface needs a third explanation for 06:00: the frame is
below the model cutoff. Calling a building or canopy the source at 06:00 would
be false even after an attribution dataset exists.

## Delivery routes measured against the current pyramid

There are 3,758 populated z16 tile coordinates per surface.

### 1. Precomputed attribution by hour and surface

Store caster class and quantized height for each casting frame and surface.
The reader fetches two small tiles for the selected point and hour.

- 14 casting frames x 2 surfaces x 3,758 coordinates = **105,224 new tile
  objects** before manifests.
- Requires a citywide argmax shadow pass that retains source cell identity.
- Gives deterministic, fast point responses on the static site.
- Needs a codec prototype before bytes and build time can be stated honestly.
- The 06:00 frame still needs the model-cutoff explanation.

This is the strongest static delivery contract, and clearly a new pyramid.

### 2. Source height and class tiles with browser ray tracing

Ship measured height, corrected height and land-cover class at z16, then run
the tested point tracer in the browser.

- 3 layers x 3,758 coordinates = **11,274 new tile objects**.
- The 20:00 maximum model buffer is about 4.39 km. A z16 tile covers about
  443 m on the ground in Toronto, so one worst-case ray crosses roughly ten
  tiles per layer.
- A selected point can therefore require about thirty source-tile requests at
  the edge of the day.
- Height tiles need a lossless multi-byte contract and a browser cache.
- The browser must reproduce source-window seams, nodata, canopy class and the
  exact shadow offsets.

This uses fewer objects but moves substantial geospatial machinery and a
worst-case network fan-out into the reader's device.

### 3. Point-query service

Keep source data off the page and send coordinate, surface and hour to a
service that returns class, height and the evidence coordinate.

- Avoids a public attribution pyramid and keeps the browser response small.
- Adds runtime infrastructure to an otherwise static atlas.
- Still needs a tiled or indexed source-surface data product behind the
  service.
- Needs availability, timeout, abuse and deployment contracts that do not
  exist in the repository.

This is not a small endpoint. It is a new operating surface.

## Recommendation

Do not add a guessed caster label to Phase 3. If arbitrary-point casting
attribution remains required, scope a Phase 3b around precomputed z16
attribution tiles. That route keeps the reader interaction fast and preserves
the static deployment model, but it adds at least 105,224 versioned objects and
a new citywide derivative pass.

The decision for Jonathan is binary:

1. Approve the material attribution pyramid and extend Phase 3.
2. Ship the interactive explorer without caster identity, state the 06:00
   model-cutoff exception, and record casting attribution as deliberately
   deferred rather than silently removed.

Until that decision is made, the explorer can proceed without a source label.
Nothing reader-visible will imply that v3 contains attribution it does not.
