# Throwing Shade | pre-registration

Written before any citywide shade raster was computed. Any change after that
point must be recorded here with a date and a reason, and disclosed in the
guide.

## Hypotheses

H1. Ground shade reaches its citywide minimum at solar noon.
H2. Downtown holds more mean shaded hours than the inner suburbs.
H3. A set of arterial road segments is shade-poor as defined below.
H4. Shade coverage differs between Neighbourhood Improvement Areas and the
    rest of the city.

## Definitions, fixed in advance

- **Modelled day:** 21 July, 15 hourly frames, 06:00 to 20:00 EDT.
- **Ground pixel:** a pixel whose normalised height is under 2 m.
- **Sidewalk sample:** ground pixels within 6 m of a street centreline from
  `public/data/streets-major.geojson` and `streets-minor.geojson`.
- **Shade-poor segment:** a street segment whose sidewalk samples are shaded
  in fewer than N of the 15 frames, on median.
- **N = 5**, meaning under a third of the day. Chosen 2026-08-06 by Jonathan,
  before any citywide shade raster existed. Rationale: given the shade floor
  recorded below, fewer than 5 shaded frames means at most one usable shaded
  hour between 07:00 and 19:00.
- **Citywide shortage:** at least X% of arterial kilometres are shade-poor.
- **X = 25**. Chosen 2026-08-06 by Jonathan, before any citywide shade raster
  existed. A quarter of Toronto's arterial kilometres.

## How to read N: the modelled day has a shade floor

Recorded 2026-08-06, before the citywide run, because it changes what any
value of N means and must not be discovered afterwards.

Three of the fifteen frames sit at a low enough sun that shade is close to
free, and one is unconditional:

| Frame | Clock | Sun altitude | Shadow / height |
|---|---|---|---|
| 0 | 06:00 | 0.38° | every pixel is marked shaded by construction |
| 1 | 07:00 | 9.87° | 5.75 |
| 13 | 19:00 | 18.15° | 3.05 |
| 14 | 20:00 | 7.78° | 7.32 |

Frame 0 is at or below the model's 0.5° horizon cutoff, so it shades the
whole city unconditionally. At frames 1, 13 and 14 a single 10 m street tree
throws 58 m, 31 m and 73 m, so anything with an object near it is shaded too.

**Consequence:** every pixel in Toronto scores at least 1 shaded hour, and
almost any pixel on a built street scores 3 or 4 before the usable day
begins. A threshold of N = 5 therefore means "one or two shaded hours between
07:00 and 19:00", not "five hours of usable shade". The guide's copy must not
present a shaded-hours count as if all fifteen hours were equivalent.

This does not change the count that the base layer renders. It changes how
the shortage threshold is worded and how the number is explained.

## Addendum, 2026-08-06: what "arterial" and "segment" mean

Added after the shade rasters began building but **before any statistic was
computed**, because the definitions above named two terms the data does not
define for itself. Fixing them now rather than at reporting time is the whole
point of this document.

- **Arterial** is `public/data/streets-major.geojson` with `tier == "major"`:
  334 features, **2,935.3 km**. This is the denominator for X.
- **Motorways are excluded** (`tier == "motorway"`, 34 features, 1,453.6 km).
  Highway 401, the Don Valley Parkway and the Gardiner have no sidewalks, so
  a claim that they are shade-poor for a walker is not false, it is empty.
  Leaving them in would have inflated the shade-poor share with 1,453 km of
  road no reader will ever walk.
- **Segment** is one feature of `streets-major.geojson`, or one exploded part
  of `streets-minor.geojson`. The minor file ships as a single dissolved
  MultiLineString and has to be exploded to have segments at all: 25,469
  parts, 11,318.1 km.
- The shortage share X is measured in **kilometres of arterial**, not in
  count of segments, so that one long boulevard is not outweighed by a
  cluster of short stubs.
- At X = 25, the shortage condition needs **733.8 km** of the 2,935.3 arterial
  kilometres to be shade-poor.

## Change record, 2026-08-06: ground under a leaf-on crown counts as shaded

**This change was made after seeing a first set of results.** It is recorded
here in full, with what the numbers were before it, because a method changed
after the fact is exactly what this document exists to catch.

**What the first run reported.** Citywide mean shaded hours: raw 6.201,
corrected **5.974**. Shade-poor arterial share: raw 39.13%, corrected 37.92%.
The leaf-on correction appeared to *reduce* shade.

**Why that is impossible.** The correction only ever raises canopy height. It
adds obstruction and removes none, so it cannot lower shade anywhere.

**The cause, measured on a midtown block rather than assumed:**

| ground sample | raw | corrected | change |
|---|---|---|---|
| under 2018 tree canopy | 8.909 | 6.441 | **-2.468** |
| open ground | 5.090 | 5.281 | +0.191 |

Raising a canopy pixel lifts the sample point from the sidewalk to the top of
the crown, and the top of a crown is in full sun. The model was measuring how
lit a treetop is and reporting it as how shaded a sidewalk is. Open ground
moved the right way, +0.191, which is the real leaf-on effect: taller crowns
throwing further onto their neighbours.

