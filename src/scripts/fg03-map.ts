import { trackAtlasEvent } from './atlas-events.mjs';
import { createMapStage, type MapStage } from './map-stage';
import {
  DEFAULT_FG03_STATE,
  parseFg03State,
  stateEquals,
} from './fg03-state.mjs';
import {
  collectFg03ResultIds,
  deriveFg03Results,
  getMatchingQueryCell,
} from './fg03-results.mjs';
import {
  applyFg03InteractiveReadiness,
  chooseFg03CloseFocus,
  createFg03Cleanup,
  createFg03DeferredLoader,
  createFg03LifecycleController,
  createFg03MapStartController,
  createFg03OperationalLayers,
  FG03_CONTEXT_FILES,
  FG03_SYMBOL_RECIPES,
  formatFg03Status,
  getFg03InvalidationCause,
  initializeFg03RuntimeState,
  loadFg03Data,
  reduceFg03Transition,
  renderFg03ResultItem,
  safeFg03Href,
  shouldShowFg03ResultLabels,
  withholdFg03Explorer,
  writeFg03History,
} from './fg03-map-core.mjs';

export {
  applyFg03InteractiveReadiness,
  chooseFg03CloseFocus,
  createFg03Cleanup,
  createFg03DeferredLoader,
  createFg03LifecycleController,
  createFg03MapStartController,
  createFg03OperationalLayers,
  FG03_CONTEXT_FILES,
  FG03_SYMBOL_RECIPES,
  formatFg03Status,
  getFg03InvalidationCause,
  initializeFg03RuntimeState,
  loadFg03Data,
  reduceFg03Transition,
  renderFg03ResultItem,
  safeFg03Href,
  shouldShowFg03ResultLabels,
  withholdFg03Explorer,
  writeFg03History,
} from './fg03-map-core.mjs';

type Snapshot = '1200' | '2030' | '2200' | '0030';
type Access = 'public' | 'rider';
type Action = 'open' | 'extend' | 'new' | 'verify' | 'retrofit';

interface Fg03State {
  time: Snapshot;
  access: Access;
  walk: 300 | 400 | 500;
  action: Action;
  place: string | null;
  map: [number, number, number] | null;
}

interface GeoJsonFeature {
  type: 'Feature';
  id?: string | number;
  geometry: {
    type: string;
    coordinates: unknown;
  };
  properties: Record<string, unknown>;
}

interface GeoJsonCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

interface Fg03Manifest {
  files: Record<string, string>;
  gate: {
    passed: boolean;
    reason?: string;
  };
  snapshotDate: string;
}

interface Fg03Config {
  defaultState?: Partial<Fg03State>;
  files?: Record<string, string>;
  gate?: {
    passed?: boolean;
    reason?: string;
  };
  manifestUrl?: string;
  snapshotDate?: string;
}

interface DerivedFg03Results {
  features: GeoJsonFeature[];
  groups: Array<{
    id: string;
    items: GeoJsonFeature[];
  }>;
  selectedId: string | null;
  selectionInvalidated: boolean;
}

interface Fg03Transition {
  state: Fg03State;
  history: 'push' | 'replace' | 'none';
  analytics: {
    name: string;
    properties: Record<string, string>;
  } | null;
  focusDetail: boolean;
  animateMap: boolean;
  restoreFocus: boolean;
}

const EMPTY_COLLECTION: GeoJsonCollection = Object.freeze({
  type: 'FeatureCollection',
  features: [],
});
const CITY_BOUNDS: [[number, number], [number, number]] = [
  [-79.6393, 43.581],
  [-79.1153, 43.8555],
];
const MAP_BOUNDS: [[number, number], [number, number]] = [
  [-79.98, 43.3],
  [-78.72, 44.12],
];
const TIME_LABELS: Record<Snapshot, string> = {
  '1200': 'Noon',
  '2030': '8:30 p.m.',
  '2200': '10 p.m.',
  '0030': '12:30 a.m.',
};
/** Plural, for counting: "Showing 10 audited extend-hours opportunities". */
const ACTION_LABELS: Record<Action, string> = {
  open: 'current open facility records',
  extend: 'audited extend-hours opportunities',
  new: 'audited new-facility zones',
  verify: 'audited information checks',
  retrofit: 'audited accessibility retrofits',
};
/** Singular, for one place: "Proposed change: Extend hours". */
const ACTION_LABELS_ONE: Record<Action, string> = {
  open: 'Currently open',
  extend: 'Extend hours',
  new: 'New facility zone',
  verify: 'Verify published information',
  retrofit: 'Accessibility retrofit',
};
/**
 * Dataset values written for a reader.
 *
 * The detail panel used to print these straight out of the GeoJSON, so a
 * reader got "unrestricted", "none" and "unknown" as answers to questions
 * they had asked in English. Every value below appears in the published
 * snapshot; anything unrecognised falls back to a "not published" phrasing
 * rather than leaking the raw token.
 */
const READER_LABELS: Record<string, Record<string, string>> = {
  access: {
    unrestricted: 'Open to anyone, no fare required',
    fare_paid: 'Inside the fare gates, valid fare required',
    unknown: 'Access condition not published',
  },
  closure: {
    none: 'No closure recorded',
    construction: 'Closed for construction',
    temporary: 'Temporarily closed',
    seasonal: 'Closed for the season',
  },
  accessibility: {
    accessible: 'Step-free access recorded',
    inaccessible: 'No step-free access recorded',
    unknown: 'Not published',
  },
  stability: {
    robust: 'Holds up under the robustness rules',
  },
  audit: {
    valid: 'Checked by hand against the source',
  },
};
const MAP_MAX_ZOOM = 18.5;
const STALE_AFTER_DAYS = 45;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type MlMap = import('maplibre-gl').Map;
type MlModule = typeof import('maplibre-gl');
const deriveResults = deriveFg03Results as unknown as (options: {
  facilities: GeoJsonCollection;
  interventions: GeoJsonCollection;
  state: Fg03State;
  search?: string;
}) => DerivedFg03Results;
const reduceTransition = reduceFg03Transition as unknown as (
  current: Fg03State,
  input: {
    cause: string;
    patch?: Partial<Fg03State>;
    nextState?: Fg03State;
    selection?: {
      action: Action;
      kind: 'facility' | 'intervention';
      source: 'map' | 'list' | 'search';
    };
  },
) => Fg03Transition;
const makeDeferredLoader = createFg03DeferredLoader as unknown as (options: {
  target: EventTarget;
  interactionTarget: EventTarget;
  start: () => Promise<unknown>;
  createObserver?: (
    callback: IntersectionObserverCallback,
    options: IntersectionObserverInit,
  ) => Pick<IntersectionObserver, 'observe' | 'disconnect'>;
}) => {
  start: () => Promise<unknown>;
  promise: Promise<unknown>;
  cleanup: () => void;
};
const makeCleanup = createFg03Cleanup as unknown as (options: {
  controller: AbortController;
  observer?: Pick<IntersectionObserver, 'disconnect'> | null;
  timers?: Set<number>;
  animationFrames?: Set<number>;
  removeListeners?: Array<() => void>;
  clearTimer?: (id: number) => void;
  cancelFrame?: (id: number) => void;
  getMap?: () => Pick<MlMap, 'stop' | 'remove'> | null;
}) => () => void;
const makeLifecycleController = createFg03LifecycleController as unknown as (
  options: {
    eventTarget: Pick<Document, 'addEventListener' | 'removeEventListener'>;
    shouldMount: () => boolean;
    init: () => Promise<() => void>;
  },
) => {
  start: () => void;
  dispose: () => void;
};
const buildOperationalLayers = createFg03OperationalLayers as unknown as (
  () => import('maplibre-gl').LayerSpecification[]
);
const makeMapStartController = createFg03MapStartController as unknown as (
  options: {
    hasMap: () => boolean;
    isHealthy: () => boolean;
    destroy: () => void;
    start: () => Promise<void>;
  },
) => {
  start: () => Promise<void>;
};
const initializeRuntimeState = initializeFg03RuntimeState as unknown as (
  options: {
    search: string;
    validPlaceIds?: Set<string>;
    applyState: (state: Fg03State, cause: string) => Fg03State;
    loadReach: (state: Fg03State) => Promise<void>;
    applyCameraState: (state: Fg03State) => void;
    centerSelection: (options: { animate: boolean; state: Fg03State }) => void;
  },
) => Promise<Fg03State>;
const formatStatus = formatFg03Status as unknown as (
  options: {
    action: Action;
    access: Access;
    count: number;
    time: Snapshot;
    walk: 300 | 400 | 500;
  },
) => string;
const showResultLabels = shouldShowFg03ResultLabels as unknown as (
  zoom: number,
) => boolean;
const chooseCloseFocus = chooseFg03CloseFocus as unknown as (
  opener: HTMLElement | null,
  replacement: HTMLElement | null,
) => HTMLElement | null;
const withholdExplorer = withholdFg03Explorer as unknown as (
  options: {
    controls: HTMLFormElement;
    destroyMap: () => void;
    explorer: HTMLElement;
    mapElement: HTMLElement;
    root: HTMLElement;
    template: HTMLTemplateElement;
  },
) => void;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asCollection(value: unknown): GeoJsonCollection {
  const source = asRecord(value);
  return source?.type === 'FeatureCollection' && Array.isArray(source.features)
    ? (value as GeoJsonCollection)
    : EMPTY_COLLECTION;
}

