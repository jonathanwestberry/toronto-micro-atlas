import assert from 'node:assert/strict';
import test from 'node:test';

const mapModule = await import('../src/scripts/fg03-map-core.mjs').catch(() => ({}));

class FakeEventTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, target: this, ...event });
    }
  }
}

class FakeNode extends FakeEventTarget {
  attributes = new Map();
  children = [];
  parentNode = null;
  tagName;
  #text = '';

  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  set innerHTML(_value) {
    throw new Error('Unsafe innerHTML assignment');
  }

  get textContent() {
    return this.#text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.#text = String(value ?? '');
    this.children = [];
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  findAll(tagName) {
    const expected = tagName.toUpperCase();
    return [
      ...(this.tagName === expected ? [this] : []),
      ...this.children.flatMap((child) => child.findAll(tagName)),
    ];
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeNode(tagName);
  }
}

function facilityFeature(overrides = {}) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [-79.38, 43.65],
    },
    properties: {
      accessCondition: 'fare_paid',
      accessibility: 'accessible',
      address: '100 Queen Street West',
      auditStatus: 'valid',
      closureCategory: 'scheduled',
      hours: 'Daily until 2 a.m.',
      id: 'facility:city-hall',
      name: '<img src=x onerror=alert(1)>',
      primaryRank: 2,
      source: 'ttc',
      sourceUrl: 'javascript:alert(1)',
      stability: 'robust',
      ...overrides,
    },
  };
}

test('near-viewport loading waits for intersection or meaningful interaction and starts once', async () => {
  let observerCallback;
  let observerOptions;
  let observedTarget;
  let disconnects = 0;
  let starts = 0;
  const target = new FakeEventTarget();
  const interactionTarget = new FakeEventTarget();
  const createLoader = mapModule.createFg03DeferredLoader;

  assert.equal(typeof createLoader, 'function');
  const loader = createLoader({
    target,
    interactionTarget,
    start: async () => {
      starts += 1;
    },
    createObserver(callback, options) {
      observerCallback = callback;
      observerOptions = options;
      return {
        observe(candidate) {
          observedTarget = candidate;
        },
        disconnect() {
          disconnects += 1;
        },
      };
    },
  });

  assert.equal(starts, 0);
  assert.equal(observedTarget, target);
  assert.equal(observerOptions.rootMargin, '700px 0px');
  observerCallback([{ isIntersecting: false }]);
  assert.equal(starts, 0);

  interactionTarget.dispatch('change');
  await loader.promise;
  assert.equal(starts, 1);
  observerCallback([{ isIntersecting: true }]);
  interactionTarget.dispatch('click');
  assert.equal(starts, 1);
  assert.equal(disconnects, 1);

  loader.cleanup();
  loader.cleanup();
  assert.equal(disconnects, 1);
});