**The change.** On the corrected surface only, a ground pixel lying under
2018 tree canopy is counted as shaded in every modelled daylight hour.

**The leaf-off surface is deliberately left alone.** In April the bare crown
really does let light through, so its lower figure is not an error to fix. The
gap between the two surfaces is the leaf-off bias this guide exists to report.

**Modelled assumption, to be stated in the guide:** a closed leaf-on crown is
treated as blocking the sun for the whole modelled day. Real crowns are not
opaque and low sun arrives sideways beneath them, so this is the generous end
of the estimate for canopy shade.

**This may change the headline.** Correcting it raises corrected shade, which
lowers the shade-poor share, which could carry it under X = 25 and cancel the
retitle. The direction of the fix was fixed by the physics before the new
numbers were computed, not chosen after seeing them.

## Change record, 2026-08-06: the sample band, and a denominator error

Two further corrections, both made after seeing results, both recorded in
full. Jonathan chose the sample band knowing what each choice produced.

**1. The denominator was not Toronto.** The addendum above fixed arterial at
`tier == "major"`, 2,935.3 km. Only **1,128.6 km of that is inside the city**;
`streets-major.geojson` spans the whole GTA, so 1,806.7 km runs through
Mississauga, Vaughan, Markham and Pickering. The tier filter was checked, the
spatial extent was not. All layers are now clipped to
`toronto-boundary.geojson`. This correction moved the shade-poor share **up**,
from 37.92% to 39.61% on the road band in that run, so it was not a change that
flattered any preferred answer. The later registration repair moved the final
road-band value to 39.50%.

**2. The "sidewalk sample" was measuring the roadway.** The pre-registration
defined it as ground within 6 m of a street centreline. An arterial right of
way runs 20 to 30 m, so 6 m from the centreline is a traffic lane. Measured:
**0.23%** of that band falls under tree canopy, against **6.64%** of ground
generally, because street trees overhang the boulevard and not the middle of
the road. The name said sidewalk and the radius said asphalt.

Both bands are now computed and reported:

| band | where it is | corrected shade-poor | shortage at X = 25 |
|---|---|---|---|
| **walk, 8 to 15 m** | where people walk | **5.26%** | fails |
| road, 0 to 6 m | traffic lanes | 39.50% | holds |

**The walk band governs the shortage test and the title**, chosen by Jonathan
on 2026-08-06 because it is what the pre-registration said it was measuring
and what the guide's stated job asks. The road band ships beside it, because
"the roadway is shade-poor and the sidewalk is not" is a finding rather than
a discarded variant.

This choice decides the title, and it was made with both numbers visible.
That is disclosed here rather than presented as if only one had been computed.

## Change record, 2026-08-07: repair one-pixel window registration

The citywide build wrote 14 of 19 covered 8 km windows one pixel south-east of
their own coordinates. The crop removed two separately rounded parts of the
same fractional buffer. For affected windows, `round(A) + round(B)` was one
pixel smaller than `round(A + B)`. The corrected build derives the crop from
the array georeference and passes a citywide zero-offset regression test.

This repair was required by the coordinates, not by the resulting figures.
Translation-invariant statistics held. Vector joins moved, with the narrow
walk band and point-sampled transit stops moving most:

| Published figure | before repair | after repair |
|---|---:|---:|
| Citywide mean, corrected | 7.020 | 7.197 |
| Ground shaded at 13:00, corrected | 19.70% | 20.73% |
| Walk band, raw | 6.79% | 8.49% |
| Walk band, corrected | 3.89% | 5.26% |
| Road band, raw | 41.92% | 42.04% |
| Road band, corrected | 39.61% | 39.50% |
| NIA mean, corrected | 6.855 | 7.034 |
| Non-NIA mean, corrected | 7.064 | 7.240 |
| Transit stop mean, raw | 6.15 | 6.00 |
| Transit stop mean, corrected | 6.30 | 6.17 |
| Staines Road, raw | 1.91 | 1.85 |
| Staines Road, corrected | 1.91 | 1.86 |
| Downsview, corrected | 3.86 | 3.90 |
| Corrected shadiest neighbourhood | Rosedale-Moore Park, 11.25 | Lawrence Park South, 11.30 |

The corrected NIA gap is 0.206 hours rather than 0.209. H1, H2, H3 and H4
still hold as published. The governing shortage remains a clear failure at
5.26% against the pre-registered 25% threshold, so the title does not change.

The first outside-downtown arterial ranking returned Oxton Avenue at 10.70
raw and 11.54 corrected, but the feature contains only 309.7 m of sampled
centreline and is a short residential street tagged as an arterial. The
published ranking requires at least 1 km of sampled centreline. Under that
floor the leader is St. Clair Avenue East, 9.99 raw and 10.65 corrected over
1,051.7 m. The floor and sampled length are written into `statistics.json`.

## Title rule

If the citywide shortage condition holds under the **leaf-on corrected**
surface, the guide is retitled **The Great Toronto Shade Shortage**. If it
holds only under the uncorrected surface, it is not a finding and the title
does not change.

## Reporting rule

Every statistic is reported twice, uncorrected and leaf-on corrected. If the
correction reverses a conclusion, that reversal is published.
