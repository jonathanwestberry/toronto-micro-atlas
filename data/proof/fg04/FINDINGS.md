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

**No citywide shade shortage on the streets people walk on.** 3.89% of
Toronto's arterial kilometres are shade-poor on the corrected surface,
against a pre-registered threshold of 25%. The condition fails, and it fails
by a wide margin rather than narrowly.

**The guide keeps the title *Throwing Shade*.** The pre-registered rule
retitled it *The Great Toronto Shade Shortage* only if the shortage held on
the corrected surface. It does not.

**The roadway is a different story: 39.61% of arterial kilometres are
shade-poor when measured over the traffic lanes.** Toronto's arterial roads
are largely bare and their sidewalks largely are not. That contrast, not a
shortage, is the honest finding.

## The pre-registered hypotheses

### H1. Ground shade reaches its citywide minimum at solar noon. **HELD.**

| | raw | corrected |
|---|---|---|
| minimum frame | 13:00 | 13:00 |
| shaded fraction of ground at minimum | 10.73% | 19.70% |

Solar noon is 13:25 EDT and 13:00 is the nearest modelled frame. The curve is
a clean bowl either way: on the corrected surface 100% at 06:00, 37.4% at
10:00, **19.7% at 13:00**, 31.8% at 16:00, 84.2% at 20:00.

Held on both surfaces, so the leaf-off bias does not touch this one.

### H2. Downtown holds more mean shaded hours than the inner suburbs. **HELD, BUT THE CORRECTION REVERSES WHO IS SHADIEST.**

This is the finding the leaf-off correction was built to catch, and it fired.

| rank | raw, shadiest neighbourhoods | corrected, shadiest neighbourhoods |
|---|---|---|
| 1 | Yonge-Bay Corridor, 10.90 | **Rosedale-Moore Park, 11.25** |
| 2 | Downtown Yonge East, 10.60 | **Mount Pleasant East, 11.17** |
| 3 | Church-Wellesley, 10.58 | **Lawrence Park South, 11.08** |

**Uncorrected, the three shadiest neighbourhoods in Toronto are downtown
tower districts. Corrected, all three are leafy midtown, and downtown drops
out of the top three entirely.**

The raw ranking is an artefact of the flight calendar. In April the towers
cast their full shadow and the midtown canopy casts almost none, so the
towers win. Give the trees their leaves and midtown overtakes them.

Downtown still comfortably beats the sunniest inner suburbs (Downsview 3.57
raw, 3.86 corrected), so H2 as written holds. But **any chapter claiming
downtown is the shadiest part of Toronto would have been reporting the month
the plane flew.**

### H3. A set of arterial segments is shade-poor. **HELD. The citywide shortage does NOT.**

Shade-poor means a median of fewer than **N = 5** shaded frames of 15.
Citywide shortage means at least **X = 25%** of arterial kilometres.

| band | surface | shade-poor share | of | shortage |
|---|---|---|---|---|
| **walk, 8-15 m** | raw | 6.79% | 1,128.6 km | **fails** |
| **walk, 8-15 m** | **corrected** | **3.89%** | 1,128.6 km | **fails** |
| road, 0-6 m | raw | 41.92% | 1,128.6 km | holds |
| road, 0-6 m | corrected | 39.61% | 1,128.6 km | holds |

Shade-poor arterials exist, so H3 holds in its literal form: about 44 km of
them on the corrected walk band. The **citywide shortage condition fails**,
on the governing band, on both surfaces, by a factor of six.

Reported plainly: **the shortage the working title anticipated is not there
for people on foot.** It is there for the road surface.

### H4. Shade differs between Neighbourhood Improvement Areas and the rest. **HELD IN DIRECTION, TOO SMALL TO CARRY A CHAPTER.**

| | raw | corrected |
|---|---|---|
| NIA mean shaded hours | 6.027 | 6.855 |
| non-NIA mean shaded hours | 6.246 | 7.064 |
| **difference** | **0.219** | **0.209** |

The 33 NIAs are less shaded than the rest of Toronto, in the expected
direction, on both surfaces. The gap is **0.21 of 15 hours, about 1.4% of the
modelled day**, and the leaf-on correction barely moves it (0.219 to 0.209).

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
- **Sunniest arterial: Staines Road, 1.91 mean shaded hours.** In Scarborough,
  and identical raw and corrected, so it has neither towers nor canopy.
- **Shadiest neighbourhood: Rosedale-Moore Park, 11.25.**
- **Sunniest neighbourhood: Downsview, 3.86** (3.57 raw).
- **Sunniest transit stops**, at a single shaded hour of 15, including
  Pharmacy Ave at Princeway Dr and Birchmount Rd at Parnell Ave. That single
  hour is the 06:00 frame, which is shaded everywhere by construction, so
  these stops have **no modelled shade at all** during the usable day.
- Mean over all 8,432 transit stops: 6.30 corrected, 6.15 raw.

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
   06:00 sits at 0.38 degrees, at or below the model's horizon cutoff, so
   **every pixel in Toronto scores at least one shaded hour by construction**.
   A shaded-hours count must never be presented as fifteen equal hours.
5. **One day of one year.** 21 July 2026. Nothing generalises across seasons.
6. **Roofs are invented and the flight has a date.** Anything built or felled
   since April 2023 is missing.
7. **The NIA designation is a dated instrument**, 31 of 140 neighbourhoods on
   2011 census tracts by origin, though the published layer is now keyed to
   the current 158-neighbourhood system.
8. **Computed at 2 m**, not the 1 m the implementation plan specified. Every
   figure here is a 2 m figure.

## What this means for the guide

- **Title stays *Throwing Shade*.** The shortage condition failed.
- **Chapter 2 holds.** Noon is every neighbourhood's minimum, 19.7% corrected.
- **Chapter 3 needs rewriting.** "Where height buys shade" is true of York
  Street and false of the city's shadiest neighbourhoods, which are leafy
  midtown once trees have leaves. The honest chapter is that towers and trees
  buy shade differently, and the flight calendar hides the trees.
- **Chapter 4 changes shape.** There is no shortage for walkers. There is a
  bare roadway, and a real set of sunless arterials like Staines Road.
- **Chapter 5 should be cut**, or published as a null result at 0.21 hours.
- **Chapter 6, the winter frame, is untouched by any of this.**
