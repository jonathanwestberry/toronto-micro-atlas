import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FG03_STATE,
  parseFg03State,
  serializeFg03State,
  stateEquals,
} from '../src/scripts/fg03-state.mjs';

const VALID_PLACE_IDS = new Set([
  'facility:abc',
  'intervention_42',
  'place.with-dots',
]);

function sequenceProperty(target, key, values) {
  let reads = 0;
  Object.defineProperty(target, key, {
    enumerable: true,
    get() {
      const index = Math.min(reads, values.length - 1);
      reads += 1;
      return values[index];
    },
  });
  return () => reads;
}

function changingState() {
  const state = {};
  const map = [];
  const reads = {
    time: sequenceProperty(state, 'time', ['0030', 'private-time']),
    access: sequenceProperty(state, 'access', ['rider', 'private-access']),
    walk: sequenceProperty(state, 'walk', [500, 999]),
    action: sequenceProperty(state, 'action', ['new', 'private-action']),
    place: sequenceProperty(
      state,
      'place',
      ['facility:abc', 'facility:abc', '<private-place>'],
    ),
    longitude: sequenceProperty(
      map,
      '0',
      [-79.383204, -79.4, -79.2],
    ),
    latitude: sequenceProperty(
      map,
      '1',
      [43.653204, 43.7, 43.8],
    ),
    zoom: sequenceProperty(map, '2', [12.344, 13, 18]),
  };
  reads.map = sequenceProperty(state, 'map', [map, ['private-map']]);
  return { state, reads };
}

function throwingState() {
  const state = {
    access: 'rider',
    action: 'new',
  };
  const reads = {};

  for (const key of ['time', 'walk', 'place', 'map']) {
    let count = 0;
    Object.defineProperty(state, key, {
      enumerable: true,
      get() {
        count += 1;
        throw new Error(`private ${key} detail`);
      },
    });
    reads[key] = () => count;
  }

  return { state, reads };
}

function assertReadOnce(reads) {
  for (const [key, count] of Object.entries(reads)) {
    assert.equal(count(), 1, key);
  }
}

test('the useful default is immutable and serializes to no query', () => {
  // 'open' must match the manifest's defaultState.action. When these two
  // disagreed the page server-rendered one landing state and hydrated into the
  // other, which is how a guide about six open washrooms came up showing ten
  // proposals instead.
  assert.deepEqual(DEFAULT_FG03_STATE, {
    time: '2200',
    access: 'public',
    walk: 400,
    action: 'open',
    place: null,
    map: null,
  });
  assert.equal(Object.isFrozen(DEFAULT_FG03_STATE), true);
  assert.deepEqual(parseFg03State('', VALID_PLACE_IDS), DEFAULT_FG03_STATE);
  assert.deepEqual(parseFg03State('?', VALID_PLACE_IDS), DEFAULT_FG03_STATE);
  assert.deepEqual(
    parseFg03State('?unrelated=value', VALID_PLACE_IDS),
    DEFAULT_FG03_STATE,
  );
  assert.equal(serializeFg03State(DEFAULT_FG03_STATE), '');
  assert.equal(
    serializeFg03State({
      time: '2200',
      access: 'public',
      walk: 400,
      action: 'open',
      place: null,
      map: null,
    }),
    '',
  );
});

test('every public enum value parses independently without changing other defaults', () => {
  for (const time of ['1200', '2030', '2200', '0030']) {
    assert.equal(parseFg03State(`?time=${time}`, VALID_PLACE_IDS).time, time);
  }

  for (const access of ['public', 'rider']) {
    assert.equal(
      parseFg03State(`?access=${access}`, VALID_PLACE_IDS).access,
      access,
    );
  }

  for (const walk of [300, 400, 500]) {
    assert.equal(
      parseFg03State(`?walk=${walk}`, VALID_PLACE_IDS).walk,
      walk,
    );
  }

  for (const action of ['open', 'extend', 'new', 'verify', 'retrofit']) {
    assert.equal(
      parseFg03State(`?action=${action}`, VALID_PLACE_IDS).action,
      action,
    );
  }
});

