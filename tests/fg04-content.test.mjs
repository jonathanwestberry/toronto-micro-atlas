import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
const homePath = new URL('../dist/index.html', import.meta.url);
const aboutPath = new URL('../dist/about/index.html', import.meta.url);
const socialPath = new URL(
  '../public/social/og-throwing-shade.jpg',
  import.meta.url,
);
const stylePath = new URL('../src/styles/fg04.css', import.meta.url);
const browserFixturePath = new URL(
  './fixtures/fg04-browser-decode.html',
  import.meta.url,
);
const browserVerifierPath = new URL(
  '../scripts/verify-fg04-browser-decode.mjs',
  import.meta.url,
);
const explorerVerifierPath = new URL(
  '../scripts/verify-fg04-selected-hour.mjs',
  import.meta.url,
);

const readRoute = () => (existsSync(routePath) ? readFileSync(routePath, 'utf8') : '');
const readHome = () => (existsSync(homePath) ? readFileSync(homePath, 'utf8') : '');
const readAbout = () => (existsSync(aboutPath) ? readFileSync(aboutPath, 'utf8') : '');

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
  // The reader's motivation, once, in the lede.
  //
  // The rule here is "no thermal CLAIM about the ground", and it was written
  // as "the word may not appear", which is wider. Two different sentences were
  // being caught by one ban:
  //
  //   "this shade is three degrees cooler"  -> a measurement the data cannot
  //                                            support. Still banned.
  //   "it is a hot afternoon"               -> why a person is reading at all.
  //
  // Banning the second deleted the guide's only reason to exist, and the proof
  // was on the site: the "Shade and Cooling" forthcoming card promised "where
  // to find cover on a hot day" and read better than the finished guide.
  // Nothing about the rigour moves. This sentence describes the reader, never
  // the ground, and every figure on the page stays a shade figure.
  'It is a hot afternoon and you want to be out of the sun.',
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
  ['6.00', '7.00', 'transit stop mean shaded hours'],
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

