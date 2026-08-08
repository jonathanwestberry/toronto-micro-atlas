import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FG04_TILE_ORIGIN = 'https://tiles.torontomicroatlas.com';

const REQUIRED_PATHS = [
  'guides/throwing-shade/index.html',
  'data/fg04/manifest.json',
  'data/fg04/street-profiles.json',
  'social/og-throwing-shade.jpg',
  '_headers',
];

const TILE_REQUESTS = [
  {
    name: 'raw-v3',
    url: `${FG04_TILE_ORIGIN}/fg04/v3/raw/16/18316/23917.webp`,
  },
  {
    name: 'corrected-v3',
    url: `${FG04_TILE_ORIGIN}/fg04/v3/corrected/16/18316/23917.webp`,
  },
  {
    name: 'class-v2',
    url: `${FG04_TILE_ORIGIN}/fg04/class/v2/16/18316/23917.webp`,
  },
];

function filesystemPath(value) {
  return value instanceof URL ? fileURLToPath(value) : resolve(value);
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNoCacheRule(headers, path) {
  const pattern = new RegExp(
    `(?:^|\\n)${escapeRegExp(path)}\\r?\\n`
    + '[ \\t]+Cache-Control: public, no-cache, must-revalidate(?:\\r?\\n|$)',
  );
  if (!pattern.test(headers)) throw new Error(`missing no-cache policy: ${path}`);
}

function assertHeaders(headers) {
  const csp = headers.match(/Content-Security-Policy:\s*([^\r\n]+)/)?.[1];
  if (!csp) throw new Error('production headers are missing Content-Security-Policy');
  const connectSrc = csp
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('connect-src '));
  const sources = connectSrc?.split(/\s+/).slice(1) ?? [];
  if (!sources.includes(FG04_TILE_ORIGIN)) {
    throw new Error(`connect-src must allow ${FG04_TILE_ORIGIN}`);
  }
  assertNoCacheRule(headers, '/data/fg04/manifest.json');
  assertNoCacheRule(headers, '/data/fg04/street-profiles.json');
}

function assertManifest(manifest) {
  if (manifest.tileVersion !== 'v3') {
    throw new Error('shade tile version must be v3');
  }
  const expectedTemplates = {
    raw: `${FG04_TILE_ORIGIN}/fg04/v3/raw/{z}/{x}/{y}.webp`,
    corrected: `${FG04_TILE_ORIGIN}/fg04/v3/corrected/{z}/{x}/{y}.webp`,
  };
  for (const [surface, expected] of Object.entries(expectedTemplates)) {
    if (manifest.tileUrlTemplates?.[surface] !== expected) {
      throw new Error(`${surface} manifest path must remain ${expected}`);
    }
  }
  if (manifest.classification?.version !== 'v2') {
    throw new Error('classification tile version must be v2');
  }
  const expectedClass = `${FG04_TILE_ORIGIN}/fg04/class/v2/{z}/{x}/{y}.webp`;
  if (manifest.classification?.tileUrlTemplate !== expectedClass) {
    throw new Error(`classification manifest path must remain ${expectedClass}`);
  }
  if (manifest.streetProfiles?.url !== '/data/fg04/street-profiles.json') {
    throw new Error('street profile manifest path must remain /data/fg04/street-profiles.json');
  }
}

export function inspectFg04Candidate({ distDir, headersFile } = {}) {
  if (!distDir) throw new TypeError('distDir is required');
  const root = filesystemPath(distDir);
  if (!statSync(root).isDirectory()) throw new Error(`dist is not a directory: ${root}`);
  const files = listFiles(root);
  for (const path of REQUIRED_PATHS) {
    if (!files.includes(path)) throw new Error(`missing required release path: ${path}`);
  }

  const forbiddenTilePaths = files.filter((path) => (
    path.endsWith('.webp')
    && (
      path.startsWith('data/fg04/tiles/')
      || path.startsWith('data/fg04/class-tiles/')
      || /(?:^|\/)fg04\/v\d+\//.test(path)
      || /(?:^|\/)fg04\/class\/v\d+\//.test(path)
    )
  ));
  if (forbiddenTilePaths.length > 0) {
    throw new Error(
      `FG04 tile pyramid must stay out of dist: ${forbiddenTilePaths.join(', ')}`,
    );
  }

  const manifest = JSON.parse(readFileSync(join(root, 'data/fg04/manifest.json'), 'utf8'));
  assertManifest(manifest);
  const headersPath = headersFile ? filesystemPath(headersFile) : join(root, '_headers');
  assertHeaders(readFileSync(headersPath, 'utf8'));

  return {
    fileCount: files.length,
    requiredPaths: [...REQUIRED_PATHS],
    forbiddenTilePaths,
    tileVersion: manifest.tileVersion,
    classVersion: manifest.classification.version,
    transportOrigins: [FG04_TILE_ORIGIN],
  };
}

