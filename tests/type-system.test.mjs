// The display face ships exactly one weight. Ask it for a bolder one and the
// browser synthesizes: measured on 2026-08-11, Bebas Neue at 700 rendered 14.4%
// more ink than at 400, thickened strokes rather than a real bold cut. That was
// happening on nearly every heading on the site, because most rules asked for
// 700-900 and unstyled h1-h6 inherit bold from the UA stylesheet.
//
// Hierarchy in this face comes from size, caps and tracking. Not weight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

// Families the atlas self-hosts, and the weights each actually ships.
const SHIPPED = {
  display: ['400'],        // Bebas Neue
  mono: ['400', '500', '600', '700'], // Space Mono ships 400/700; 500 and 600
                           // snap to those without synthesis (verified by ink
                           // measurement), so they are imprecise, not broken.
};

const APPLIES_DISPLAY = /font-family:\s*var\(--(?:font-heading|font-display|fg0\d-display)\)/;

const files = globSync('**/*.{css,astro}', { cwd: SRC }).map((f) => join(SRC, f));

test('source files are present to scan', () => {
  assert.ok(files.length > 10, `expected the stylesheet set, found ${files.length}`);
});

test('every rule that applies the display face pins it to a weight it ships', () => {
  const offenders = [];
  for (const file of files) {
    const css = readFileSync(file, 'utf8');
    for (const match of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const [, selector, body] = match;
      if (!APPLIES_DISPLAY.test(body)) continue;
      const weight = body.match(/font-weight:\s*(\d+)/);
      const name = `${file.replace(SRC, '')} ${selector.trim().split('\n').pop().trim()}`;
      if (!weight) {
        // Absent is not safe: the UA stylesheet bolds h1-h6, so an unpinned
        // heading silently requests 700 and gets a synthesized one.
        offenders.push(`${name} (no font-weight; UA bold applies)`);
      } else if (!SHIPPED.display.includes(weight[1])) {
        offenders.push(`${name} (font-weight: ${weight[1]})`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'display face asked for a weight it does not ship');
});

test('the retired pre-redesign face is gone', () => {
  // Archivo was held as a fallback through the redesign so nothing re-rendered
  // mid-migration. FG03 was the last route still on it.
  const offenders = [];
  for (const file of files) {
    if (/Archivo/i.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))) {
      offenders.push(file.replace(SRC, ''));
    }
  }
  assert.deepEqual(offenders, [], 'Archivo should only survive in explanatory comments');
});
