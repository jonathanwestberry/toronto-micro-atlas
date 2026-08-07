import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FG04_STATE,
  fg04StateEquals,
  parseFg04State,
  serializeFg04State,
} from '../src/scripts/fg04-state.mjs';

test('a bare URL has one single-sourced default state', () => {
  assert.deepEqual(parseFg04State(''), DEFAULT_FG04_STATE);
  assert.deepEqual(DEFAULT_FG04_STATE, {
    hour: 13,
    map: null,
    point: null,
    street: null,
  });
  assert.equal(serializeFg04State(DEFAULT_FG04_STATE), '');
});

test('clock hours parse and serialize canonically', () => {
  for (let hour = 6; hour <= 20; hour += 1) {
    const parsed = parseFg04State(`?hour=${hour}`);
    assert.equal(parsed.hour, hour);
    assert.equal(
      serializeFg04State(parsed),
      hour === 13 ? '' : `?hour=${hour}`,
    );
  }
});

test('malformed repeated and out-of-range hours fall back to 13:00', () => {
  for (const search of [
    '?hour=', '?hour=05', '?hour=5', '?hour=21', '?hour=13.0',
    '?hour=013', '?hour=13&hour=13', '?hour=%2013%20', '?hour=nope',
  ]) {
    assert.equal(parseFg04State(search).hour, 13, search);
  }
});

test('the shared camera contract is byte-identical', () => {
  const state = parseFg04State('?map=-79.3832049%2C43.6532051%2C12.346');
  assert.deepEqual(state.map, [-79.3832, 43.65321, 12.35]);
  assert.equal(
    serializeFg04State(state),
    '?map=-79.38320%2C43.65321%2C12.35',
  );
});

test('repeated malformed and out-of-bounds cameras are rejected', () => {
  for (const search of [
    '?map=-79.38,43.65,12&map=-79.38,43.65,12',
    '?map=-79.38,43.65',
    '?map=-79.70,43.65,12',
    '?map=-79.38,43.65,99',
    '?map=%20-79.38,43.65,12',
  ]) {
    assert.equal(parseFg04State(search).map, null, search);
  }
});

test('point selections are canonical and exclude street selections', () => {
  const point = parseFg04State('?point=-79.3832049%2C43.6532051');
  assert.deepEqual(point.point, [-79.3832, 43.65321]);
  assert.equal(
    serializeFg04State(point),
    '?point=-79.38320%2C43.65321',
  );

  const ambiguous = parseFg04State(
    '?point=-79.38320%2C43.65321&street=queen-street-west',
  );
  assert.equal(ambiguous.point, null);
  assert.equal(ambiguous.street, null);
});

test('street ids accept only the stable public wire format', () => {
  assert.equal(
    serializeFg04State(parseFg04State('?street=queen-street-west')),
    '?street=queen-street-west',
  );
  for (const search of [
    '?street=', '?street=Queen%20Street', '?street=-queen',
    '?street=queen%2Fwest', '?street=queen&street=queen',
  ]) {
    assert.equal(parseFg04State(search).street, null, search);
  }
});

test('serializer orders state and rejects invalid values', () => {
  assert.equal(
    serializeFg04State({
      hour: 16,
      map: [-79.3832049, 43.6532051, 12.346],
      point: [-79.4, 43.7],
      street: 'ignored-because-point-wins',
    }),
    '?hour=16&map=-79.38320%2C43.65321%2C12.35&point=-79.40000%2C43.70000',
  );
  assert.equal(
    serializeFg04State({ hour: 999, map: [0, 0, 0], point: [0, 0] }),
    '',
  );
});

test('state equality normalizes values before comparing', () => {
  assert.equal(
    fg04StateEquals(
      { hour: 16, map: [-79.3832049, 43.6532051, 12.346] },
      parseFg04State('?hour=16&map=-79.38320,43.65321,12.35'),
    ),
    true,
  );
  assert.equal(fg04StateEquals({ hour: 16 }, { hour: 17 }), false);
});
