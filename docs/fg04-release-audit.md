# FG04 release candidate audit

Audit date: 2026-08-07

## Release record

- Guide: Throwing Shade, internal id `fg04`
- Branch: `fg04-phase-0`
- Audited commit: `589659f371a5ad547510739c5ce9990116f61652`
- Runtime: Node 22.12.0
- State: release candidate, not pushed, merged, or deployed
- Production guide route: HTTP 404
- Production manifest: HTTP 404

The 404 responses are expected. This branch has not been deployed, and the
release workflow has no preview environment. A push to `main` is the production
deployment trigger.

## Automated release gates

| Gate | Result |
| --- | ---: |
| FG0 Python data tests | 325 passed, 1 intentional skip |
| Node runtime assertions | 181 passed |
| Astro diagnostics | 0 errors, 0 warnings, 12 pre-existing hints |
| Built-site contracts | 50 passed |
| `npm audit` | 0 vulnerabilities |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Production build | 453 files |
| FG04 tile files in `dist` | 0 |
| Direct Chrome byte checks | 2 passed |
| Keyboard acceptance checks | 10 passed |
| Six-width axe violations | 0 |
| Six-width horizontal spills | 0 |
| FG04 zoom and reflow clipping | 0 |

The final commands were:

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover \
  -s data/scripts/tests -p 'test_fg0*.py'

PATH="/Users/jonathanwestberry/.local/node/node-v22.12.0-darwin-arm64/bin:$PATH" \
  npm test
PATH="/Users/jonathanwestberry/.local/node/node-v22.12.0-darwin-arm64/bin:$PATH" \
  npm audit
PATH="/Users/jonathanwestberry/.local/node/node-v22.12.0-darwin-arm64/bin:$PATH" \
  npm audit --omit=dev
PATH="/Users/jonathanwestberry/.local/node/node-v22.12.0-darwin-arm64/bin:$PATH" \
  npm run verify:fg04-release
PATH="/Users/jonathanwestberry/.local/node/node-v22.12.0-darwin-arm64/bin:$PATH" \
  npm run verify:fg04-browser
PATH="/Users/jonathanwestberry/.local/node/node-v22.12.0-darwin-arm64/bin:$PATH" \
  npm run verify:fg04-explorer
```

## CI deployment order

The contract in `tests/fg04-release.test.mjs` proves this exact order in
`.github/workflows/deploy.yml`:

1. Check out the repository.
2. Set up Node 22.12.0.
3. Set up Python 3.14.
4. Install web and data dependencies.
5. Run the complete FG0 Python suite.
6. Run Node runtime tests.
7. Run Astro and TypeScript checks.
8. Build `dist`.
9. Run built-site contracts.
10. Verify FG04 candidate contents, headers, manifest paths, and live R2.
11. Run `npm audit --omit=dev`.
12. Deploy `dist` to Cloudflare Pages.

The contract also fails if any release step appears after the Cloudflare
deployment command.

## Production candidate contents

The release verifier found 453 files and required all of these paths:

- `guides/out-of-the-sun/index.html`
- `data/fg04/manifest.json`
- `data/fg04/street-profiles.json`
- `social/og-throwing-shade.jpg`
- `_headers`

No shade or classification WebP appears in `dist`. The manifest remains pinned
to these products:

- measured v3: `https://tiles.torontomicroatlas.com/fg04/v3/raw/{z}/{x}/{y}.webp`
- corrected v3: `https://tiles.torontomicroatlas.com/fg04/v3/corrected/{z}/{x}/{y}.webp`
- class v2: `https://tiles.torontomicroatlas.com/fg04/class/v2/{z}/{x}/{y}.webp`
- street profiles: `/data/fg04/street-profiles.json`

The candidate `_headers` file now permits the R2 hostname in `connect-src`.
The unversioned FG04 manifest and street asset both use `public, no-cache,
must-revalidate`.

## Direct R2 transport

The release verifier sent `Origin: https://torontomicroatlas.com` to one raw
v3 tile, one corrected v3 tile, and one class v2 tile. All three returned:

