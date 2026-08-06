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

## Title rule

If the citywide shortage condition holds under the **leaf-on corrected**
surface, the guide is retitled **The Great Toronto Shade Shortage**. If it
holds only under the uncorrected surface, it is not a finding and the title
does not change.

## Reporting rule

Every statistic is reported twice, uncorrected and leaf-on corrected. If the
correction reverses a conclusion, that reversal is published.
