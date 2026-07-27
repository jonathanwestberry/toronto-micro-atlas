# Accessibility and reflow audit harness

Deliberately **not** wired into `npm test`. It needs a browser and a running
preview server, and the gate is meant to stay fast and hermetic. Run it by hand
when the visual layer changes.

It exists because this project keeps shipping bugs that pass typecheck, build
and all 154 tests, and that only a screenshot or a computed style catches. Phase
6 alone found: `.fg03 a` (0,1,1) beating `.map-stage__btn--expand` (0,1,0) and
painting the Expand label at 1.29:1, a hardcoded tab stop on a panel that only
sometimes scrolls, and four grid and flex tracks that refused to shrink.

## Setup

Nothing is added to `package.json`. Install the two tools into a scratch
directory instead, so the project's dependency tree does not grow for a tool
that runs a few times a phase:

    mkdir -p /tmp/tma-audit && cd /tmp/tma-audit
    npm init -y && npm install playwright@1.61.1 axe-core@4
    npx playwright install chromium     # only if the cached build is missing

Pin playwright to whatever version matches an already-downloaded Chromium
(`ls ~/Library/Caches/ms-playwright`); a mismatch triggers a 150MB download.

## Running

    npm run build && npm run preview &     # serves dist on :4321
    cd /tmp/tma-audit
    node <repo>/scripts/audit/audit.mjs         # ladder: 11 routes x 6 widths
    node <repo>/scripts/audit/report.mjs out/results.json
    node <repo>/scripts/audit/zoom.mjs          # 200% / 400% / text-only zoom

## What each one does

- **audit.mjs** — axe-core (wcag2a/aa, wcag21aa, wcag22aa) plus three probes axe
  does not cover: a contrast check that composites ancestor backgrounds itself,
  target sizes including pseudo-element hit areas, and horizontal overflow.
  Reports axe's *incompletes* too, since map labels over a canvas always land
  there and someone has to look.
- **report.mjs** — groups a results.json into findings, collapsing "the same
  problem at six widths" into one line.
- **zoom.mjs** — SC 1.4.4 and 1.4.10. Page zoom is emulated by halving the
  viewport, which is what the browser control actually does. Text-only zoom runs
  separately because it fails differently, and note that this codebase's spacing
  scale is in rem, so scaling the root font size scales the boxes too. That is a
  harsher test than any browser applies; treat its findings as robustness rather
  than as conformance.
- **distdiff.mjs / inlinediff.mjs** — before/after proof for refactors. Compares
  built HTML with asset hashes neutralised, and compares emitted CSS as a *set
  of rules* rather than as text. The rule-set check is the one that matters when
  moving CSS between files: an HTML diff cannot see a dropped selector or a lost
  media query. inlinediff.mjs splits markup from Astro's inlined `<style>`
  blocks so a colour change does not read as a markup change.

## Two contrast gotchas, both of which produced false results once

1. Chromium serialises `color-mix()` as `color(srgb r g b / a)` with 0-1
   channels. Parsing only `rgb()` silently falls through to the ancestor
   background and reports 1.0:1 on perfectly legible text. `parseColor` handles
   both, and resolves anything else through a canvas rather than treating it as
   transparent.
2. MapLibre stamps `role="button" aria-label="Map marker"` on every marker
   element including the decorative context labels, which are `aria-hidden`.
   Those are not targets, so 2.5.8 does not apply and the probe skips
   `[aria-hidden="true"]` subtrees. Contrast still applies to them: it is about
   what is on the screen, not what is in the accessibility tree.
