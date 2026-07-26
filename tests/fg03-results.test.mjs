import assert from 'node:assert/strict';
import test from 'node:test';

import * as results from '../src/scripts/fg03-results.mjs';

const { toDataAccessMode } = results;

function facility(
  id,
  {
    accessCondition = 'unrestricted',
    address = `${id} Example Street`,
    name = id,
    observed = 'open',
    partialService = false,
    source = 'parks',
    states = {},
  } = {},
) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [-79.4, 43.7],
    },
    properties: {
      accessCondition,
      accessibility: 'accessible',
      address,
      closureCategory: 'none',
      hours: 'Daily 6 a.m. to 11 p.m.',
      id,
      name,
      partialService,
      reachAvailable: true,
      schemaVersion: 1,
      source,
      sourceUrl: 'https://open.toronto.ca/example',
      stateByTime: {
        '0030': { observed: 'scheduled_closed', scheduled: 'closed' },
        '1200': { observed: 'open', scheduled: 'open' },
        '2030': { observed: 'open', scheduled: 'open' },
        '2200': { observed, scheduled: observed === 'open' ? 'open' : 'closed' },
        ...states,
      },
    },
  };
}

function collection(features) {
  return { type: 'FeatureCollection', features };
}

function withOnceProperties(feature, reads, key) {
  const properties = feature.properties;
  return {
    ...feature,
    get properties() {
      reads[key] = (reads[key] ?? 0) + 1;
      if (reads[key] > 1) {
        throw new Error(`${key} properties read twice`);
      }
      return properties;
    },
  };
}

function collectionWithOnceFeatures(features, reads, key) {
  return {
    type: 'FeatureCollection',
    get features() {
      reads[key] = (reads[key] ?? 0) + 1;
      if (reads[key] > 1) {
        throw new Error(`${key} features read twice`);
      }
      return features;
    },
  };
}

