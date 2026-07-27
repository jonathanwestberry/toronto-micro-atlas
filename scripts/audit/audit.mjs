/**
 * Phase 6 audit harness for Toronto Micro-Atlas.
 *
 * Runs against the built `dist` served by `npm run preview`, in a real
 * Chromium, because this project has repeatedly shipped bugs that passed
 * typecheck, build and the full test suite.
 *
 * Three probes per route:
 *   1. axe-core (wcag2a/aa, wcag21aa, wcag22aa) — violations AND incompletes
 *   2. a compositing contrast probe that axe skips (background-image ancestors,
 *      semi-transparent layers), computed from getComputedStyle
 *   3. layout probes: horizontal overflow, elements past the right edge,
 *      heading outline, and SC 2.5.8 target sizes
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const ORIGIN = process.env.ORIGIN || 'http://localhost:4321';
const OUT = process.env.OUT || './out';
mkdirSync(OUT, { recursive: true });

const ROUTES = [
  ['home', '/'],
  ['gallery', '/guides/'],
  ['fg01', '/guides/hidden-landscapes/'],
  ['fg01-map', '/guides/hidden-landscapes/map/'],
  ['fg01-location', '/guides/hidden-landscapes/glen-stewart-ravine/'],
  ['fg02', '/guides/sidewalk-forest/'],
  ['fg02-map', '/guides/sidewalk-forest/map/'],
  ['fg03', '/guides/when-toronto-has-to-go/'],
  ['fg03-map', '/guides/when-toronto-has-to-go/map/'],
  ['about', '/about/'],
  ['404', '/404.html'],
];

const WIDTHS = [320, 480, 768, 1024, 1280, 1440];
const AXE_WIDTHS = (process.env.AXE_WIDTHS || '320,1280').split(',').map(Number);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

/* ---------- in-page probes ---------- */