test('manifest loads first and every dependent source settles independently', async () => {
  const calls = [];
  let releaseManifest;
  const manifestReady = new Promise((resolve) => {
    releaseManifest = resolve;
  });
  const manifest = {
    files: {
      facilities: '/data/fg03/facilities.geojson',
      interventions: '/data/fg03/interventions.geojson',
      stops2200: '/data/fg03/stops-2200.geojson',
    },
    gate: { passed: true },
    snapshotDate: '2026-07-21',
  };
  const values = new Map([
    ['/data/fg03/interventions.geojson', { type: 'FeatureCollection', features: [] }],
    ['/data/fg03/stops-2200.geojson', { type: 'FeatureCollection', features: [] }],
    ['/data/toronto-boundary.geojson', { type: 'FeatureCollection', features: [] }],
    ['/data/lake-ontario.geojson', { type: 'FeatureCollection', features: [] }],
    ['/data/watercourses.geojson', { type: 'FeatureCollection', features: [] }],
    ['/data/streets-major.geojson', { type: 'FeatureCollection', features: [] }],
    ['/data/streets-minor.geojson', { type: 'FeatureCollection', features: [] }],
    ['/data/rail.geojson', { type: 'FeatureCollection', features: [] }],
    ['/data/outside-mask.geojson', { type: 'FeatureCollection', features: [] }],
  ]);

  const loading = mapModule.loadFg03Data({
    manifestUrl: '/data/fg03/manifest.json',
    snapshot: '2200',
    contextFiles: {
      boundary: '/data/toronto-boundary.geojson',
      lake: '/data/lake-ontario.geojson',
      water: '/data/watercourses.geojson',
      majorStreets: '/data/streets-major.geojson',
      minorStreets: '/data/streets-minor.geojson',
      rail: '/data/rail.geojson',
      outside: '/data/outside-mask.geojson',
      labels: '/data/orientation-labels.geojson',
    },
    async fetchJson(url) {
      calls.push(url);
      if (url === '/data/fg03/manifest.json') {
        await manifestReady;
        return manifest;
      }
      if (url === '/data/fg03/facilities.geojson') {
        throw new Error('facilities unavailable');
      }
      if (url === '/data/orientation-labels.geojson') {
        throw new Error('labels unavailable');
      }
      return values.get(url);
    },
  });

  await Promise.resolve();
  assert.deepEqual(calls, ['/data/fg03/manifest.json']);
  releaseManifest();
  const loaded = await loading;

  assert.equal(loaded.manifest, manifest);
  assert.equal(loaded.resources.facilities.status, 'rejected');
  assert.equal(loaded.resources.interventions.status, 'fulfilled');
  assert.equal(loaded.resources.stops.status, 'fulfilled');
  assert.equal(loaded.resources.context.boundary.status, 'fulfilled');
  assert.equal(loaded.resources.context.labels.status, 'rejected');
  assert.deepEqual(
    new Set(calls.slice(1)),
    new Set([
      '/data/fg03/facilities.geojson',
      '/data/fg03/interventions.geojson',
      '/data/fg03/stops-2200.geojson',
      '/data/toronto-boundary.geojson',
      '/data/lake-ontario.geojson',
      '/data/watercourses.geojson',
      '/data/streets-major.geojson',
      '/data/streets-minor.geojson',
      '/data/rail.geojson',
      '/data/outside-mask.geojson',
      '/data/orientation-labels.geojson',
    ]),
  );
});

test('a failed manifest gate withholds every dependent request', async () => {
  const calls = [];
  const manifest = {
    files: {
      facilities: '/data/fg03/facilities.geojson',
      interventions: '/data/fg03/interventions.geojson',
      stops2200: '/data/fg03/stops-2200.geojson',
    },
    gate: {
      passed: false,
      reason: 'audit failed',
    },
    snapshotDate: '2026-07-21',
  };

  const loaded = await mapModule.loadFg03Data({
    manifestUrl: '/data/fg03/manifest.json',
    snapshot: '2200',
    contextFiles: {
      boundary: '/data/toronto-boundary.geojson',
    },
    async fetchJson(url) {
      calls.push(url);
      if (url !== '/data/fg03/manifest.json') {
        throw new Error(`Unexpected dependent request: ${url}`);
      }
      return manifest;
    },
  });

  assert.equal(loaded.manifest, manifest);
  assert.equal(loaded.resources, null);
  assert.deepEqual(calls, ['/data/fg03/manifest.json']);
});

test('operational layers expose complete, ordered, non-color-only map semantics', () => {
  const buildLayers = mapModule.createFg03OperationalLayers;

  assert.equal(typeof buildLayers, 'function');
  const layers = buildLayers();
  const ids = layers.map((layer) => layer.id);

  assert.deepEqual(ids, [
    'fg03-reach',
    'fg03-stops-uncovered',
    'fg03-stops-unknown',
    'fg03-stops-covered',
    'fg03-facilities-unrestricted',
    'fg03-facilities-fare-paid',
    'fg03-facilities-unknown',
    'fg03-interventions',
    'fg03-selected-halo',
  ]);
  assert.equal(layers.at(-1).id, 'fg03-selected-halo');
  assert.notDeepEqual(
    layers.find((layer) => layer.id === 'fg03-stops-covered').paint,
    layers.find((layer) => layer.id === 'fg03-stops-uncovered').paint,
  );
  assert.match(
    JSON.stringify(layers.find((layer) => layer.id === 'fg03-stops-unknown')),
    /unknown|missing/i,
  );
  assert.notEqual(
    layers
      .find((layer) => layer.id === 'fg03-facilities-fare-paid')
      .layout['icon-image'],
    layers
      .find((layer) => layer.id === 'fg03-interventions')
      .layout['icon-image'][7],
  );
});

