import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const routePath = new URL(
  '../dist/guides/when-toronto-has-to-go/index.html',
  import.meta.url,
);

const readRoute = () => (existsSync(routePath) ? readFileSync(routePath, 'utf8') : '');
const normalize = (value) =>
  value
    .replaceAll('&amp;', '&')
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replace(/\s+/g, ' ')
    .trim();

test('build publishes the exact FG03 route', () => {
  assert.equal(
    existsSync(routePath),
    true,
    'Expected /guides/when-toronto-has-to-go/ to build an index.html file',
  );
});

test('route has one editorial title, guide position, breadcrumb, and social metadata', () => {
  const html = readRoute();
  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /Guide 03 of 03/);
  assert.match(html, /aria-label="Breadcrumb"/);
  assert.match(html, /<h1[^>]*>When Toronto Has to Go<\/h1>/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/torontomicroatlas\.com\/guides\/when-toronto-has-to-go\/">/,
  );
  assert.doesNotMatch(
    html,
    /<link rel="canonical"[^>]+href="[^"]+[?#][^"]*"/,
    'Canonical URL must not include query or fragment state',
  );
  assert.match(html, /property="og:title" content="When Toronto Has to Go"/);
  assert.match(
    html,
    /property="og:image" content="https:\/\/torontomicroatlas\.com\/social\/og-when-toronto-has-to-go\.jpg"/,
  );
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(
    html,
    /name="twitter:image" content="https:\/\/torontomicroatlas\.com\/social\/og-when-toronto-has-to-go\.jpg"/,
  );
  assert.doesNotMatch(
    normalize(html),
    /\b(?:TODO|TBD|lorem ipsum|coming soon|unfinished placeholder)\b/i,
  );
});

test('proof keeps each snapshot count and measurement unit together', () => {
  const html = normalize(readRoute());
  const snapshots = [
    ['1200', 'Noon', '324', '8,142', '987'],
    ['2030', '8:30 p.m.', '242', '8,007', '623'],
    ['2200', '10 p.m.', '6', '7,994', '18'],
    ['0030', '12:30 a.m.', '1', '7,885', '8'],
  ];

  for (const [time, label, facilities, points, covered] of snapshots) {
    const pattern = new RegExp(
      `data-fg03-snapshot="${time}"[^>]*>[\\s\\S]*?${label}[\\s\\S]*?${facilities}[\\s\\S]*?${points}[\\s\\S]*?${covered}[\\s\\S]*?<\\/li>`,
    );
    assert.match(html, pattern, `Expected complete ${label} evidence`);
  }

  assert.match(html, /data-fg03-central-finding="phase1Grouped"/);
  assert.match(html, /grouped transit points/);
  assert.match(html, /GTFS stops and platforms/);
  assert.match(html, /data-fg03-rider-conditional-count="13"/);
  assert.match(html, /13 fare-gate washrooms/);
});

test('native controls expose the complete shareable state contract before the map', () => {
  const html = readRoute();

  for (const fieldset of ['time', 'access', 'walk', 'action']) {
    assert.match(
      html,
      new RegExp(`<fieldset[^>]*data-fg03-filter="${fieldset}"`),
      `Expected ${fieldset} fieldset`,
    );
  }

  for (const value of ['1200', '2030', '2200', '0030']) {
    assert.match(html, new RegExp(`name="time"[^>]*value="${value}"`));
  }
  for (const value of ['public', 'rider']) {
    assert.match(html, new RegExp(`name="access"[^>]*value="${value}"`));
  }
  for (const value of ['300', '400', '500']) {
    assert.match(html, new RegExp(`name="walk"[^>]*value="${value}"`));
  }
  for (const value of ['open', 'extend', 'new', 'verify', 'retrofit']) {
    assert.match(html, new RegExp(`name="action"[^>]*value="${value}"`));
  }

  assert.match(html, /<label[^>]*for="fg03-search"[^>]*>[\s\S]*Search/);
  assert.match(html, /data-fg03-clear-search/);
  assert.match(html, /data-fg03-reset/);
  assert.match(html, /data-fg03-retry/);
  assert.match(html, /data-fg03-share/);
  assert.ok(
    html.indexOf('data-fg03-controls') < html.indexOf('data-fg03-map'),
    'Controls must precede the map in DOM order',
  );
  assert.match(
    html,
    /<form(?=[^>]*data-fg03-controls)(?=[^>]*\binert(?:\s|>|=""))[^>]*>/,
    'Controls must be inert until the progressive enhancement mounts',
  );
  assert.match(
    html,
    /<div(?=[^>]*data-fg03-map)(?=[^>]*\binert(?:\s|>|=""))(?=[^>]*tabindex="-1")[^>]*>/,
    'The map must be inert and unfocusable until MapLibre mounts',
  );
});

