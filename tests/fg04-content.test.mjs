import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * The copy contract for the shade guide (internal id fg04).
 *
 * This guide can be wrong in two ways that no build error would ever catch, so
 * they are pinned here instead:
 *
 *   1. It maps SHADE. It does not map temperature, heat, or coolness, and it
 *      never will. Shade is a geometric fact about where the sun is blocked at
 *      a given minute. A shaded asphalt lot can outrun a sunny lawn on a
 *      thermometer by a wide margin. Any drift toward "cooler streets" turns a
 *      defensible measurement into a claim the data cannot carry.
 *
 *   2. Every lidar flight over Toronto is leaf-off. The correction that raises
 *      bare canopy to a leaf-on equivalent REVERSES which neighbourhoods are
 *      shadiest: raw, the top three are downtown tower districts; corrected,
 *      all three are leafy midtown. Publishing one number without its twin
 *      reports the month the plane flew as a fact about the city.
 *
 * Both are copy-level failures, which is why this file reads the rendered page
 * rather than the source: the constraint is about what a reader sees, not what
 * the markup contains. `fg04` is expected in class names and data attributes
 * and forbidden in visible text, and stripping tags is what tells them apart.
 */

const routePath = new URL(
  '../dist/guides/throwing-shade/index.html',
  import.meta.url,
);

const readRoute = () => (existsSync(routePath) ? readFileSync(routePath, 'utf8') : '');

/**
 * The guide's own copy, excluding the shared header and footer. The atlas-wide
 * navigation is not this guide's prose and is not governed by its constraints.
 */
const mainMarkup = (html) => html.match(/<main\b[\s\S]*?<\/main>/)?.[0] ?? '';

/** What a reader actually sees: no tags, no attributes, no scripts. */
const visibleText = (markup) =>
  markup
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&#39;', "'")
    .replaceAll('&rsquo;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&#8217;', "'")
    .replace(/\s+/g, ' ')
    .trim();

const readCopy = () => visibleText(mainMarkup(readRoute()));

const sentences = (text) =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

/**
 * The ONLY sentences allowed to contain a temperature word, matched exactly.
 * A disclaimer has to name the thing it is disclaiming, so these are stripped
 * before the forbidden-word sweep runs. Editing one of these sentences in the
 * page without editing it here is meant to fail the build.
 */
const REQUIRED_DISCLAIMER = 'This guide maps shade, not temperature.';

const ALLOWED_TEMPERATURE_SENTENCES = [
  REQUIRED_DISCLAIMER,
  'A shaded asphalt lot can be hotter than a sunny lawn, and nothing here measures heat.',
];

/**
 * Deliberately wider than "cool" and "heat". The rule is that the guide makes
 * no thermal claim at all, so the near-synonyms that would let one back in are
 * banned too. Solar elevation is written with the degree symbol and the words
 * "above the horizon", never the word "degrees", so that a sun angle can never
 * be misread as a temperature.
 */
const FORBIDDEN_CLAIM_WORDS = [
  'cool', 'cools', 'cooled', 'cooler', 'coolest', 'cooling', 'coolness',
  'temperature', 'temperatures', 'thermal', 'degrees',
  'heat', 'heats', 'heated', 'heating',
  'hot', 'hotter', 'hottest',
  'warm', 'warms', 'warmer', 'warmest', 'warming',
];

/**
 * Raw beside corrected, always. The left value is the measured leaf-off
 * surface; the right value is the leaf-on equivalent. Neither may travel
 * alone, in either direction.
 */
const RAW_AND_CORRECTED = [
  ['6.201', '7.020', 'citywide mean shaded hours'],
  ['10.73', '19.7', 'ground shaded at 13:00'],
  ['6.79', '3.89', 'shade-poor arterial, walk band'],
  ['41.92', '39.61', 'shade-poor arterial, road band'],
  ['10.90', '11.25', 'shadiest neighbourhood'],
];

test('build publishes the exact shade guide route', () => {
  assert.equal(
    existsSync(routePath),
    true,
    'Expected /guides/throwing-shade/ to build an index.html file',
  );
});

