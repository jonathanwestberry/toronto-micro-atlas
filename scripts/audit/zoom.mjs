/**
 * SC 1.4.4 Resize Text and SC 1.4.10 Reflow.
 *
 * Two different failures, so two different tests:
 *
 *  - Full-page zoom at 200% is a viewport in CSS pixels half as wide and half
 *    as tall. That is what the browser's zoom control actually does, so it is
 *    emulated by halving the viewport rather than by a CSS transform.
 *  - Text-only zoom (browser "increase font size", or a user stylesheet)
 *    scales type without scaling the boxes. Fixed heights clip here and pass
 *    the page-zoom test, which is why both run.
 *
 * Reported: horizontal overflow, clipped text (scrollHeight beyond a
 * fixed-height box), and how much of the viewport the sticky header eats,
 * since a header that takes a third of a zoomed screen is a reflow failure in
 * substance even when nothing technically overflows.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const ORIGIN = 'http://localhost:4321';
const OUT = process.env.OUT || './out-zoom';
mkdirSync(OUT, { recursive: true });

const ROUTES = [
  ['home', '/'], ['gallery', '/guides/'],
  ['fg01', '/guides/hidden-landscapes/'], ['fg01-map', '/guides/hidden-landscapes/map/'],
  ['fg01-location', '/guides/hidden-landscapes/glen-stewart-ravine/'],
  ['fg02', '/guides/sidewalk-forest/'], ['fg02-map', '/guides/sidewalk-forest/map/'],
  ['fg03', '/guides/when-toronto-has-to-go/'], ['fg03-map', '/guides/when-toronto-has-to-go/map/'],
  ['fg04', '/guides/out-of-the-sun/'],
  ['about', '/about/'], ['404', '/404.html'],
];

/* 200% page zoom of a 1280x900 window == a 640x450 CSS viewport.
   400% of 1280 == 320 CSS px, the SC 1.4.10 reflow target. */
const MODES = [
  { name: 'zoom200', viewport: { width: 640, height: 450 }, textScale: null },
  { name: 'zoom400-reflow', viewport: { width: 320, height: 225 }, textScale: null },
  { name: 'text200', viewport: { width: 1280, height: 900 }, textScale: 2 },
  { name: 'text200-narrow', viewport: { width: 375, height: 667 }, textScale: 2 },
];

const PROBE = `(() => {
  const winW = window.innerWidth, winH = window.innerHeight;
  const label = (el) => {
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const spills = [];
  document.querySelectorAll('body *').forEach((el) => {
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    if (r.right > winW + 1 && r.width < document.documentElement.scrollWidth) {
      spills.push({ sel: label(el), right: Math.round(r.right), w: Math.round(r.width) });
    }
  });

  /* Text clipped by a box that cannot grow. Skip anything that is a legitimate
     scroll container (the reader can still reach the content) and skip maps,
     which are two-dimensional by nature. */
  const clipped = [];
  document.querySelectorAll('body *').forEach((el) => {
    if (!visible(el)) return;
    if (el.closest('.maplibregl-map, canvas')) return;
    const cs = getComputedStyle(el);
    const oy = cs.overflowY, ox = cs.overflowX;
    const hidden = oy === 'hidden' || oy === 'clip' || ox === 'hidden' || ox === 'clip';
    if (!hidden) return;
    if (!el.textContent.trim()) return;
    const vClip = el.scrollHeight > el.clientHeight + 2 && (oy === 'hidden' || oy === 'clip');
    const hClip = el.scrollWidth > el.clientWidth + 2 && (ox === 'hidden' || ox === 'clip');
    if (vClip || hClip) {
      clipped.push({
        sel: label(el),
        by: vClip ? \`\${el.scrollHeight - el.clientHeight}px tall\` : \`\${el.scrollWidth - el.clientWidth}px wide\`,
        text: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 50),
        lineClamp: cs.webkitLineClamp && cs.webkitLineClamp !== 'none' ? cs.webkitLineClamp : null,
      });
    }
  });

  const header = document.querySelector('.site-header');
  const hr = header ? header.getBoundingClientRect() : null;
  const main = document.querySelector('main');

  return {
    docW: document.documentElement.scrollWidth, winW, winH,
    overflowX: document.documentElement.scrollWidth > winW + 1,
    spills: spills.slice(0, 12),
    clipped: clipped.slice(0, 12),
    headerH: hr ? Math.round(hr.height) : null,
    headerPct: hr ? +(hr.height / winH * 100).toFixed(1) : null,
    headerVar: getComputedStyle(document.documentElement).getPropertyValue('--header-h').trim(),
    mainTop: main ? Math.round(main.getBoundingClientRect().top) : null,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
    /* A full-height route must not scroll the window at all. */
    fullHeight: document.body.hasAttribute('data-full-height'),
    docScrollH: document.documentElement.scrollHeight,
  };
})()`;

const browser = await chromium.launch();
const results = [];
for (const mode of MODES) {
  for (const [name, path] of ROUTES) {
    const ctx = await browser.newContext({ viewport: mode.viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    if (mode.textScale) {
      // Text-only zoom: scale the root font size, leave the boxes alone.
      await page.addStyleTag; // no-op guard
      await page.addInitScript((s) => {
        document.addEventListener('DOMContentLoaded', () => {
          const st = document.createElement('style');
          st.textContent = `html{font-size:${100 * s}% !important}`;
          document.head.appendChild(st);
        });
      }, mode.textScale);
    }
    try {
      await page.goto(ORIGIN + path, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(name.includes('map') || name.startsWith('fg') ? 3500 : 1200);
      await page.evaluate(() => document.fonts.ready);
      const r = await page.evaluate(PROBE);
      results.push({ mode: mode.name, name, ...r });
      const flags = [
        r.overflowX ? `OVERFLOW ${r.docW}>${r.winW}` : '',
        r.clipped.length ? `clipped:${r.clipped.length}` : '',
        r.fullHeight && r.docScrollH > r.winH + 1 ? `FULLHEIGHT-SCROLLS ${r.docScrollH}>${r.winH}` : '',
        r.headerPct > 25 ? `HEADER ${r.headerPct}%` : '',
      ].filter(Boolean).join(' ');
      console.log(`${mode.name.padEnd(16)} ${name.padEnd(14)} hdr ${String(r.headerH).padStart(3)}px/${String(r.headerPct).padStart(5)}%  ${flags || 'ok'}`);
    } catch (e) {
      console.log(`${mode.name} ${name} FAILED ${e.message}`);
    }
    await ctx.close();
  }
  console.log('');
}
await browser.close();
writeFileSync(`${OUT}/zoom.json`, JSON.stringify(results, null, 2));
