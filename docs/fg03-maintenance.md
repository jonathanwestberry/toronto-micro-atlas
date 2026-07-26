# FG03 maintenance

This document is the release runbook for **When Toronto Has to Go**. The dated public finding and the intervention explorer are separate products with separate evidence gates. Never refresh only the browser files or copy old audit decisions onto a new analysis hash.

## Architecture

FG03 has four layers:

1. Frozen source snapshots in `data/raw/fg03/`.
2. Phase 1 proof outputs in `data/proof/fg03/<snapshot-date>/`.
3. Phase 2 network analysis and manual audit evidence in `data/proof/fg03/<snapshot-date>/phase2/`.
4. A versioned browser contract in `public/data/fg03/<snapshot-date>/`.

`src/pages/guides/when-toronto-has-to-go/index.astro` renders the central evidence, native controls, default ranked results, method, limitations, and downloads as HTML. `src/scripts/fg03-map.ts` progressively mounts MapLibre after engagement. `src/scripts/fg03-map-core.mjs`, `fg03-state.mjs`, and `fg03-results.mjs` keep state transitions and result derivation testable outside the browser.

## Sources

The snapshot combines City of Toronto washroom records for parks, libraries, civic buildings, museums, and automated facilities; TTC station washroom information; the Toronto Pedestrian Network; the municipal boundary; and TTC GTFS scheduled service. Exact source URLs and snapshot hashes are recorded in the proof manifests and `data/provenance.md`.

The proof describes published records at a dated observation time. It does not guarantee physical entry, current service, ridership, demand, personal safety, or route accessibility.

## Transformations

- `20_download_washroom_proof.py` freezes and inventories the source snapshot.
- `21_build_washroom_proof.py` normalizes facilities, weekly hours, closure status, access conditions, transit activity, and Phase 1 grouped coverage.
- `fg03_schedule.py` parses weekly schedules without turning unknown or scheduled-closed periods into open periods.
- `fg03_transit.py`, `fg03_network.py`, and `fg03_analysis.py` build the Phase 2 stop-platform and pedestrian-network analysis.
- `fg03_interventions.py` ranks candidate actions and applies materiality and audit rules.
- `22_build_washroom_analysis.py` validates the analysis hash, enforces the release gate, and atomically exports proof and public artifacts.

Partial-service records retain their warning but still obey the published weekly schedule. A partial-service flag never makes a scheduled-closed or unknown period open.

## Data refresh

Use this order for every new snapshot:

1. Place the reproducible raw snapshot under `data/raw/fg03/`. This directory is intentionally ignored because GTFS and source archives are large.
2. Run `20_download_washroom_proof.py`.
3. Run `21_build_washroom_proof.py` with the new snapshot date.
4. Run `22_build_washroom_analysis.py` first with isolated temporary proof and public destinations.
5. Record the new analysis hash and compare the complete candidate set with the prior release.
6. Inspect every required map and source record. Update `data/fg03/phase2-audit-decisions.csv` only for the new hash and only after review.
7. Rebuild the real dated proof and public destinations. The builder must report a passing gate before recommendations appear.
8. Regenerate the social card from the verified 10 p.m. map.
9. Update dated copy and metadata only after counts are final.
10. Run the full release checks and visually inspect the local production preview.

Example Phase 1 build:

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python \
  data/scripts/21_build_washroom_proof.py \
  --snapshot-date 2026-07-21
```

Example Phase 2 build:

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python \
  data/scripts/22_build_washroom_analysis.py \
  --snapshot-date 2026-07-21 \
  --proof-dir data/proof/fg03/2026-07-21 \
  --raw-dir /absolute/path/to/toronto-micro-atlas/data/raw/fg03 \
  --public-dir public/data/fg03/2026-07-21
```

## Public schema

`manifest.json` is the entry point and carries `schemaVersion`, `snapshotDate`, the default explorer state, headline counts, gate status, limitations, and paths to:

- `facilities.geojson`
- `interventions.geojson`
- four dated stop snapshots
- `reach-facilities.geojson`
- `reach-promoted.geojson`

Facilities and interventions use browser-safe public IDs. Internal source IDs and raw trip IDs are not published. Stops and unaudited candidates never include reach geometry. Dated GeoJSON files are immutable after release; a changed analysis requires a new dated directory.

## Styling and copy

The guide uses the shared 4 px rhythm, a 1200 px content grid, warm paper `#F3EDDD`, contour ink `#1A1F2A`, and mauve `#8A4A70`. Archivo Variable is used for headings and interface text. Source Serif 4 Variable is used for editorial prose.

The central statement must always name its counting grain: Phase 1 grouped transit points. Phase 2 results must say GTFS stops and platforms. Do not combine these denominators, describe scheduled service as ridership, or describe an investigation zone as a construction-ready site.