- HTTP 200
- `Content-Type: image/webp`
- `Cache-Control: public, max-age=31536000, immutable`
- `Access-Control-Allow-Origin: *`
- `Access-Control-Expose-Headers: ETag`

The observed ETags were:

| Product | ETag |
| --- | --- |
| raw v3 | `ce4131eee8318f92ae6af78b748c5292` |
| corrected v3 | `7df62c256bd96f1afbebfc7db04b86f3` |
| class v2 | `c22700930603528f8665ae902a7a9764` |

The preflight returned HTTP 204, allowed GET and HEAD, and set a max age of
86,400 seconds.

## Browser contract preservation

System Chrome fetched the real raw v3 tile directly from R2. It decoded these
two independent Python reference pixels:

| Pixel | RGB | Mask | 13:00 |
| --- | --- | --- | --- |
| row 128, column 128 | `(11,112,255)` | `0x70ff` | shaded |
| row 126, column 127 | `(10,124,103)` | `0x7c67` | sunlit |

The complete explorer verifier passed all existing contracts for:

- the bare 13:00 URL and canonical selected-hour URLs;
- synchronized camera and selected-hour expressions;
- both measured and corrected surfaces;
- paired fifteen-hour point profiles and cached hour changes;
- paired fifteen-hour York Street profiles;
- malformed URL cleanup;
- Back and Forward replay without new history entries;
- share URL copy and focus retention;
- manifest, measured tile, classification tile, and street asset recovery;
- explicit missing-street no-data behavior.

The added keyboard scenario used trusted Chrome key dispatch. Home, End, and
arrow keys changed the native range and both map expressions. Enter on a
focused map selected its centre and produced paired markers. Keyboard text
entry found York Street, Tab reached its ordinary result button, Enter selected
it, and Enter activated the share button without moving focus. Changing the
hour kept the three decoded point tiles cached.

## Accessibility, zoom, and reflow

The final FG04 candidate was audited at 320, 480, 768, 1024, 1280, and 1440 px.
Axe ran at all six widths.

| Check | Result at all six widths |
| --- | ---: |
| Text contrast failures | 0 |
| Non-text contrast failures | 0 |
| Horizontal spill | 0 |
| Axe violations | 0 |
| Targets below 24 px | 0 |

Axe marked four MapLibre text surfaces incomplete for automated contrast at
each width. The independent computed-style contrast probe inspected those
surfaces and found zero failures. The audit also lists the two MapLibre
canvases as tab stops. They are intentional: the documented keyboard path
focuses either map and uses Enter to inspect its centre.

The final reflow matrix for FG04 was:

| Mode | Horizontal overflow | Clipped content | Header height |
| --- | ---: | ---: | ---: |
| 200% | 0 | 0 | 15.1% of viewport |
| 400% | 0 | 0 | 25.1% of viewport |
| 200% text | 0 | 0 | 14.9% of viewport |
| narrow 200% text | 0 | 0 | 26.5% of viewport |

The header crosses the audit's quarter-viewport advisory at 400% and narrow
200% text on every route. It is shared site behavior, not an FG04 regression.

## Known advisories and closed decisions

- One generic site-wide 404 remains in the audit console at every width. It is
  not an FG04 tile or CORS failure.
- Astro reports 12 pre-existing unused-symbol hints in FG03 files.
- Vite reports the existing large-chunk advisory.
- The Python suite reports existing NumPy and pvlib deprecation warnings.
- Named caster attribution remains explicitly deferred with Jonathan's
  approval. The v3 tile does not contain a defensible caster identity.
- No tile byte changed. v3 and class v2 remain immutable.

## Remaining action

Jonathan must explicitly authorize the production release. The release action
is a push to `main`. After GitHub Actions and Cloudflare Pages finish, verify
the production guide route, manifest, candidate cache and security headers,
direct R2 interaction, URL restoration, selected hour, point and street
profiles, recovery, Back, Forward, and share behavior. Until that authorization
and verification, the release state remains `release candidate, not deployed`.