test('invalid recognized values fall back independently while valid values survive', () => {
  assert.deepEqual(
    parseFg03State(
      '?time=2030&access=Rider&walk=0400&action=%20new%20&place=%3Cscript%3E&map=nope',
      VALID_PLACE_IDS,
    ),
    {
      time: '2030',
      access: 'public',
      walk: 400,
      action: 'open',
      place: null,
      map: null,
    },
  );

  assert.deepEqual(
    parseFg03State(
      '?time=&access=%20rider&walk=&action=NEW&place=&map=',
      VALID_PLACE_IDS,
    ),
    DEFAULT_FG03_STATE,
  );
});

test('duplicate recognized parameters fall back even when both values match', () => {
  assert.deepEqual(
    parseFg03State(
      '?time=1200&time=1200&access=rider&walk=500&walk=300&action=new&place=facility%3Aabc&map=-79.38%2C43.65%2C12',
      VALID_PLACE_IDS,
    ),
    {
      time: '2200',
      access: 'rider',
      walk: 400,
      action: 'new',
      place: 'facility:abc',
      map: [-79.38, 43.65, 12],
    },
  );

  assert.equal(
    parseFg03State(
      '?place=facility%3Aabc&place=facility%3Aabc',
      VALID_PLACE_IDS,
    ).place,
    null,
  );
});

test('place IDs must be safe and globally known after both ID datasets load', () => {
  assert.equal(
    parseFg03State('?place=facility%3Aabc', VALID_PLACE_IDS).place,
    'facility:abc',
  );
  assert.equal(
    parseFg03State('?place=place.with-dots', VALID_PLACE_IDS).place,
    'place.with-dots',
  );

  for (const place of [
    '<script>',
    '.starts-with-punctuation',
    'not-in-the-global-set',
    `a${'b'.repeat(128)}`,
  ]) {
    assert.equal(
      parseFg03State(
        `?place=${encodeURIComponent(place)}`,
        VALID_PLACE_IDS,
      ).place,
      null,
    );
  }
});

test('a safe place survives until the complete global ID set is available', () => {
  assert.equal(
    parseFg03State('?place=pending%3Afacility', undefined).place,
    'pending:facility',
  );
  assert.equal(
    parseFg03State('?place=pending%3Afacility', null).place,
    'pending:facility',
  );
  assert.equal(
    parseFg03State('?place=pending%3Afacility', new Set()).place,
    null,
  );
});

test('map parsing accepts the Toronto camera boundaries', () => {
  assert.deepEqual(
    parseFg03State(
      '?map=-79.63930%2C43.58100%2C8.00',
      VALID_PLACE_IDS,
    ).map,
    [-79.6393, 43.581, 8],
  );
  assert.deepEqual(
    parseFg03State(
      '?map=-79.11530%2C43.85550%2C18.50',
      VALID_PLACE_IDS,
    ).map,
    [-79.1153, 43.8555, 18.5],
  );
});

test('map parsing rejects malformed, non-finite, exponential, and out-of-bounds values', () => {
  const invalidMaps = [
    '-7.94e1,43.7,12',
    '-79.4,Infinity,12',
    '-79.4,NaN,12',
    '-79.4,43.7',
    '-79.4,43.7,12,extra',
    '+79.4,43.7,12',
    '-79.63931,43.7,12',
    '-79.11529,43.7,12',
    '-79.4,43.58099,12',
    '-79.4,43.85551,12',
    '-79.4,43.7,7.99',
    '-79.4,43.7,18.51',
  ];

  for (const map of invalidMaps) {
    assert.equal(
      parseFg03State(`?map=${encodeURIComponent(map)}`, VALID_PLACE_IDS).map,
      null,
      map,
    );
  }
});

test('map coordinates normalize to fixed public precision', () => {
  const state = parseFg03State(
    '?map=-79.3832049%2C43.6532051%2C12.346',
    VALID_PLACE_IDS,
  );

  assert.deepEqual(state.map, [-79.3832, 43.65321, 12.35]);
  assert.equal(
    serializeFg03State(state),
    '?map=-79.38320%2C43.65321%2C12.35',
  );

  const second = parseFg03State(
    '?map=-79.3832049%2C43.6532051%2C12.346',
    VALID_PLACE_IDS,
  );
  assert.notEqual(state.map, second.map);
  state.map[0] = -79.2;
  assert.deepEqual(second.map, [-79.3832, 43.65321, 12.35]);
});