test('initial runtime reconciliation cleans the URL and hydrates a direct selection', async () => {
  const calls = [];
  const selectedId = 'extend-hours:library:MD';
  const initialize = mapModule.initializeFg03RuntimeState;

  assert.equal(typeof initialize, 'function');
  const state = await initialize({
    search:
      `?time=2200&time=2200&unknown=x&place=${encodeURIComponent(selectedId)}`,
    validPlaceIds: new Set([selectedId]),
    applyState(nextState, cause) {
      calls.push(['state', cause, nextState]);
    },
    async loadReach(nextState) {
      calls.push(['reach', nextState.place]);
    },
    applyCameraState() {
      calls.push(['camera']);
    },
    centerSelection({ animate }) {
      calls.push(['center', animate]);
    },
  });

  assert.equal(state.place, selectedId);
  assert.equal(state.map, null);
  assert.deepEqual(calls, [
    ['state', 'initial-cleanup', state],
    ['reach', selectedId],
    ['center', false],
  ]);
});

test('initial runtime reconciliation returns the action-compatible state', async () => {
  const calls = [];
  const selectedId = 'extend-hours:library:DP';
  const initialize = mapModule.initializeFg03RuntimeState;

  const state = await initialize({
    search: `?action=new&place=${encodeURIComponent(selectedId)}`,
    validPlaceIds: new Set([selectedId]),
    applyState(nextState, cause) {
      calls.push(['state', cause, nextState.place]);
      return { ...nextState, place: null };
    },
    async loadReach(nextState) {
      calls.push(['reach', nextState.place]);
    },
    applyCameraState() {
      calls.push(['camera']);
    },
    centerSelection() {
      calls.push(['center']);
    },
  });

  assert.equal(state.action, 'new');
  assert.equal(state.place, null);
  assert.deepEqual(calls, [
    ['state', 'data-load', selectedId],
  ]);
});

test('an explicit map view wins over direct-selection centring', async () => {
  const calls = [];
  const selectedId = 'extend-hours:library:MD';
  const initialize = mapModule.initializeFg03RuntimeState;
  const state = await initialize({
    search:
      `?place=${encodeURIComponent(selectedId)}`
      + '&map=-79.380000,43.650000,14.000',
    validPlaceIds: new Set([selectedId]),
    applyState(nextState, cause) {
      calls.push(['state', cause, nextState]);
    },
    async loadReach(nextState) {
      calls.push(['reach', nextState.place]);
    },
    applyCameraState(nextState) {
      calls.push(['camera', nextState.map]);
    },
    centerSelection() {
      calls.push(['center']);
    },
  });

  assert.deepEqual(calls, [
    ['state', 'initial-cleanup', state],
    ['reach', selectedId],
    ['camera', [-79.38, 43.65, 14]],
  ]);
});

test('map symbols keep unknown conditions and retrofit actions distinct without color', () => {
  const recipes = new Map(
    mapModule.FG03_SYMBOL_RECIPES.map(([name, shape]) => [name, shape]),
  );

  assert.equal(recipes.get('fg03-unknown'), 'cross');
  assert.equal(recipes.get('fg03-retrofit'), 'plus');
  assert.notEqual(
    recipes.get('fg03-unknown'),
    recipes.get('fg03-retrofit'),
  );
});

test('map retry removes a failed instance and never duplicates a healthy instance', async () => {
  let mapExists = false;
  let healthy = false;
  let starts = 0;
  let destroys = 0;
  const starter = mapModule.createFg03MapStartController({
    hasMap: () => mapExists,
    isHealthy: () => healthy,
    destroy() {
      destroys += 1;
      mapExists = false;
      healthy = false;
    },
    async start() {
      starts += 1;
      mapExists = true;
      if (starts === 1) {
        throw new Error('partial map startup');
      }
      healthy = true;
    },
  });

  await assert.rejects(starter.start, /partial map startup/);
  await starter.start();
  await starter.start();

  assert.equal(starts, 2);
  assert.equal(destroys, 1);
  assert.equal(mapExists, true);
  assert.equal(healthy, true);
});

