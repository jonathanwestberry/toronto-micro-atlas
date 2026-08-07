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
 *
 * Since the map landed, both rules have to survive contact with a colour ramp,
 * a legend and a layer name rather than only prose. A blue-to-orange ramp
 * reads as a thermometer whatever the legend says, and a map showing one
 * surface at a time hides the reversal that is the guide's finding. So the
 * temperature sweep now covers the legend and the surface labels, and the map
 * has to name both surfaces in words.
 */

const routePath = new URL(
  '../dist/guides/throwing-shade/index.html',
  import.meta.url,
);
const socialPath = new URL(
  '../public/social/og-throwing-shade.jpg',
  import.meta.url,
);

const readRoute = () => (existsSync(routePath) ? readFileSync(routePath, 'utf8') : '');

const jpegDimensions = (path) => {
  const bytes = readFileSync(path);
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);

  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  for (let offset = 2; offset < bytes.length - 8; offset += 1) {
    if (bytes[offset] !== 0xff || !startOfFrameMarkers.has(bytes[offset + 1])) {
      continue;
    }
    return {
      height: bytes.readUInt16BE(offset + 5),
      width: bytes.readUInt16BE(offset + 7),
    };
  }
  throw new Error('JPEG is missing a start-of-frame marker');
};

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
  // The map's own "how to read this" panel, once per surface.
  'This map shows where the sun was blocked.',
  'It says nothing about temperature.',
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
  ['6.201', '7.197', 'citywide mean shaded hours'],
  ['10.73', '20.73', 'ground shaded at 13:00'],
  ['8.49', '5.26', 'shade-poor arterial, walk band'],
  ['42.04', '39.50', 'shade-poor arterial, road band'],
  ['6.027', '7.034', 'NIA mean shaded hours'],
  ['6.246', '7.240', 'non-NIA mean shaded hours'],
  ['0.219', '0.206', 'NIA gap'],
  ['6.00', '6.17', 'transit stop mean shaded hours'],
  ['1.85', '1.86', 'sunniest arterial'],
  ['9.99', '10.65', 'shadiest arterial outside downtown'],
  ['10.90', '11.30', 'shadiest neighbourhood'],
  ['3.57', '3.90', 'sunniest neighbourhood'],
  ['47.22', '53.27', 'January midday ground shade'],
];

test('build publishes the exact shade guide route', () => {
  assert.equal(
    existsSync(routePath),
    true,
    'Expected /guides/throwing-shade/ to build an index.html file',
  );
});

test('the guide publishes an accessible 1200 by 630 social comparison', () => {
  const html = readRoute();
  const alt = 'The same Toronto streets at 13:00 and 18:00 on 21 July 2026, with shaded ground shown in dark charcoal.';

  assert.equal(existsSync(socialPath), true);
  assert.deepEqual(jpegDimensions(socialPath), { height: 630, width: 1200 });
  assert.match(
    html,
    /property="og:image" content="https:\/\/torontomicroatlas\.com\/social\/og-throwing-shade\.jpg"/,
  );
  assert.match(html, new RegExp(`property="og:image:alt" content="${alt}"`));
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);
  assert.match(html, /property="og:image:type" content="image\/jpeg"/);
  assert.match(
    html,
    /name="twitter:image" content="https:\/\/torontomicroatlas\.com\/social\/og-throwing-shade\.jpg"/,
  );
  assert.match(html, new RegExp(`name="twitter:image:alt" content="${alt}"`));
});