test('serialization emits only meaningful state in canonical parameter order', () => {
  assert.equal(
    serializeFg03State({
      time: '0030',
      access: 'rider',
      walk: 500,
      action: 'new',
      place: 'facility:abc',
      map: [-79.3832, 43.6532, 12.3456],
    }),
    '?time=0030&access=rider&walk=500&action=new&place=facility%3Aabc&map=-79.38320%2C43.65320%2C12.35',
  );
  // A non-default action rides in the URL; the default one stays out of it.
  // 'extend' is the non-default now that the guide opens on 'open'.
  assert.equal(
    serializeFg03State({
      ...DEFAULT_FG03_STATE,
      action: 'extend',
      time: '2200',
    }),
    '?action=extend',
  );
  assert.equal(
    serializeFg03State({ ...DEFAULT_FG03_STATE, action: 'open' }),
    '',
    'the landing state is what a bare URL means, so it never serializes',
  );
});

test('serialization validates and emits one snapshot of every state value', () => {
  const { state, reads } = changingState();

  assert.equal(
    serializeFg03State(state),
    '?time=0030&access=rider&walk=500&action=new&place=facility%3Aabc&map=-79.38320%2C43.65320%2C12.34',
  );
  assertReadOnce(reads);
});

test('serialization defaults throwing fields while preserving other valid state', () => {
  const { state, reads } = throwingState();
  let query;

  assert.doesNotThrow(() => {
    query = serializeFg03State(state);
  });
  assert.equal(query, '?access=rider&action=new');
  assertReadOnce(reads);
});

test('serialization, parsing, and equality form an idempotent normalized round trip', () => {
  const original = {
    time: '0030',
    access: 'rider',
    walk: 300,
    action: 'verify',
    place: 'intervention_42',
    map: [-79.383204, 43.653204, 12.344],
  };
  const query = serializeFg03State(original);
  const parsed = parseFg03State(query, VALID_PLACE_IDS);

  assert.equal(
    query,
    '?time=0030&access=rider&walk=300&action=verify&place=intervention_42&map=-79.38320%2C43.65320%2C12.34',
  );
  assert.equal(serializeFg03State(parsed), query);
  assert.equal(
    serializeFg03State(
      parseFg03State(serializeFg03State(parsed), VALID_PLACE_IDS),
    ),
    query,
  );
  assert.equal(stateEquals(original, parsed), true);
});

test('stateEquals compares all six normalized fields rather than object identity', () => {
  const baseline = {
    time: '2030',
    access: 'rider',
    walk: 500,
    action: 'retrofit',
    place: 'intervention_42',
    map: [-79.383204, 43.653204, 12.344],
  };

  assert.equal(
    stateEquals(baseline, {
      ...baseline,
      map: [-79.3832, 43.6532, 12.34],
    }),
    true,
  );

  for (const changed of [
    { ...baseline, time: '1200' },
    { ...baseline, access: 'public' },
    { ...baseline, walk: 300 },
    { ...baseline, action: 'new' },
    { ...baseline, place: 'facility:abc' },
    { ...baseline, map: [-79.4, 43.7, 12] },
  ]) {
    assert.equal(stateEquals(baseline, changed), false);
  }
});

test('stateEquals compares one validated snapshot from accessor-backed state', () => {
  const { state, reads } = changingState();
  const expected = {
    time: '0030',
    access: 'rider',
    walk: 500,
    action: 'new',
    place: 'facility:abc',
    map: [-79.383204, 43.653204, 12.344],
  };

  assert.equal(stateEquals(state, expected), true);
  assertReadOnce(reads);
});

test('stateEquals defaults throwing fields without discarding other valid fields', () => {
  const { state, reads } = throwingState();
  const expected = {
    ...DEFAULT_FG03_STATE,
    access: 'rider',
    action: 'new',
  };
  let equal;

  assert.doesNotThrow(() => {
    equal = stateEquals(state, expected);
  });
  assert.equal(equal, true);
  assertReadOnce(reads);
});

test('URLSearchParams input preserves the leading-zero time', () => {
  const params = new URLSearchParams(
    'time=0030&access=rider&walk=300&action=open',
  );

  assert.deepEqual(parseFg03State(params, VALID_PLACE_IDS), {
    time: '0030',
    access: 'rider',
    walk: 300,
    action: 'open',
    place: null,
    map: null,
  });
});
