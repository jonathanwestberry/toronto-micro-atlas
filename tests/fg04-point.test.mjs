import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLASSIFICATION,
  createLatestPointRequest,
  loadPointProfile,
  pointStateAtHour,
  pointTileRequest,
} from '../src/scripts/fg04-point.mjs';

const coordinate = [-79.3844497203827, 43.653954970269545];
const manifest = {
  nativeZoom: 16,
  tileSize: 256,
  firstHour: 6,
  lastHour: 20,
  hourBits: Object.fromEntries(
    Array.from({ length: 15 }, (_, index) => [String(index + 6), index]),
  ),
  tileUrlTemplates: {
    raw: 'https://tiles.example/v3/raw/{z}/{x}/{y}.webp',
    corrected: 'https://tiles.example/v3/corrected/{z}/{x}/{y}.webp',
  },
  classification: {
    tileUrlTemplate: 'https://tiles.example/class/v2/{z}/{x}/{y}.webp',
  },
};

function tileWithPixel(row, column, rgb) {
  const pixels = new Uint8ClampedArray(256 * 256 * 4);
  const offset = (row * 256 + column) * 4;
  pixels.set([...rgb, 255], offset);
  return { width: 256, height: 256, pixels };
}

function environmentFor(values, requests = []) {
  return {
    fetchImpl: async (url) => {
      requests.push(url);
      if (!(url in values)) return { ok: false, status: 404 };
      return { ok: true, status: 200, blob: async () => ({ url }) };
    },
    decodeTileBlob: async ({ url }) => values[url],
  };
}

function urls() {
  return pointTileRequest(coordinate, manifest).urls;
}

test('one coordinate resolves all three products to the same z16 pixel', () => {
  const request = pointTileRequest(coordinate, manifest);

  assert.deepEqual(
    { zoom: request.zoom, x: request.x, y: request.y,
      column: request.column, row: request.row },
    { zoom: 16, x: 18316, y: 23917, column: 128, row: 128 },
  );
  assert.deepEqual(request.urls, {
    measured: 'https://tiles.example/v3/raw/16/18316/23917.webp',
    corrected: 'https://tiles.example/v3/corrected/16/18316/23917.webp',
    classification: 'https://tiles.example/class/v2/16/18316/23917.webp',
  });
});

test('ground loads both surfaces and classification concurrently', async () => {
  const requestUrls = urls();
  const requests = [];
  const values = {
    [requestUrls.measured]: tileWithPixel(128, 128, [2, 0, 0b00000101]),
    [requestUrls.corrected]: tileWithPixel(128, 128, [2, 0, 0b00000011]),
    [requestUrls.classification]: tileWithPixel(
      128, 128, [CLASSIFICATION.ground, 0, 0]),
  };

  const result = await loadPointProfile(
    coordinate, manifest, new Map(), environmentFor(values, requests));

  assert.equal(result.status, 'ground');
  assert.deepEqual(requests, Object.values(requestUrls));
  assert.deepEqual(result.measured.slice(0, 4), [true, false, true, false]);
  assert.deepEqual(result.corrected.slice(0, 4), [true, true, false, false]);
  assert.equal(result.measured.length, 15);
  assert.equal(result.corrected.length, 15);
});

test('missing and non-ground are explicit states rather than zero shade', async () => {
  for (const [classValue, status] of [
    [CLASSIFICATION.missing, 'missing'],
    [CLASSIFICATION.nonGround, 'non-ground'],
  ]) {
    const requestUrls = urls();
    const values = {
      [requestUrls.measured]: tileWithPixel(128, 128, [1, 0, 1]),
      [requestUrls.corrected]: tileWithPixel(128, 128, [1, 0, 1]),
      [requestUrls.classification]: tileWithPixel(128, 128, [classValue, 0, 0]),
    };

    const result = await loadPointProfile(
      coordinate, manifest, new Map(), environmentFor(values));

    assert.equal(result.status, status);
    assert.equal(result.measured, null);
    assert.equal(result.corrected, null);
  }
});

test('corrected ground under canopy is shaded for all fifteen frames', async () => {
  const requestUrls = urls();
  const values = {
    [requestUrls.measured]: tileWithPixel(128, 128, [1, 0, 1]),
    [requestUrls.corrected]: tileWithPixel(128, 128, [1, 0, 1]),
    [requestUrls.classification]: tileWithPixel(
      128, 128, [CLASSIFICATION.underCanopy, 0, 0]),
  };

  const result = await loadPointProfile(
    coordinate, manifest, new Map(), environmentFor(values));

  assert.equal(result.status, 'ground');
  assert.equal(result.underCanopy, true);
  assert.deepEqual(result.corrected, Array(15).fill(true));
  assert.deepEqual(result.measured.slice(0, 3), [true, false, false]);
});

test('decoded tiles are cached and clock lookups never fetch', async () => {
  const requestUrls = urls();
  const requests = [];
  const values = {
    [requestUrls.measured]: tileWithPixel(128, 128, [1, 0, 1]),
    [requestUrls.corrected]: tileWithPixel(128, 128, [1, 0, 1]),
    [requestUrls.classification]: tileWithPixel(
      128, 128, [CLASSIFICATION.ground, 0, 0]),
  };
  const cache = new Map();
  const environment = environmentFor(values, requests);

  const first = await loadPointProfile(coordinate, manifest, cache, environment);
  const second = await loadPointProfile(coordinate, manifest, cache, environment);
  const selected = pointStateAtHour(first, 6, manifest);

  assert.equal(requests.length, 3);
  assert.deepEqual(second, first);
  assert.deepEqual(selected, { measured: true, corrected: true });
  assert.equal(requests.length, 3);
});

test('tile and image failures return a recoverable error state', async () => {
  const requestUrls = urls();
  const result = await loadPointProfile(
    coordinate,
    manifest,
    new Map(),
    environmentFor({
      [requestUrls.measured]: tileWithPixel(128, 128, [1, 0, 1]),
    }),
  );

  assert.equal(result.status, 'error');
  assert.equal(result.measured, null);
  assert.equal(result.corrected, null);
});

test('a slow older request cannot replace a newer point', async () => {
  const pending = [];
  const committed = [];
  const latest = createLatestPointRequest(
    (value) => new Promise((resolve) => pending.push({ value, resolve })),
    (result) => committed.push(result),
  );

  const oldRequest = latest('old');
  const newRequest = latest('new');
  pending[1].resolve({ point: 'new' });
  await newRequest;
  pending[0].resolve({ point: 'old' });
  await oldRequest;

  assert.deepEqual(committed, [{ point: 'new' }]);
});
