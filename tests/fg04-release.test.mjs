import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  assertFg04Workflow,
  inspectFg04Candidate,
  verifyFg04Transport,
} from '../scripts/fg04-release.mjs';

const TILE_ORIGIN = 'https://tiles.torontomicroatlas.com';
const roots = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true });
  }
});

function write(root, relative, contents = '') {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

function validManifest(overrides = {}) {
  return {
    tileVersion: 'v3',
    tileUrlTemplates: {
      raw: `${TILE_ORIGIN}/fg04/v3/raw/{z}/{x}/{y}.webp`,
      corrected: `${TILE_ORIGIN}/fg04/v3/corrected/{z}/{x}/{y}.webp`,
    },
    classification: {
      version: 'v2',
      tileUrlTemplate: `${TILE_ORIGIN}/fg04/class/v2/{z}/{x}/{y}.webp`,
    },
    streetProfiles: { url: '/data/fg04/street-profiles.json' },
    ...overrides,
  };
}

function validHeaders() {
  return `/*
  Content-Security-Policy: default-src 'self'; connect-src 'self' ${TILE_ORIGIN}; img-src 'self' data: blob:

/data/fg04/manifest.json
  Cache-Control: public, no-cache, must-revalidate

/data/fg04/street-profiles.json
  Cache-Control: public, no-cache, must-revalidate
`;
}

function candidateFixture({ headers = validHeaders(), manifest = validManifest() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fg04-release-test-'));
  roots.push(root);
  write(root, 'guides/out-of-the-sun/index.html', '<main>Throwing Shade</main>');
  write(root, 'data/fg04/manifest.json', JSON.stringify(manifest));
  write(root, 'data/fg04/street-profiles.json', '{"records":[]}');
  write(root, 'social/og-throwing-shade.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  write(root, '_headers', headers);
  return root;
}

test('a valid candidate keeps FG04 data present and tile pyramids out of dist', () => {
  const report = inspectFg04Candidate({ distDir: candidateFixture() });

  assert.equal(report.fileCount, 5);
  assert.deepEqual(report.forbiddenTilePaths, []);
  assert.equal(report.tileVersion, 'v3');
  assert.equal(report.classVersion, 'v2');
  assert.deepEqual(report.transportOrigins, [TILE_ORIGIN]);
});

test('a candidate fails when one required public artifact is missing', () => {
  const root = candidateFixture();
  rmSync(join(root, 'data/fg04/street-profiles.json'));

  assert.throws(
    () => inspectFg04Candidate({ distDir: root }),
    /missing required release path: data\/fg04\/street-profiles\.json/,
  );
});

test('a candidate fails when a shade tile enters the deployable tree', () => {
  const root = candidateFixture();
  write(root, 'data/fg04/tiles/raw/16/18316/23917.webp', 'tile');

  assert.throws(
    () => inspectFg04Candidate({ distDir: root }),
    /FG04 tile pyramid must stay out of dist/,
  );
});

test('a candidate fails when the manifest leaves the immutable tile versions', () => {
  const root = candidateFixture({ manifest: validManifest({ tileVersion: 'v4' }) });

  assert.throws(
    () => inspectFg04Candidate({ distDir: root }),
    /shade tile version must be v3/,
  );
});

test('a candidate fails when production CSP blocks direct R2 fetches', () => {
  const headers = validHeaders().replace(
    `connect-src 'self' ${TILE_ORIGIN}`,
    "connect-src 'self'",
  );

  assert.throws(
    () => inspectFg04Candidate({ distDir: candidateFixture({ headers }) }),
    /connect-src must allow https:\/\/tiles\.torontomicroatlas\.com/,
  );
});

test('a candidate fails when an unversioned FG04 asset lacks revalidation', () => {
  const headers = validHeaders().replace(
    '/data/fg04/street-profiles.json',
    '/data/fg04/street-profiles-v1.json',
  );

  assert.throws(
    () => inspectFg04Candidate({ distDir: candidateFixture({ headers }) }),
    /missing no-cache policy: \/data\/fg04\/street-profiles\.json/,
  );
});

function corsHeaders(overrides = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'ETag',
    'cache-control': 'public, max-age=31536000, immutable',
    'content-type': 'image/webp',
    etag: '"release-fixture"',
    ...overrides,
  };
}

function transportFixture({ rawHeaders = corsHeaders() } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-methods': 'GET, HEAD',
          'access-control-allow-origin': '*',
          'access-control-max-age': '86400',
        },
      });
    }
    const headers = url.includes('/v3/raw/') ? rawHeaders : corsHeaders();
    return new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers });
  };
  return { calls, fetchImpl };
}

test('direct transport verifies raw v3, corrected v3, class v2, and preflight', async () => {
  const { calls, fetchImpl } = transportFixture();
  const report = await verifyFg04Transport(fetchImpl, 'https://torontomicroatlas.com');

  assert.deepEqual(report.products.map(({ name }) => name), [
    'raw-v3', 'corrected-v3', 'class-v2',
  ]);
  assert.equal(report.preflight.maxAge, 86400);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ options }) => (
    options.headers.Origin === 'https://torontomicroatlas.com'
  )));
});

test('direct transport fails when a tile does not expose ETag to the browser', async () => {
  const { fetchImpl } = transportFixture({
    rawHeaders: corsHeaders({ 'access-control-expose-headers': '' }),
  });

  await assert.rejects(
    verifyFg04Transport(fetchImpl, 'https://torontomicroatlas.com'),
    /raw-v3 must expose ETag/,
  );
});

test('the real workflow keeps every release gate before deployment', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/deploy.yml', import.meta.url),
    'utf8',
  );

  assert.doesNotThrow(() => assertFg04Workflow(workflow));
});

test('the workflow fails when any release step follows Cloudflare deployment', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/deploy.yml', import.meta.url),
    'utf8',
  );

  assert.throws(
    () => assertFg04Workflow(`${workflow}\n      - name: Too late\n        run: npm test\n`),
    /Cloudflare deployment must be the final release step/,
  );
});

test('the real built candidate satisfies the static release contract', () => {
  const distDir = new URL('../dist/', import.meta.url);
  const headersFile = new URL('../public/_headers', import.meta.url);

  const report = inspectFg04Candidate({ distDir, headersFile });
  assert.ok(report.fileCount < 20_000);
});
