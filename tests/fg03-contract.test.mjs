import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const distPath = new URL('../dist/', import.meta.url);
const routePath = new URL(
  '../dist/guides/when-toronto-has-to-go/index.html',
  import.meta.url,
);
const mapRoutePath = new URL(
  '../dist/guides/when-toronto-has-to-go/map/index.html',
  import.meta.url,
);
const homePath = new URL('../dist/index.html', import.meta.url);
const aboutPath = new URL('../dist/about/index.html', import.meta.url);
const socialPath = new URL(
  '../public/social/og-when-toronto-has-to-go.jpg',
  import.meta.url,
);
const headersPath = new URL('../public/_headers', import.meta.url);
const workflowPath = new URL('../.github/workflows/deploy.yml', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);
const nvmrcPath = new URL('../.nvmrc', import.meta.url);
const contentConfigPath = new URL('../src/content.config.ts', import.meta.url);
const fg03StylesPath = new URL('../src/styles/fg03.css', import.meta.url);
const fg03ScriptPath = new URL('../src/scripts/fg03-map.ts', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);
const maintenancePath = new URL('../docs/fg03-maintenance.md', import.meta.url);

const readRoute = () => (existsSync(routePath) ? readFileSync(routePath, 'utf8') : '');
const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const normalize = (value) =>
  value
    .replaceAll('&amp;', '&')
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replace(/\s+/g, ' ')
    .trim();

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
  // Editorial kicker replaces the old numbered "Guide 03 of 03" position label.
  assert.match(html, /class="fg03-kicker">Public access & time/);
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
  assert.match(html, /<strong>13<\/strong> fare-gate facility records/);
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
  const styles = readText(fg03StylesPath);
  assert.match(html, /data-fg03-map[^>]*role="region"/);
  assert.match(html, /Focus the map and use arrow keys to pan/);
  assert.match(html, /data-fg03-legend/);
  assert.match(html, /circle[\s\S]*current open facility/i);
  assert.match(html, /square[\s\S]*extend hours/i);
  assert.match(html, /triangle[\s\S]*new facility zone/i);
  // Two of the seven facility marks were named for the wrong symbol: "diamond,
  // a record needing verification" was true of the hollow one and false of the
  // solid one, which is fare-paid; "cross, accessibility retrofit" was true of
  // the blue plus and false of the amber cross, which means data is missing.
  // The names now carry fill and colour, so they survive being read aloud.
  assert.match(html, /hollow diamond[\s\S]*needs verification/i);
  assert.match(html, /solid diamond[\s\S]*fare-paid facility/i);
  assert.match(html, /amber cross[\s\S]*data missing/i);
  assert.match(html, /blue plus[\s\S]*accessibility retrofit/i);
  assert.doesNotMatch(html, /a record needing verification/i);
  // The prose that named six shapes and showed none of them is replaced by the
  // drawn swatches, so "How to read this map" and the map agree by construction.
  assert.match(html, /id="fg03-howto-legend"/);
  assert.match(html, /covered transit stop/i);
  assert.match(html, /uncovered transit stop/i);
  assert.match(html, /unknown or missing coverage/i);
  assert.match(html, /selected walking reach/i);
  assert.match(html, /selected place halo/i);
  assert.match(html, /Snapshot: July 21, 2026/);
  assert.match(html, /OpenStreetMap contributors/);
  assert.match(html, /Open Government Licence - Toronto/);
  assert.match(styles, /\.maplibregl-ctrl-group button/);
  assert.match(styles, /\.maplibregl-ctrl-attrib-button/);
  assert.match(
    styles,
    /maplibregl[\s\S]*?min-height:\s*2\.75rem[\s\S]*?min-width:\s*2\.75rem/,
  );
  assert.match(
    styles,
    /\.fg03-legend > p,\s*\.fg03-legend > ul\s*\{[^}]*grid-column:\s*2;/,
    'Desktop legend groups must stay out of the narrow heading column',
  );
});