function featureProperties(feature: unknown): Record<string, unknown> {
  return asRecord(asRecord(feature)?.properties) ?? {};
}

function featureId(feature: unknown): string | null {
  const id = featureProperties(feature).id;
  return typeof id === 'string' && SAFE_ID.test(id) ? id : null;
}

function sourceValue<T>(
  result: PromiseSettledResult<T> | undefined,
  fallback: T,
): T {
  return result?.status === 'fulfilled' ? result.value : fallback;
}

function isReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function hasWebGlSupport(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      canvas.getContext('webgl2')
      || canvas.getContext('webgl'),
    );
  } catch {
    return false;
  }
}

function eventKind(error: unknown): string {
  if (!navigator.onLine) {
    return 'offline';
  }
  const record = asRecord(error);
  const explicit = record?.fg03Kind;
  if (
    typeof explicit === 'string'
    && [
      'network',
      'http',
      'parse',
      'invalid_data',
      'webgl',
      'unsupported',
      'unknown',
    ].includes(explicit)
  ) {
    return explicit;
  }
  if (error instanceof TypeError) {
    return 'network';
  }
  return 'unknown';
}

function addListener(
  removers: Array<() => void>,
  target: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions | boolean,
): void {
  target.addEventListener(type, listener, options);
  removers.push(() => target.removeEventListener(type, listener, options));
}

function dataUrlForSnapshot(
  manifest: Fg03Manifest,
  snapshot: Snapshot,
): string | null {
  return safeFg03Href(manifest.files[`stops${snapshot}`]);
}

function stateShape(state: Fg03State): string {
  if (state.place !== null) {
    return 'selected';
  }
  if (state.map !== null) {
    return 'mapped';
  }
  return stateEquals(state, DEFAULT_FG03_STATE) ? 'default' : 'filtered';
}

function resultBucket(count: number): string {
  if (count === 0) {
    return '0';
  }
  if (count <= 5) {
    return '1-5';
  }
  if (count <= 20) {
    return '6-20';
  }
  return '21+';
}

function isStale(snapshotDate: string): boolean {
  const timestamp = Date.parse(`${snapshotDate}T00:00:00Z`);
  return Number.isFinite(timestamp)
    && Date.now() - timestamp > STALE_AFTER_DAYS * 86_400_000;
}

function ensureGeoJsonSource(
  map: MlMap,
  id: string,
  data: GeoJsonCollection,
): void {
  const existing = map.getSource(id) as import('maplibre-gl').GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data as GeoJSON.FeatureCollection);
    return;
  }
  map.addSource(id, {
    type: 'geojson',
    data: data as GeoJSON.FeatureCollection,
  });
}

function addLayerOnce(
  map: MlMap,
  layer: import('maplibre-gl').LayerSpecification,
  beforeId?: string,
): void {
  if (!map.getLayer(layer.id)) {
    map.addLayer(layer, beforeId && map.getLayer(beforeId) ? beforeId : undefined);
  }
}

function addContextLayers(
  map: MlMap,
  context: Record<string, GeoJsonCollection>,
): void {
  const beforeResults = map.getLayer('fg03-reach') ? 'fg03-reach' : undefined;
  const add = (
    key: string,
    sourceId: string,
    layer: import('maplibre-gl').LayerSpecification,
  ): void => {
    const collection = context[key];
    if (!collection || collection.features.length === 0) {
      return;
    }
    ensureGeoJsonSource(map, sourceId, collection);
    addLayerOnce(map, layer, beforeResults);
  };

  add('outside', 'fg03-context-outside', {
    id: 'fg03-context-outside',
    type: 'fill',
    source: 'fg03-context-outside',
    paint: {
      'fill-color': '#e6deca',
      'fill-opacity': 0.9,
    },
  });
  add('lake', 'fg03-context-lake', {
    id: 'fg03-context-lake',
    type: 'fill',
    source: 'fg03-context-lake',
    paint: {
      'fill-color': '#d7e3e1',
      'fill-opacity': 0.92,
    },
  });
  add('minorStreets', 'fg03-context-minor', {
    id: 'fg03-context-minor',
    type: 'line',
    source: 'fg03-context-minor',
    minzoom: 10.5,
    paint: {
      'line-color': '#d3c9b6',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10.5, 0.35, 16, 1.15],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 10.5, 0.28, 15, 0.7],
    },
  });
  add('water', 'fg03-context-water', {
    id: 'fg03-context-water',
    type: 'line',
    source: 'fg03-context-water',
    paint: {
      'line-color': '#9bb5b5',
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.4, 16, 1.8],
      'line-opacity': 0.68,
    },
  });
  add('majorStreets', 'fg03-context-major', {
    id: 'fg03-context-major',
    type: 'line',
    source: 'fg03-context-major',
    paint: {
      'line-color': '#b9ad99',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.45, 16, 2.4],
      'line-opacity': 0.78,
    },
  });
  add('rail', 'fg03-context-rail', {
    id: 'fg03-context-rail',
    type: 'line',
    source: 'fg03-context-rail',
    paint: {
      'line-color': '#746d65',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 16, 1.5],
      'line-opacity': 0.55,
      'line-dasharray': [3, 2],
    },
  });
  add('boundary', 'fg03-context-boundary', {
    id: 'fg03-context-boundary',
    type: 'line',
    source: 'fg03-context-boundary',
    paint: {
      'line-color': '#1a1f2a',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.1, 15, 2],
      'line-opacity': 0.82,
    },
  });
}

type SymbolShape = 'square' | 'triangle' | 'diamond' | 'cross' | 'plus';

function createMapSymbol(
  shape: SymbolShape,
  fill: string,
  stroke: string,
): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = 40;
  canvas.height = 40;
  const context = canvas.getContext('2d');
  if (!context) {
    return new ImageData(40, 40);
  }
  context.scale(2, 2);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.lineWidth = 2;
  context.strokeStyle = stroke;
  context.fillStyle = fill;
  context.beginPath();
  if (shape === 'square') {
    context.rect(4, 4, 12, 12);
  } else if (shape === 'triangle') {
    context.moveTo(10, 2.5);
    context.lineTo(17.5, 16.5);
    context.lineTo(2.5, 16.5);
    context.closePath();
  } else if (shape === 'diamond') {
    context.moveTo(10, 2);
    context.lineTo(18, 10);
    context.lineTo(10, 18);
    context.lineTo(2, 10);
    context.closePath();
  } else if (shape === 'cross') {
    context.moveTo(4, 4);
    context.lineTo(16, 16);
    context.moveTo(16, 4);
    context.lineTo(4, 16);
  } else {
    context.moveTo(10, 3);
    context.lineTo(10, 17);
    context.moveTo(3, 10);
    context.lineTo(17, 10);
  }
  if (shape !== 'cross' && shape !== 'plus') {
    context.fill();
  }
  context.stroke();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function addShapeImages(map: MlMap): void {
  const shapes = FG03_SYMBOL_RECIPES as ReadonlyArray<
    readonly [string, SymbolShape, string, string]
  >;
  for (const [name, shape, fill, stroke] of shapes) {
    if (!map.hasImage(name)) {
      map.addImage(name, createMapSymbol(shape, fill, stroke), {
        pixelRatio: 2,
      });
    }
  }
}

function addOperationalLayers(map: MlMap): void {
  for (const source of [
    'fg03-reach',
    'fg03-stops',
    'fg03-facilities',
    'fg03-interventions',
    'fg03-selected',
  ]) {
    ensureGeoJsonSource(map, source, EMPTY_COLLECTION);
  }

  for (const layer of buildOperationalLayers()) {
    addLayerOnce(map, layer);
  }
}