test('failed gate replacement removes the explorer and marks the runtime withheld', () => {
  const calls = [];
  const root = { dataset: { fg03GateStatus: 'passed' } };
  const controls = {
    inert: false,
    setAttribute(name, value) {
      calls.push(['controls-attribute', name, value]);
    },
  };
  const mapElement = {
    inert: false,
    tabIndex: 0,
    setAttribute(name, value) {
      calls.push(['map-attribute', name, value]);
    },
  };
  const replacement = { kind: 'failed-gate' };
  const explorer = {
    replaceWith(node) {
      calls.push(['replace', node]);
    },
  };
  const template = {
    content: {
      cloneNode(deep) {
        calls.push(['clone', deep]);
        return replacement;
      },
    },
  };

  mapModule.withholdFg03Explorer({
    controls,
    destroyMap() {
      calls.push(['destroy-map']);
    },
    explorer,
    mapElement,
    root,
    template,
  });

  assert.equal(root.dataset.fg03GateStatus, 'failed');
  assert.equal(controls.inert, true);
  assert.equal(mapElement.inert, true);
  assert.equal(mapElement.tabIndex, -1);
  assert.deepEqual(calls, [
    ['controls-attribute', 'aria-disabled', 'true'],
    ['map-attribute', 'aria-disabled', 'true'],
    ['destroy-map'],
    ['clone', true],
    ['replace', replacement],
  ]);
});

test('close focus prefers the connected opener and falls back only after replacement', () => {
  const mapOpener = { isConnected: true, kind: 'map' };
  const detachedListOpener = { isConnected: false, kind: 'old-list-button' };
  const replacement = { isConnected: true, kind: 'new-list-button' };
  const chooseFocus = mapModule.chooseFg03CloseFocus;

  assert.equal(chooseFocus(mapOpener, replacement), mapOpener);
  assert.equal(chooseFocus(detachedListOpener, replacement), replacement);
  assert.equal(chooseFocus(null, replacement), replacement);
  assert.equal(chooseFocus(detachedListOpener, null), null);
});

test('status and result-label helpers name the counting grain and zoom threshold', () => {
  const status = mapModule.formatFg03Status({
    action: 'open',
    access: 'public',
    count: 332,
    time: '1200',
    walk: 400,
  });

  assert.equal(
    status,
    'Showing 332 current open facility records for Noon, public access, and a 400 m walk.',
  );
  assert.equal(mapModule.shouldShowFg03ResultLabels(13.49), false);
  assert.equal(mapModule.shouldShowFg03ResultLabels(13.5), true);
  assert.equal(mapModule.shouldShowFg03ResultLabels(Number.NaN), false);
});

test('state transitions keep history intent and make popstate a silent replay', () => {
  const current = {
    time: '2200',
    access: 'public',
    walk: 400,
    action: 'extend',
    place: null,
    map: null,
  };

  const control = mapModule.reduceFg03Transition(current, {
    cause: 'time-change',
    patch: { time: '0030' },
  });
  assert.deepEqual(control.state, { ...current, time: '0030' });
  assert.equal(control.history, 'push');
  assert.deepEqual(control.analytics, {
    name: 'fg03_time_change',
    properties: { time: '0030' },
  });
  assert.equal(control.focusDetail, false);
  assert.equal(control.animateMap, false);

  const selection = mapModule.reduceFg03Transition(control.state, {
    cause: 'selection',
    patch: { place: 'intervention:42' },
    selection: {
      action: 'extend',
      kind: 'intervention',
      source: 'list',
    },
  });
  assert.equal(selection.history, 'push');
  assert.equal(selection.focusDetail, true);
  assert.equal(selection.animateMap, true);
  assert.deepEqual(selection.analytics, {
    name: 'fg03_feature_select',
    properties: {
      action: 'extend',
      kind: 'intervention',
      source: 'list',
    },
  });
  assert.doesNotMatch(JSON.stringify(selection.analytics), /intervention:42/);

  const replay = mapModule.reduceFg03Transition(selection.state, {
    cause: 'popstate',
    nextState: current,
  });
  assert.equal(replay.history, 'none');
  assert.equal(replay.analytics, null);
  assert.equal(replay.focusDetail, false);
  assert.equal(replay.animateMap, false);

  const invalidation = mapModule.reduceFg03Transition(selection.state, {
    cause: 'search-invalidation',
    patch: { place: null },
  });
  assert.equal(invalidation.history, 'replace');
  assert.equal(invalidation.analytics, null);

  assert.equal(
    mapModule.getFg03InvalidationCause('data-load'),
    'search-invalidation',
  );
  assert.equal(
    mapModule.getFg03InvalidationCause('initial-cleanup'),
    'search-invalidation',
  );
  assert.equal(
    mapModule.getFg03InvalidationCause('action-change'),
    'action-change',
  );
});

