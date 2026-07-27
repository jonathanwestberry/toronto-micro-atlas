import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TORONTO_MAP_BOUNDS,
  buildExpandedMapHref,
  normalizeCamera,
  parseCamera,
  parseCameraFromSearch,
  serializeCamera,
} from '../src/scripts/map-url.mjs';
import { parseFg03State, serializeFg03State } from '../src/scripts/fg03-state.mjs';

const INSIDE = [
  [-79.3832, 43.6532, 12],
  [-79.6393, 43.581, 8],
  [-79.1153, 43.8555, 18.5],
  [-79.41234567, 43.66789012, 14.987654],
];

const OUTSIDE = [
  [-80.0, 43.6532, 12],
  [-79.3832, 44.9, 12],
  [-79.3832, 43.6532, 7.99],
  [-79.3832, 43.6532, 18.51],
];

// ---------------------------------------------------------------------------
// The point of this file: the shared module and fg03 must agree forever, or a
// URL copied out of one guide means something different in another.
// ---------------------------------------------------------------------------

test('serializes the map param byte-identically to fg03', () => {
  for (const camera of INSIDE) {
    const shared = serializeCamera(camera);
    const fg03 = new URLSearchParams(serializeFg03State({ map: camera })).get('map');
    assert.equal(shared, fg03, `camera ${camera.join(',')}`);
  }
});

test('parses the map param identically to fg03', () => {
  for (const camera of INSIDE) {
    const wire = serializeCamera(camera);
    assert.deepEqual(parseCamera(wire), parseFg03State(`?map=${wire}`, null).map);
  }
});

test('rejects out-of-Toronto cameras exactly as fg03 does', () => {
  for (const camera of OUTSIDE) {
    assert.equal(serializeCamera(camera), null, `camera ${camera.join(',')}`);
    const raw = camera.join(',');
    assert.equal(parseCamera(raw), null);
    assert.equal(parseFg03State(`?map=${raw}`, null).map, null);
  }
});

test('rounds to five decimals of position and two of zoom', () => {
  assert.deepEqual(
    normalizeCamera([-79.41234567, 43.66789012, 14.987654]),
    [-79.41235, 43.66789, 14.99],
  );
  assert.equal(serializeCamera([-79.3832, 43.6532, 12]), '-79.38320,43.65320,12.00');
});

test('rejects malformed, partial, and non-numeric values', () => {
  for (const raw of ['', 'a,b,c', '-79.38,43.65', '-79.38,43.65,12,3', '1e2,43.65,12', 'NaN,43.65,12']) {
    assert.equal(parseCamera(raw), null, `raw ${JSON.stringify(raw)}`);
  }
  assert.equal(parseCamera(null), null);
  assert.equal(parseCamera(undefined), null);
  assert.equal(normalizeCamera([-79.38, 43.65]), null);
  assert.equal(normalizeCamera('nope'), null);
});

test('an ambiguous repeated map param falls back to the default view', () => {
  const one = '-79.38320,43.65320,12.00';
  assert.deepEqual(parseCameraFromSearch(`?map=${one}`), [-79.3832, 43.6532, 12]);
  assert.equal(parseCameraFromSearch(`?map=${one}&map=${one}`), null);
  assert.equal(parseCameraFromSearch(''), null);
});

// ---------------------------------------------------------------------------
// Expand hrefs
// ---------------------------------------------------------------------------

test('expand href carries the camera onto the map route', () => {
  assert.equal(
    buildExpandedMapHref({ mapPath: '/guides/sidewalk-forest/map', camera: [-79.3832, 43.6532, 12] }),
    '/guides/sidewalk-forest/map?map=-79.38320%2C43.65320%2C12.00',
  );
});

test('expand href preserves the guide state already in the URL', () => {
  const href = buildExpandedMapHref({
    mapPath: '/guides/when-toronto-has-to-go/map',
    search: '?time=0030&access=rider&place=facility%3Aabc',
    camera: [-79.3832, 43.6532, 12],
  });
  const params = new URLSearchParams(href.split('?')[1]);
  assert.equal(params.get('time'), '0030');
  assert.equal(params.get('access'), 'rider');
  assert.equal(params.get('place'), 'facility:abc');
  assert.equal(params.get('map'), '-79.38320,43.65320,12.00');
});

test('an unrepresentable camera drops the param instead of writing junk', () => {
  assert.equal(
    buildExpandedMapHref({ mapPath: '/guides/hidden-landscapes/map', search: '?place=x', camera: [999, 999, 999] }),
    '/guides/hidden-landscapes/map?place=x',
  );
  assert.equal(
    buildExpandedMapHref({ mapPath: '/guides/hidden-landscapes/map', camera: null }),
    '/guides/hidden-landscapes/map',
  );
});

test('a stale map param in the source URL is replaced, not duplicated', () => {
  const href = buildExpandedMapHref({
    mapPath: '/guides/sidewalk-forest/map',
    search: '?map=-79.10000,43.60000,9.00',
    camera: [-79.3832, 43.6532, 12],
  });
  assert.deepEqual(new URLSearchParams(href.split('?')[1]).getAll('map'), ['-79.38320,43.65320,12.00']);
});

test('bounds are the documented Toronto window', () => {
  assert.deepEqual({ ...TORONTO_MAP_BOUNDS }, {
    minLongitude: -79.6393,
    maxLongitude: -79.1153,
    minLatitude: 43.581,
    maxLatitude: 43.8555,
    minZoom: 8,
    maxZoom: 18.5,
  });
});