test('map shell explains keyboard use, symbol shapes, date, and attribution', () => {
  const html = normalize(readRoute());
  assert.match(html, /data-fg03-map[^>]*role="region"/);
  assert.match(html, /Focus the map and use arrow keys to pan/);
  assert.match(html, /data-fg03-legend/);
  assert.match(html, /circle[\s\S]*Current open facility/);
  assert.match(html, /square[\s\S]*Extend hours/);
  assert.match(html, /triangle[\s\S]*New facility zone/);
  assert.match(html, /diamond[\s\S]*Verify information/);
  assert.match(html, /diamond[\s\S]*Fare-paid facility/);
  assert.match(html, /cross[\s\S]*Accessibility retrofit/);
  assert.match(html, /Snapshot: July 21, 2026/);
  assert.match(html, /OpenStreetMap contributors/);
  assert.match(html, /Open Government Licence - Toronto/);
});

test('default recommendation list is complete, ranked, and useful without JavaScript', () => {
  const html = normalize(readRoute());
  const items = html.match(/<li[^>]*data-fg03-result-item[^>]*>/g) ?? [];
  assert.equal(items.length, 10);
  assert.deepEqual(
    items.map((item) => Number(item.match(/data-rank="(\d+)"/)?.[1])),
    [1, 2, 3, 4, 5, 6, 8, 9, 10, 11],
  );

  for (const name of [
    'Mount Dennis library',
    'Spadina Road library',
    'York Recreation Centre Washroom',
    'Northern District library',
    'Riverdale library',
    'East York Community Centre Washroom',
    'Scarlett Woods Golf Course Washroom',
    'Deer Park library',
    'Locke library',
    'St. Lawrence library',
  ]) {
    assert.match(html, new RegExp(name));
  }

  assert.match(html, /data-fg03-gate="passed"/);
  assert.match(html, /data-fg03-results-count="10"/);
  assert.match(html, /data-fg03-detail/);
  assert.match(html, /id="fg03-detail-title"[^>]*tabindex="-1"/);
  assert.match(html, /data-fg03-verify-group="hours"/);
  assert.match(html, /data-fg03-verify-group="accessibility"/);

  for (const evidence of [
    'Action',
    'Access condition',
    'Published hours',
    'Closure evidence',
    'Stability',
    'Audit status',
    'Official source',
    'GTFS stops and platforms',
    'Scheduled trips',
    'Routes',
  ]) {
    assert.match(html, new RegExp(evidence), `Expected SSR result evidence: ${evidence}`);
  }
});

test('manifest defaults drive checked controls, status, description, and lifecycle wiring', () => {
  const html = normalize(readRoute());
  const checkedInput = (name, value) => new RegExp(
    `<input(?=[^>]*name="${name}")(?=[^>]*value="${value}")(?=[^>]*checked)[^>]*>`,
  );

  assert.match(html, checkedInput('time', '2200'));
  assert.match(html, checkedInput('access', 'public'));
  assert.match(html, checkedInput('walk', '400'));
  assert.match(html, checkedInput('action', 'extend'));
  assert.match(
    html,
    /Showing 10 audited extend-hours opportunities for 10 p\.m\., public access, and a 400 m walk\./,
  );
  assert.match(
    html,
    /name="description" content="At 10 p\.m\., Toronto has 7,994 grouped transit points with scheduled activity but only 6 documented unrestricted washroom access points\./,
  );
  assert.match(html, /data-fg03-runtime/);
});

test('shell includes explicit recovery and edge-state surfaces', () => {
  const html = readRoute();
  for (const state of [
    'loading',
    'partial',
    'error',
    'offline',
    'stale',
    'empty',
    'no-results',
    'failed',
  ]) {
    assert.match(html, new RegExp(`data-fg03-state="${state}"`));
  }
  assert.match(html, /role="status"[^>]*data-fg03-status/);
  assert.match(html, /role="alert"[^>]*data-fg03-alert/);
  assert.match(html, /data-fg03-gate-failed-template/);
});

test('method, definitions, limitations, sources, downloads, credits, and series remain in HTML', () => {
  const html = normalize(readRoute());
  for (const id of [
    'method',
    'definitions',
    'limitations',
    'sources',
    'downloads',
    'credits',
    'series',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-fg03-no-js/);
  assert.match(html, /Download facilities \(GeoJSON\)/);
  assert.match(html, /Download interventions \(GeoJSON\)/);
  assert.match(html, /Download snapshot summary \(CSV\)/);
  assert.match(html, /Hidden Landscapes/);
  assert.match(html, /Sidewalk Forest/);
  assert.match(html, /All field guides/);
});
