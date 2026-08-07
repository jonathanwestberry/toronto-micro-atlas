# Throwing Shade | Phase 0 findings

Computed 2026-08-06 from Ontario GTA 2023 lidar and Toronto's 2018 land
cover. Pre-registration in `PREREGISTRATION.md`, sources in
`data/provenance.md`, machine-readable output in `statistics.json`.

**This guide maps shade. It does not map temperature.** A shaded asphalt lot
can be hotter than a sunny lawn. Surface material, wind and humidity are not
modelled and no line of copy may claim coolness.

## How to read every number here

**Two surfaces, always reported together.** Every lidar flight ever made over
Toronto is spring: GTA 2014 April-May, GTA 2015 April, GTA 2023 April-May.
Buildings look the same in April as in July; deciduous trees do not. So
building shade is measured correctly and tree shade is understated, and the
bias runs one way. **Raw** is the measured leaf-off surface. **Corrected**
raises bare canopy to a leaf-on equivalent.

**Two bands, because it turned out to matter enormously.** The **walk** band
samples 8 to 15 m from a street centreline, where the sidewalk is. The
**road** band is the pre-registered 6 m buffer, which on a 20 to 30 m
arterial right of way lands in the traffic lanes.

**Computed on a 2 m grid**, 15 hourly frames, 21 July, 06:00 to 20:00 EDT.

## Headline

**No citywide shade shortage on the streets people walk on.** 5.26% of
Toronto's arterial kilometres are shade-poor on the corrected surface,
against a pre-registered threshold of 25%. The condition fails, and it fails
by a wide margin rather than narrowly.

**The guide keeps the title *Throwing Shade*.** The pre-registered rule
retitled it *The Great Toronto Shade Shortage* only if the shortage held on
the corrected surface. It does not.

**The roadway is a different story: 39.50% of arterial kilometres are
shade-poor when measured over the traffic lanes.** Toronto's arterial roads
are largely bare and their sidewalks largely are not. That contrast, not a
shortage, is the honest finding.

## The pre-registered hypotheses

### H1. Ground shade reaches its citywide minimum at solar noon. **HELD.**

| | raw | corrected |
|---|---|---|
| minimum frame | 13:00 | 13:00 |
| shaded fraction of ground at minimum | 10.73% | 20.73% |

Solar noon is 13:25 EDT and 13:00 is the nearest modelled frame. The curve is
a clean bowl either way: on the corrected surface 100% at 06:00, 39.1% at
10:00, **20.73% at 13:00**, 32.5% at 16:00, 85.2% at 20:00.

Held on both surfaces, so the leaf-off bias does not touch this one.

### H2. Downtown holds more mean shaded hours than the inner suburbs. **HELD, BUT THE CORRECTION REVERSES WHO IS SHADIEST.**

This is the finding the leaf-off correction was built to catch, and it fired.

| rank | raw, shadiest neighbourhoods | corrected, shadiest neighbourhoods |
|---|---|---|
| 1 | Yonge-Bay Corridor, 10.90 | **Lawrence Park South, 11.30** |
| 2 | Downtown Yonge East, 10.60 | **Rosedale-Moore Park, 11.25** |
| 3 | Church-Wellesley, 10.58 | **Mount Pleasant East, 11.17** |

**Uncorrected, the three shadiest neighbourhoods in Toronto are downtown
tower districts. Corrected, all three are leafy midtown, and downtown drops
out of the top three entirely.**

The raw ranking is an artefact of the flight calendar. In April the towers
cast their full shadow and the midtown canopy casts almost none, so the
towers win. Give the trees their leaves and midtown overtakes them.

Downtown still comfortably beats the sunniest inner suburbs (Downsview 3.57
raw, 3.90 corrected), so H2 as written holds. But **any chapter claiming
downtown is the shadiest part of Toronto would have been reporting the month
the plane flew.**

### H3. A set of arterial segments is shade-poor. **HELD. The citywide shortage does NOT.**

Shade-poor means a median of fewer than **N = 5** shaded frames of 15.
Citywide shortage means at least **X = 25%** of arterial kilometres.

| band | surface | shade-poor share | of | shortage |
|---|---|---|---|---|
| **walk, 8-15 m** | raw | 8.49% | 1,128.6 km | **fails** |
| **walk, 8-15 m** | **corrected** | **5.26%** | 1,128.6 km | **fails** |
| road, 0-6 m | raw | 42.04% | 1,128.6 km | holds |
| road, 0-6 m | corrected | 39.50% | 1,128.6 km | holds |

Shade-poor arterials exist, so H3 holds in its literal form: 59.4 km of
them on the corrected walk band. The **citywide shortage condition fails**,
on the governing band, on both surfaces, by nearly a factor of five.

Reported plainly: **the shortage the working title anticipated is not there
for people on foot.** It is there for the road surface.

### H4. Shade differs between Neighbourhood Improvement Areas and the rest. **HELD IN DIRECTION, TOO SMALL TO CARRY A CHAPTER.**

| | raw | corrected |
|---|---|---|
| NIA mean shaded hours | 6.027 | 7.034 |
| non-NIA mean shaded hours | 6.246 | 7.240 |
| **difference** | **0.219** | **0.206** |

The 33 NIAs are less shaded than the rest of Toronto, in the expected
direction, on both surfaces. The gap is **0.21 of 15 hours, about 1.4% of the
modelled day**, and the leaf-on correction barely moves it (0.219 to 0.206).

**Recommendation: cut chapter 5, or rewrite it as a null result.** The spec
committed to cutting it rather than fudging it. A 0.21 hour difference cannot
support "shade is unevenly handed out" as a civic argument, and stating it as
one would be the manufactured inequality finding this whole phase existed to
prevent. That the correction did not rescue it is itself worth one honest
paragraph.