test('the Throwing Shade card references an asset that exists in the build', () => {
  const card = mainMarkup(readHome()).match(
    /<a[^>]+href="\/guides\/throwing-shade\/"[^>]+class="[^"]*guide-card[^"]*"[\s\S]*?<\/a>/,
  )?.[0] ?? '';
  const source = card.match(/<img[^>]+src="([^"]+)"/)?.[1];
  assert.ok(source, 'The Throwing Shade card must have a cover image');
  assert.equal(
    existsSync(resolve(new URL('../dist', import.meta.url).pathname, source.replace(/^\//, ''))),
    true,
    `The Throwing Shade card image does not exist in dist: ${source}`,
  );
});

test('the shared header includes Throwing Shade', () => {
  const header = readHome().match(/<header\b[\s\S]*?<\/header>/)?.[0] ?? '';
  assert.match(header, /href="\/guides\/throwing-shade\/"[^>]*>Throwing Shade<\/a>/);
});

test('the shared footer includes Throwing Shade', () => {
  const footer = readHome().match(/<footer\b[\s\S]*?<\/footer>/)?.[0] ?? '';
  assert.match(footer, /href="\/guides\/throwing-shade\/"[^>]*>Throwing Shade<\/a>/);
});

test('About names all four published field guides', () => {
  const html = readAbout();
  assert.match(html, />Four ways to read the city<\/h2>/);
  const item = mainMarkup(html).match(
    /<a href="\/guides\/throwing-shade\/"[^>]*>[\s\S]*?<\/a>/,
  )?.[0] ?? '';
  assert.equal(visibleText(item), '04 Throwing Shade');
});

test('the paired explorer panes may shrink to the 320 px reading frame', () => {
  const css = readFileSync(stylePath, 'utf8');
  assert.match(
    css,
    /\.fg04-maps__pane\s*\{[^}]*min-width:\s*0;/s,
    'MapLibre attribution must not impose its min-content width on a map pane',
  );
});

test('the release decoder fetches the R2 tile directly in Chrome', () => {
  const fixture = readFileSync(browserFixturePath, 'utf8');
  const verifier = readFileSync(browserVerifierPath, 'utf8');
  assert.match(fixture, /fetch\(proof\.tile\.url\)/);
  assert.doesNotMatch(fixture, /__fg04_live_tile/);
  assert.doesNotMatch(verifier, /__fg04_live_tile/);
});

test('the selected-hour browser gate proves visible shaded and sunlit pixels', () => {
  const verifier = readFileSync(explorerVerifierPath, 'utf8');
  assert.match(verifier, /CDP_TIMEOUT_MS\s*=\s*30_000/);
  assert.match(verifier, /Page\.captureScreenshot/);
  assert.match(verifier, /renderedPixels/);
  assert.match(verifier, /shadedPixels/);
  assert.match(verifier, /sunlitPixels/);
  assert.doesNotMatch(verifier, /getPaintProperty\([^)]*color-relief-color/);
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
  assert.doesNotMatch(
    html,
    /<div[^>]*data-fg04-map="(?:raw|corrected)"[^>]*aria-labelledby=/,
    'The labelled MapStage owns the accessible name; a generic map div must not duplicate it',
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

test('the explorer exposes a labelled share action and live result', () => {
  const html = readRoute();
  const copy = readCopy();

  assert.match(copy, /Copy this view/);
  assert.match(html, /data-fg04-share/);
  assert.match(html, /data-fg04-share-status[^>]+role="status"/);
  assert.match(html, /data-fg04-share-status[^>]+aria-live="polite"/);
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

test('street search names its broader grain and keeps hourly values paired', () => {
  const html = readRoute();
  const copy = readCopy();

  assert.match(copy, /Search for a Toronto street/);
  assert.match(copy, /named walkable OpenStreetMap features/);
  assert.match(copy, /8 to 15 m from the centreline/);
  assert.match(copy, /broader than the arterial-only analysis/);
  assert.match(html, /data-fg04-street-search/);
  assert.match(html, /data-fg04-street-results/);
  assert.match(html, /data-fg04-street-status/);
  assert.match(html, /data-fg04-street-profile/);
  assert.match(html, /data-fg04-street-table/);
  assert.match(html, /<th[^>]*>Measured, leaf-off<\/th>/);
  assert.match(html, /<th[^>]*>Leaf-on corrected<\/th>/);
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

/**
 * Nothing in this file opened the proof file until now, and that is precisely
 * how three wrong numbers shipped together: a 20:00 frame the data never
 * produced, a top-five span that contradicted the ranking table printed six
 * lines above it, and a bare-transit-stop count written as "three" when it was
 * 533. Every one of them was checkable against statistics.json. The pairs in
 * RAW_AND_CORRECTED above only ever caught figures the stats script already
 * printed, so anything derived, or anything the script summarised away, was
 * unguarded. So the proof file is opened here.
 */
const statsPath = new URL('../data/proof/fg04/statistics.json', import.meta.url);
const readStats = () => JSON.parse(readFileSync(statsPath, 'utf8'));

test('the bare transit stop count in the copy is the count in the proof file', () => {
  const bare = readStats().transit_stops_no_usable_shade_both_surfaces;
  assert.ok(
    bare,
    'statistics.json must publish the both-surfaces bare stop count. '
    + 'The per-surface "sunniest" list cannot stand in for it.',
  );

  assert.ok(
    readCopy().includes(String(bare.count)),
    `The guide must print ${bare.count}: stops with no usable shade on either `
    + 'surface. "sunniest" is an argsort slice of a large tied set, so it can '
    + 'name five stops and can never say how many exist. Reading the count off '
    + `that list gave "three" and understated this by ${bare.count - 3}.`,
  );
});

test('the corrected top-five span matches the corrected top five', () => {
  const top = readStats().surfaces.corrected.shadiest_neighbourhoods;
  const span = Math.round(
    (top[0].mean_shaded_hours - top[top.length - 1].mean_shaded_hours) * 100,
  ) / 100;

  const claimed = readCopy().match(/top five spans\s*([0-9]+\.[0-9]+)\s*hours/);
  assert.ok(claimed, 'Chapter three must state the span of the corrected top five');
  assert.equal(
    Number(claimed[1]),
    span,
    'Chapter three exists to calibrate how small the reversal is, so a wrong '
    + 'span there misleads worse than a wrong span anywhere else on the page. '
    + `The table directly above it runs ${top[0].mean_shaded_hours} to `
    + `${top[top.length - 1].mean_shaded_hours}.`,
  );
});