test('the map frame carries its own title, empty state, and way back out', () => {
  const html = normalize(readRoute());
  // Everything here draws inside the map frame. The only state readout used to
  // be the grey status sentence outside it, which sits below the fold on the
  // map route and about 1,600px above the map on a phone: a caption for
  // something the reader cannot see at the same time as the caption.
  assert.match(html, /data-fg03-map-title/);
  assert.match(html, /data-fg03-map-title-count/);
  assert.match(html, /data-fg03-map-title-filters/);
  // A search matching nothing emptied the map and explained itself 205px below
  // the fold, so the map read as broken. The card says it on the canvas.
  assert.match(html, /data-fg03-map-veil/);
  assert.match(html, /data-fg03-map-veil-action[^>]*>Clear search/);
  // The phone's detail surface. Scrolling to the real panel is right on a
  // desktop and wrong at 390px, where the panel is a screen and a half away.
  assert.match(html, /data-fg03-map-card/);
  assert.match(html, /data-fg03-map-card-more[^>]*>Read the full record/);
  // "Clear selected place" named the data operation. The button also restores
  // the camera the selection took away, so it now names the outcome.
  assert.match(html, /data-fg03-close-detail[^>]*>\s*Back to all results/);
  assert.doesNotMatch(html, /Clear selected place/);
  // The eyebrow is the only line that says whether the rows are facilities or
  // arguments, so it is a hook the runtime rewrites, not a build-time constant.
  assert.match(html, /data-fg03-results-eyebrow[^>]*>\s*What Toronto has/);
  assert.match(
    html,
    /data-fg03-rank-basis[^>]*hidden[^>]*>\s*Ranked by transit served within the selected walk/,
  );
});

test('the expanded map route keeps a legend, a snapshot date, and control advice', () => {
  const html = normalize(readText(mapRoutePath));
  // This route has the largest map and used to be the only one with no key at
  // all: the figure's legend was hidden by a rule whose comment claimed it had
  // moved in with the controls, a move never made. Now it has.
  assert.match(html, /id="fg03-rail-legend"[^>]*open/);
  assert.match(html, /<summary>Legend: 12 map marks<\/summary>/);
  assert.match(html, /hollow diamond[\s\S]*needs verification/i);
  // Hiding the whole figcaption also hid the snapshot date, which is the one
  // thing a dated map cannot publish without.
  assert.match(html, /data-fg03-caption-snapshot[^>]*>Snapshot: July 21, 2026/);
  // The controls help line reads as a caption for the map when it lands at the
  // top of the rail, and as advice about a control when it sits beside Share.
  assert.ok(
    html.indexOf('id="fg03-controls-help"') > html.indexOf('data-fg03-share'),
    'Control advice belongs at the foot of the rail, beside Share this view',
  );
});

test('access-point proof and facility-record explorer use explicit counting grains', () => {
  const html = normalize(readRoute());

  assert.match(
    html,
    /fare-gate facility records open at every snapshot/i,
  );
  assert.match(
    html,
    /current open count[\s\S]*facility records[\s\S]*co-located[\s\S]*access points/i,
  );
});