function updateStopFilters(map: MlMap, state: Fg03State): void {
  const access = state.access === 'rider' ? 'rider_conditional' : 'public';
  const coverage = [
    'get',
    String(state.walk),
    ['get', access, ['get', 'coverage']],
  ] as import('maplibre-gl').ExpressionSpecification;
  const covered = [
    '==',
    coverage,
    true,
  ] as import('maplibre-gl').FilterSpecification;
  const uncovered = [
    '==',
    coverage,
    false,
  ] as import('maplibre-gl').FilterSpecification;
  const unknown = [
    'all',
    ['!=', coverage, true],
    ['!=', coverage, false],
  ] as import('maplibre-gl').FilterSpecification;
  if (map.getLayer('fg03-stops-covered')) {
    map.setFilter('fg03-stops-covered', covered);
  }
  if (map.getLayer('fg03-stops-uncovered')) {
    map.setFilter('fg03-stops-uncovered', uncovered);
  }
  if (map.getLayer('fg03-stops-unknown')) {
    map.setFilter('fg03-stops-unknown', unknown);
  }
}

function addOrientationLabels(
  maplibre: MlModule,
  map: MlMap,
  labels: GeoJsonCollection,
): import('maplibre-gl').Marker[] {
  const allowed = new Set([
    'Lake Ontario',
    'Downtown',
    'Etobicoke',
    'Scarborough',
    'North York',
    'Don Valley',
    'Humber River',
  ]);
  const markers: import('maplibre-gl').Marker[] = [];
  for (const feature of labels.features) {
    const properties = featureProperties(feature);
    const name = properties.name;
    const coordinates = feature.geometry.coordinates;
    if (
      typeof name !== 'string'
      || !allowed.has(name)
      || !Array.isArray(coordinates)
      || coordinates.length < 2
      || typeof coordinates[0] !== 'number'
      || typeof coordinates[1] !== 'number'
    ) {
      continue;
    }
    const label = document.createElement('span');
    label.textContent = name;
    label.setAttribute('aria-hidden', 'true');
    label.style.color = '#5f5b54';
    label.style.fontFamily = 'var(--fg03-ui)';
    label.style.fontSize = '11px';
    label.style.fontWeight = '650';
    label.style.letterSpacing = '0.04em';
    label.style.pointerEvents = 'none';
    label.style.textShadow = '0 1px 0 #f3eddd, 1px 0 0 #f3eddd';
    markers.push(
      new maplibre.Marker({ element: label, anchor: 'center' })
        .setLngLat([coordinates[0], coordinates[1]])
        .addTo(map),
    );
  }
  return markers;
}

function addResultLabels(
  maplibre: MlModule,
  map: MlMap,
  features: GeoJsonFeature[],
): import('maplibre-gl').Marker[] {
  if (!showResultLabels(map.getZoom())) {
    return [];
  }
  const markers: import('maplibre-gl').Marker[] = [];
  for (const feature of features.slice(0, 40)) {
    const properties = featureProperties(feature);
    const coordinates = feature.geometry.coordinates;
    if (
      !Array.isArray(coordinates)
      || coordinates.length < 2
      || typeof coordinates[0] !== 'number'
      || typeof coordinates[1] !== 'number'
    ) {
      continue;
    }
    const label = document.createElement('span');
    label.setAttribute('data-fg03-map-result-label', '');
    label.setAttribute('aria-hidden', 'true');
    label.textContent = typeof properties.name === 'string'
      && properties.name.trim() !== ''
      ? properties.name.trim()
      : 'Name unavailable';
    label.style.background = 'rgba(243, 237, 221, 0.94)';
    label.style.border = '1px solid #8f8678';
    label.style.borderRadius = '2px';
    label.style.color = '#1a1f2a';
    label.style.fontFamily = 'var(--fg03-ui)';
    label.style.fontSize = '10px';
    label.style.fontWeight = '650';
    label.style.lineHeight = '1.2';
    label.style.maxWidth = '10rem';
    label.style.overflow = 'hidden';
    label.style.padding = '2px 4px';
    label.style.pointerEvents = 'none';
    label.style.textOverflow = 'ellipsis';
    label.style.whiteSpace = 'nowrap';
    markers.push(
      new maplibre.Marker({ element: label, anchor: 'bottom', offset: [0, -10] })
        .setLngLat([coordinates[0], coordinates[1]])
        .addTo(map),
    );
  }
  return markers;
}

async function fetchGeoJson(
  url: unknown,
  signal: AbortSignal,
): Promise<GeoJsonCollection> {
  const safeUrl = safeFg03Href(url);
  if (safeUrl === null) {
    throw Object.assign(new TypeError('Invalid FG03 data path'), {
      fg03Kind: 'invalid_data',
    });
  }
  const response = await fetch(safeUrl, {
    headers: { Accept: 'application/geo+json, application/json' },
    signal,
  });
  if (!response.ok) {
    throw Object.assign(new Error('FG03 request failed'), {
      fg03Kind: 'http',
    });
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw Object.assign(new TypeError('FG03 response was not JSON'), {
      fg03Kind: 'parse',
    });
  }
  const collection = asCollection(value);
  if (collection === EMPTY_COLLECTION && value !== EMPTY_COLLECTION) {
    throw Object.assign(new TypeError('FG03 response was not GeoJSON'), {
      fg03Kind: 'invalid_data',
    });
  }
  return collection;
}

function configuredDefault(config: Fg03Config): Fg03State {
  const candidate = config.defaultState ?? {};
  const time = ['1200', '2030', '2200', '0030'].includes(String(candidate.time))
    ? candidate.time as Snapshot
    : DEFAULT_FG03_STATE.time;
  const access = candidate.access === 'rider' || candidate.access === 'public'
    ? candidate.access
    : DEFAULT_FG03_STATE.access;
  const walk = [300, 400, 500].includes(Number(candidate.walk))
    ? Number(candidate.walk) as 300 | 400 | 500
    : DEFAULT_FG03_STATE.walk;
  const action = ['open', 'extend', 'new', 'verify', 'retrofit'].includes(
    String(candidate.action),
  )
    ? candidate.action as Action
    : DEFAULT_FG03_STATE.action;
  return {
    time,
    access,
    walk,
    action,
    place: null,
    map: null,
  };
}

const activeMounts = new WeakMap<HTMLElement, () => void>();