test('the guide never claims temperature, heat, or coolness', () => {
  const copy = readCopy();
  const html = readRoute();

  // Layer names, aria labels and data attributes are not visible prose and
  // would slip past a sweep of the copy alone. A layer called "cooling" is
  // still the guide making a thermal claim.
  const labels = [
    ...(html.match(/aria-label="[^"]*"/g) ?? []),
    ...(html.match(/data-fg04-map="[^"]*"/g) ?? []),
    ...(html.match(/id="[^"]*legend[^"]*"/g) ?? []),
  ].join(' ');
  for (const word of ['cool', 'heat', 'hot', 'warm', 'temperature', 'thermal']) {
    assert.doesNotMatch(
      labels,
      new RegExp(word, 'i'),
      `"${word}" appears in a map label. This guide maps shade only, and a `
      + 'layer name is a claim as much as a sentence is.',
    );
  }

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
  const hasWalk = copy.includes('5.26');
  const hasRoad = copy.includes('39.50');

  if (hasWalk || hasRoad) {
    assert.ok(
      hasWalk && hasRoad,
      'The governing walk band (5.26%, 8 to 15 m from the centreline) and the '
      + 'road band beside it (39.50%, 0 to 6 m) must appear together. The walk '
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

test('the map shows both surfaces, each named in words', () => {
  const html = readRoute();
  const copy = readCopy();

  assert.match(
    html,
    /data-fg04-map="raw"/,
    'The measured leaf-off surface must be on the page',
  );
  assert.match(
    html,
    /data-fg04-map="corrected"/,
    'The leaf-on corrected surface must be on the page. Every lidar flight '
    + 'over Toronto is leaf-off and the correction reverses which '
    + 'neighbourhoods are shadiest, so one surface alone is not a map of '
    + 'Toronto, it is a map of April.',
  );

  for (const label of ['Measured, leaf-off', 'Leaf-on corrected']) {
    assert.ok(
      copy.includes(label),
      `The map must label each surface in words: "${label}". Mauve and Plum `
      + 'sit 2.11 apart in contrast, so colour alone cannot carry which '
      + 'surface a reader is looking at.',
    );
  }
});

test('the map legend states the instrument, and does not invent one', () => {
  const copy = readCopy();

  assert.match(copy, /Shaded frames/i, 'the legend names what it counts');
  assert.match(
    copy,
    /shaded everywhere by construction/i,
    'The legend must say the 06:00 frame is shaded everywhere, or a reader '
    + 'takes the count for hours of usable shade.',
  );
});

test('the clock is native, labelled, and shared by both maps', () => {
  const html = readRoute();
  const copy = readCopy();

  assert.match(
    html,
    /<input[^>]+type="range"[^>]+min="6"[^>]+max="20"[^>]+step="1"[^>]+value="13"/,
  );
  assert.match(html, /<output[^>]+for="fg04-shade-hour"/);
  assert.match(copy, /Clock hour/);
  assert.match(copy, /13:00 EDT/);
  assert.match(copy, /Both maps use the same selected hour/);
});

test('the selected-hour legend and no-script state explain the binary map', () => {
  const html = readRoute();
  const copy = readCopy();

  assert.match(copy, /Shaded at the selected hour/);
  assert.match(copy, /Direct sun at the selected hour/);
  assert.match(copy, /Not sampled ground/);
  assert.match(html, /<noscript>/);
  assert.match(copy, /JavaScript is required to change the clock hour/);
});

test('point inspection has instructions, paired states, and a table alternative', () => {
  const html = readRoute();
  const copy = readCopy();

  assert.match(copy, /Click or tap either map to inspect a point/);
  assert.match(copy, /focus a map and press Enter/);
  assert.match(html, /data-fg04-point-status/);
  assert.match(html, /data-fg04-point-profile/);
  assert.match(html, /<th[^>]*>Measured, leaf-off<\/th>/);
  assert.match(html, /<th[^>]*>Leaf-on corrected<\/th>/);
  assert.match(html, /<th[^>]*>Clock hour<\/th>/);
});

test('the selected-hour legend uses declared shade tokens, not a second copy', () => {
  const html = readRoute();

  const invented = html.match(/#[0-9a-f]{6}/gi) ?? [];
  const shadeTokens = html.match(/--fg04-selected-(?:shaded|sunlit)/g) ?? [];

  assert.ok(
    new Set(shadeTokens).size >= 2,
    'The binary legend must reference the declared selected-hour tokens rather '
    + 'than hard-coded colours.',
  );
  assert.ok(
    invented.length === 0,
    `The rendered guide must not carry raw hex colours. Found: ${invented.slice(0, 5).join(', ')}`,
  );
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
