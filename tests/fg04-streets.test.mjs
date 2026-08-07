import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseStreetProfiles,
  profileAtHour,
  searchStreets,
  streetById,
} from '../src/scripts/fg04-streets.mjs';

const hours = Array.from({ length: 15 }, (_, index) => index + 6);

function record(overrides = {}) {
  return {
    id: 'queen-street-west',
    name: 'Queen Street West',
    center: [-79.4, 43.65],
    lengthM: 1200.5,
    groundPixels: 900,
    measured: hours.map((hour) => hour / 20),
    corrected: hours.map((hour) => Math.min(1, hour / 20 + 0.1)),
    ...overrides,
  };
}

function asset(streets = [record()]) {
  return {
    schemaVersion: 1,
    modelledDate: '2026-07-21',
    timezone: 'America/Toronto',
    hours,
    surfaceOrder: ['measured', 'corrected'],
    grain: {
      included: 'named walkable street features clipped to Toronto',
      source: 'OpenStreetMap named ways',
      minimumCenterlineM: 100,
      walkingBandM: { inner: 8, outer: 15 },
    },
    streets,
  };
}

test('search folds Unicode and requires every normalized token', () => {
  const streets = [
    record({ id: 'eglinton-avenue-east', name: 'Églinton Avenue East' }),
    record({ id: 'eglinton-way', name: 'Eglinton Way' }),
    record({ id: 'avenue-road', name: 'Avenue Road' }),
  ];

  assert.deepEqual(
    searchStreets(streets, 'eglinton east').map(({ id }) => id),
    ['eglinton-avenue-east'],
  );
});

test('names that start with the query rank before names that contain it', () => {
  const streets = [
    record({ id: 'old-queen-street', name: 'Old Queen Street' }),
    record({ id: 'queen-drive', name: 'Queen Drive' }),
    record({ id: 'queen-street', name: 'Queen Street' }),
  ];

  assert.deepEqual(
    searchStreets(streets, 'queen').map(({ id }) => id),
    ['queen-drive', 'queen-street', 'old-queen-street'],
  );
});

test('search ties are stable by normalized name then public id', () => {
  const streets = [
    record({ id: 'queen-b', name: 'Queen Street' }),
    record({ id: 'queen-a', name: 'Queen Street' }),
    record({ id: 'queen-c', name: 'Queen Road' }),
  ];

  assert.deepEqual(
    searchStreets(streets, 'queen').map(({ id }) => id),
    ['queen-c', 'queen-a', 'queen-b'],
  );
});

test('search limits results and an empty or unmatched query returns none', () => {
  const streets = Array.from({ length: 12 }, (_, index) => record({
    id: `queen-${String(index).padStart(2, '0')}`,
    name: `Queen Street ${String(index).padStart(2, '0')}`,
  }));

  assert.equal(searchStreets(streets, 'queen').length, 8);
  assert.equal(searchStreets(streets, 'queen', 3).length, 3);
  assert.deepEqual(searchStreets(streets, ''), []);
  assert.deepEqual(searchStreets(streets, 'not-a-street'), []);
});

test('the asset parser validates every paired hourly record', () => {
  const parsed = parseStreetProfiles(asset());
  assert.equal(parsed.streets.length, 1);
  assert.equal(parsed.hours.length, 15);

  const invalidRows = [
    record({ id: 'Unsafe ID' }),
    record({ center: [-90, 43.65] }),
    record({ lengthM: 99.9 }),
    record({ groundPixels: 0 }),
    record({ measured: [0.5] }),
    record({ corrected: hours.map(() => 1.1) }),
  ];
  invalidRows.forEach((invalid) => {
    assert.throws(() => parseStreetProfiles(asset([invalid])));
  });
});

test('duplicate ids and a malformed analytical contract are rejected', () => {
  assert.throws(() => parseStreetProfiles(asset([record(), record()])));
  assert.throws(() => parseStreetProfiles({ ...asset(), hours: [6, 7] }));
  assert.throws(() => parseStreetProfiles({ ...asset(), schemaVersion: 2 }));
  assert.throws(() => parseStreetProfiles({
    ...asset(), surfaceOrder: ['corrected', 'measured'],
  }));
});

test('street lookup and selected-hour values always remain paired', () => {
  const parsed = parseStreetProfiles(asset());
  const selected = streetById(parsed.streets, 'queen-street-west');

  assert.equal(selected.name, 'Queen Street West');
  assert.deepEqual(profileAtHour(selected, 13, parsed.hours), {
    measured: 0.65,
    corrected: 0.75,
  });
  assert.equal(streetById(parsed.streets, 'missing'), null);
  assert.throws(() => profileAtHour(selected, 21, parsed.hours));
});