export async function initWhenTorontoHasToGo(): Promise<() => void> {
  const root = document.querySelector<HTMLElement>('[data-fg03-root]');
  if (!root) {
    return () => {};
  }
  const existing = activeMounts.get(root);
  if (existing) {
    return existing;
  }

  const controls = root.querySelector<HTMLFormElement>('[data-fg03-controls]');
  const mapShell = root.querySelector<HTMLElement>('[data-fg03-map-shell]');
  const mapElement = root.querySelector<HTMLElement>('[data-fg03-map]');
  const configElement = root.querySelector<HTMLScriptElement>('[data-fg03-config]');
  if (!controls || !mapShell || !mapElement || !configElement) {
    return () => {};
  }
  const mountedRoot = root;

  let config: Fg03Config;
  try {
    config = JSON.parse(configElement.textContent ?? '{}') as Fg03Config;
  } catch {
    return () => {};
  }
  if (config.gate?.passed === false || root.dataset.fg03GateStatus === 'failed') {
    return () => {};
  }

  const controller = new AbortController();
  const timers = new Set<number>();
  const animationFrames = new Set<number>();
  const removeListeners: Array<() => void> = [];
  const defaultState = configuredDefault(config);
  let currentState = parseFg03State(
    window.location.search,
    undefined,
  ) as Fg03State;
  let currentSearch = '';
  let currentFeatures: GeoJsonFeature[] = [];
  let facilities = EMPTY_COLLECTION;
  let interventions = EMPTY_COLLECTION;
  let context: Record<string, GeoJsonCollection> = {};
  let manifest: Fg03Manifest | null = null;
  let dataReady = false;
  let validPlaceIds: Set<string> | undefined;
  let map: MlMap | null = null;
  let maplibre: MlModule | null = null;
  let mapStyleReady = false;
  let mapStage: MapStage | null = null;

  // The expanded route renders the same root with this flag set, so one script
  // drives both the in-page map and /guides/when-toronto-has-to-go/map.
  const isExpandedRoute = root.dataset.fg03Expanded === 'true';
  const withBase = (path: string): string => {
    const raw = import.meta.env.BASE_URL;
    const prefix = raw.endsWith('/') ? raw : `${raw}/`;
    return `${prefix}${path}`.replace(/\/{2,}/g, '/');
  };
  let dataLoadPromise: Promise<void> | null = null;
  let disposed = false;
  let gateWithheld = false;
  let suppressCameraHistory = false;
  let lastSelectionOpener: HTMLElement | null = null;
  /** Where the current selection came from. Decides whether the detail panel
      has to bring itself into view: see renderDetail. */
  let lastSelectionSource: 'map' | 'list' | 'search' | null = null;
  let searchAnalyticsTimer = 0;
  let loadSequence = 0;
  let deferredLoader: ReturnType<typeof makeDeferredLoader> | null = null;
  const stopsByTime = new Map<Snapshot, GeoJsonCollection>();
  const stopsRequests = new Map<Snapshot, Promise<GeoJsonCollection>>();
  const reachCache = new Map<string, GeoJsonCollection>();
  const orientationMarkers: import('maplibre-gl').Marker[] = [];
  const resultLabelMarkers: import('maplibre-gl').Marker[] = [];

  const explorer = root.querySelector<HTMLElement>('[data-fg03-gate="passed"]');
  const failedGateTemplate = root.querySelector<HTMLTemplateElement>(
    '[data-fg03-gate-failed-template]',
  );
  const resultsRoot = root.querySelector<HTMLElement>('[data-fg03-results]');
  const standardGroup = root.querySelector<HTMLElement>(
    '[data-fg03-results-group="standard"]',
  );
  const standardList = root.querySelector<HTMLOListElement>('[data-fg03-result-list]');
  const hoursGroup = root.querySelector<HTMLElement>(
    '[data-fg03-verify-group="hours"]',
  );
  const hoursList = root.querySelector<HTMLOListElement>(
    '[data-fg03-verify-list="hours"]',
  );
  const accessibilityGroup = root.querySelector<HTMLElement>(
    '[data-fg03-verify-group="accessibility"]',
  );
  const accessibilityList = root.querySelector<HTMLOListElement>(
    '[data-fg03-verify-list="accessibility"]',
  );
  const resultsCount = root.querySelector<HTMLElement>('[data-fg03-results-count]');
  const resultsHeading = resultsRoot?.querySelector<HTMLElement>(
    '.fg03-results-header h3',
  ) ?? null;
  const status = root.querySelector<HTMLElement>('[data-fg03-status]');
  const alert = root.querySelector<HTMLElement>('[data-fg03-alert]');
  const alertMessage = root.querySelector<HTMLElement>('[data-fg03-alert-message]');
  const retryButton = root.querySelector<HTMLButtonElement>('[data-fg03-retry]');
  const searchInput = root.querySelector<HTMLInputElement>('[data-fg03-search]');
  const clearSearchButton = root.querySelector<HTMLButtonElement>(
    '[data-fg03-clear-search]',
  );
  const resetButton = root.querySelector<HTMLButtonElement>('[data-fg03-reset]');
  const shareButton = root.querySelector<HTMLButtonElement>('[data-fg03-share]');
  const detail = root.querySelector<HTMLElement>('[data-fg03-detail]');
  const detailTitle = root.querySelector<HTMLElement>('#fg03-detail-title');
  const detailBody = root.querySelector<HTMLElement>('[data-fg03-detail-body]');
  const closeDetail = root.querySelector<HTMLButtonElement>(
    '[data-fg03-close-detail]',
  );

  const showState = (name: string, visible: boolean): void => {
    const element = root.querySelector<HTMLElement>(
      `[data-fg03-state="${name}"]`,
    );
    if (element) {
      element.hidden = !visible;
    }
  };

  const showAlert = (message: string | null): void => {
    if (!alert || !alertMessage) {
      return;
    }
    alert.hidden = message === null;
    if (message !== null) {
      alertMessage.textContent = message;
    }
  };

  const reportError = (stage: string, error: unknown): void => {
    const safeStage = [
      'manifest',
      'facilities',
      'snapshot',
      'interventions',
      'stops',
      'map',
      'share',
      'explorer',
    ].includes(stage)
      ? stage
      : 'explorer';
    trackAtlasEvent('fg03_error', {
      stage: safeStage,
      kind: eventKind(error),
    });
  };

  const setTimer = (callback: () => void, delay: number): number => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      callback();
    }, delay);
    timers.add(id);
    return id;
  };

  const destroyMap = (): void => {
    for (const marker of orientationMarkers) {
      marker.remove();
    }
    orientationMarkers.length = 0;
    for (const marker of resultLabelMarkers) {
      marker.remove();
    }
    resultLabelMarkers.length = 0;
    mapStyleReady = false;
    try {
      map?.stop();
    } catch {
      // A partially initialized map may not have a usable render loop.
    }
    try {
      map?.remove();
    } catch {
      // A partially initialized map may already have removed its container.
    }
    map = null;
    delete mapElement.dataset.ready;
  };

  const syncInteractiveReadiness = (): void => {
    applyFg03InteractiveReadiness({
      controls,
      dataReady,
      gateWithheld,
      mapElement,
      mapReady: map !== null && mapStyleReady,
    });
  };

  const updateControls = (): void => {
    for (const input of controls.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    )) {
      const value = input.name === 'walk'
        ? Number(input.value)
        : input.value;
      input.checked = currentState[input.name as keyof Fg03State] === value;
    }
    if (searchInput) {
      searchInput.value = currentSearch;
    }
    if (clearSearchButton) {
      clearSearchButton.disabled = currentSearch === '';
    }
  };

  /**
   * What one row in the list actually is. Open washrooms are facility records
   * from the city's datasets; everything else is an audited proposal.
   */
  const countedUnit = (action: Action, count: number): string => {
    if (action === 'open') {
      return count === 1 ? 'facility record' : 'facility records';
    }
    return count === 1 ? 'proposed place' : 'proposed places';
  };

  const statusText = (count: number): string => {
    return formatStatus({
      action: currentState.action,
      access: currentState.access,
      count,
      time: currentState.time,
      walk: currentState.walk,
    });
  };

  const findVisibleFeature = (id: string | null): GeoJsonFeature | null => (
    id === null
      ? null
      : currentFeatures.find((feature) => featureId(feature) === id) ?? null
  );

  const metricsFor = (feature: GeoJsonFeature): {
    activeStops: number;
    uniqueRoutes: number;
    uniqueTrips: number;
  } | null => {
    const cell = getMatchingQueryCell(feature, currentState);
    return cell
      ? {
          activeStops: Number(cell.activeStops) || 0,
          uniqueRoutes: Number(cell.uniqueRoutes) || 0,
          uniqueTrips: Number(cell.uniqueTrips) || 0,
        }
      : null;
  };

  const sourceForFeature = (feature: GeoJsonFeature): string | null => (
    safeFg03Href(featureProperties(feature).sourceUrl)
  );

  const renderDetail = (
    feature: GeoJsonFeature | null,
    focus: boolean,
  ): void => {
    if (!detail || !detailTitle || !detailBody || !closeDetail) {
      return;
    }
    detailBody.replaceChildren();
    if (!feature) {
      detailTitle.textContent = 'Choose a ranked place';
      const paragraph = document.createElement('p');
      paragraph.textContent =
        'Select Show on map to connect one result to its location and walking reach.';
      detailBody.append(paragraph);
      closeDetail.disabled = true;
      return;
    }

    const properties = featureProperties(feature);
    detailTitle.textContent =
      typeof properties.name === 'string' ? properties.name : 'Selected place';
    const evidence = document.createElement('dl');
    // This row used to print the raw action id, so a reader who clicked a
    // square got the single word "extend": a conclusion, with nothing saying
    // it was a conclusion. It reads as a property of the washroom when it is
    // an argument about the washroom. Name the kind of thing first, then the
    // proposal, and only then the facts underneath it.
    const rawAction = String(properties.action ?? 'open');
    const isProposal = rawAction !== 'open';
    const actionLabel = ACTION_LABELS_ONE[rawAction as Action] ?? rawAction;
    const rows: Array<[string, string]> = [
      isProposal
        ? ['What this is', 'A change I am proposing here, not an open washroom']
        : ['What this is', 'A washroom recorded as open at the selected time'],
    ];
    if (isProposal) {
      rows.push(['Proposed change', actionLabel]);
    }
    rows.push(
      ['Access', READER_LABELS.access[String(properties.accessCondition)]
        ?? 'Access condition not published'],
      ['Hours', String(properties.hours ?? 'Not published')],
      ['Closure', READER_LABELS.closure[String(properties.closureCategory)]
        ?? 'Not classified'],
      ['Accessibility', READER_LABELS.accessibility[String(properties.accessibility)]
        ?? 'Not published'],
      ['Stability', READER_LABELS.stability[String(properties.stability)]
        ?? 'Not evaluated'],
      ['Audit', READER_LABELS.audit[String(properties.auditStatus)]
        ?? 'Not applicable'],
    );
    const metrics = metricsFor(feature);
    if (metrics) {
      rows.push(
        ['GTFS stops and platforms', metrics.activeStops.toLocaleString('en-CA')],
        ['Scheduled trips', metrics.uniqueTrips.toLocaleString('en-CA')],
        ['Routes', metrics.uniqueRoutes.toLocaleString('en-CA')],
      );
    }
    for (const [term, value] of rows) {
      const wrapper = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = term;
      dd.textContent = value;
      wrapper.append(dt, dd);
      evidence.append(wrapper);
    }
    detailBody.append(evidence);

    const source = sourceForFeature(feature);
    if (source) {
      const link = document.createElement('a');
      link.setAttribute('href', source);
      link.setAttribute('rel', 'noopener noreferrer');
      link.textContent = 'Open the official source';
      detailBody.append(link);
    }
    closeDetail.disabled = false;
    if (focus) {
      // preventScroll is right when the reader picked the place from the list:
      // the panel is already beside the row they clicked and a jump would be
      // noise. It is wrong when the click came from the map, because the panel
      // can be a full column away, off-screen. That combination made a marker
      // click look like it did nothing at all: the record rendered, took focus,
      // and never came into view, so the only way to read a place was to scroll
      // the results column by hand until something looked highlighted.
      const cameFromMap = lastSelectionSource === 'map';
      detailTitle.focus({ preventScroll: true });
      if (cameFromMap) {
        detail.scrollIntoView({
          block: 'nearest',
          behavior: isReducedMotion() ? 'auto' : 'smooth',
        });
      }
    }
  };

  const selectFromList = (
    id: string,
    opener: HTMLButtonElement,
  ): void => {
    lastSelectionOpener = opener;
    const feature = currentFeatures.find((candidate) => featureId(candidate) === id);
    if (!feature) {
      return;
    }
    const source = currentSearch === '' ? 'list' : 'search';
    applyInput({
      cause: 'selection',
      patch: { place: id },
      selection: {
        action: currentState.action,
        kind: currentState.action === 'open' ? 'facility' : 'intervention',
        source,
      },
    });
  };

  const renderResults = (
    result: DerivedFg03Results,
    focusDetail: boolean,
  ): void => {
    currentFeatures = result.features as GeoJsonFeature[];
    if (
      !standardList
      || !standardGroup
      || !hoursGroup
      || !hoursList
      || !accessibilityGroup
      || !accessibilityList
    ) {
      return;
    }
    standardList.replaceChildren();
    hoursList.replaceChildren();
    accessibilityList.replaceChildren();

    const groups = new Map<string, GeoJsonFeature[]>(
      result.groups.map((group: { id: string; items: GeoJsonFeature[] }) => [
        group.id,
        group.items,
      ]),
    );
    const hours = groups.get('verify-hours') ?? [];
    const accessibility = groups.get('verify-accessibility') ?? [];
    const standard = currentState.action === 'verify'
      ? currentFeatures.filter(
          (feature) => !hours.includes(feature) && !accessibility.includes(feature),
        )
      : currentFeatures;

    for (const feature of standard) {
      standardList.append(
        renderFg03ResultItem({
          document,
          feature,
          metrics: metricsFor(feature),
          selected: featureId(feature) === currentState.place,
          onSelect: selectFromList,
        }),
      );
    }
    for (const feature of hours) {
      hoursList.append(
        renderFg03ResultItem({
          document,
          feature,
          metrics: metricsFor(feature),
          selected: featureId(feature) === currentState.place,
          onSelect: selectFromList,
        }),
      );
    }
    for (const feature of accessibility) {
      accessibilityList.append(
        renderFg03ResultItem({
          document,
          feature,
          metrics: metricsFor(feature),
          selected: featureId(feature) === currentState.place,
          onSelect: selectFromList,
        }),
      );
    }

    standardGroup.hidden = standard.length === 0;
    hoursGroup.hidden = hours.length === 0;
    accessibilityGroup.hidden = accessibility.length === 0;
    if (resultsCount) {
      // "places" hid which grain was being counted. The proof above the
      // explorer counts unrestricted *access points*, which groups co-located
      // records: 324 at noon. This list counts facility *records*: 332 at the
      // same hour. Both are right and the page explains the difference, but
      // while the label said "places" the two numbers just looked wrong next
      // to each other. At 10 p.m. they both read 6, so nothing gave it away.
      resultsCount.textContent = `${currentFeatures.length.toLocaleString('en-CA')} ${
        countedUnit(currentState.action, currentFeatures.length)
      }`;
      resultsCount.setAttribute(
        'data-fg03-results-count',
        String(currentFeatures.length),
      );
    }
    if (resultsHeading) {
      resultsHeading.textContent = `${ACTION_LABELS[currentState.action]} at ${
        TIME_LABELS[currentState.time]
      }`;
    }
    if (status) {
      status.textContent = statusText(currentFeatures.length);
    }

    showState('empty', currentSearch === '' && currentFeatures.length === 0);
    showState('no-results', currentSearch !== '' && currentFeatures.length === 0);
    renderDetail(findVisibleFeature(currentState.place), focusDetail);
  };

  const selectedCollection = (): GeoJsonCollection => {
    const feature = findVisibleFeature(currentState.place);
    return feature
      ? { type: 'FeatureCollection', features: [feature] }
      : EMPTY_COLLECTION;
  };

  const reachForSelection = (): GeoJsonCollection => {
    const selected = currentState.place;
    if (!selected) {
      return EMPTY_COLLECTION;
    }
    const key = `${currentState.action === 'open' ? 'facilities' : 'promoted'}:${selected}`;
    const collection = reachCache.get(key);
    if (!collection) {
      return EMPTY_COLLECTION;
    }
    return {
      type: 'FeatureCollection',
      features: collection.features.filter(
        (feature) => featureProperties(feature).walk === currentState.walk,
      ),
    };
  };

  const syncResultLabels = (): void => {
    for (const marker of resultLabelMarkers) {
      marker.remove();
    }
    resultLabelMarkers.length = 0;
    if (!map || !maplibre || !mapStyleReady) {
      return;
    }
    resultLabelMarkers.push(
      ...addResultLabels(maplibre, map, currentFeatures),
    );
  };

  const syncMapData = (): void => {
    if (!map || !mapStyleReady) {
      return;
    }
    const open = currentState.action === 'open';
    ensureGeoJsonSource(
      map,
      'fg03-facilities',
      open
        ? { type: 'FeatureCollection', features: currentFeatures }
        : EMPTY_COLLECTION,
    );
    ensureGeoJsonSource(
      map,
      'fg03-interventions',
      open
        ? EMPTY_COLLECTION
        : { type: 'FeatureCollection', features: currentFeatures },
    );
    ensureGeoJsonSource(
      map,
      'fg03-stops',
      stopsByTime.get(currentState.time) ?? EMPTY_COLLECTION,
    );
    ensureGeoJsonSource(map, 'fg03-selected', selectedCollection());
    ensureGeoJsonSource(map, 'fg03-reach', reachForSelection());
    updateStopFilters(map, currentState);
    syncResultLabels();
  };

  const moveMapToSelection = (animate: boolean): void => {
    if (!map) {
      return;
    }
    const selected = findVisibleFeature(currentState.place);
    const coordinates = selected?.geometry.coordinates;
    if (
      !Array.isArray(coordinates)
      || coordinates.length < 2
      || typeof coordinates[0] !== 'number'
      || typeof coordinates[1] !== 'number'
    ) {
      return;
    }
    suppressCameraHistory = true;
    const camera = {
      center: [coordinates[0], coordinates[1]] as [number, number],
      zoom: Math.max(map.getZoom(), 14),
    };
    if (animate && !isReducedMotion()) {
      map.easeTo({ ...camera, duration: 700, essential: false });
    } else {
      map.jumpTo(camera);
    }
  };

  const applyCameraState = (state: Fg03State): void => {
    if (!map || state.map === null) {
      return;
    }
    suppressCameraHistory = true;
    map.jumpTo({
      center: [state.map[0], state.map[1]],
      zoom: state.map[2],
    });
  };

  const loadReach = async (): Promise<void> => {
    const selected = currentState.place;
    const selectedFeature = findVisibleFeature(selected);
    if (
      !manifest
      || !selected
      || !selectedFeature
      || featureProperties(selectedFeature).reachAvailable !== true
    ) {
      syncMapData();
      return;
    }
    const sourceType = currentState.action === 'open' ? 'facilities' : 'promoted';
    const key = `${sourceType}:${selected}`;
    if (reachCache.has(key)) {
      syncMapData();
      return;
    }
    const url = sourceType === 'facilities'
      ? manifest.files.reachFacilities
      : manifest.files.reachPromoted;
    try {
      const sidecar = await fetchGeoJson(url, controller.signal);
      if (disposed || currentState.place !== selected) {
        return;
      }
      const selectedReach: GeoJsonCollection = {
        type: 'FeatureCollection',
        features: sidecar.features.filter(
          (feature) => featureProperties(feature).placeId === selected,
        ),
      };
      reachCache.set(key, selectedReach);
      while (reachCache.size > 3) {
        const oldest = reachCache.keys().next().value as string | undefined;
        if (!oldest) {
          break;
        }
        reachCache.delete(oldest);
      }
      syncMapData();
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      showState('partial', true);
      showAlert(
        'The selected walking reach is unavailable. The ranked evidence remains usable.',
      );
      reportError('map', error);
    }
  };

  const ensureStops = async (snapshot: Snapshot): Promise<void> => {
    if (!manifest || stopsByTime.has(snapshot)) {
      return;
    }
    let pending = stopsRequests.get(snapshot);
    if (!pending) {
      const url = dataUrlForSnapshot(manifest, snapshot);
      pending = fetchGeoJson(url, controller.signal);
      stopsRequests.set(snapshot, pending);
    }
    try {
      const stops = await pending;
      stopsByTime.set(snapshot, stops);
      if (currentState.time === snapshot) {
        syncMapData();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        showState('partial', true);
        showAlert(
          'The selected transit snapshot is unavailable. Other evidence remains usable.',
        );
        reportError('snapshot', error);
      }
    } finally {
      stopsRequests.delete(snapshot);
    }
  };

  function applyInput(input: {
    cause: string;
    patch?: Partial<Fg03State>;
    nextState?: Fg03State;
    selection?: {
      action: Action;
      kind: 'facility' | 'intervention';
      source: 'map' | 'list' | 'search';
    };
  }): Fg03State {
    if (input.selection) {
      lastSelectionSource = input.selection.source;
    }
    let transition = reduceTransition(currentState, input);
    let result: DerivedFg03Results | null = null;
    if (dataReady) {
      try {
        result = deriveResults({
          facilities,
          interventions,
          state: transition.state,
          search: currentSearch,
        });
      } catch (error) {
        showState('error', true);
        showAlert(
          'The explorer data is invalid. The published proof remains available.',
        );
        reportError('explorer', error);
        return currentState;
      }
      if (result.selectionInvalidated && transition.state.place !== null) {
        const invalidationCause = getFg03InvalidationCause(input.cause);
        transition = reduceTransition(transition.state, {
          cause: invalidationCause,
          patch: { place: null },
        });
        result = deriveResults({
          facilities,
          interventions,
          state: transition.state,
          search: currentSearch,
        });
      }
    }

    const previous = currentState;
    currentState = transition.state;
    updateControls();
    if (result) {
      renderResults(result, transition.focusDetail);
    }
    writeFg03History({
      effect: transition.history,
      history: window.history,
      location: window.location,
      state: currentState,
    });
    if (transition.analytics) {
      trackAtlasEvent(
        transition.analytics.name,
        transition.analytics.properties,
      );
    }

    syncMapData();
    if (transition.animateMap) {
      moveMapToSelection(true);
    } else if (input.cause === 'popstate') {
      applyCameraState(currentState);
    }
    if (previous.time !== currentState.time) {
      void ensureStops(currentState.time);
    }
    if (
      previous.place !== currentState.place
      || previous.walk !== currentState.walk
    ) {
      void loadReach();
    }
    if (
      transition.restoreFocus
    ) {
      const replacement = previous.place === null
        ? null
        : [...mountedRoot.querySelectorAll<HTMLButtonElement>(
            '[data-fg03-select-place]',
          )].find(
            (button) => button.getAttribute('data-fg03-select-place') === previous.place,
          ) ?? null;
      const focusTarget = chooseCloseFocus(lastSelectionOpener, replacement);
      if (focusTarget) {
        const frame = window.requestAnimationFrame(() => {
          animationFrames.delete(frame);
          if (focusTarget.isConnected) {
            focusTarget.focus({ preventScroll: true });
          }
        });
        animationFrames.add(frame);
      }
      lastSelectionOpener = focusTarget;
    }
    return currentState;
  }

  const applyLoadedContext = (): void => {
    if (!map || !mapStyleReady) {
      return;
    }
    addContextLayers(map, context);
    if (
      maplibre
      && orientationMarkers.length === 0
      && context.labels
    ) {
      orientationMarkers.push(
        ...addOrientationLabels(maplibre, map, context.labels),
      );
    }
    syncMapData();
  };

  const loadData = async (): Promise<void> => {
    if (dataLoadPromise) {
      return dataLoadPromise;
    }
    const sequence = ++loadSequence;
    const requestedSnapshot = currentState.time;
    const snapshotDate =
      config.snapshotDate ?? root.dataset.fg03SnapshotDate ?? '';
    const manifestUrl = safeFg03Href(
      config.manifestUrl
      ?? `/data/fg03/${snapshotDate}/manifest.json`,
    );

    showState('loading', true);
    showState('error', false);
    showState('offline', !navigator.onLine);
    showAlert(null);
    mapElement.dataset.loading = 'true';

    dataLoadPromise = (async () => {
      if (manifestUrl === null) {
        throw Object.assign(new TypeError('Invalid FG03 manifest path'), {
          fg03Kind: 'invalid_data',
          fg03Stage: 'manifest',
        });
      }
      const loaded = await loadFg03Data({
        manifestUrl,
        snapshot: requestedSnapshot,
        contextFiles: FG03_CONTEXT_FILES,
        signal: controller.signal,
      });
      if (disposed || sequence !== loadSequence) {
        return;
      }

      const loadedManifest = loaded.manifest as Fg03Manifest;
      manifest = loadedManifest;
      if (!loadedManifest.gate.passed) {
        gateWithheld = true;
        dataReady = false;
        delete mapElement.dataset.loading;
        if (explorer && failedGateTemplate) {
          withholdExplorer({
            controls,
            destroyMap,
            explorer,
            mapElement,
            root,
            template: failedGateTemplate,
          });
        } else {
          root.dataset.fg03GateStatus = 'failed';
          controls.inert = true;
          controls.setAttribute('aria-disabled', 'true');
          mapElement.inert = true;
          mapElement.tabIndex = -1;
          mapElement.setAttribute('aria-disabled', 'true');
          destroyMap();
        }
        return;
      }
      if (loaded.resources === null) {
        throw Object.assign(new TypeError('FG03 resources were withheld'), {
          fg03Kind: 'invalid_data',
        });
      }

      facilities = sourceValue(
        loaded.resources.facilities,
        EMPTY_COLLECTION,
      );
      interventions = sourceValue(
        loaded.resources.interventions,
        EMPTY_COLLECTION,
      );
      const stops = sourceValue(loaded.resources.stops, EMPTY_COLLECTION);
      if (loaded.resources.stops.status === 'fulfilled') {
        stopsByTime.set(requestedSnapshot, stops);
      }
      context = Object.fromEntries(
        Object.entries(loaded.resources.context)
          .filter(([, result]) => result.status === 'fulfilled')
          .map(([key, result]) => [
            key,
            (result as PromiseFulfilledResult<GeoJsonCollection>).value,
          ]),
      );

      const failures: Array<[string, unknown]> = [];
      if (loaded.resources.facilities.status === 'rejected') {
        failures.push(['facilities', loaded.resources.facilities.reason]);
      }
      if (loaded.resources.interventions.status === 'rejected') {
        failures.push(['interventions', loaded.resources.interventions.reason]);
      }
      if (loaded.resources.stops.status === 'rejected') {
        failures.push(['snapshot', loaded.resources.stops.reason]);
      }
      for (const result of Object.values(loaded.resources.context)) {
        if (result.status === 'rejected') {
          failures.push(['map', result.reason]);
        }
      }
      for (const [stage, error] of failures) {
        reportError(stage, error);
      }

      try {
        validPlaceIds = collectFg03ResultIds(facilities, interventions);
      } catch (error) {
        facilities = EMPTY_COLLECTION;
        interventions = EMPTY_COLLECTION;
        validPlaceIds = new Set();
        showState('error', true);
        showAlert(
          'The result identifiers are invalid. Interactive rankings are unavailable.',
        );
        reportError('explorer', error);
      }

      dataReady = true;
      showState('loading', false);
      showState('partial', failures.length > 0);
      showState('offline', !navigator.onLine);
      showState(
        'stale',
        isStale(loadedManifest.snapshotDate)
        || (
          typeof config.snapshotDate === 'string'
          && config.snapshotDate !== loadedManifest.snapshotDate
        ),
      );
      if (failures.length > 0) {
        showAlert(
          'Some explorer layers are unavailable. Available evidence and results remain usable.',
        );
      }
      delete mapElement.dataset.loading;

      currentState = await initializeRuntimeState({
        search: window.location.search,
        validPlaceIds,
        applyState(state, cause) {
          return applyInput({
            cause,
            nextState: state,
          });
        },
        loadReach: async () => loadReach(),
        applyCameraState,
        centerSelection({ animate }) {
          moveMapToSelection(animate);
        },
      });
      applyLoadedContext();
      if (!stopsByTime.has(currentState.time)) {
        void ensureStops(currentState.time);
      }
      syncInteractiveReadiness();
    })()
      .catch((error) => {
        if (controller.signal.aborted || disposed) {
          return;
        }
        dataReady = false;
        showState('loading', false);
        showState('offline', !navigator.onLine);
        showState('error', navigator.onLine);
        delete mapElement.dataset.loading;
        showAlert(
          navigator.onLine
            ? 'The explorer data could not load. Retry or use the dated downloads below.'
            : 'You appear to be offline. The proof and default server-rendered ranking remain available.',
        );
        reportError('manifest', error);
        syncInteractiveReadiness();
      })
      .finally(() => {
        dataLoadPromise = null;
      });
    return dataLoadPromise;
  };

  const measureMinimumZoom = (): void => {
    if (!map) {
      return;
    }
    const camera = map.cameraForBounds(CITY_BOUNDS, { padding: 24 });
    if (!camera || typeof camera.zoom !== 'number') {
      return;
    }
    const minimum = Math.max(8, Math.min(camera.zoom - 0.08, 11));
    map.setMinZoom(minimum);
    if (map.getZoom() < minimum) {
      suppressCameraHistory = true;
      map.jumpTo({ center: camera.center, zoom: minimum });
    }
  };

  const selectMapFeature = (
    id: unknown,
    source: 'map',
  ): void => {
    if (typeof id !== 'string' || !SAFE_ID.test(id)) {
      return;
    }
    const feature = currentFeatures.find((candidate) => featureId(candidate) === id);
    if (!feature) {
      return;
    }
    lastSelectionOpener = mapElement;
    applyInput({
      cause: 'selection',
      patch: { place: id },
      selection: {
        action: currentState.action,
        kind: currentState.action === 'open' ? 'facility' : 'intervention',
        source,
      },
    });
  };

  const wireMapEvents = (): void => {
    if (!map) {
      return;
    }
    const interactiveLayers = [
      'fg03-facilities-unrestricted',
      'fg03-facilities-fare-paid',
      'fg03-facilities-unknown',
      'fg03-interventions',
    ];
    map.on('click', (event) => {
      const hits = map?.queryRenderedFeatures(event.point, {
        layers: interactiveLayers.filter((id) => Boolean(map?.getLayer(id))),
      }) ?? [];
      selectMapFeature(hits[0]?.properties?.id, 'map');
    });
    map.on('mousemove', (event) => {
      if (!map) {
        return;
      }
      const hits = map.queryRenderedFeatures(event.point, {
        layers: interactiveLayers.filter((id) => Boolean(map?.getLayer(id))),
      });
      map.getCanvas().style.cursor = hits.length > 0 ? 'pointer' : '';
    });
    map.on('moveend', () => {
      if (!map || disposed) {
        return;
      }
      if (suppressCameraHistory) {
        suppressCameraHistory = false;
        return;
      }
      const center = map.getCenter();
      applyInput({
        cause: 'camera',
        patch: {
          map: [center.lng, center.lat, map.getZoom()],
        },
      });
    });
    map.on('resize', measureMinimumZoom);
    map.on('zoomend', syncResultLabels);

    const stopMotion = (): void => {
      map?.stop();
    };
    for (const type of ['pointerdown', 'wheel', 'touchstart', 'keydown']) {
      addListener(
        removeListeners,
        mapElement,
        type,
        stopMotion,
        type === 'wheel' || type === 'touchstart' ? { passive: true } : undefined,
      );
    }
    addListener(removeListeners, mapElement, 'keydown', (event) => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Enter' || !map) {
        return;
      }
      event.preventDefault();
      const point = map.project(map.getCenter());
      const hits = map.queryRenderedFeatures(
        [
          [point.x - 14, point.y - 14],
          [point.x + 14, point.y + 14],
        ],
        {
          layers: interactiveLayers.filter((id) => Boolean(map?.getLayer(id))),
        },
      );
      selectMapFeature(hits[0]?.properties?.id, 'map');
    });
  };

  const buildMap = async (): Promise<void> => {
    const [module] = await Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl.css'),
    ]);
    if (disposed || gateWithheld) {
      return;
    }
    maplibre = module.default;
    if (!hasWebGlSupport()) {
      throw Object.assign(new Error('WebGL is unavailable'), {
        fg03Kind: 'webgl',
      });
    }

    map = new maplibre.Map({
      container: mapElement,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: 'fg03-paper',
            type: 'background',
            paint: { 'background-color': '#f3eddd' },
          },
        ],
      },
      bounds: CITY_BOUNDS,
      fitBoundsOptions: { padding: 24 },
      maxBounds: MAP_BOUNDS,
      minZoom: 8,
      maxZoom: MAP_MAX_ZOOM,
      dragRotate: false,
      pitchWithRotate: false,
      // Cooperative gestures removed; MapStage holds scroll-zoom back until the
      // reader interacts, and the /map route hands over everything.
      attributionControl: false,
    });
    map.touchZoomRotate.disableRotation();

    // These three groups all defaulted into the bottom-right corner, where they
    // collided and crowded the primary gesture area, worst on a phone. Each
    // now has its own corner: zoom top-right, scale and attribution bottom-left,
    // leaving bottom-right to the stage's expand control.
    map.addControl(
      new maplibre.NavigationControl({
        showCompass: false,
        showZoom: true,
        visualizePitch: false,
      }),
      'top-right',
    );
    map.addControl(
      new maplibre.ScaleControl({
        maxWidth: 100,
        unit: 'metric',
      }),
      'bottom-left',
    );
    // `compact` unset: expanded where there is room, collapsed only when narrow.
    // Its ⓘ was being read as a help button because it was the only info
    // affordance on the map; "How to read this map" is now that affordance.
    map.addControl(
      new maplibre.AttributionControl({
        customAttribution:
          'Map data © OpenStreetMap contributors · City data under the Open Government Licence - Toronto',
      }),
      'bottom-left',
    );

    await new Promise<void>((resolve, reject) => {
      const onLoad = (): void => {
        map?.off('error', onError);
        resolve();
      };
      const onError = (event: import('maplibre-gl').ErrorEvent): void => {
        if (!mapStyleReady) {
          map?.off('load', onLoad);
          reject(
            Object.assign(event.error ?? new Error('Map failed to load'), {
              fg03Kind: 'webgl',
            }),
          );
        }
      };
      map?.once('load', onLoad);
      map?.once('error', onError);
    });
    if (disposed || gateWithheld || !map) {
      if (gateWithheld) {
        destroyMap();
      }
      return;
    }

    mapStyleReady = true;
    measureMinimumZoom();
    addShapeImages(map);
    addOperationalLayers(map);
    applyLoadedContext();
    syncMapData();
    if (currentState.map !== null) {
      applyCameraState(currentState);
    } else if (currentState.place !== null) {
      moveMapToSelection(false);
    }
    syncResultLabels();
    wireMapEvents();
    mapElement.dataset.ready = 'true';
    delete mapElement.dataset.failed;
    delete mapElement.dataset.loading;
    syncInteractiveReadiness();

    // The shared stage, for gesture context, the "How to read this map"
    // disclosure, and the expand link only. Its status region is not rendered
    // here (status={false}): fg03 already owns a richer state machine wired to
    // the results list, and startMap's catch above is what drives it.
    //
    // syncExpandHref reads window.location.search, which fg03 keeps in step
    // with the filters, so expanding carries the reader's whole query across.
    mapStage?.destroy();
    mapStage = createMapStage({
      root: mapElement.closest<HTMLElement>('[data-map-stage]'),
      map,
      expanded: isExpandedRoute,
      expandPath: isExpandedRoute
        ? undefined
        : `${withBase('guides/when-toronto-has-to-go/map')}`,
    });
    if (isExpandedRoute) {
      map.once('idle', () => mapStage?.focusMap());
    }
  };

  const mapStarter = makeMapStartController({
    hasMap: () => map !== null,
    isHealthy: () => map !== null && mapStyleReady,
    destroy: destroyMap,
    start: buildMap,
  });

  const startMap = async (): Promise<void> => {
    if (disposed || gateWithheld || (map !== null && mapStyleReady)) {
      return;
    }
    mapElement.dataset.loading = 'true';
    try {
      await mapStarter.start();
    } catch (error) {
      if (controller.signal.aborted || disposed || gateWithheld) {
        return;
      }
      mapElement.dataset.failed = 'true';
      delete mapElement.dataset.loading;
      showState('partial', dataReady);
      showState('error', !dataReady);
      showAlert(
        'The interactive map is unavailable. The synchronized result list remains fully usable.',
      );
      reportError('map', error);
      syncInteractiveReadiness();
    }
  };

  const startEnhancement = async (): Promise<void> => {
    trackAtlasEvent('fg03_engage', { surface: 'map' });
    await Promise.allSettled([loadData(), startMap()]);
  };

  const shareCurrentView = async (): Promise<void> => {
    const shareData = {
      title: 'When Toronto Has to Go',
      text: 'Toronto public washroom access and audited late-night interventions',
      url: window.location.href,
    };
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share(shareData);
        trackAtlasEvent('fg03_share', {
          method: 'native',
          state_shape: stateShape(currentState),
        });
      } else {
        await navigator.clipboard.writeText(shareData.url);
        trackAtlasEvent('fg03_share', {
          method: 'clipboard',
          state_shape: stateShape(currentState),
        });
      }
      trackAtlasEvent('fg03_journey_complete', { outcome: 'share' });
      if (status) {
        status.textContent = 'Share link ready.';
        setTimer(() => {
          if (status) {
            status.textContent = statusText(currentFeatures.length);
          }
        }, 2400);
      }
    } catch (error) {
      if (asRecord(error)?.name === 'AbortError') {
        return;
      }
      showAlert('The share link could not be copied. Use the browser address bar.');
      reportError('share', error);
    }
  };

  const engagedSurfaces = new Set<string>();
  const engage = (surface: string): void => {
    if (
      engagedSurfaces.has(surface)
      || !['controls', 'map', 'results', 'detail'].includes(surface)
    ) {
      return;
    }
    engagedSurfaces.add(surface);
    trackAtlasEvent('fg03_engage', { surface });
  };

  syncInteractiveReadiness();
  root.dataset.fg03RuntimeMounted = 'true';
  updateControls();

  addListener(removeListeners, controls, 'change', (event) => {
    engage('controls');
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'radio') {
      return;
    }
    if (input.name === 'time') {
      applyInput({
        cause: 'time-change',
        patch: { time: input.value as Snapshot },
      });
    } else if (input.name === 'access') {
      applyInput({
        cause: 'access-change',
        patch: { access: input.value as Access },
      });
    } else if (input.name === 'walk') {
      applyInput({
        cause: 'walk-change',
        patch: { walk: Number(input.value) as 300 | 400 | 500 },
      });
    } else if (input.name === 'action') {
      applyInput({
        cause: 'action-change',
        patch: { action: input.value as Action },
      });
    }
  });

  if (searchInput) {
    addListener(removeListeners, searchInput, 'input', () => {
      engage('controls');
      currentSearch = searchInput.value;
      applyInput({ cause: 'search' });
      if (searchAnalyticsTimer !== 0) {
        window.clearTimeout(searchAnalyticsTimer);
        timers.delete(searchAnalyticsTimer);
      }
      searchAnalyticsTimer = setTimer(() => {
        searchAnalyticsTimer = 0;
        trackAtlasEvent('fg03_search_use', {
          result_bucket: resultBucket(currentFeatures.length),
        });
      }, 500);
    });
  }
  if (clearSearchButton) {
    addListener(removeListeners, clearSearchButton, 'click', () => {
      currentSearch = '';
      applyInput({ cause: 'search' });
      searchInput?.focus();
    });
  }
  if (resetButton) {
    addListener(removeListeners, resetButton, 'click', () => {
      currentSearch = '';
      lastSelectionOpener = resetButton;
      applyInput({ cause: 'reset', nextState: defaultState });
      if (map) {
        suppressCameraHistory = true;
        const camera = map.cameraForBounds(CITY_BOUNDS, { padding: 24 });
        if (camera) {
          if (isReducedMotion()) {
            map.jumpTo({ center: camera.center, zoom: camera.zoom });
          } else {
            map.easeTo({
              center: camera.center,
              zoom: camera.zoom,
              duration: 700,
              essential: false,
            });
          }
        }
      }
    });
  }
  if (closeDetail) {
    addListener(removeListeners, closeDetail, 'click', () => {
      engage('detail');
      applyInput({ cause: 'close', patch: { place: null } });
    });
  }
  if (shareButton) {
    addListener(removeListeners, shareButton, 'click', () => {
      void shareCurrentView();
    });
  }
  if (retryButton) {
    addListener(removeListeners, retryButton, 'click', () => {
      showAlert(null);
      void Promise.allSettled([loadData(), startMap()]);
    });
  }
  if (resultsRoot) {
    addListener(removeListeners, resultsRoot, 'pointerdown', () => engage('results'));
  }
  addListener(removeListeners, mapElement, 'pointerdown', () => engage('map'));
  if (detail) {
    addListener(removeListeners, detail, 'focusin', () => engage('detail'));
  }
  addListener(removeListeners, window, 'popstate', () => {
    const state = parseFg03State(
      window.location.search,
      validPlaceIds,
    ) as Fg03State;
    applyInput({ cause: 'popstate', nextState: state });
  });
  addListener(removeListeners, window, 'offline', () => {
    showState('offline', true);
    showAlert(
      'You appear to be offline. The proof and loaded results remain available.',
    );
  });
  addListener(removeListeners, window, 'online', () => {
    showState('offline', false);
    if (dataReady) {
      showAlert(null);
    }
  });

  deferredLoader = makeDeferredLoader({
    target: mapShell,
    interactionTarget: root,
    start: startEnhancement,
    createObserver:
      typeof IntersectionObserver === 'function'
        ? (
            callback: IntersectionObserverCallback,
            options: IntersectionObserverInit,
          ) => new IntersectionObserver(callback, options)
        : undefined,
  });

  const resourceCleanup = makeCleanup({
    controller,
    observer: {
      disconnect() {
        deferredLoader?.cleanup();
      },
    },
    timers,
    animationFrames,
    removeListeners,
    clearTimer: window.clearTimeout.bind(window),
    cancelFrame: window.cancelAnimationFrame.bind(window),
    getMap: () => map,
  });
  let cleanupCalled = false;
  const cleanup = (): void => {
    if (cleanupCalled) {
      return;
    }
    cleanupCalled = true;
    disposed = true;
    loadSequence += 1;
    mapStage?.destroy();
    mapStage = null;
    destroyMap();
    resourceCleanup();
    controls.inert = true;
    controls.setAttribute('aria-disabled', 'true');
    mapElement.inert = true;
    mapElement.setAttribute('aria-disabled', 'true');
    mapElement.tabIndex = -1;
    delete root.dataset.fg03RuntimeMounted;
    activeMounts.delete(root);
  };
  activeMounts.set(root, cleanup);

  trackAtlasEvent('fg03_entry', {
    state_shape: stateShape(currentState),
  });
  return cleanup;
}

let lifecycleController:
  | ReturnType<typeof makeLifecycleController>
  | null = null;

export function registerWhenTorontoHasToGoLifecycle(): void {
  if (lifecycleController || typeof document === 'undefined') {
    return;
  }
  lifecycleController = makeLifecycleController({
    eventTarget: document,
    shouldMount: () => Boolean(
      document.querySelector('[data-fg03-root][data-fg03-gate-status="passed"]'),
    ),
    init: initWhenTorontoHasToGo,
  });
  lifecycleController.start();
}
