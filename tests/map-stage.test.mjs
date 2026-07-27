import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Exercises the real MapStage against a fake DOM rather than an extracted copy
 * of its logic, so the gesture gate, the status vocabulary, and the focus
 * behaviour are tested as they actually ship.
 */

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

class FakeEvents {
  listeners = new Map();

  addEventListener(type, listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  count(type) {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type, target: this, ...event });
    }
  }
}

class FakeEl extends FakeEvents {
  attributes = new Map();
  dataset = {};
  hidden = false;
  textContent = '';
  focused = false;
  children = [];
  #registry;

  constructor(registry = new Map()) {
    super();
    this.#registry = registry;
  }

  register(selector, el) {
    this.#registry.set(selector, el);
    this.children.push(el);
    el.parent = this;
    return el;
  }

  querySelector(selector) {
    return this.#registry.get(selector) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  focus() {
    this.focused = true;
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child === node || child.contains?.(node));
  }
}

class FakeMap {
  calls = [];
  center = { lng: -79.3832, lat: 43.6532 };
  zoom = 12;
  handlers = new Map();

  #handle(name) {
    return {
      enable: () => this.calls.push(`${name}:enable`),
      disable: () => this.calls.push(`${name}:disable`),
    };
  }

  scrollZoom = this.#handle('scrollZoom');
  dragPan = this.#handle('dragPan');
  touchZoomRotate = this.#handle('touchZoomRotate');

  getCenter() { return this.center; }
  getZoom() { return this.zoom; }
  resize() { this.calls.push('resize'); }

  on(type, listener) {
    const set = this.handlers.get(type) ?? new Set();
    set.add(listener);
    this.handlers.set(type, set);
  }

  off(type, listener) {
    this.handlers.get(type)?.delete(listener);
  }

  emit(type) {
    for (const listener of this.handlers.get(type) ?? []) listener();
  }

  /** Latest state of a gesture handler: true = enabled. */
  state(name) {
    const last = [...this.calls].reverse().find((c) => c.startsWith(`${name}:`));
    return last === undefined ? null : last.endsWith(':enable');
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let MapStage;

function setup({ coarse = false, expanded = false, search = '', withBack = false } = {}) {
  const doc = new FakeEvents();
  doc.querySelector = () => null;
  globalThis.document = doc;
  globalThis.window = {
    matchMedia: (query) => ({ matches: coarse && query.includes('pointer') }),
    location: { search, assign(href) { this.assigned = href; } },
  };

  const root = new FakeEl();
  const hint = root.register('[data-map-hint]', new FakeEl());
  const status = root.register('[data-map-status]', new FakeEl());
  const statusText = new FakeEl();
  status.register('[data-map-status-text]', statusText);
  const howtoToggle = root.register('[data-map-howto-toggle]', new FakeEl());
  const howtoPanel = root.register('[data-map-howto]', new FakeEl());
  const howtoClose = new FakeEl();
  howtoPanel.register('[data-map-howto-close]', howtoClose);
  const expandLink = root.register('[data-map-expand]', new FakeEl());
  const retry = root.register('[data-map-retry]', new FakeEl());
  const canvas = root.register('[data-map-canvas]', new FakeEl());
  const back = withBack ? root.register('[data-map-back]', new FakeEl()) : null;
  if (back) back.href = '/guides/sidewalk-forest/';

  const map = new FakeMap();
  return {
    doc, root, hint, status, statusText, howtoToggle, howtoPanel, howtoClose,
    expandLink, retry, canvas, back, map,
    els: { expanded },
  };
}

function build(fixture, options = {}) {
  return new MapStage({
    root: fixture.root,
    map: fixture.map,
    expandPath: '/guides/sidewalk-forest/map',
    ...options,
  }).init();
}

test.before(async () => {
  ({ MapStage } = await import('../src/scripts/map-stage.ts'));
});

// ---------------------------------------------------------------------------
// The gesture gate — the replacement for cooperative gestures
// ---------------------------------------------------------------------------

test('embedded on a trackpad: scroll-zoom waits, panning does not', () => {
  const f = setup();
  build(f);
  assert.equal(f.map.state('scrollZoom'), false, 'scroll-zoom must not steal the page scroll');
  assert.equal(f.map.state('dragPan'), true, 'dragging a canvas with a mouse was never ambiguous');
  assert.equal(f.root.dataset.mapActive, 'false');
});

test('embedded on touch: one-finger drag and pinch wait too', () => {
  const f = setup({ coarse: true });
  build(f);
  assert.equal(f.map.state('scrollZoom'), false);
  assert.equal(f.map.state('dragPan'), false, 'a one-finger drag is also a page scroll');
  assert.equal(f.map.state('touchZoomRotate'), false);
});

test('a pointer down on the stage hands over every gesture', () => {
  const f = setup();
  const stage = build(f);
  f.root.dispatch('pointerdown');
  assert.equal(stage.isActive(), true);
  assert.equal(f.map.state('scrollZoom'), true);
  assert.equal(f.root.dataset.mapActive, 'true');
});

test('using the chrome does not hand over the map', () => {
  const f = setup();
  const stage = build(f);
  const chrome = new FakeEl();
  chrome.closest = (sel) => (sel === '[data-map-chrome]' ? chrome : null);
  f.root.dispatch('pointerdown', { target: chrome });
  assert.equal(
    stage.isActive(),
    false,
    'asking how to read the map is not asking to drive it',
  );
});

test('Enter activates for keyboard readers', () => {
  const f = setup();
  const stage = build(f);
  f.root.dispatch('keydown', { key: 'Enter' });
  assert.equal(stage.isActive(), true);
});

test('Escape releases the map', () => {
  const f = setup();
  const stage = build(f);
  f.root.dispatch('pointerdown');
  assert.equal(stage.isActive(), true);
  f.doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(stage.isActive(), false);
  assert.equal(f.map.state('scrollZoom'), false);
});

test('interacting elsewhere on the page keeps the map armed', () => {
  const f = setup();
  const stage = build(f);
  f.root.dispatch('pointerdown');
  f.doc.dispatch('pointerdown', { target: new FakeEl() });
  assert.equal(
    stage.isActive(),
    true,
    'fg03 keeps its result list outside this root, so clicking a result must not disarm the map',
  );
});

test('a pointer down inside the stage does not release it', () => {
  const f = setup();
  const stage = build(f);
  f.root.dispatch('pointerdown');
  f.doc.dispatch('pointerdown', { target: f.canvas });
  assert.equal(stage.isActive(), true);
});

test('the hint says what is available and changes once the reader takes over', () => {
  const f = setup();
  const stage = build(f);
  assert.equal(f.hint.textContent, 'Click the map to zoom and pan');
  assert.equal(f.hint.dataset.mapHintState, 'idle');
  stage.activate();
  assert.match(f.hint.textContent, /Scroll to zoom/);
  assert.equal(f.hint.dataset.mapHintState, 'active');
});

test('the hint speaks touch on touch devices', () => {
  const f = setup({ coarse: true });
  const stage = build(f);
  assert.equal(f.hint.textContent, 'Tap the map to zoom and pan');
  stage.activate();
  assert.match(f.hint.textContent, /Pinch to zoom/);
});

// ---------------------------------------------------------------------------
// The expanded route
// ---------------------------------------------------------------------------

test('the expanded route arms every gesture up front and hides the hint', () => {
  const f = setup();
  const stage = build(f, { expanded: true, expandPath: undefined });
  // It used to assert no calls at all and inherit MapLibre's defaults. Silence
  // is not a contract: it says the route works only as long as nothing upstream
  // ever disables a gesture. The route now states what it wants.
  assert.deepEqual(
    f.map.calls,
    ['scrollZoom:enable', 'dragPan:enable', 'touchZoomRotate:enable'],
    'the map owns the viewport, so it asks for the gestures rather than assuming them',
  );
  assert.equal(f.hint.hasAttribute('hidden'), true);
  assert.equal(f.root.dataset.mapStageMode, 'expanded');
  assert.equal(f.root.dataset.mapActive, 'true');
  assert.equal(stage.isActive(), true, 'the expanded route is always live');
});

test('Escape on the expanded route follows the back link', () => {
  const f = setup({ withBack: true });
  build(f, { expanded: true, expandPath: undefined });
  f.doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(globalThis.window.location.assigned, '/guides/sidewalk-forest/');
});

test('focusMap sends a keyboard reader into the map, not the top of the document', () => {
  const f = setup();
  const stage = build(f, { expanded: true, expandPath: undefined });
  stage.focusMap();
  assert.equal(f.canvas.focused, true);
  assert.equal(f.canvas.getAttribute('tabindex'), '-1');
});

// ---------------------------------------------------------------------------
// "How to read this map" — the control the ⓘ was pretending to be
// ---------------------------------------------------------------------------

test('the disclosure starts closed and reports its state', () => {
  const f = setup();
  build(f);
  assert.equal(f.howtoToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(f.howtoPanel.hidden, true);
});

test('the toggle opens and closes the panel', () => {
  const f = setup();
  build(f);
  f.howtoToggle.dispatch('click');
  assert.equal(f.howtoToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(f.howtoPanel.hidden, false);
  f.howtoToggle.dispatch('click');
  assert.equal(f.howtoToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(f.howtoPanel.hidden, true);
});

test('closing returns focus to the toggle', () => {
  const f = setup();
  build(f);
  f.howtoToggle.dispatch('click');
  f.howtoClose.dispatch('click');
  assert.equal(f.howtoPanel.hidden, true);
  assert.equal(f.howtoToggle.focused, true);
});

test('Escape closes the panel before it releases the map', () => {
  const f = setup();
  const stage = build(f);
  stage.activate();
  f.howtoToggle.dispatch('click');
  f.doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(f.howtoPanel.hidden, true, 'the innermost thing closes first');
  assert.equal(stage.isActive(), true, 'the map is not released by the same keypress');
  f.doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(stage.isActive(), false);
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test('loading is the state the stage starts in', () => {
  const f = setup();
  const stage = build(f);
  stage.setState('loading');
  assert.equal(f.status.hidden, false);
  assert.equal(f.statusText.textContent, 'Loading the map');
  assert.equal(f.retry.hidden, true);
  assert.equal(f.status.getAttribute('role'), 'status');
});

test('ready clears the status layer', () => {
  const f = setup();
  const stage = build(f);
  stage.setState('ready');
  assert.equal(f.status.hidden, true);
  assert.equal(f.root.dataset.mapState, 'ready');
});

test('a failed load says so, interrupts, and offers a way out', () => {
  const f = setup();
  const stage = build(f);
  stage.setState('error');
  assert.equal(f.status.hidden, false);
  assert.equal(f.status.getAttribute('role'), 'alert');
  assert.equal(f.status.getAttribute('aria-live'), 'assertive');
  assert.equal(f.retry.hidden, false);
  assert.match(f.statusText.textContent, /could not be loaded/);
  assert.match(f.statusText.textContent, /listed below the map/, 'names the fallback');
});

test('empty is a real state, not a blank rectangle', () => {
  const f = setup();
  const stage = build(f);
  stage.setState('empty');
  assert.equal(f.status.hidden, false);
  assert.match(f.statusText.textContent, /Nothing to show/);
  assert.equal(f.retry.hidden, true);
});

test('partial reports the gap without taking the map away', () => {
  const f = setup();
  const stage = build(f);
  stage.setState('partial');
  assert.equal(f.status.hidden, false);
  assert.equal(
    f.status.dataset.mapStatusCovering,
    'false',
    'a map missing one context layer is still worth looking at',
  );
  assert.equal(f.status.getAttribute('role'), 'status', 'not worth interrupting for');
  assert.equal(f.retry.hidden, false, 'the missing layers are still retryable');
  assert.match(f.statusText.textContent, /What you can see is accurate/);
});

test('only the states with nothing underneath cover the canvas', () => {
  const f = setup();
  const stage = build(f);
  for (const [state, covering] of [
    ['loading', 'true'],
    ['empty', 'true'],
    ['error', 'true'],
    ['partial', 'false'],
  ]) {
    stage.setState(state);
    assert.equal(f.status.dataset.mapStatusCovering, covering, `state ${state}`);
  }
});

test('a caller can override the message', () => {
  const f = setup();
  const stage = build(f);
  stage.setState('error', 'The tree inventory did not load.');
  assert.equal(f.statusText.textContent, 'The tree inventory did not load.');
});

test('retry returns to loading and calls back exactly once', () => {
  const f = setup();
  let retries = 0;
  const stage = build(f, { onRetry: () => { retries += 1; } });
  stage.setState('error');
  f.retry.dispatch('click');
  assert.equal(retries, 1);
  assert.equal(stage.getState(), 'loading');
  assert.equal(f.retry.hidden, true);
});

// ---------------------------------------------------------------------------
// The expand link
// ---------------------------------------------------------------------------

test('the expand href points at what the reader is looking at', () => {
  const f = setup();
  build(f);
  assert.equal(
    f.expandLink.getAttribute('href'),
    '/guides/sidewalk-forest/map?map=-79.38320%2C43.65320%2C12.00',
  );
});

test('the href follows the camera as the reader moves', () => {
  const f = setup();
  build(f);
  f.map.center = { lng: -79.4, lat: 43.7 };
  f.map.zoom = 15.5;
  f.map.emit('moveend');
  assert.match(f.expandLink.getAttribute('href'), /map=-79\.40000%2C43\.70000%2C15\.50/);
});

test('expanding preserves the guide state already in the URL', () => {
  const f = setup({ search: '?place=cedarvale' });
  build(f);
  const href = f.expandLink.getAttribute('href');
  const params = new URLSearchParams(href.split('?')[1]);
  assert.equal(params.get('place'), 'cedarvale', 'expanding must not silently reset the selection');
  assert.equal(params.get('map'), '-79.38320,43.65320,12.00');
});

test('destroy unhooks the map and the document', () => {
  const f = setup();
  const stage = build(f);
  assert.ok(f.doc.count('keydown') > 0);
  stage.destroy();
  assert.equal(f.doc.count('keydown'), 0);
  assert.equal(f.doc.count('pointerdown'), 0);
  assert.equal(f.map.handlers.get('moveend').size, 0);
});