const PROBE = `(() => {
  // Chromium serialises color-mix() as CSS Color 4 \`color(srgb r g b / a)\`
  // with 0-1 channels. Parsing only rgb() silently fell through to the
  // ancestor background and reported a 1.0 ratio on perfectly legible text.
  const parseColor = (s) => {
    if (!s || s === 'transparent' || s === 'none') return [0, 0, 0, 0];
    let m = s.match(/^color\\(srgb\\s+([^)]+)\\)/);
    if (m) {
      const p = m[1].split(/[\\s/]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] === undefined ? 1 : p[3]];
    }
    m = s.match(/rgba?\\(([^)]+)\\)/);
    if (m) {
      const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
    }
    if (s.startsWith('color(') || s.startsWith('oklch') || s.startsWith('lab')) {
      // Unhandled colour space: resolve it through the canvas so we never
      // silently treat it as transparent again.
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, 1, 1);
      cx.fillStyle = s;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], 1];
    }
    return [0, 0, 0, 0];
  };
  const over = (fg, bg) => {
    const a = fg[3];
    return [
      fg[0] * a + bg[0] * (1 - a),
      fg[1] * a + bg[1] * (1 - a),
      fg[2] * a + bg[2] * (1 - a),
      1,
    ];
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };

  // Walk ancestors compositing background-color; report if any ancestor
  // paints a background-image / gradient (axe bails here, we flag it).
  const effectiveBg = (el) => {
    let stack = [];
    let imageAncestor = null;
    let node = el;
    while (node && node !== document.documentElement.parentNode) {
      const cs = getComputedStyle(node);
      const bg = parseColor(cs.backgroundColor);
      const bi = cs.backgroundImage;
      if (bi && bi !== 'none' && !imageAncestor) imageAncestor = node.tagName.toLowerCase() + (node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\\s+/).join('.') : '');
      if (bg[3] > 0) stack.push(bg);
      if (bg[3] === 1) break;
      node = node.parentElement;
    }
    let acc = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
    return { bg: acc, imageAncestor };
  };

  const label = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.')
      : '';
    return el.tagName.toLowerCase() + id + cls;
  };

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  /* --- contrast probe: every element with its own directly-owned text --- */
  const contrast = [];
  const seen = new Set();
  document.querySelectorAll('body *').forEach((el) => {
    if (el.closest('.visually-hidden, [hidden], script, style, svg')) return;
    if (!visible(el)) return;
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim();
    if (!ownText) return;
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color);
    if (fg[3] === 0) return;
    const { bg, imageAncestor } = effectiveBg(el);
    const composited = fg[3] < 1 ? over(fg, bg) : fg;
    const px = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const r = ratio(composited, bg);
    const key = label(el) + '|' + cs.color + '|' + Math.round(r * 100);
    if (seen.has(key)) return;
    seen.add(key);
    if (r < need + 0.01) {
      contrast.push({
        sel: label(el),
        text: ownText.slice(0, 60),
        color: cs.color,
        bg: 'rgb(' + bg.slice(0, 3).map(Math.round).join(', ') + ')',
        px, weight, large, need, ratio: Math.round(r * 100) / 100,
        overImage: imageAncestor,
      });
    }
  });

  /* --- non-text contrast (SC 1.4.11): focusable control borders --- */
  const nonText = [];
  document.querySelectorAll('input, select, textarea, button, summary, [role="button"]').forEach((el) => {
    if (!visible(el)) return;
    const cs = getComputedStyle(el);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    if (bw < 0.5) return;
    const bc = parseColor(cs.borderTopColor);
    if (bc[3] === 0) return;
    const parent = el.parentElement ? effectiveBg(el.parentElement).bg : [255, 255, 255, 1];
    const composited = bc[3] < 1 ? over(bc, parent) : bc;
    const r = ratio(composited, parent);
    if (r < 3.0) {
      nonText.push({ sel: label(el), borderColor: cs.borderTopColor, against: 'rgb(' + parent.slice(0,3).map(Math.round).join(', ') + ')', ratio: Math.round(r * 100) / 100 });
    }
  });

  /* --- layout --- */
  const docW = document.documentElement.scrollWidth;
  const winW = window.innerWidth;
  const spills = [];
  if (docW > winW + 1) {
    document.querySelectorAll('body *').forEach((el) => {
      if (!visible(el)) return;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') return;
      const r = el.getBoundingClientRect();
      if (r.right > winW + 1 && r.width <= docW) {
        spills.push({ sel: label(el), right: Math.round(r.right), width: Math.round(r.width) });
      }
    });
  }

  /* --- headings --- */
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .filter(visible)
    .map((h) => ({ level: +h.tagName[1], text: h.textContent.trim().slice(0, 70) }));

  /* --- SC 2.5.8 target size (24x24 min, incl. pseudo-element hit areas) --- */
  const smallTargets = [];
  document.querySelectorAll('a[href], button, summary, input, select, [role="button"], [tabindex]:not([tabindex="-1"])').forEach((el) => {
    if (!visible(el)) return;
    // aria-hidden subtrees are not exposed as controls at all. MapLibre stamps
    // role="button" aria-label="Map marker" on EVERY marker element, including
    // the purely decorative context labels, which are aria-hidden. Those are
    // not targets, so 2.5.8 does not apply to them.
    if (el.closest('[aria-hidden="true"]')) return;
    if (el.closest('.maplibregl-ctrl-attrib-inner')) return; // inline licence links: exempt (inline exception)
    const cs = getComputedStyle(el);
    if (cs.display === 'inline' && el.closest('p, li, .prose')) return; // SC 2.5.8 inline exception
    let r = el.getBoundingClientRect();
    let w = r.width, h = r.height;
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content === 'none' || ps.position !== 'absolute') continue;
      const ins = (v) => (v === 'auto' ? 0 : parseFloat(v) || 0);
      const ew = w - ins(ps.left) - ins(ps.right);
      const eh = h - ins(ps.top) - ins(ps.bottom);
      if (ew > w) w = ew;
      if (eh > h) h = eh;
    }
    if (w < 23.5 || h < 23.5) {
      smallTargets.push({ sel: label(el), text: (el.textContent || '').trim().slice(0, 40), w: Math.round(w), h: Math.round(h) });
    }
  });

  /* --- stray tab stops: tabindex="0" on non-interactive containers --- */
  const strayTabStops = Array.from(document.querySelectorAll('[tabindex="0"]'))
    .filter(visible)
    .filter((el) => !['a','button','input','select','textarea','summary'].includes(el.tagName.toLowerCase()))
    .filter((el) => !el.getAttribute('role')?.match(/button|link|tab|menuitem|checkbox|radio|textbox|slider|option/))
    .map((el) => ({
      sel: label(el),
      role: el.getAttribute('role'),
      scrollable: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
    }));

  /* --- new-tab links without a cue --- */
  const newTab = Array.from(document.querySelectorAll('a[target="_blank"]'))
    .filter(visible)
    .map((el) => ({
      sel: label(el),
      text: (el.textContent || '').trim().slice(0, 50),
      aria: el.getAttribute('aria-label'),
      hasCue: /new (tab|window)/i.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')),
      rel: el.getAttribute('rel'),
    }));

  return { contrast, nonText, docW, winW, spills, headings, smallTargets, strayTabStops, newTab };
})()`;

/* ---------- runner ---------- */

const browser = await chromium.launch();
const results = [];

for (const [name, path] of ROUTES) {
  if (ONLY && !ONLY.includes(name)) continue;
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      deviceScaleFactor: 1,
      reducedMotion: 'no-preference',
    });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
    });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message.slice(0, 200)));

    try {
      await page.goto(ORIGIN + path, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(name.includes('map') || name.startsWith('fg') ? 3500 : 1200);
      await page.evaluate(() => document.fonts.ready);

      const probe = await page.evaluate(PROBE);
      let axeOut = null;
      if (AXE_WIDTHS.includes(width)) {
        await page.addScriptTag({ content: AXE });
        axeOut = await page.evaluate(async () => {
          const r = await window.axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
            resultTypes: ['violations', 'incomplete'],
          });
          const trim = (arr) => arr.map((v) => ({
            id: v.id, impact: v.impact, help: v.help,
            nodes: v.nodes.slice(0, 6).map((n) => ({
              target: n.target.join(' '),
              summary: (n.failureSummary || '').replace(/\s+/g, ' ').slice(0, 260),
            })),
            count: v.nodes.length,
          }));
          return { violations: trim(r.violations), incomplete: trim(r.incomplete) };
        });
      }
      results.push({ name, path, width, ...probe, axe: axeOut, consoleErrors });
      process.stdout.write(`${name}@${width} ok  contrast:${probe.contrast.length} spill:${probe.spills.length} axe:${axeOut ? axeOut.violations.length : '-'}\n`);
    } catch (e) {
      results.push({ name, path, width, error: e.message });
      process.stdout.write(`${name}@${width} FAILED ${e.message}\n`);
    }
    await ctx.close();
  }
}

await browser.close();
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(`\nwrote ${OUT}/results.json (${results.length} runs)`);