## Named things the guide can quote

Derived on the corrected surface unless stated.

- **Shadiest arterial: York Street, 11.74 mean shaded hours.** A downtown
  tower canyon. Unchanged from raw (11.70), because its shade is buildings.
- **Shadiest arterial outside downtown, with at least 1 km sampled: St. Clair
  Avenue East, 9.99 raw and 10.65 corrected**, over 1,051.7 m. The floor
  excludes a 309.7 m Oxton Avenue feature whose arterial tag is too short to
  support a citywide superlative.
- **Sunniest arterial: Staines Road, 1.85 raw and 1.86 corrected mean shaded
  hours.** In Scarborough, with almost no movement from the correction.
- **Shadiest neighbourhood: Lawrence Park South, 11.30 corrected**
  (Yonge-Bay Corridor, 10.90 raw).
- **Sunniest neighbourhood: Downsview, 3.90 corrected** (3.57 raw).
- **Sunniest transit stops**, at a single shaded hour of 15, including
  Midland Ave at Emblem Crt, Warden Ave at Roper Rd (North Commuter Parking
  Lot), and Kingston Rd at Highland Creek Overpass on both surfaces. That
  single hour is the 06:00 frame, which is shaded everywhere by construction,
  so these stops have **no modelled shade at all** during the usable day.
- Mean over all 8,432 transit stops: 6.00 raw, 6.17 corrected.

## The January scope measurement

Chapter six now has the one winter frame it promised. This is not a winter
day model and does not support any claim about how long shade lasts.

| Ground shaded at midday | measured, leaf-off | leaf-on corrected |
|---|---:|---:|
| 21 July 2026, 13:00 EDT, 66.19&deg; | 10.73% | 20.73% |
| 21 January 2026, 12:00 EST, 26.24&deg; | **47.22%** | **53.27%** |

The **47.22% measured value is the one to read in January** because the trees
are bare. The 53.27% corrected column is a summer-foliage counterfactual,
printed because this guide always shows both surfaces.

## Exclusions and counts

- **727 DSM and 727 DTM tiles**, clipped to the municipal boundary. The
  product plan's 1,031 was a bounding-box count including lake, Peel and York.
- **1,128.6 arterial km**, of 2,935.3 km in `streets-major.geojson`. The rest
  lies outside Toronto. 174 arterial segments after clipping, of 334.
- **10,584 street segments** total after clipping, of 25,803.
- Motorways excluded, 34 features: no sidewalks, so a shade claim about them
  is empty rather than false.
- **33 NIA polygons**, all live, on the current 158-neighbourhood system.
- Ground pixel means normalised height under 2 m, taken from the **measured**
  surface so that raw and corrected share one denominator.

## Limitations, all of which belong in the guide

1. **The correction is generous where it matters most.** Ground under a
   leaf-on crown is counted as shaded for the whole modelled day. Real crowns
   are not opaque and low sun arrives sideways beneath them.
2. **The correction is a step at 3 m.** It fixes canopy the flight missed and
   under-corrects canopy the flight partly caught, so it is not a full
   leaf-on reconstruction. 99.8% of raised pixels took a height measured from
   a neighbouring crown, not the assumed 8 m default, so it is evidence-led.
3. **Land cover is 2018, lidar is 2023.** Five years of growth and removal sit
   between them, in both directions. One consequence is visible in the build
   report: a maximum correction rise of 142.5 m, which is a 2018 tree polygon
   now standing over a 2023 tower.
4. **Three of fifteen frames are near-free shade, and one is unconditional.**
   06:00 sits at 0.38&deg;, at or below the model's horizon cutoff, so
   **every pixel in Toronto scores at least one shaded hour by construction**.
   A shaded-hours count must never be presented as fifteen equal hours.
5. **One July day and one January frame.** The main model is 21 July 2026.
   The winter comparison is 12:00 EST on 21 January 2026 only. It measures
   midday coverage, not a winter day or season.
6. **Roofs are invented and the flight has a date.** Anything built or felled
   since April 2023 is missing.
7. **The NIA designation is a dated instrument**, 31 of 140 neighbourhoods on
   2011 census tracts by origin, though the published layer is now keyed to
   the current 158-neighbourhood system.
8. **Computed at 2 m**, not the 1 m the implementation plan specified. Every
   figure here is a 2 m figure.

## What this means for the guide

- **Title stays *Throwing Shade*.** The shortage condition failed.
- **Chapter 2 holds.** Noon is every neighbourhood's minimum, 20.73% corrected.
- **Chapter 3 needs rewriting.** "Where height buys shade" is true of York
  Street and false of the city's shadiest neighbourhoods, which are leafy
  midtown once trees have leaves. The honest chapter is that towers and trees
  buy shade differently, and the flight calendar hides the trees.
- **Chapter 4 changes shape.** There is no shortage for walkers. There is a
  bare roadway, and a real set of sunless arterials like Staines Road.
- **Chapter 5 should be cut**, or published as a null result at 0.21 hours.
- **Chapter 6 now carries one January midday measurement.** Read the measured
  47.22%; the corrected 53.27% is a summer-foliage counterfactual.

## Registration correction, 2026-08-07

The original citywide build placed most 8 km windows one pixel south-east of
their own coordinates. The crop used two separately rounded parts of a
fractional buffer, so `round(A) + round(B)` differed from `round(A + B)` by one
pixel for 14 of 19 windows. The rebuild derives each crop from the array's own
georeference. Translation-invariant figures held, while vector-joined figures
moved most where the sample geometry was narrow. The statistics above are the
post-fix figures from `statistics.json`.