test('history writes preserve Astro state while serializing only FG03 state', () => {
  const calls = [];
  const history = {
    state: {
      astro: { index: 7 },
      unrelated: 'keep',
    },
    pushState(...args) {
      calls.push(['push', ...args]);
    },
    replaceState(...args) {
      calls.push(['replace', ...args]);
    },
  };
  const state = {
    time: '0030',
    access: 'public',
    walk: 400,
    action: 'extend',
    place: null,
    map: null,
  };

  mapModule.writeFg03History({
    effect: 'push',
    history,
    location: {
      hash: '#explorer',
      pathname: '/guides/when-toronto-has-to-go/',
    },
    state,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'push');
  assert.deepEqual(calls[0][1], {
    astro: { index: 7 },
    unrelated: 'keep',
    fg03: state,
  });
  assert.equal(
    calls[0][3],
    '/guides/when-toronto-has-to-go/?time=0030#explorer',
  );
});

test('public data renders as text and unsafe source links never become hrefs', () => {
  const document = new FakeDocument();
  const unsafeRow = mapModule.renderFg03ResultItem({
    document,
    feature: facilityFeature(),
    metrics: {
      activeStops: 8,
      uniqueRoutes: 3,
      uniqueTrips: 21,
    },
  });

  assert.match(unsafeRow.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(unsafeRow.textContent, /Fare-paid area/);
  assert.match(unsafeRow.textContent, /Daily until 2 a\.m\./);
  assert.match(unsafeRow.textContent, /scheduled/i);
  assert.match(unsafeRow.textContent, /robust/i);
  assert.match(unsafeRow.textContent, /valid/i);
  assert.match(unsafeRow.textContent, /21/);
  assert.equal(unsafeRow.findAll('a').length, 0);

  const safeRow = mapModule.renderFg03ResultItem({
    document,
    feature: facilityFeature({
      id: 'facility:safe',
      name: 'Safe facility',
      sourceUrl: 'https://www.ttc.ca/example',
    }),
    metrics: null,
  });
  assert.equal(
    safeRow.findAll('a')[0]?.getAttribute('href'),
    'https://www.ttc.ca/example',
  );
  assert.equal(mapModule.safeFg03Href('/data/fg03/file.geojson'), '/data/fg03/file.geojson');
  assert.equal(mapModule.safeFg03Href('//evil.example/file'), null);
  assert.equal(mapModule.safeFg03Href('http://example.com/file'), null);
  assert.equal(mapModule.safeFg03Href('javascript:alert(1)'), null);
});

test('cleanup is idempotent across network, observer, timers, listeners, and WebGL', () => {
  const calls = [];
  const controller = new AbortController();
  const cleanup = mapModule.createFg03Cleanup({
    controller,
    observer: {
      disconnect() {
        calls.push('disconnect');
      },
    },
    timers: new Set([11, 12]),
    animationFrames: new Set([21]),
    removeListeners: [
      () => calls.push('listener-a'),
      () => calls.push('listener-b'),
    ],
    clearTimer(id) {
      calls.push(`timer-${id}`);
    },
    cancelFrame(id) {
      calls.push(`frame-${id}`);
    },
    getMap() {
      return {
        stop() {
          calls.push('stop');
        },
        remove() {
          calls.push('remove');
        },
      };
    },
  });

  cleanup();
  cleanup();

  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(calls, [
    'disconnect',
    'timer-11',
    'timer-12',
    'frame-21',
    'listener-a',
    'listener-b',
    'stop',
    'remove',
  ]);
});

test('persistent lifecycle mounts once per visit and cleans before every swap', async () => {
  const events = new FakeEventTarget();
  let onGuide = true;
  let mounts = 0;
  let cleanups = 0;
  const controller = mapModule.createFg03LifecycleController({
    eventTarget: events,
    shouldMount: () => onGuide,
    async init() {
      mounts += 1;
      return () => {
        cleanups += 1;
      };
    },
  });

  controller.start();
  await Promise.resolve();
  events.dispatch('astro:page-load');
  await Promise.resolve();
  assert.equal(mounts, 1);

  onGuide = false;
  events.dispatch('astro:before-swap');
  assert.equal(cleanups, 1);
  events.dispatch('astro:page-load');
  await Promise.resolve();
  assert.equal(mounts, 1);

  onGuide = true;
  events.dispatch('astro:page-load');
  await Promise.resolve();
  assert.equal(mounts, 2);
  controller.dispose();
  assert.equal(cleanups, 2);
  events.dispatch('astro:page-load');
  await Promise.resolve();
  assert.equal(mounts, 2);
});
