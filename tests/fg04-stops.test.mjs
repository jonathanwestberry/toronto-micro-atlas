import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterStops,
  parseNoShadeStops,
  stopById,
  stopCountLabel,
} from '../src/scripts/fg04-stops.mjs';

function stop(overrides = {}) {
  return {
    id: 'stop:1',
    name: 'Queen St West at Bathurst',
    lon: -79.4,
    lat: 43.65,
    ...overrides,
  };
}

function payload(overrides = {}) {
  const stops = overrides.stops ?? [stop()];
  return {
    count: stops.length,
    ofTotal: 8432,
    sharePercent: 6.32,
    order: 'name',
    ...overrides,
    stops,
  };
}

test('it parses a well formed set', () => {
  const parsed = parseNoShadeStops(payload());

  assert.equal(parsed.count, 1);
  assert.equal(parsed.ofTotal, 8432);
  assert.equal(parsed.sharePercent, 6.32);
  assert.deepEqual(parsed.stops[0].coordinate, [-79.4, 43.65]);
});

test('a count that disagrees with the set is refused', () => {
  // Two answers to one question. The proof file is the record and the set may
  // not quietly hold a different number of stops than it claims.
  assert.throws(
    () => parseNoShadeStops({ ...payload(), count: 9 }),
    /count says 9 but the set holds 1/,
  );
});

test('an order other than name is refused', () => {
  // Every stop here sits at the same single frame. An order that implied a
  // ranking would invent a worst stop out of a tie.
  assert.throws(
    () => parseNoShadeStops({ ...payload(), order: 'shadedHours' }),
    /carries no ranking/,
  );
});

test('a stop outside Toronto is refused rather than plotted', () => {
  assert.throws(
    () => parseNoShadeStops(payload({ stops: [stop({ lon: -80.9 })] })),
    /outside Toronto in longitude/,
  );
  assert.throws(
    () => parseNoShadeStops(payload({ stops: [stop({ lat: 45.2 })] })),
    /outside Toronto in latitude/,
  );
});

test('a duplicate stop id is refused', () => {
  assert.throws(
    () => parseNoShadeStops(payload({
      stops: [stop(), stop({ name: 'Somewhere else' })],
    })),
    /appears twice/,
  );
});

test('a nameless stop is refused', () => {
  assert.throws(
    () => parseNoShadeStops(payload({ stops: [stop({ name: '   ' })] })),
    /has no name/,
  );
});

test('filtering matches every token in any position', () => {
  const { stops } = parseNoShadeStops(payload({
    stops: [
      stop({ id: 'stop:1', name: 'Queen St West at Bathurst' }),
      stop({ id: 'stop:2', name: 'King St East at Parliament' }),
      stop({ id: 'stop:3', name: 'Bathurst St at Queen' }),
    ],
  }));

  const matched = filterStops(stops, 'queen bathurst');

  assert.deepEqual(matched.map((record) => record.id), ['stop:1', 'stop:3']);
});

test('filtering keeps the published order rather than scoring matches', () => {
  // A relevance sort would put one stop at the top of a list about missing
  // shade, and a reader would take that as the worst one. There is no worst.
  const { stops } = parseNoShadeStops(payload({
    stops: [
      stop({ id: 'stop:1', name: 'Avenue Rd at Bloor' }),
      stop({ id: 'stop:2', name: 'Bloor St at Avenue' }),
    ],
  }));

  const matched = filterStops(stops, 'bloor');

  assert.deepEqual(matched.map((record) => record.id), ['stop:1', 'stop:2']);
});

test('an empty query returns the whole set so it can be browsed', () => {
  const { stops } = parseNoShadeStops(payload({
    stops: [stop({ id: 'stop:1' }), stop({ id: 'stop:2', name: 'Other' })],
  }));

  assert.equal(filterStops(stops, '').length, 2);
  assert.equal(filterStops(stops, '   ').length, 2);
});

test('filtering ignores punctuation and case', () => {
  const { stops } = parseNoShadeStops(payload({
    stops: [stop({ name: "St. Clair Ave West at Bathurst" })],
  }));

  assert.equal(filterStops(stops, 'st clair').length, 1);
  assert.equal(filterStops(stops, 'ST. CLAIR').length, 1);
});

test('the count label never lets a filtered number read as the total', () => {
  assert.equal(stopCountLabel(533, 533), 'All 533 stops, listed by name.');
  assert.equal(stopCountLabel(4, 533), '4 of 533 stops match.');
  assert.equal(stopCountLabel(0, 533),
    'No stop of the 533 matches that name.');
});

test('stopById finds a stop and returns null rather than undefined', () => {
  const { stops } = parseNoShadeStops(payload());

  assert.equal(stopById(stops, 'stop:1').name, 'Queen St West at Bathurst');
  assert.equal(stopById(stops, 'stop:404'), null);
  assert.equal(stopById(null, 'stop:1'), null);
});