## URL state

The explorer accepts:

- `time`: `1200`, `2030`, `2200`, or `0030`
- `access`: `public` or `rider`
- `walk`: `300`, `400`, or `500`
- `action`: `open`, `extend`, `new`, `verify`, or `retrofit`
- `place`: one current public facility or intervention ID
- `lng`, `lat`, and `zoom`: a bounded map view

Defaults are omitted from the canonical share URL. Unknown, duplicated, non-finite, or out-of-range values are discarded. Browser back and forward replay state without adding history entries.

## Analytics

The optional analytics bridge dispatches a sanitized `tma:analytics` custom event and calls `window.plausible` when available. Allowed event names are:

- `fg03_entry`, `fg03_engage`
- `fg03_time_change`, `fg03_access_change`, `fg03_walk_change`, `fg03_action_change`
- `fg03_search_use`, `fg03_feature_select`
- `fg03_method_view`, `fg03_data_download`
- `fg03_share`, `fg03_series_navigation`
- `fg03_error`, `fg03_journey_complete`

Properties are allowlisted in `src/scripts/atlas-events.mjs`. Analytics failure must never block the explorer.

### Cloudflare injection policy

Keep `Cache-Control: no-transform` on the five HTML rules in `public/_headers`: `/`, `/index.html`, `/about/*`, `/guides/*`, and `/404.html`. Production testing found that Cloudflare's automatically injected Web Analytics beacon version `2026.6.0` emitted a malformed `https:://` SPA payload. `no-transform` prevents automatic HTML injection while Cloudflare edge analytics remain available.

Do not remove `no-transform` or widen the same-origin CSP for the automatic beacon without retesting the current beacon, Astro `ClientRouter` navigation, History API payloads, direct page loads, and browser console output. See the [Cloudflare Web Analytics FAQ](https://developers.cloudflare.com/web-analytics/faq/) and [Cloudflare SPA analytics guidance](https://developers.cloudflare.com/web-analytics/get-started/web-analytics-spa/).

## Accessibility contract

- The complete argument and a useful default result list exist without JavaScript.
- Controls are native fieldsets and radio inputs, appear before the map, and remain inert until the runtime has usable data.
- Every map result has an equivalent ranked-list control.
- Selecting a result focuses its detail heading. Explicit close restores focus to the originating result.
- The map explains keyboard panning, zooming, and centre inspection.
- Loading, partial, offline, failed, stale, empty, and no-result states use explicit status or alert surfaces.
- Touch targets are at least 44 px. The layout must work at 320 px, 200 percent zoom, reduced motion, and forced colors.

## Local development

Install the supported runtime and dependencies:

```bash
nvm use
npm ci
python3 -m venv data/scripts/.venv
data/scripts/.venv/bin/pip install -r data/scripts/requirements-fg03.txt
```

Run the site:

```bash
npm run dev
```

Run the data tests:

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover \
  -s data/scripts/tests -p 'test_fg03*.py' -v
```

Run the web and production-contract tests:

```bash
npm run test:web
npm run check
npm run build
npm run test:web:contract
npm audit --omit=dev
```

Astro is pinned to `7.1.3` and the minimum Node version is `22.12.0`. As of the FG03 release, `npm audit --omit=dev` reports zero advisories.

## Cloudflare deployment

The site is static. A push to `main` starts `.github/workflows/deploy.yml`, which runs data tests, web logic tests, Astro check, build, the built-site contract, and the production dependency audit. The final step deploys `dist/` to the `toronto-micro-atlas` Cloudflare Pages project.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Preview hosts under `pages.dev` are marked `noindex`. The production custom domain is `https://torontomicroatlas.com`.

## Production verification

After deployment:

1. Open `/guides/when-toronto-has-to-go/` directly over HTTPS and refresh it.
2. Verify the canonical URL, Article metadata, social image, fonts, scripts, manifest, facilities, interventions, stops, and selected reach file.
3. Test every time, access, walk, and action control.
4. Select from the list and map, search, clear, reset, share, and use browser back and forward.
5. Test keyboard-only navigation, focus restoration, reduced motion, forced colors, 200 percent zoom, and a 320 px viewport.
6. Confirm there are no console errors, failed requests, horizontal overflow, or blocked WebGL workers.
7. Inspect cache and security response headers.
8. Recheck the homepage, About page, Hidden Landscapes, and Sidewalk Forest.

Record the evidence and final production responses in `docs/fg03-release-audit.md`.

## Limitations

The build is intentionally fail-closed. A changed analysis hash invalidates prior audit decisions. A failed product gate publishes the dated proof but withholds recommendations. Raw source availability, municipal update cadence, schedule interpretation, pedestrian-network topology, manual audit judgment, and browser WebGL support remain operational risks. Preserve those limits in both the interface and release notes.