test('the guide never claims temperature, heat, or coolness', () => {
  const copy = readCopy();

  assert.ok(
    copy.includes(REQUIRED_DISCLAIMER),
    `The guide must state, verbatim: "${REQUIRED_DISCLAIMER}"`,
  );

  let remainder = copy;
  for (const allowed of ALLOWED_TEMPERATURE_SENTENCES) {
    remainder = remainder.split(allowed).join(' ');
  }

  for (const word of FORBIDDEN_CLAIM_WORDS) {
    assert.doesNotMatch(
      remainder,
      new RegExp(`\\b${word}\\b`, 'i'),
      `"${word}" is a thermal claim. This guide maps shade only. If it belongs `
      + 'in a disclaimer, add that exact sentence to ALLOWED_TEMPERATURE_SENTENCES.',
    );
  }
});

test('no statistic travels without its leaf-on corrected twin', () => {
  const copy = readCopy();

  for (const [raw, corrected, label] of RAW_AND_CORRECTED) {
    const hasRaw = copy.includes(raw);
    const hasCorrected = copy.includes(corrected);
    if (!hasRaw && !hasCorrected) continue;
    assert.ok(
      hasRaw && hasCorrected,
      `${label}: found ${hasRaw ? raw : corrected} without `
      + `${hasRaw ? corrected : raw}. Every lidar flight over Toronto is `
      + 'leaf-off, so an uncorrected figure alone reports the month the plane flew.',
    );
  }
});

test('the walk band and the road band are always published together', () => {
  const copy = readCopy();
  const hasWalk = copy.includes('3.89');
  const hasRoad = copy.includes('39.61');

  if (hasWalk || hasRoad) {
    assert.ok(
      hasWalk && hasRoad,
      'The governing walk band (3.89%, 8 to 15 m from the centreline) and the '
      + 'road band beside it (39.61%, 0 to 6 m) must appear together. The walk '
      + 'figure alone invites the reader to picture the roadway.',
    );
    assert.match(
      copy,
      /8 to 15 m/,
      'The walk band must be defined where it is used',
    );
  }
});

test('the pre-registered shortage is reported as a failure, and the old title is retired', () => {
  const copy = readCopy();
  const retired = 'The Great Toronto Shade Shortage';

  assert.match(
    copy,
    /25%/,
    'The pre-registered threshold must be stated, or "failed" means nothing',
  );
  assert.match(
    copy,
    /did not find|found no|failed|no citywide shortage/i,
    'The guide went looking for a citywide shortage and did not find one. Say so.',
  );

  if (copy.includes(retired)) {
    const carrier = sentences(copy).find((sentence) => sentence.includes(retired));
    assert.match(
      carrier ?? '',
      /reject|retire|abandon|did not|failed|no longer/i,
      `"${retired}" may appear only in a sentence saying the title was rejected. `
      + `Found instead: "${carrier}"`,
    );
  }
});

test('shaded hours are never presented as fifteen equal hours', () => {
  const copy = readCopy();

  assert.match(
    copy,
    /of the modelled day/i,
    'Shaded-hour counts must be qualified as a share of the modelled day',
  );
  assert.match(
    copy,
    /shaded everywhere/i,
    'The 06:00 frame is shaded everywhere by construction, and the guide must '
    + 'say so once, plainly, before any shaded-hour count is read.',
  );
});

test('the guide states the instrument that produced every figure', () => {
  const copy = readCopy();

  assert.match(copy, /21 July 2026/, 'the modelled date');
  assert.match(copy, /\bEDT\b/, 'the timezone');
  assert.match(copy, /06:00/, 'the first modelled frame');
  assert.match(copy, /20:00/, 'the last modelled frame');
  assert.match(copy, /April (?:to|and) May 2023/, 'the lidar flight season');
  assert.match(copy, /2 m grid/, 'the grid resolution');
});

test('the internal id and the retired series naming stay out of the copy', () => {
  const copy = readCopy();

  assert.doesNotMatch(
    copy,
    /\bfg04\b/i,
    'fg04 is an internal id. It belongs in paths, CSS and comments, never in copy.',
  );
  assert.doesNotMatch(
    copy,
    /field guides?\b/i,
    '"Field Guide" naming is retired from public copy',
  );
  assert.doesNotMatch(
    copy,
    /\bguide (?:0\d|four|4)\b/i,
    'Guides are not numbered in public copy',
  );
});