test('the default list is the six open washrooms, and it is useful without JavaScript', () => {
  // The guide used to open on the ten extend-hours proposals, which put a set
  // of arguments where the reader expected the facilities the headline counts.
  // The landing state is now the six washrooms actually open at 10 p.m., and
  // this test pins that: the count, the names, and the fact that these rows
  // carry no rank, because an open washroom is not a ranked recommendation.
  const html = normalize(readRoute());
  const items = html.match(/<li[^>]*data-fg03-result-item[^>]*>/g) ?? [];
  const mapButtons =
    html.match(/<button[^>]*data-fg03-select-place[^>]*>/g) ?? [];
  assert.equal(items.length, 6);
  assert.equal(mapButtons.length, 6);
  assert.equal(
    mapButtons.filter((button) => /\bdisabled(?:\s|>|="")/.test(button)).length,
    6,
    'Server-rendered map controls must stay disabled until the runtime replaces them',
  );
  assert.equal(
    items.filter((item) => /data-rank=/.test(item)).length,
    0,
    'Open facilities are facts, not a ranking',
  );

  for (const name of [
    'Union Station',
    "L'Amoreaux Community Recreation Centre Washroom",
    'Ellesmere Community Centre Washroom',
    'Stephen Leacock Community Recreation Centre Washroom',
    'Don Montgomery Community Centre Washroom',
    'Jack Layton Ferry Terminal Washroom',
  ]) {
    assert.match(html, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(html, /data-fg03-gate="passed"/);
  assert.match(html, /data-fg03-results-count="6"/);
  assert.match(html, /data-fg03-detail/);
  assert.match(html, /id="fg03-detail-title"[^>]*tabindex="-1"/);
  assert.match(html, /data-fg03-verify-group="hours"/);
  assert.match(html, /data-fg03-verify-group="accessibility"/);

  for (const evidence of [
    'Action',
    'Access condition',
    'Published hours',
    'Closure evidence',
    'Official source',
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
  assert.match(html, checkedInput('action', 'open'));
  assert.match(
    html,
    /Showing 6 current open facility records for 10 p\.m\., public access, and a 400 m walk\./,
  );
  // The point of this assertion is that the manifest's live figures reach the
  // meta description, not that the sentence around them never changes. Pinning
  // the prose made a shortening of an over-long description read as a
  // regression, so it now checks the snapshot label and both counts.
  const description = html.match(/name="description" content="([^"]*)"/)?.[1];
  assert.ok(description, 'the guide must publish a meta description');
  assert.match(description, /10 p\.m\./);
  assert.match(description, /7,994/);
  assert.match(description, /\b6\b/);
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

test('shared discovery surfaces publish all three guides with FG03 newest', () => {
  const route = normalize(readRoute());
  const home = normalize(readText(homePath));
  const about = normalize(readText(aboutPath));
  const homeMain = home.match(/<main\b[\s\S]*?<\/main>/)?.[0] ?? '';
  const guideLinks = [
    ['/guides/hidden-landscapes/', 'Hidden Landscapes'],
    ['/guides/sidewalk-forest/', 'Sidewalk Forest'],
    ['/guides/when-toronto-has-to-go/', 'When Toronto Has to Go'],
  ];

  const header = route.match(/<header\b[\s\S]*?<\/header>/)?.[0] ?? '';
  const footer = route.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] ?? '';
  for (const [href, title] of guideLinks) {
    const escapedHref = href.replaceAll('/', '\\/');
    assert.match(header, new RegExp(`href="${escapedHref}".*?${title}`));
    assert.match(footer, new RegExp(`href="${escapedHref}".*?${title}`));
    assert.match(homeMain, new RegExp(`href="${escapedHref}"`));
    // Titles render tight in cards and with wrapping whitespace in the feature.
    assert.match(homeMain, new RegExp(`>\\s*${title}\\s*<`));
    assert.match(about, new RegExp(`href="${escapedHref}".*?${title}`));
  }

  // The homepage h1 is the hero tagline (single h1, fixes heading order); each
  // guide is a peer card in one gallery, the newest wearing the New status.
  assert.equal((homeMain.match(/<h1\b/g) ?? []).length, 1);
  assert.match(homeMain, /<h1[^>]*>\s*Field guides to a city you think you know\s*<\/h1>/);
  assert.equal(
    (homeMain.match(/guide-card-status--new/g) ?? []).length,
    1,
    'Only the newest guide may carry the New status',
  );
  assert.ok(
    homeMain.indexOf('When Toronto Has to Go') < homeMain.indexOf('Sidewalk Forest'),
    'FG03 must appear before the older guides on the homepage',
  );
});

test('FG03 publishes article metadata and the verified social card', () => {
  const html = normalize(readRoute());
  assert.equal(existsSync(socialPath), true);
  assert.deepEqual(jpegDimensions(socialPath), { height: 630, width: 1200 });
  assert.match(html, /property="og:type" content="article"/);
  assert.match(html, /property="article:published_time" content="2026-07-25"/);
  assert.match(html, /property="article:modified_time" content="2026-07-25"/);
  assert.match(html, /type="application\/ld\+json"/);

  // Assert the meaning, not the serialization. The layout now emits one @graph
  // per page holding WebSite, Organization and Person, and the Article points at
  // the Person by @id rather than restating it inline. Matching the old inline
  // author string would fail on a change that is strictly better structured
  // data, so the check walks the graph instead.
  const graph = JSON.parse(
    html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
  )['@graph'];
  const byType = (t) => graph.find((node) => node['@type'] === t);

  const article = byType('Article');
  assert.ok(article, 'the guide must publish an Article node');
  assert.equal(article.datePublished, '2026-07-25');

  const person = byType('Person');
  assert.equal(person.name, 'Jonathan Westberry');
  assert.equal(article.author['@id'], person['@id'], 'the Article must credit that Person');

  const org = byType('Organization');
  assert.equal(org.name, 'Toronto Micro-Atlas');
  assert.equal(article.publisher['@id'], org['@id']);

  // The visible breadcrumb has a machine-readable twin ending on this page.
  const crumbs = byType('BreadcrumbList').itemListElement;
  assert.deepEqual(
    crumbs.map((c) => c.name),
    ['Toronto Micro-Atlas', 'Field guides', 'When Toronto Has to Go'],
  );
  assert.equal(crumbs.at(-1).item, 'https://torontomicroatlas.com/guides/when-toronto-has-to-go/');
});

test('production headers preserve indexing, caching, and browser security', () => {
  const headers = readText(headersPath);
  assert.match(headers, /https:\/\/toronto-micro-atlas\.pages\.dev\/\*/);
  assert.match(headers, /https:\/\/:version\.toronto-micro-atlas\.pages\.dev\/\*/);
  assert.match(headers, /X-Robots-Tag: noindex, nofollow/);
  assert.match(headers, /\/data\/fg03\/2026-07-21\/manifest\.json[\s\S]*?no-cache/);
  assert.match(
    headers,
    /\/data\/fg03\/2026-07-21\/\*\.geojson[\s\S]*?max-age=31536000, immutable/,
  );
  assert.match(headers, /\/_astro\/\*[\s\S]*?max-age=31536000, immutable/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /X-Frame-Options: DENY/);
  assert.match(headers, /Referrer-Policy: strict-origin-when-cross-origin/);
  assert.match(headers, /Content-Security-Policy:/);
  // Cloudflare Web Analytics is ON, deliberately, and the CSP names exactly the
  // two hosts it needs: the script host it loads from, and the host it reports
  // to. Verified in a browser against this policy: the beacon loads and POSTs
  // to https://cloudflareinsights.com/cdn-cgi/rum with no CSP violation.
  // Nothing else third-party is allowed in.
  assert.match(headers, /script-src [^;]*https:\/\/static\.cloudflareinsights\.com/);
  // The analytics beacon remains same-origin. The only cross-origin connection
  // is the public read-only R2 hostname used by the FG04 shade explorer.
  assert.match(
    headers,
    /connect-src 'self' https:\/\/tiles\.torontomicroatlas\.com;/,
  );
  assert.equal(
    (headers.match(/cloudflareinsights\.com/g) ?? []).length,
    1,
    'Only the analytics script host may be allowed, and nothing in connect-src',
  );
  assert.match(headers, /worker-src 'self' blob:/);
  for (const route of ['/', '/index.html', '/about/*', '/guides/*', '/404.html']) {
    const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      headers,
      new RegExp(
        `(?:^|\\n)${escapedRoute}\\n\\s+Cache-Control: `
        + 'public, no-cache, must-revalidate$',
        'm',
      ),
      `HTML route must revalidate on every request: ${route}`,
    );
  }

  // This used to assert `no-transform` on all five HTML routes, to stop
  // Cloudflare injecting its analytics beacon. It did stop that, and it also
  // stopped compression, because compressing a response is a body
  // transformation and the directive does not distinguish. Every page shipped
  // uncompressed, the heaviest guide at 47.7 kB against roughly 12 kB brotli.
  //
  // Removed on 2026-08-10 after testing the premise rather than trusting it:
  // the 404 route never carried the directive, so the edge could rewrite it
  // freely, and it returned byte-identical to the build with one beacon tag.
  // Zone transforms are all off; Brotli is on. Re-adding the directive to fix
  // a future injection would be the wrong lever: turn injection off instead.
  // Count directives, not prose: the file explains the removal in a comment
  // block, and that explanation names the directive it is about.
  const directives = headers
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.equal(
    (directives.match(/\bno-transform\b/g) ?? []).length,
    0,
    'no-transform disables compression as well as injection; do not reintroduce it',
  );

  // The single hand-written beacon below is now the whole guarantee, so the
  // per-page assertion that follows carries the weight the header used to.
  const beaconMarkup = /cloudflareinsights|beacon\.min\.js|data-cf-beacon/i;
  const htmlFiles = readdirSync(distPath, { recursive: true })
    .filter((path) => path.endsWith('.html'));
  assert.ok(htmlFiles.length > 0, 'Expected built HTML files to scan');
  for (const htmlFile of htmlFiles) {
    const html = readText(new URL(htmlFile, distPath));
    assert.match(
      html,
      beaconMarkup,
      `Built HTML must carry the analytics beacon: ${htmlFile}`,
    );
    // Astro entity-escapes the quotes inside the attribute, so the built markup
    // reads data-cf-beacon="{&quot;token&quot;: &quot;...&quot;}". Match either
    // form rather than the one that happened to be in the source.
    assert.match(
      html,
      /data-cf-beacon=["'][^"']*(?:&quot;|")token(?:&quot;|")\s*:\s*(?:&quot;|")[0-9a-f]{32}(?:&quot;|")/,
      `Beacon must carry a site token: ${htmlFile}`,
    );
    // Without `version` the beacon reports cross-origin to an endpoint that
    // 404s for manual installs, which is silent: the script still loads, the
    // page still works, and no data is ever recorded. Pin it.
    assert.match(
      html,
      /data-cf-beacon=["'][^"']*(?:&quot;|")version(?:&quot;|")\s*:\s*(?:&quot;|")[0-9.]+(?:&quot;|")/,
      `Beacon must set a version, or it reports to the wrong endpoint: ${htmlFile}`,
    );
    assert.equal(
      (html.match(/beacon\.min\.js/g) ?? []).length,
      1,
      `Exactly one beacon per page, or views get counted twice: ${htmlFile}`,
    );
  }
});

test('CI tests data and web output before the final Cloudflare deployment step', () => {
  const workflow = readText(workflowPath);
  const expectedInOrder = [
    'actions/checkout@v7',
    'actions/setup-node@v7',
    'node-version: 22.12.0',
    'actions/setup-python@v7',
    'requirements-fg03.txt',
    'unittest discover',
    'npm run test:web',
    'npm run check',
    'npm run build',
    'npm run test:web:contract',
    'run: npm audit --omit=dev\n',
    'cloudflare/wrangler-action@v4',
  ];

  let cursor = -1;
  for (const fragment of expectedInOrder) {
    const next = workflow.indexOf(fragment);
    assert.ok(next > cursor, `Expected CI fragment in release order: ${fragment}`);
    cursor = next;
  }
  assert.match(workflow, /contents: read/);
  assert.match(
    workflow,
    /jobs:\s+deploy:\s+if: github\.ref == 'refs\/heads\/main' && github\.ref_type == 'branch'\s+concurrency:\s+group: production-cloudflare-pages\s+cancel-in-progress: true/,
  );
});

test('the supported runtime and Astro release are exact and migration-safe', () => {
  const packageJson = JSON.parse(readText(packagePath));
  const contentConfig = readText(contentConfigPath);
  assert.equal(packageJson.dependencies.astro, '7.1.3');
  assert.equal(packageJson.engines.node, '>=22.12.0');
  assert.equal(readText(nvmrcPath).trim(), '22.12.0');
  assert.match(contentConfig, /from 'astro:zod'|from 'astro\/zod'/);
  assert.equal((contentConfig.match(/\bglob\(/g) ?? []).length, 2);
});

test('release and maintenance docs describe the real production workflow', () => {
  const readme = readText(readmePath);
  const maintenance = readText(maintenancePath);
  assert.match(readme, /Cloudflare Pages/);
  assert.doesNotMatch(readme, /Deployment target is GitHub Pages/);
  for (const topic of [
    'Architecture',
    'Data refresh',
    'Public schema',
    'URL state',
    'Analytics',
    'Accessibility',
    'Local development',
    'Cloudflare',
    'Production verification',
    'Limitations',
  ]) {
    assert.match(maintenance, new RegExp(topic, 'i'), `Missing maintenance topic: ${topic}`);
  }
});

test('the wheel does not cancel the zoom it just started', () => {
  const script = readText(fg03ScriptPath);
  // The map element listens for the gestures that should interrupt an
  // in-flight camera animation and calls map.stop(). 'wheel' was in that list,
  // which meant every wheel tick cancelled the eased zoom MapLibre had just
  // started from that same event: scroll-zoom was dead on the /map route until
  // the reader happened to click the canvas first. MapLibre already interrupts
  // its own animations when a gesture begins, so the wheel never belonged here.
  const stopMotionList = script.match(
    /for \(const type of \[([^\]]*)\]\) \{\s*addListener\(\s*removeListeners,\s*mapElement,/,
  );
  assert.ok(stopMotionList, 'stopMotion listener list not found in fg03-map.ts');
  assert.doesNotMatch(stopMotionList[1], /'wheel'/);
  assert.match(stopMotionList[1], /'pointerdown'/);
});

test('sharing a view confirms on the button, not only in the far-off status line', () => {
  const script = readText(fg03ScriptPath);
  // The only success signal used to be status.textContent, which renders about
  // 500px down the control panel and is never on screen at the same time as the
  // button. The link copied and the reader saw nothing, which reads as a dead
  // button. The label now answers where the click happened, then restores.
  assert.match(script, /shareButton\.textContent = copiedToClipboard \?/);
  assert.match(script, /shareButton\.textContent = shareButtonLabel;/);
  // Restored from the markup, so it cannot drift from Fg03Controls.astro.
  assert.match(script, /const shareButtonLabel = shareButton\?\.textContent\?\.trim\(\)/);
});
