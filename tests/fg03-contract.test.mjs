import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const distPath = new URL('../dist/', import.meta.url);
const routePath = new URL(
  '../dist/guides/when-toronto-has-to-go/index.html',
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
  assert.match(html, /circle[\s\S]*Current open facility/);
  assert.match(html, /square[\s\S]*Extend hours/);
  assert.match(html, /triangle[\s\S]*New facility zone/);
  assert.match(html, /outline diamond[\s\S]*Verify information/i);
  assert.match(html, /filled diamond[\s\S]*Fare-paid facility/i);
  assert.match(html, /cross[\s\S]*Accessibility retrofit/);
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

test('default recommendation list is complete, ranked, and useful without JavaScript', () => {
  const html = normalize(readRoute());
  const items = html.match(/<li[^>]*data-fg03-result-item[^>]*>/g) ?? [];
  const mapButtons =
    html.match(/<button[^>]*data-fg03-select-place[^>]*>/g) ?? [];
  assert.equal(items.length, 10);
  assert.equal(mapButtons.length, 10);
  assert.equal(
    mapButtons.filter((button) => /\bdisabled(?:\s|>|="")/.test(button)).length,
    10,
    'Server-rendered map controls must stay disabled until the runtime replaces them',
  );
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

  // The homepage h1 is now the publication identity (fixes heading order); the
  // featured guide title is an h2.
  assert.equal((homeMain.match(/<h1\b/g) ?? []).length, 1);
  assert.match(homeMain, /<h1[^>]*>Toronto&nbsp;Micro-Atlas<\/h1>/);
  assert.match(homeMain, /<h2[^>]*>\s*When Toronto Has to Go\s*<\/h2>/);
  assert.equal(
    (homeMain.match(/New guide/g) ?? []).length,
    1,
    'Only the newest guide may carry the New label',
  );
  assert.ok(
    homeMain.indexOf('When Toronto Has to Go') < homeMain.indexOf('Sidewalk Forest'),
    'FG03 must appear before the older guides on the homepage',
  );
  assert.match(
    homeMain,
    /href="\/guides\/when-toronto-has-to-go\/"[\s\S]*?>Open the guide<\/a>/,
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
  assert.match(html, /"@type":"Article"/);
  assert.match(html, /"author":\{"@type":"Person","name":"Jonathan Westberry"\}/);
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
  assert.doesNotMatch(headers, /cloudflareinsights/);
  assert.match(headers, /connect-src 'self'/);
  assert.match(headers, /worker-src 'self' blob:/);
  for (const route of ['/', '/index.html', '/about/*', '/guides/*', '/404.html']) {
    const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      headers,
      new RegExp(
        `(?:^|\\n)${escapedRoute}\\n\\s+Cache-Control: `
        + 'public, no-cache, must-revalidate, no-transform',
      ),
      `HTML route must prevent automatic third-party transformation: ${route}`,
    );
  }
  assert.equal(
    (headers.match(/\bno-transform\b/g) ?? []).length,
    5,
    'Only the five HTML cache rules may disable Cloudflare transformation',
  );

  const beaconMarkup = /cloudflareinsights|beacon\.min\.js|data-cf-beacon/i;
  const htmlFiles = readdirSync(distPath, { recursive: true })
    .filter((path) => path.endsWith('.html'));
  assert.ok(htmlFiles.length > 0, 'Expected built HTML files to scan');
  for (const htmlFile of htmlFiles) {
    assert.doesNotMatch(
      readText(new URL(htmlFile, distPath)),
      beaconMarkup,
      `Built HTML must not contain analytics beacon markup: ${htmlFile}`,
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
