// Every colour the atlas draws is a ONE PALETTE V2.0 colour, or two of them
// mixed in sRGB at a whole-percent share. Nothing else.
//
// "Never invent a hex" was a rule in a planning note, and a rule nobody
// measures does not hold: the 2026-10-25 recolour found loose literals in
// thirty files, some of them years of hand-tuning away from any palette. This
// test is the measurement. A new colour has to be one of the fifteen, or a mix
// someone can name ("Red 80 / Black 20"), or it fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const PALETTE = {
  Black: '#000000', White: '#FFFFFF', Cream: '#EFE9C9', Sand: '#CFC5A2',
  Beige: '#FDB497', Brown: '#E1804D', Red: '#FC5237', Orange: '#FF9D03',
  Yellow: '#FFCB03', 'Light Green': '#D2E90F', Green: '#03C739',
  'Light Blue': '#99ECFF', Blue: '#0E98FF', Purple: '#CFB6FF', Pink: '#FFB6F4',
};

// The surfaces that put colour on screen or into a baked image. Proof records
// (data/proof) are deliberately absent: they keep the colours they were
// recorded in.
const SCANNED = [
  'src/**/*.{css,astro,ts,mjs,js}',
  'scripts/build-*.{mjs,py}',
  'data/scripts/11_process_trees.py',
  'data/scripts/13_render_trees.py',
  'data/scripts/40_build_guide_thumbs.py',
  'public/favicon.svg',
  'public/hero/*.svg',
  'public/maps/*.svg',
  'public/data/fg02/meta.json',
];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

// Python's round() takes a half to the even neighbour, Math.round takes it up.
// The build scripts that derived these mixes are Python, so accept either.
const halfEven = (v) => (Math.abs((v % 1) - 0.5) < 1e-9 ? 2 * Math.round(v / 2) : Math.round(v));

const ALLOWED = new Map(Object.entries(PALETTE).map(([name, hex]) => [hex, name]));
for (const [a, ha] of Object.entries(PALETTE)) {
  for (const [b, hb] of Object.entries(PALETTE)) {
    if (a === b) continue;
    const ca = rgb(ha);
    const cb = rgb(hb);
    for (let share = 1; share < 100; share += 1) {
      const t = share / 100;
      for (const round of [Math.round, halfEven]) {
        const hex = toHex(ca.map((v, i) => round(v * t + cb[i] * (1 - t))));
        if (!ALLOWED.has(hex)) ALLOWED.set(hex, `${a} ${share} / ${b} ${100 - share}`);
      }
    }
  }
}

const files = [...new Set(SCANNED.flatMap((pattern) => globSync(pattern, { cwd: ROOT })))]
  .map((f) => join(ROOT, f));

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

test('the scanned set is present', () => {
  assert.ok(files.length > 40, `expected the source and image set, found ${files.length}`);
});

test('every hex colour is a V2.0 colour or a named mix of two', () => {
  const off = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g)) {
      const raw = m[1];
      const hex = '#' + (raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw).toUpperCase();
      if (!ALLOWED.has(hex)) off.push(`${file.replace(ROOT, '')}:${lineOf(text, m.index)} ${m[0]}`);
    }
  }
  assert.deepEqual(off, [], `Off-palette colours:\n${off.join('\n')}`);
});

test('every rgb() and rgba() colour is a V2.0 colour or a named mix of two', () => {
  const off = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/g)) {
      const hex = toHex([m[1], m[2], m[3]].map(Number));
      if (!ALLOWED.has(hex)) off.push(`${file.replace(ROOT, '')}:${lineOf(text, m.index)} ${m[0]}`);
    }
  }
  assert.deepEqual(off, [], `Off-palette colours:\n${off.join('\n')}`);
});

test('no hsl() colours, which cannot be checked against the palette by eye', () => {
  const found = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/hsla?\(/g)) found.push(`${file.replace(ROOT, '')}:${lineOf(text, m.index)}`);
  }
  assert.deepEqual(found, [], `hsl() colours:\n${found.join('\n')}`);
});
