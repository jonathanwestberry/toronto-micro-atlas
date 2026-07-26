import assert from 'node:assert/strict';
import test from 'node:test';

import { trackAtlasEvent } from '../src/scripts/atlas-events.mjs';

class TestCustomEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
}

function installTestWindow({ plausible } = {}) {
  const previousWindow = globalThis.window;
  const target = new EventTarget();
  target.CustomEvent = TestCustomEvent;
  if (plausible) {
    target.plausible = plausible;
  }
  globalThis.window = target;

  return () => {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  };
}

function captureEvents(target) {
  const details = [];
  target.addEventListener('tma:analytics', (event) => {
    details.push(event.detail);
  });
  return details;
}

test('every allowed event dispatches the same sanitized payload to both analytics bridges', async (t) => {
  const cases = [
    ['fg03_entry', { state_shape: 'mapped' }],
    ['fg03_engage', { surface: 'results' }],
    ['fg03_time_change', { time: '0030' }],
    ['fg03_access_change', { access: 'rider' }],
    ['fg03_walk_change', { walk: '500' }],
    ['fg03_action_change', { action: 'retrofit' }],
    ['fg03_search_use', { result_bucket: '6-20' }],
    [
      'fg03_feature_select',
      { kind: 'intervention', source: 'search', action: 'verify' },
    ],
    ['fg03_method_view', { section: 'limitations' }],
    ['fg03_data_download', { asset: 'phase2' }],
    ['fg03_share', { method: 'clipboard', state_shape: 'selected' }],
    ['fg03_series_navigation', { destination: 'guide-02' }],
    ['fg03_error', { stage: 'map', kind: 'webgl' }],
    ['fg03_journey_complete', { outcome: 'share' }],
  ];

  for (const [name, properties] of cases) {
    await t.test(name, async () => {
      const plausibleCalls = [];
      const restore = installTestWindow({
        plausible: (...args) => plausibleCalls.push(args),
      });

      try {
        const details = captureEvents(globalThis.window);
        trackAtlasEvent(name, properties);

        assert.deepEqual(details, [{ name, properties }]);
        assert.deepEqual(plausibleCalls, [[name, { props: properties }]]);
      } finally {
        restore();
      }
    });
  }
});

test('unknown event names produce no browser or Plausible side effects', () => {
  const plausibleCalls = [];
  let browserEvents = 0;
  const restore = installTestWindow({
    plausible: (...args) => plausibleCalls.push(args),
  });
  globalThis.window.addEventListener('tma:analytics', () => {
    browserEvents += 1;
  });

  try {
    trackAtlasEvent('fg03_pointer_move', {
      longitude: -79.38,
      latitude: 43.65,
    });

    assert.equal(browserEvents, 0);
    assert.deepEqual(plausibleCalls, []);
  } finally {
    restore();
  }
});

test('invalid and sensitive properties are dropped individually without mutating input', async () => {
  const input = {
    kind: 'facility',
    source: 'map',
    action: 'delete',
    query: 'private search',
    place: 'facility:abc',
    name: 'Selected washroom',
    address: '1 Example Street',
    url: 'https://example.test/private',
    referrer: 'https://example.test',
    longitude: -79.38,
    latitude: 43.65,
    coordinates: [-79.38, 43.65],
    pointer: { x: 12, y: 24 },
    error: new Error('private server detail'),
    stack: 'private stack',
    unknown: 'value',
  };
  const snapshot = {
    ...input,
    coordinates: [...input.coordinates],
    pointer: { ...input.pointer },
  };
  const restore = installTestWindow();

  try {
    const details = captureEvents(globalThis.window);
    trackAtlasEvent('fg03_feature_select', input);

    assert.deepEqual(details, [{
      name: 'fg03_feature_select',
      properties: {
        kind: 'facility',
        source: 'map',
      },
    }]);
    assert.deepEqual(input, snapshot);
  } finally {
    restore();
  }
});

test('invalid values cannot pass through an otherwise allowed property key', async () => {
  const restore = installTestWindow();

  try {
    const details = captureEvents(globalThis.window);
    trackAtlasEvent('fg03_share', {
      method: 'email',
      state_shape: 'selected',
    });

    assert.deepEqual(details, [{
      name: 'fg03_share',
      properties: { state_shape: 'selected' },
    }]);
  } finally {
    restore();
  }
});

test('browser listeners cannot inject properties into the Plausible payload', () => {
  const plausibleCalls = [];
  const restore = installTestWindow({
    plausible: (...args) => plausibleCalls.push(args),
  });
  globalThis.window.addEventListener('tma:analytics', (event) => {
    event.detail.properties.query = 'injected after sanitization';
  });

  try {
    trackAtlasEvent('fg03_entry', { state_shape: 'filtered' });

    assert.deepEqual(plausibleCalls, [[
      'fg03_entry',
      { props: { state_shape: 'filtered' } },
    ]]);
  } finally {
    restore();
  }
});

test('optional properties may be absent without blocking a valid event', async () => {
  const restore = installTestWindow();

  try {
    const details = captureEvents(globalThis.window);
    trackAtlasEvent('fg03_feature_select', {
      kind: 'facility',
      source: 'list',
    });

    assert.deepEqual(details, [{
      name: 'fg03_feature_select',
      properties: {
        kind: 'facility',
        source: 'list',
      },
    }]);
  } finally {
    restore();
  }
});

test('missing window and throwing Plausible callbacks never affect the interface or log', async () => {
  const previousWindow = globalThis.window;
  const previousError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  delete globalThis.window;

  try {
    assert.doesNotThrow(() => {
      trackAtlasEvent('fg03_entry', { state_shape: 'default' });
    });

    const restore = installTestWindow({
      plausible: () => {
        throw new Error('analytics unavailable');
      },
    });
    try {
      const details = captureEvents(globalThis.window);
      assert.doesNotThrow(() => {
        trackAtlasEvent('fg03_entry', { state_shape: 'filtered' });
      });
      assert.deepEqual(details, [{
        name: 'fg03_entry',
        properties: { state_shape: 'filtered' },
      }]);
    } finally {
      restore();
    }

    assert.deepEqual(logged, []);
  } finally {
    console.error = previousError;
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});