function assertTileResponse(name, response) {
  if (response.status !== 200) throw new Error(`${name} returned ${response.status}`);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('image/webp')) {
    throw new Error(`${name} must return image/webp`);
  }
  const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? '';
  if (!cacheControl.includes('max-age=31536000') || !cacheControl.includes('immutable')) {
    throw new Error(`${name} must return one-year immutable caching`);
  }
  if (response.headers.get('access-control-allow-origin') !== '*') {
    throw new Error(`${name} must allow every read-only origin`);
  }
  const exposed = (response.headers.get('access-control-expose-headers') ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase());
  if (!exposed.includes('etag')) throw new Error(`${name} must expose ETag`);
  if (!response.headers.get('etag')) throw new Error(`${name} must return ETag`);
  return {
    name,
    status: response.status,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    allowOrigin: response.headers.get('access-control-allow-origin'),
    exposeHeaders: response.headers.get('access-control-expose-headers'),
    etag: response.headers.get('etag'),
  };
}

export async function verifyFg04Transport(
  fetchImpl = globalThis.fetch,
  origin = 'https://torontomicroatlas.com',
) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const products = [];
  for (const request of TILE_REQUESTS) {
    const response = await fetchImpl(request.url, {
      method: 'GET',
      headers: {
        Origin: origin,
        'User-Agent': 'Mozilla/5.0 FG04 release verifier',
      },
    });
    products.push(assertTileResponse(request.name, response));
  }

  const preflightResponse = await fetchImpl(TILE_REQUESTS[0].url, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'User-Agent': 'Mozilla/5.0 FG04 release verifier',
    },
  });
  if (preflightResponse.status < 200 || preflightResponse.status >= 300) {
    throw new Error(`R2 preflight returned ${preflightResponse.status}`);
  }
  if (preflightResponse.headers.get('access-control-allow-origin') !== '*') {
    throw new Error('R2 preflight must allow every read-only origin');
  }
  const methods = (preflightResponse.headers.get('access-control-allow-methods') ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase());
  for (const method of ['GET', 'HEAD']) {
    if (!methods.includes(method)) throw new Error(`R2 preflight must allow ${method}`);
  }
  const maxAge = Number(preflightResponse.headers.get('access-control-max-age'));
  if (maxAge !== 86400) throw new Error('R2 preflight max age must be 86400 seconds');

  return {
    origin,
    products,
    preflight: {
      status: preflightResponse.status,
      allowOrigin: preflightResponse.headers.get('access-control-allow-origin'),
      methods,
      maxAge,
    },
  };
}

export function assertFg04Workflow(workflow) {
  const expectedInOrder = [
    'actions/checkout@v7',
    'actions/setup-node@v7',
    'node-version: 22.12.0',
    'actions/setup-python@v7',
    "python-version: '3.14'",
    "-p 'test_fg0*.py'",
    'npm run test:web',
    'npm run check',
    'npm run build',
    'npm run test:web:contract',
    'npm run verify:fg04-explorer',
    'npm run verify:fg04-release',
    'npm audit --omit=dev',
    'cloudflare/wrangler-action@v4',
  ];
  let cursor = -1;
  for (const fragment of expectedInOrder) {
    const next = workflow.indexOf(fragment, cursor + 1);
    if (next < 0) throw new Error(`missing or out-of-order CI fragment: ${fragment}`);
    cursor = next;
  }
  const deployCommand = 'command: pages deploy dist --project-name=toronto-micro-atlas --branch=main';
  const deploy = workflow.indexOf(deployCommand);
  if (deploy < cursor || !workflow.trimEnd().endsWith(deployCommand)) {
    throw new Error('Cloudflare deployment must be the final release step');
  }
}