function throwingPrimitive(label) {
  return new Proxy({}, {
    get(target, key, receiver) {
      if (
        key === Symbol.toPrimitive
        || key === 'toString'
        || key === 'valueOf'
      ) {
        throw new Error(`${label} primitive conversion`);
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

function queryCell({
  access = 'public',
  active = true,
  activeStops = 3,
  events = 12,
  time = '2200',
  uniqueRoutes = 2,
  uniqueTrips = 10,
  walk = 400,
} = {}) {
  return {
    access,
    active,
    activeStops,
    events,
    time,
    uniqueRoutes,
    uniqueTrips,
    walk,
  };
}

function completeQueryCells({
  access: activeAccess,
  time: activeTime,
  walk: activeWalk,
}) {
  const cells = [];
  for (const time of ['1200', '2030', '2200', '0030']) {
    for (const access of ['public', 'rider_conditional']) {
      for (const walk of [300, 400, 500]) {
        const active = (
          time === activeTime
          && access === activeAccess
          && walk === activeWalk
        );
        cells.push(queryCell({
          access,
          active,
          activeStops: active ? 1 : 0,
          events: active ? 2 : 0,
          time,
          uniqueRoutes: active ? 1 : 0,
          uniqueTrips: active ? 2 : 0,
          walk,
        }));
      }
    }
  }
  return cells;
}

function intervention(
  id,
  {
    action = 'extend',
    actionClass = 'extend_hours',
    materialGain = true,
    name = id,
    primaryRank = 1,
    queryCells = [queryCell()],
    verificationSubtype = null,
  } = {},
) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [-79.39, 43.71],
    },
    properties: {
      accessCondition: 'unrestricted',
      accessibility: 'unknown',
      action,
      actionClass,
      auditStatus: 'valid',
      closureCategory: 'none',
      facilityId: `parks:${id}`,
      hours: 'Daily 9 a.m. to 10 p.m.',
      id,
      materialGain,
      name,
      primaryMetrics: {
        combined_incremental: {
          active_stops: 3,
          stop_time_events: 12,
          unique_routes: 2,
          unique_trips: 10,
        },
        combined_total: {
          active_stops: 3,
          stop_time_events: 12,
          unique_routes: 2,
          unique_trips: 10,
        },
        positive_late_snapshots: 1,
        scenario_id: 'primary',
        snapshot_gains: [],
      },
      primaryRank,
      queryCells,
      reachAvailable: true,
      schemaVersion: 1,
      sensitivityRanks: [],
      sourceUrl: 'https://www.toronto.ca/example',
      stability: 'robust',
      verificationSubtype,
    },
  };
}

test('maps public URL access values to the audited data values', () => {
  assert.equal(toDataAccessMode('public'), 'public');
  assert.equal(toDataAccessMode('rider'), 'rider_conditional');
  assert.equal(toDataAccessMode('rider_conditional'), null);
  assert.equal(toDataAccessMode('RIDER'), null);
});

test('open results use the exact observed state and retain partial-service facilities', () => {
  const facilities = collection([
    facility('open'),
    facility('partial', { partialService: true }),
    facility('scheduled', { observed: 'scheduled_closed' }),
    facility('seasonal', { observed: 'seasonal_closed' }),
    facility('temporary', { observed: 'temporary_closed' }),
    facility('construction', { observed: 'construction_closed' }),
    facility('unknown', { observed: 'unknown_hours', partialService: true }),
    facility('wrong-time', {
      observed: 'scheduled_closed',
      states: {
        '2030': { observed: 'open', scheduled: 'open' },
      },
    }),
    facility('malformed', { observed: true }),
  ]);

  const actual = typeof results.filterOpenFacilities === 'function'
    ? results.filterOpenFacilities(facilities, {
        time: '2200',
        access: 'public',
      })
    : undefined;

  assert.deepEqual(actual?.map((feature) => feature.properties.id), [
    'open',
    'partial',
  ]);
});

test('open results keep fare-paid facilities out of public mode and in rider mode', () => {
  const facilities = collection([
    facility('public', { accessCondition: 'unrestricted' }),
    facility('fare-paid', { accessCondition: 'fare_paid' }),
    facility('unknown-access', { accessCondition: 'unknown' }),
  ]);

  const publicIds = results
    .filterOpenFacilities(facilities, { time: '2200', access: 'public' })
    .map((feature) => feature.properties.id);
  const riderIds = results
    .filterOpenFacilities(facilities, { time: '2200', access: 'rider' })
    .map((feature) => feature.properties.id);
  const invalidIds = results
    .filterOpenFacilities(facilities, { time: '2200', access: 'anything' })
    .map((feature) => feature.properties.id);

  assert.deepEqual(publicIds, ['public']);
  assert.deepEqual(riderIds, ['fare-paid', 'public']);
  assert.deepEqual(invalidIds, []);
});

test('fare-paid rider results expose a condition that the interface can display', () => {
  const disclosure = typeof results.getAccessDisclosure === 'function'
    ? results.getAccessDisclosure(
        facility('fare-paid', { accessCondition: 'fare_paid' }),
      )
    : undefined;

  assert.equal(disclosure?.condition, 'fare_paid');
  assert.equal(disclosure?.requiresFare, true);
  assert.match(disclosure?.label ?? '', /fare/i);
  assert.equal(
    results.getAccessDisclosure?.(
      facility('public', { accessCondition: 'unrestricted' }),
    )?.requiresFare,
    false,
  );
});

test('open results return the full list ordered by normalized name then stable ID', () => {
  const generated = Array.from(
    { length: 60 },
    (_, index) => facility(`site-${String(index).padStart(2, '0')}`, {
      name: `Site ${String(index).padStart(2, '0')}`,
    }),
  ).reverse();
  const facilities = collection([
    ...generated,
    facility('alpha-b', { name: '  ALPHA   washroom ' }),
    facility('cafe-b', { name: 'Cafe\u0301' }),
    facility('alpha-a', { name: 'Alpha washroom' }),
    facility('cafe-a', { name: 'Café' }),
  ]);

  const actual = results.filterOpenFacilities(facilities, {
    time: '2200',
    access: 'public',
    viewportIds: ['site-22'],
    limit: 3,
  });
  const ids = actual.map((feature) => feature.properties.id);

  assert.equal(ids.length, 64);
  assert.deepEqual(ids.slice(0, 5), [
    'alpha-a',
    'alpha-b',
    'cafe-a',
    'cafe-b',
    'site-00',
  ]);
  assert.equal(ids.at(-1), 'site-59');
});

test('interventions require one exact active query cell with positive exported gain', () => {
  const interventions = collection([
    intervention('eligible'),
    intervention('wrong-action', { action: 'new', actionClass: 'new_facility_zone' }),
    intervention('wrong-time', {
      queryCells: [queryCell({ time: '0030' })],
    }),
    intervention('wrong-access', {
      queryCells: [queryCell({ access: 'rider_conditional' })],
    }),
    intervention('wrong-walk', {
      queryCells: [queryCell({ walk: 500 })],
    }),
    intervention('inactive', {
      queryCells: [queryCell({ active: false })],
    }),
    intervention('zero-gain', {
      queryCells: [
        queryCell({
          activeStops: 0,
          events: 0,
          uniqueRoutes: 0,
          uniqueTrips: 0,
        }),
      ],
    }),
    intervention('not-material', { materialGain: false }),
    intervention('string-gain', {
      queryCells: [
        queryCell({
          activeStops: '3',
          events: '12',
          uniqueRoutes: '2',
          uniqueTrips: '10',
        }),
      ],
    }),
  ]);

  const actual = typeof results.filterInterventions === 'function'
    ? results.filterInterventions(interventions, {
        time: '2200',
        access: 'public',
        walk: 400,
        action: 'extend',
      })
    : undefined;

  assert.deepEqual(actual?.map((feature) => feature.properties.id), [
    'eligible',
  ]);
});

test('interventions reject an ambiguous duplicate query cell', () => {
  const duplicated = intervention('duplicated', {
    queryCells: [
      queryCell(),
      queryCell({ events: 99 }),
    ],
  });

  assert.deepEqual(
    results.filterInterventions(collection([duplicated]), {
      time: '2200',
      access: 'public',
      walk: 400,
      action: 'extend',
    }),
    [],
  );
});

test('all 120 control combinations use only the exact action and query cell', () => {
  const closed = { observed: 'scheduled_closed', scheduled: 'closed' };
  const open = { observed: 'open', scheduled: 'open' };
  const publicFacility = facility('public-open', {
    observed: 'scheduled_closed',
    states: {
      '0030': closed,
      '1200': open,
      '2030': closed,
      '2200': closed,
    },
  });
  const farePaidFacility = facility('fare-open', {
    accessCondition: 'fare_paid',
    observed: 'scheduled_closed',
    states: {
      '0030': closed,
      '1200': closed,
      '2030': open,
      '2200': closed,
    },
  });
  const interventions = collection([
    intervention('extend-exact', {
      action: 'extend',
      actionClass: 'extend_hours',
      queryCells: completeQueryCells({
        access: 'public',
        time: '1200',
        walk: 300,
      }),
    }),
    intervention('new-exact', {
      action: 'new',
      actionClass: 'new_facility_zone',
      queryCells: completeQueryCells({
        access: 'rider_conditional',
        time: '2030',
        walk: 400,
      }),
    }),
    intervention('verify-exact', {
      action: 'verify',
      actionClass: 'verify_information',
      queryCells: completeQueryCells({
        access: 'public',
        time: '2200',
        walk: 500,
      }),
      verificationSubtype: 'hours',
    }),
    intervention('retrofit-exact', {
      action: 'retrofit',
      actionClass: 'retrofit_accessibility',
      queryCells: completeQueryCells({
        access: 'rider_conditional',
        time: '0030',
        walk: 300,
      }),
    }),
  ]);
  const facilities = collection([farePaidFacility, publicFacility]);
  let combinations = 0;
  let nonempty = 0;

  for (const time of ['1200', '2030', '2200', '0030']) {
    for (const access of ['public', 'rider']) {
      for (const walk of [300, 400, 500]) {
        for (const action of ['open', 'extend', 'new', 'verify', 'retrofit']) {
          let expected = [];
          if (action === 'open' && time === '1200') {
            expected = ['public-open'];
          } else if (
            action === 'open'
            && time === '2030'
            && access === 'rider'
          ) {
            expected = ['fare-open'];
          } else if (
            action === 'extend'
            && time === '1200'
            && access === 'public'
            && walk === 300
          ) {
            expected = ['extend-exact'];
          } else if (
            action === 'new'
            && time === '2030'
            && access === 'rider'
            && walk === 400
          ) {
            expected = ['new-exact'];
          } else if (
            action === 'verify'
            && time === '2200'
            && access === 'public'
            && walk === 500
          ) {
            expected = ['verify-exact'];
          } else if (
            action === 'retrofit'
            && time === '0030'
            && access === 'rider'
            && walk === 300
          ) {
            expected = ['retrofit-exact'];
          }

          const actual = results.deriveFg03Results({
            facilities,
            interventions,
            state: {
              time,
              access,
              walk,
              action,
              place: null,
            },
          }).features.map((feature) => feature.properties.id);

          assert.deepEqual(
            actual,
            expected,
            `${time}/${access}/${walk}/${action}`,
          );
          combinations += 1;
          nonempty += Number(actual.length > 0);
        }
      }
    }
  }

  assert.equal(combinations, 120);
  assert.equal(nonempty, 13);
});

test('verification rankings stay separate by subtype and retain exported ranks', () => {
  const features = [
    intervention('access-4', {
      action: 'verify',
      actionClass: 'verify_information',
      primaryRank: 4,
      verificationSubtype: 'accessibility',
    }),
    intervention('hours-10', {
      action: 'verify',
      actionClass: 'verify_information',
      primaryRank: 10,
      verificationSubtype: 'hours',
    }),
    intervention('hours-b', {
      action: 'verify',
      actionClass: 'verify_information',
      primaryRank: 2,
      verificationSubtype: 'hours',
    }),
    intervention('access-1', {
      action: 'verify',
      actionClass: 'verify_information',
      primaryRank: 1,
      verificationSubtype: 'accessibility',
    }),
    intervention('hours-a', {
      action: 'verify',
      actionClass: 'verify_information',
      primaryRank: 2,
      verificationSubtype: 'hours',
    }),
  ];

  const groups = typeof results.groupRankedInterventions === 'function'
    ? results.groupRankedInterventions(features)
    : undefined;

  assert.deepEqual(groups?.map((group) => group.id), [
    'verify-hours',
    'verify-accessibility',
  ]);
  assert.deepEqual(
    groups?.[0]?.items.map((feature) => [
      feature.properties.id,
      feature.properties.primaryRank,
    ]),
    [
      ['hours-a', 2],
      ['hours-b', 2],
      ['hours-10', 10],
    ],
  );
  assert.deepEqual(
    groups?.[1]?.items.map((feature) => [
      feature.properties.id,
      feature.properties.primaryRank,
    ]),
    [
      ['access-1', 1],
      ['access-4', 4],
    ],
  );
});

test('intervention results return every match in exported rank order with ID ties', () => {
  const ranked = Array.from(
    { length: 60 },
    (_, index) => intervention(`rank-${String(index + 1).padStart(2, '0')}`, {
      primaryRank: index + 1,
    }),
  ).reverse();
  const interventions = collection([
    ...ranked,
    intervention('z-tie', { primaryRank: 1 }),
    intervention('a-tie', { primaryRank: 1 }),
  ]);

  const actual = results.filterInterventions(interventions, {
    time: '2200',
    access: 'public',
    walk: 400,
    action: 'extend',
    viewportIds: ['rank-22'],
    limit: 3,
  });
  const ids = actual.map((feature) => feature.properties.id);

  assert.equal(ids.length, 62);
  assert.deepEqual(ids.slice(0, 3), ['a-tie', 'rank-01', 'z-tie']);
  assert.equal(ids.at(-1), 'rank-60');
  assert.equal(actual.at(-1).properties.primaryRank, 60);
});

test('search uses normalized AND tokens only across approved result labels', () => {
  const cafe = facility('cafe', {
    address: '10 Queen Street West',
    name: 'Cafe\u0301 at Queen',
    source: 'parks',
  });
  const library = intervention('verify-library', {
    action: 'verify',
    actionClass: 'verify_information',
    name: 'Spadina Road branch',
    primaryRank: 2,
    verificationSubtype: 'hours',
  });
  library.properties.facilityId = 'library:SP';
  const addressMatch = facility('king', {
    address: '123 King Street West',
    name: 'Downtown facility',
    source: 'crem',
  });
  const hidden = facility('hidden', { name: 'Ordinary facility' });
  hidden.properties.hours = 'supersecret';
  hidden.properties.sourceUrl = 'https://example.test/supersecret';
  hidden.properties.auditNote = 'supersecret';
  hidden.geometry.coordinates = [-79.12345, 43.76543];
  const ordered = [library, cafe, addressMatch, hidden];

  const search = typeof results.searchFg03Results === 'function'
    ? results.searchFg03Results
    : () => undefined;

  assert.deepEqual(
    search(ordered, '  CAFÉ   park  ')?.map((feature) => feature.properties.id),
    ['cafe'],
  );
  assert.deepEqual(
    search(ordered, 'VERIFY    hours library')
      ?.map((feature) => feature.properties.id),
    ['verify-library'],
  );
  assert.deepEqual(
    search(ordered, 'king west')?.map((feature) => feature.properties.id),
    ['king'],
  );
  assert.deepEqual(search(ordered, 'supersecret'), []);
  assert.deepEqual(
    search(ordered, 'facility')?.map((feature) => feature.properties.id),
    ['king', 'hidden'],
  );
  assert.deepEqual(search(ordered, '   '), ordered);
});

test('search folds German sharp s after compatibility normalization', () => {
  const features = [
    facility('strasse', { address: '1 Queen Street', name: 'Straße' }),
    facility('nearby', { address: '2 Queen Street', name: 'Strase' }),
  ];

  assert.deepEqual(
    results
      .searchFg03Results(features, 'ＳＴＲＡＳＳＥ')
      .map((feature) => feature.properties.id),
    ['strasse'],
  );
});

test('search treats ordinary and final Greek sigma as equivalent', () => {
  const features = [
    facility('ordinary-sigma', { name: 'οσ' }),
    facility('final-sigma', { name: 'ος' }),
  ];

  assert.deepEqual(
    results
      .searchFg03Results(features, 'ΟΣ')
      .map((feature) => feature.properties.id),
    ['ordinary-sigma', 'final-sigma'],
  );
});

test('global result IDs are collected once and duplicates or missing IDs are rejected', () => {
  const collect = typeof results.collectFg03ResultIds === 'function'
    ? results.collectFg03ResultIds
    : () => undefined;
  const facilities = collection([
    facility('facility:a'),
    facility('facility:b'),
  ]);
  const interventions = collection([
    intervention('intervention:a'),
    intervention('intervention:b'),
  ]);

  assert.deepEqual(
    [...(collect(facilities, interventions) ?? [])],
    [
      'facility:a',
      'facility:b',
      'intervention:a',
      'intervention:b',
    ],
  );
  assert.throws(
    () => collect(
      collection([facility('shared')]),
      collection([intervention('shared')]),
    ),
    /duplicate.*shared/i,
  );
  assert.throws(
    () => collect(
      collection([facility('same'), facility('same')]),
      collection([]),
    ),
    /duplicate.*same/i,
  );
  const missing = facility('temporary');
  delete missing.properties.id;
  assert.throws(
    () => collect(collection([missing]), collection([])),
    /valid id/i,
  );
});

test('selection is invalidated only when its ID leaves the visible result set', () => {
  const visible = [
    facility('facility:a'),
    intervention('intervention:a'),
  ];
  const reconcile = typeof results.reconcileFg03Selection === 'function'
    ? results.reconcileFg03Selection
    : () => undefined;

  assert.deepEqual(reconcile('intervention:a', visible), {
    selectedId: 'intervention:a',
    invalidated: false,
  });
  assert.deepEqual(reconcile('filtered-out', visible), {
    selectedId: null,
    invalidated: true,
  });
  assert.deepEqual(reconcile(null, visible), {
    selectedId: null,
    invalidated: false,
  });
  assert.deepEqual(reconcile('facility:a', null), {
    selectedId: null,
    invalidated: true,
  });
});

test('history effects distinguish explicit navigation, replacement, and popstate', () => {
  const effect = typeof results.getFg03HistoryEffect === 'function'
    ? results.getFg03HistoryEffect
    : () => undefined;

  for (const cause of [
    'time-change',
    'access-change',
    'walk-change',
    'action-change',
    'selection',
    'close',
    'reset',
  ]) {
    assert.equal(effect(cause), 'push', cause);
  }
  for (const cause of [
    'initial-cleanup',
    'camera',
    'search-invalidation',
  ]) {
    assert.equal(effect(cause), 'replace', cause);
  }
  assert.equal(effect('popstate'), 'none');
  assert.equal(effect('search'), 'none');
  assert.equal(effect('unknown'), 'none');
  assert.equal(effect(null), 'none');
});

test('derived results switch source by action, search after filtering, and reuse feature objects', () => {
  const open = facility('open-result', {
    name: 'Queen Street washroom',
  });
  const extend = intervention('extend-result', {
    name: 'King Street washroom',
  });
  const derive = typeof results.deriveFg03Results === 'function'
    ? results.deriveFg03Results
    : () => undefined;

  const openResult = derive({
    facilities: collection([open]),
    interventions: collection([extend]),
    state: {
      time: '2200',
      access: 'public',
      walk: 400,
      action: 'open',
      place: 'open-result',
    },
    search: 'queen',
  });
  assert.deepEqual(
    openResult?.features.map((feature) => feature.properties.id),
    ['open-result'],
  );
  assert.equal(openResult?.features[0], open);
  assert.equal(openResult?.selectedId, 'open-result');
  assert.equal(openResult?.selectionInvalidated, false);
  assert.deepEqual(openResult?.groups.map((group) => group.id), ['open']);

  const extendResult = derive({
    facilities: collection([open]),
    interventions: collection([extend]),
    state: {
      time: '2200',
      access: 'public',
      walk: 400,
      action: 'extend',
      place: 'open-result',
    },
    search: 'king',
  });
  assert.equal(extendResult?.features[0], extend);
  assert.equal(extendResult?.selectedId, null);
  assert.equal(extendResult?.selectionInvalidated, true);
  assert.deepEqual(
    extendResult?.groups.map((group) => group.id),
    ['extend_hours'],
  );
});

test('open filtering snapshots state once and ignores features with throwing accessors', () => {
  let timeReads = 0;
  let accessReads = 0;
  const state = {
    get time() {
      timeReads += 1;
      if (timeReads > 1) {
        throw new Error('time read twice');
      }
      return '2200';
    },
    get access() {
      accessReads += 1;
      if (accessReads > 1) {
        throw new Error('access read twice');
      }
      return 'public';
    },
  };
  const malformed = {
    get properties() {
      throw new Error('broken feature');
    },
  };

  assert.deepEqual(
    results
      .filterOpenFacilities(
        collection([
          malformed,
          facility('second', { name: 'Second' }),
          facility('first', { name: 'First' }),
        ]),
        state,
      )
      .map((feature) => feature.properties.id),
    ['first', 'second'],
  );
  assert.equal(timeReads, 1);
  assert.equal(accessReads, 1);
});

test('intervention matching snapshots state and gain fields once', () => {
  const reads = {
    access: 0,
    action: 0,
    events: 0,
    time: 0,
    walk: 0,
  };
  const once = (key, value) => ({
    enumerable: true,
    get() {
      reads[key] += 1;
      if (reads[key] > 1) {
        throw new Error(`${key} read twice`);
      }
      return value;
    },
  });
  const exact = queryCell({
    activeStops: 0,
    events: 0,
    uniqueRoutes: 0,
    uniqueTrips: 0,
  });
  Object.defineProperty(exact, 'events', once('events', 12));
  const feature = intervention('snapshot', {
    queryCells: [
      queryCell({ time: '0030' }),
      exact,
    ],
  });
  const state = {};
  Object.defineProperties(state, {
    access: once('access', 'public'),
    action: once('action', 'extend'),
    time: once('time', '2200'),
    walk: once('walk', 400),
  });

  assert.deepEqual(
    results
      .filterInterventions(collection([feature]), state)
      .map((item) => item.properties.id),
    ['snapshot'],
  );
  assert.deepEqual(reads, {
    access: 1,
    action: 1,
    events: 1,
    time: 1,
    walk: 1,
  });
});

test('derived results snapshot every state field before routing work', () => {
  const reads = new Map();
  const state = {};
  for (const [key, value] of [
    ['access', 'public'],
    ['action', 'extend'],
    ['place', 'derived'],
    ['time', '2200'],
    ['walk', 400],
  ]) {
    Object.defineProperty(state, key, {
      enumerable: true,
      get() {
        const next = (reads.get(key) ?? 0) + 1;
        reads.set(key, next);
        if (next > 1) {
          throw new Error(`${key} read twice`);
        }
        return value;
      },
    });
  }

  const actual = results.deriveFg03Results({
    facilities: collection([]),
    interventions: collection([intervention('derived')]),
    state,
  });

  assert.equal(actual.features[0].properties.id, 'derived');
  assert.equal(actual.selectedId, 'derived');
  assert.deepEqual(Object.fromEntries(reads), {
    access: 1,
    action: 1,
    place: 1,
    time: 1,
    walk: 1,
  });
});

test('open derivation snapshots collection and sortable feature properties once', () => {
  const reads = {};
  const alpha = withOnceProperties(
    facility('alpha', { name: 'Alpha washroom' }),
    reads,
    'alpha',
  );
  const beta = withOnceProperties(
    facility('beta', { name: 'Beta washroom' }),
    reads,
    'beta',
  );
  const facilities = collectionWithOnceFeatures(
    [beta, alpha],
    reads,
    'facilities',
  );
  let actual;

  assert.doesNotThrow(() => {
    actual = results.deriveFg03Results({
      facilities,
      interventions: collection([]),
      state: {
        time: '2200',
        access: 'public',
        walk: 400,
        action: 'open',
        place: 'alpha',
      },
      search: 'alpha',
    });
  });
  assert.deepEqual(
    actual.features.map((feature) => feature === alpha ? 'alpha' : 'other'),
    ['alpha'],
  );
  assert.equal(actual.selectedId, 'alpha');
  assert.deepEqual(reads, {
    alpha: 1,
    beta: 1,
    facilities: 1,
  });
});

test('intervention derivation snapshots grouping and ranking properties once', () => {
  const reads = {};
  const hoursTwo = withOnceProperties(
    intervention('hours-two', {
      action: 'verify',
      actionClass: 'verify_information',
      primaryRank: 2,
      verificationSubtype: 'hours',
    }),
    reads,
    'hours-two',
  );
  const accessibility = withOnceProperties(
    intervention('accessibility-one', {
      action: 'verify',
      actionClass: 'verify_information',
      primaryRank: 1,
      verificationSubtype: 'accessibility',
    }),
    reads,
    'accessibility',
  );
  const hoursOne = withOnceProperties(
    intervention('hours-one', {
      action: 'verify',
      actionClass: 'verify_information',
      primaryRank: 1,
      verificationSubtype: 'hours',
    }),
    reads,
    'hours-one',
  );
  const interventions = collectionWithOnceFeatures(
    [hoursTwo, accessibility, hoursOne],
    reads,
    'interventions',
  );
  let actual;

  assert.doesNotThrow(() => {
    actual = results.deriveFg03Results({
      facilities: collection([]),
      interventions,
      state: {
        time: '2200',
        access: 'public',
        walk: 400,
        action: 'verify',
        place: 'hours-one',
      },
      search: 'verify',
    });
  });
  assert.deepEqual(
    actual.groups.map((group) => [
      group.id,
      group.items.map((feature) => (
        feature === hoursOne
          ? 'hours-one'
          : feature === hoursTwo
            ? 'hours-two'
            : 'accessibility-one'
      )),
    ]),
    [
      ['verify-hours', ['hours-one', 'hours-two']],
      ['verify-accessibility', ['accessibility-one']],
    ],
  );
  assert.equal(actual.selectedId, 'hours-one');
  assert.deepEqual(reads, {
    accessibility: 1,
    'hours-one': 1,
    'hours-two': 1,
    interventions: 1,
  });
});

test('global ID collection snapshots each collection and feature properties once', () => {
  const reads = {};
  const facilities = collectionWithOnceFeatures(
    [
      withOnceProperties(facility('facility:a'), reads, 'facility'),
    ],
    reads,
    'facilities',
  );
  const interventions = collectionWithOnceFeatures(
    [
      withOnceProperties(
        intervention('intervention:a'),
        reads,
        'intervention',
      ),
    ],
    reads,
    'interventions',
  );
  let ids;

  assert.doesNotThrow(() => {
    ids = results.collectFg03ResultIds(facilities, interventions);
  });
  assert.deepEqual([...ids], ['facility:a', 'intervention:a']);
  assert.deepEqual(reads, {
    facilities: 1,
    facility: 1,
    interventions: 1,
    intervention: 1,
  });
});

test('open filtering degrades a revoked feature array to no results', () => {
  const revoked = Proxy.revocable([facility('open')], {});
  revoked.revoke();

  assert.deepEqual(
    results.filterOpenFacilities(
      collection(revoked.proxy),
      { time: '2200', access: 'public' },
    ),
    [],
  );
});

test('global ID collection gives its generic error for a revoked feature array', () => {
  const revoked = Proxy.revocable([facility('open')], {});
  revoked.revoke();

  assert.throws(
    () => results.collectFg03ResultIds(
      collection(revoked.proxy),
      collection([]),
    ),
    {
      name: 'TypeError',
      message: 'FG03 result data must contain a features array',
    },
  );
});

test('open filtering does not invoke an untrusted feature array map method', () => {
  const open = facility('open');
  const features = new Proxy([open], {
    get(target, key, receiver) {
      if (key === 'map') {
        throw new Error('untrusted map method');
      }
      return Reflect.get(target, key, receiver);
    },
  });

  assert.deepEqual(
    results.filterOpenFacilities(
      collection(features),
      { time: '2200', access: 'public' },
    ),
    [open],
  );
});

test('intervention filtering degrades revoked query cells to no results', () => {
  const revoked = Proxy.revocable([queryCell()], {});
  const candidate = intervention('revoked-cells', {
    queryCells: revoked.proxy,
  });
  revoked.revoke();

  assert.deepEqual(
    results.filterInterventions(collection([candidate]), {
      time: '2200',
      access: 'public',
      walk: 400,
      action: 'extend',
    }),
    [],
  );
});

test('intervention filtering does not invoke an untrusted query-cell filter method', () => {
  const queryCells = new Proxy([queryCell()], {
    get(target, key, receiver) {
      if (key === 'filter') {
        throw new Error('untrusted filter method');
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const candidate = intervention('proxied-cells', { queryCells });

  assert.deepEqual(
    results.filterInterventions(collection([candidate]), {
      time: '2200',
      access: 'public',
      walk: 400,
      action: 'extend',
    }),
    [candidate],
  );
});

test('search does not invoke an untrusted feature-list map method', () => {
  const candidate = facility('searchable', { name: 'Searchable washroom' });
  const features = new Proxy([candidate], {
    get(target, key, receiver) {
      if (key === 'map') {
        throw new Error('untrusted search map method');
      }
      return Reflect.get(target, key, receiver);
    },
  });

  assert.deepEqual(
    results.searchFg03Results(features, 'searchable'),
    [candidate],
  );
});

test('grouping does not invoke an untrusted feature-list map method', () => {
  const candidate = intervention('groupable');
  const features = new Proxy([candidate], {
    get(target, key, receiver) {
      if (key === 'map') {
        throw new Error('untrusted grouping map method');
      }
      return Reflect.get(target, key, receiver);
    },
  });

  assert.deepEqual(
    results.groupRankedInterventions(features),
    [{
      id: 'extend_hours',
      items: [candidate],
    }],
  );
});

test('selection reconciliation degrades a revoked feature list to empty', () => {
  const revoked = Proxy.revocable([facility('selected')], {});
  revoked.revoke();

  assert.deepEqual(
    results.reconcileFg03Selection('selected', revoked.proxy),
    {
      selectedId: null,
      invalidated: true,
    },
  );
});

test('facility sorting does not coerce proxy-valued IDs', () => {
  const first = facility('first', { name: 'Same name' });
  const second = facility('second', { name: 'Same name' });
  first.properties.id = throwingPrimitive('first ID');
  second.properties.id = throwingPrimitive('second ID');

  assert.deepEqual(
    results.filterOpenFacilities(
      collection([first, second]),
      { time: '2200', access: 'public' },
    ),
    [first, second],
  );
});

test('intervention sorting does not coerce proxy-valued IDs', () => {
  const first = intervention('first', { primaryRank: 1 });
  const second = intervention('second', { primaryRank: 1 });
  first.properties.id = throwingPrimitive('first ID');
  second.properties.id = throwingPrimitive('second ID');

  assert.deepEqual(
    results.groupRankedInterventions([first, second]),
    [{
      id: 'extend_hours',
      items: [first, second],
    }],
  );
});

test('action labels degrade a proxy-valued action to an empty label', () => {
  const candidate = intervention('hostile-action');
  candidate.properties.action = throwingPrimitive('action');

  assert.equal(results.getActionLabel(candidate), '');
});

test('search ignores a proxy-valued action without coercing it', () => {
  const candidate = intervention('hostile-action', {
    name: 'Neutral candidate',
  });
  candidate.properties.action = throwingPrimitive('action');

  assert.deepEqual(
    results.searchFg03Results([candidate], 'verify'),
    [],
  );
});

test('presentation helpers isolate a feature with a throwing properties accessor', () => {
  const malformed = {
    get properties() {
      throw new Error('broken properties');
    },
  };
  const valid = facility('valid', { name: 'Valid washroom' });
  const inheritedSource = facility('inherited', { source: '__proto__' });

  assert.equal(results.getAccessDisclosure(malformed), null);
  assert.equal(results.getSourceLabel(malformed), '');
  assert.equal(results.getActionLabel(malformed), '');
  assert.equal(results.getSourceLabel(inheritedSource), '');
  assert.deepEqual(
    results
      .searchFg03Results([malformed, valid], 'valid')
      .map((feature) => feature.properties.id),
    ['valid'],
  );
  assert.deepEqual(results.reconcileFg03Selection('valid', [malformed, valid]), {
    selectedId: 'valid',
    invalidated: false,
  });
});
