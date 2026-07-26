# FG03 production release audit

Audit date: 2026-07-26

## Release record

- Production URL: [When Toronto Has to Go](https://torontomicroatlas.com/guides/when-toronto-has-to-go/)
- Release pull requests: [#1](https://github.com/jonathanwestberry/toronto-micro-atlas/pull/1), [#2](https://github.com/jonathanwestberry/toronto-micro-atlas/pull/2), [#3](https://github.com/jonathanwestberry/toronto-micro-atlas/pull/3), and [#4](https://github.com/jonathanwestberry/toronto-micro-atlas/pull/4)
- Latest workflow run reviewed: [30189751660](https://github.com/jonathanwestberry/toronto-micro-atlas/actions/runs/30189751660)
- Latest workflow conclusion: success. All release gates and the Cloudflare Pages deployment completed in 1 minute 35 seconds.

The production route returned HTTP 200 and reached a ready map state throughout the browser matrix below.

## Automated release gates

| Gate | Result |
| --- | ---: |
| FG03 Python data tests | 99 of 99 passed |
| Web logic tests | 98 of 98 passed |
| Astro diagnostics | 0 errors, 0 warnings, 0 hints |
| Built-site contract | 16 of 16 passed |
| Production dependency audit | 0 vulnerabilities |
| Automated accessibility scan | 0 axe violations |

The local release commands were:

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover \
  -s data/scripts/tests -p 'test_fg03*.py' -v
npm run test:web
npm run check
npm run build
npm run test:web:contract
npm audit --omit=dev
```

## Data proof

The dated public finding keeps the Phase 1 grouped-transit-point grain separate from the Phase 2 GTFS stop and platform grain.

| Time | Unrestricted open access points | Active grouped transit points | Covered grouped transit points |
| --- | ---: | ---: | ---: |
| Noon | 324 | 8,142 | 987 |
| 8:30 p.m. | 242 | 8,007 | 623 |
| 10 p.m. | 6 | 7,994 | 18 |
| 12:30 a.m. | 1 | 7,885 | 8 |

Phase 2 considered 843 deduplicated candidates. Fifty-six survived the robustness rules, 34 required manual map and source review, 25 passed, 9 were excluded, and 0 remain unresolved.

- Public records: 475 facilities and 25 audited interventions
- Analysis hash: `aafebe1d0373fe78f878042aac41e0db6e07b0d1f7238d056cd83505072cdb2b`
- Exhaustive results digest: `2337279f9d9fe95b81ed1903ff8870673a2a1786886cc7c82f268e96a52709a6`
- Results matrix: 120 of 120 valid states, with 96 nonempty states
- Privacy scan: 134,626 raw trip IDs checked with 0 public leaks
- Determinism: all 9 public files rebuilt byte-for-byte identically
- Largest compressed public file: 1,091,820 bytes, below the 1.5 MB release budget

## Production browser coverage

| Environment | Route | Explorer |
| --- | --- | --- |
| Chromium | HTTP 200 | Map ready |
| System Google Chrome | HTTP 200 | Map ready |
| Firefox | HTTP 200 | Map ready |
| Playwright WebKit | HTTP 200 | Map ready |
| Installed Safari | HTTPS page loaded | Map ready |
| iPhone 13 WebKit | HTTP 200 | Map ready |
| Pixel 7 Chromium | HTTP 200 | Map ready |
| iPad Mini WebKit | HTTP 200 | Map ready |
| Landscape mobile | HTTP 200 | Map ready |
| 320 px viewport | HTTP 200 | Map ready |

The installed Safari check also confirmed that its accessibility tree exposes the native radio groups, search field, map region, zoom controls, ranked-result buttons, disclosures, headings, table, sources, and downloads with useful names. VoiceOver was toggled on for representative navigation-key checks, then restored to its original state. Spoken output was not recorded.

## Performance

| Measurement | Result |
| --- | ---: |
| Useful HTML available | 223.5 ms |
| Representative interaction | 247.9 ms |
| Cumulative Layout Shift | 0.06887 |
| Initial MapLibre document dependency | None |

These are measurements from the recorded production audit run, not universal network or device guarantees.

## Resilience

The production harness confirmed:

- Individual facilities, interventions, and stops request failures preserve a useful partial-data state.
- A manifest failure exposes retry, and the test completed after two attempts.
- A selected detail remains readable when its reach request fails.
- Stale and offline states are explicit.
- WebGL failure falls back to the proof and synchronized results rather than removing the argument.
- Server-rendered results and headline evidence remain available before interactive data is ready.

## Headers, security, and analytics

The production policy keeps CSP network and script origins same-origin only, while allowing the local data and blob capabilities required by the map. `Cache-Control: no-transform` appears on exactly five HTML rules: `/`, `/index.html`, `/about/*`, `/guides/*`, and `/404.html`.

During verification, Cloudflare's automatically injected Web Analytics beacon version `2026.6.0` produced a malformed `https:://` SPA payload. The HTML `no-transform` rules intentionally prevent that automatic response mutation. Cloudflare edge analytics remain available without the injected browser beacon.

This decision follows Cloudflare's documentation that `no-transform` prevents automatic beacon injection and that SPA measurement modifies History API behavior:

- [Cloudflare Web Analytics FAQ](https://developers.cloudflare.com/web-analytics/faq/)
- [Cloudflare Web Analytics for SPAs](https://developers.cloudflare.com/web-analytics/get-started/web-analytics-spa/)

## Known limitations

- Microsoft Edge was not installed in the verification environment.
- Playwright WebKit provided automated Safari-like coverage.
- VoiceOver speech output was not independently captured. The check used its navigation keys and Safari's macOS accessibility tree.
