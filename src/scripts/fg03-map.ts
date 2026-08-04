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
  readerLabel,
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
  FG03_READER_LABELS,
  FG03_SYMBOL_RECIPES,
  formatFg03Status,
  getFg03InvalidationCause,
  initializeFg03RuntimeState,
  loadFg03Data,
  readerLabel,
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
 * The reader wording for every dataset value, shared with the row disclosure.
 *
 * The table itself lives in fg03-map-core.mjs so that the detail panel here and
 * the "Read the evidence" rows there cannot drift into two vocabularies for one
 * washroom. See FG03_READER_LABELS for why that mattered.
 */
const readValue = readerLabel as (
  field: string,
  value: unknown,
  fallback: string,
) => string;
/** Line one of the in-frame title block, by what the reader asked to see. */
const FRAME_TITLE: Record<Action, (count: string, plural: boolean) => string> = {
  open: (count, plural) => `${count} washroom${plural ? 's' : ''} open`,
  extend: (count, plural) => `${count} place${plural ? 's' : ''} to extend hours`,
  new: (count, plural) => `${count} new-facility zone${plural ? 's' : ''}`,
  verify: (count, plural) => `${count} record${plural ? 's' : ''} to verify`,
  retrofit: (count, plural) => `${count} accessibility retrofit${plural ? 's' : ''}`,
};
/** Below this width the detail panel is a screen or more away from the map. */
const NARROW_VIEWPORT = 900;
const MAP_MAX_ZOOM = 18.5;
const STALE_AFTER_DAYS = 45;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type MlMap = import('maplibre-gl').Map;
type MlModule = typeof import('maplibre-gl');
/** A camera this guide can hand back to the map whole, centre and zoom together. */
type Camera = {
  center: import('maplibre-gl').LngLatLike;
  zoom: number;
};
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
    'fg03-hover',
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
  /**
   * Where the camera was before the reader picked a place.
   *
   * Selecting anything zooms to at least 14, which is a 300 m scale bar and
   * five of six results off screen. Clearing the selection used to leave the
   * reader there: the only control that brought the city back was "Reset
   * explorer", which also threw away the time, access, walk and action they had
   * chosen to get there. Remembering one camera makes clearing reversible.
   */
  let cameraBeforeSelection: Camera | null = null;
  /**
   * The "Fit all results" control, built before the map exists.
   *
   * renderResults can run before MapLibre has loaded, and the count in this
   * button's tooltip has to be right whenever it becomes visible, so the DOM is
   * made here and only handed to the map in buildMap.
   */
  const fitControlRoot = document.createElement('div');
  fitControlRoot.className =
    'maplibregl-ctrl maplibregl-ctrl-group fg03-fit-control';
  const fitControlButton = document.createElement('button');
  fitControlButton.type = 'button';
  fitControlButton.textContent = 'Fit all results';
  fitControlRoot.append(fitControlButton);
  /** Name near the cursor, so a hover says which place, not just that there is one. */
  const hoverLabel = document.createElement('p');
  hoverLabel.className = 'fg03-map-hover-label';
  hoverLabel.setAttribute('aria-hidden', 'true');
  hoverLabel.hidden = true;
  mapElement.append(hoverLabel);

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
  // Read back from the markup rather than repeating the string here, so the
  // label restored after a copy cannot drift from Fg03Controls.astro.
  const shareButtonLabel = shareButton?.textContent?.trim() ?? 'Share this view';
  const detail = root.querySelector<HTMLElement>('[data-fg03-detail]');
  const detailTitle = root.querySelector<HTMLElement>('#fg03-detail-title');
  const detailBody = root.querySelector<HTMLElement>('[data-fg03-detail-body]');
  const closeDetail = root.querySelector<HTMLButtonElement>(
    '[data-fg03-close-detail]',
  );
  const resultsEyebrow = resultsRoot?.querySelector<HTMLElement>(
    '[data-fg03-results-eyebrow]',
  ) ?? null;
  const rankBasis = root.querySelector<HTMLElement>('[data-fg03-rank-basis]');
  const railLegend = root.querySelector<HTMLDetailsElement>(
    '[data-fg03-legend-disclosure]',
  );
  const mapTitle = root.querySelector<HTMLElement>('[data-fg03-map-title]');
  const mapTitleCount = root.querySelector<HTMLElement>(
    '[data-fg03-map-title-count]',
  );
  const mapTitleFilters = root.querySelector<HTMLElement>(
    '[data-fg03-map-title-filters]',
  );
  const mapVeil = root.querySelector<HTMLElement>('[data-fg03-map-veil]');
  const mapVeilMessage = root.querySelector<HTMLElement>(
    '[data-fg03-map-veil-message]',
  );
  const mapVeilAction = root.querySelector<HTMLButtonElement>(
    '[data-fg03-map-veil-action]',
  );
  const mapCard = root.querySelector<HTMLElement>('[data-fg03-map-card]');
  const mapCardTitle = root.querySelector<HTMLElement>(
    '[data-fg03-map-card-title]',
  );
  const mapCardBody = root.querySelector<HTMLElement>(
    '[data-fg03-map-card-body]',
  );
  const mapCardClose = root.querySelector<HTMLButtonElement>(
    '[data-fg03-map-card-close]',
  );
  const mapCardMore = root.querySelector<HTMLButtonElement>(
    '[data-fg03-map-card-more]',
  );

  /**
   * True where the detail panel is a screenful away rather than a column away.
   *
   * Measured at 390px: the panel starts about 2,600px below the map, so the
   * scroll that helps on a desktop leaves a phone reader looking at a results
   * list with the map entirely off screen and nothing linking back.
   */
  const isNarrowViewport = (): boolean =>
    window.matchMedia(`(max-width: ${NARROW_VIEWPORT - 1}px)`).matches;

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

  const pointOf = (feature: GeoJsonFeature): [number, number] | null => {
    const coordinates = feature.geometry.coordinates;
    return Array.isArray(coordinates)
      && typeof coordinates[0] === 'number'
      && typeof coordinates[1] === 'number'
      ? [coordinates[0], coordinates[1]]
      : null;
  };

  const moveCamera = (camera: Camera, animate: boolean): void => {
    if (!map) {
      return;
    }
    if (animate && !isReducedMotion()) {
      map.easeTo({ ...camera, duration: 700, essential: false });
    } else {
      map.jumpTo(camera);
    }
  };

  /** cameraForBounds leaves both halves optional; only a whole camera is usable. */
  const asCamera = (
    result: import('maplibre-gl').CenterZoomBearing | undefined,
  ): Camera | null => (
    result && result.center !== undefined && typeof result.zoom === 'number'
      ? { center: result.center, zoom: result.zoom }
      : null
  );

  /** The whole visible result set, or the city when there is nothing to frame. */
  const cameraForAllResults = (): Camera | null => {
    if (!map || !maplibre) {
      return null;
    }
    const points = currentFeatures
      .map(pointOf)
      .filter((point): point is [number, number] => point !== null);
    const cityCamera = asCamera(map.cameraForBounds(CITY_BOUNDS, { padding: 24 }));
    if (points.length === 0) {
      return cityCamera;
    }
    const bounds = new maplibre.LngLatBounds(points[0], points[0]);
    for (const point of points) {
      bounds.extend(point);
    }
    // maxZoom keeps a single result from becoming a rooftop view, which is the
    // same trap the selection zoom fell into.
    return asCamera(map.cameraForBounds(bounds, { padding: 56, maxZoom: 15 }))
      ?? cityCamera;
  };

  const fitAllResults = (): void => {
    const camera = cameraForAllResults();
    if (camera) {
      moveCamera(camera, true);
    }
  };

  const updateFitControl = (count: number): void => {
    const label = `Zoom out to show all ${count.toLocaleString('en-CA')}`;
    fitControlButton.title = label;
    fitControlButton.setAttribute('aria-label', label);
    fitControlButton.disabled = count === 0;
  };

  /**
   * The one-line answer to "what am I looking at", drawn on the map itself.
   *
   * The status sentence outside the frame says the same thing, but it is below
   * the fold on the map route and 1,600px above the map on a phone, which makes
   * it a caption for something the reader cannot see at the same time.
   */
  const updateMapTitle = (count: number): void => {
    if (!mapTitle || !mapTitleCount || !mapTitleFilters) {
      return;
    }
    const build = FRAME_TITLE[currentState.action] ?? FRAME_TITLE.open;
    mapTitleCount.textContent = `${
      build(count.toLocaleString('en-CA'), count !== 1)
    } at ${TIME_LABELS[currentState.time]}`;
    mapTitleFilters.textContent = `${
      currentState.access === 'rider' ? 'TTC rider access' : 'Public access'
    } · ${currentState.walk} m walk`;
    mapTitle.hidden = !dataReady;
  };

  const updateMapVeil = (count: number): void => {
    if (!mapVeil || !mapVeilMessage || !mapVeilAction) {
      return;
    }
    if (!dataReady || count > 0) {
      mapVeil.hidden = true;
      return;
    }
    const searching = currentSearch !== '';
    mapVeilMessage.textContent = searching
      ? 'No places match this search and these filters.'
      : 'This snapshot publishes nothing for that choice.';
    mapVeilAction.hidden = !searching;
    mapVeil.hidden = false;
  };

  /**
   * The phone's version of the detail panel, docked to the bottom of the map.
   *
   * Deliberately short: the name, what kind of thing it is, and the two facts a
   * reader standing outside actually needs. Anything longer would cover the map
   * it is describing. "Read the full record" is the way to the real panel, and
   * it is a link the reader chooses rather than a scroll done to them.
   */
  const renderMapCard = (feature: GeoJsonFeature | null): void => {
    if (!mapCard || !mapCardTitle || !mapCardBody) {
      return;
    }
    mapCardBody.replaceChildren();
    if (!feature || !isNarrowViewport()) {
      mapCard.hidden = true;
      return;
    }
    const properties = featureProperties(feature);
    mapCardTitle.textContent =
      typeof properties.name === 'string' ? properties.name : 'Selected place';
    const isProposal = String(properties.action ?? 'open') !== 'open';
    const rows: Array<[string, string]> = [
      [
        'What this is',
        isProposal
          ? 'A change I am proposing here, not an open washroom'
          : 'A washroom recorded as open at the selected time',
      ],
      ['Access', readValue(
        'access',
        properties.accessCondition,
        'Access condition not published',
      )],
      ['Hours', String(properties.hours ?? 'Not published')],
    ];
    for (const [term, value] of rows) {
      const wrapper = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = term;
      dd.textContent = value;
      wrapper.append(dt, dd);
      mapCardBody.append(wrapper);
    }
    mapCard.hidden = false;
  };

  const renderDetail = (
    feature: GeoJsonFeature | null,
    focus: boolean,
  ): void => {
    renderMapCard(feature);
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
      ['Access', readValue(
        'access',
        properties.accessCondition,
        'Access condition not published',
      )],
      ['Hours', String(properties.hours ?? 'Not published')],
      ['Closure', readValue(
        'closure',
        properties.closureCategory,
        'Not classified',
      )],
      ['Accessibility', readValue(
        'accessibility',
        properties.accessibility,
        'Not published',
      )],
      ['Stability', readValue(
        'stability',
        properties.stability,
        'Not evaluated',
      )],
      ['Audit', readValue('audit', properties.auditStatus, 'Not applicable')],
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
      //
      // Narrow viewports are the opposite case again. There the panel is not a
      // column away but a screen and a half away, so scrolling to it takes the
      // map off screen entirely. The docked card carries the record instead and
      // offers the trip to the panel as a choice.
      const cameFromMap = lastSelectionSource === 'map' && !isNarrowViewport();
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
    if (resultsEyebrow) {
      // The heading below this changed with every choice while the eyebrow was
      // frozen at whatever the build-time default happened to be, so ten
      // proposals could sit under "What Toronto has". The eyebrow is the only
      // line that names the kind of thing, so it has to move with the rest.
      resultsEyebrow.textContent = currentState.action === 'open'
        ? 'What Toronto has'
        : 'What I would change';
    }
    if (rankBasis) {
      rankBasis.hidden = currentState.action === 'open';
    }
    if (status) {
      status.textContent = statusText(currentFeatures.length);
    }
    updateMapTitle(currentFeatures.length);
    updateMapVeil(currentFeatures.length);
    updateFitControl(currentFeatures.length);

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
    // Read before anything moves the map: moveMapToSelection runs later in this
    // same call, and by then the view worth remembering is already gone.
    if (map && previous.place === null && transition.state.place !== null) {
      const center = map.getCenter();
      cameraBeforeSelection = {
        center: [center.lng, center.lat],
        zoom: map.getZoom(),
      };
    }
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
    } else if (
      // Clearing a selection puts the camera back where the reader left it.
      // popstate replays its own camera and reset fits the city itself, so
      // neither wants this. The moveend it triggers is deliberately not
      // suppressed: the restored view is the one the URL should carry.
      map
      && previous.place !== null
      && currentState.place === null
      && cameraBeforeSelection !== null
      && input.cause !== 'reset'
    ) {
      moveCamera(cameraBeforeSelection, true);
    }
    if (currentState.place === null) {
      cameraBeforeSelection = null;
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
    // The invisible 14px-radius layers, asked first. The drawn markers are 7px
    // at their largest, an 18px target against the 24px WCAG 2.5.8 asks for, so
    // hitting one used to take a steady hand. The drawn layers stay in the list
    // behind them because a symbol icon can extend past its circle.
    const hitLayers = ['fg03-facilities-hit', 'fg03-interventions-hit'];
    const present = (ids: string[]): string[] =>
      ids.filter((id) => Boolean(map?.getLayer(id)));
    const featureAt = (
      point: import('maplibre-gl').Point,
    ): import('maplibre-gl').MapGeoJSONFeature | null => {
      if (!map) {
        return null;
      }
      const hit = map.queryRenderedFeatures(point, {
        layers: present(hitLayers),
      });
      if (hit.length > 0) {
        return hit[0];
      }
      const drawn = map.queryRenderedFeatures(point, {
        layers: present(interactiveLayers),
      });
      return drawn[0] ?? null;
    };

    const clearHover = (): void => {
      hoverLabel.hidden = true;
      if (map && mapStyleReady) {
        ensureGeoJsonSource(map, 'fg03-hover', EMPTY_COLLECTION);
      }
    };

    map.on('click', (event) => {
      selectMapFeature(featureAt(event.point)?.properties?.id, 'map');
    });
    map.on('mousemove', (event) => {
      if (!map) {
        return;
      }
      const hit = featureAt(event.point);
      map.getCanvas().style.cursor = hit === null ? '' : 'pointer';
      if (hit === null) {
        clearHover();
        return;
      }
      ensureGeoJsonSource(map, 'fg03-hover', {
        type: 'FeatureCollection',
        features: [hit as unknown as GeoJsonFeature],
      });
      // Above 13.5 the map already prints every result's name beside its
      // marker, so a second copy following the cursor is the same word twice.
      if (showResultLabels(map.getZoom())) {
        hoverLabel.hidden = true;
        return;
      }
      const name = hit.properties?.name;
      hoverLabel.textContent =
        typeof name === 'string' && name.trim() !== ''
          ? name.trim()
          : 'Name unavailable';
      // Offset up and right of the cursor. Directly under it the label would
      // sit between the pointer and the marker it names.
      hoverLabel.style.left = `${event.point.x + 14}px`;
      hoverLabel.style.top = `${event.point.y - 28}px`;
      hoverLabel.hidden = false;
    });
    map.on('mouseout', clearHover);
    addListener(removeListeners, mapElement, 'pointerleave', clearHover);
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
    for (const type of ['pointerdown', 'touchstart', 'keydown']) {
      addListener(
        removeListeners,
        mapElement,
        type,
        stopMotion,
        type === 'touchstart' ? { passive: true } : undefined,
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
          layers: present([...hitLayers, ...interactiveLayers]),
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
    // Directly under the zoom pair, because that is where a reader already
    // looks for "change how much of the city I can see". Selecting a place
    // zooms to at least 14 and used to leave no way back short of Reset
    // explorer, which also discarded the filters.
    map.addControl(
      {
        onAdd: () => fitControlRoot,
        onRemove: () => fitControlRoot.remove(),
      } satisfies import('maplibre-gl').IControl,
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
    let copiedToClipboard = false;
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share(shareData);
        trackAtlasEvent('fg03_share', {
          method: 'native',
          state_shape: stateShape(currentState),
        });
      } else {
        await navigator.clipboard.writeText(shareData.url);
        copiedToClipboard = true;
        trackAtlasEvent('fg03_share', {
          method: 'clipboard',
          state_shape: stateShape(currentState),
        });
      }
      trackAtlasEvent('fg03_journey_complete', { outcome: 'share' });
      // Confirm on the button itself. The aria-live status below already
      // announced this, but it renders roughly 500px down the panel and is
      // never on screen at the same time as the button, so a sighted reader
      // clicked Share and saw nothing happen at all.
      if (shareButton) {
        shareButton.textContent = copiedToClipboard ? 'Link copied' : 'Shared';
        setTimer(() => {
          if (shareButton) {
            shareButton.textContent = shareButtonLabel;
          }
        }, 2400);
      }
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
  addListener(removeListeners, fitControlButton, 'click', () => {
    engage('map');
    fitAllResults();
  });
  if (mapVeilAction && searchInput) {
    addListener(removeListeners, mapVeilAction, 'click', () => {
      currentSearch = '';
      applyInput({ cause: 'search' });
      searchInput.focus();
    });
  }
  if (mapCardClose) {
    addListener(removeListeners, mapCardClose, 'click', () => {
      engage('detail');
      applyInput({ cause: 'close', patch: { place: null } });
    });
  }
  if (mapCardMore && detail && detailTitle) {
    addListener(removeListeners, mapCardMore, 'click', () => {
      engage('detail');
      detail.scrollIntoView({
        block: 'start',
        behavior: isReducedMotion() ? 'auto' : 'smooth',
      });
      detailTitle.focus({ preventScroll: true });
    });
  }
  // Rotating a phone, or dragging a desktop window narrow, changes which of the
  // two detail surfaces is the right one. Re-deciding on resize is cheaper than
  // leaving a card stranded over a map that now has a panel beside it.
  addListener(removeListeners, window, 'resize', () => {
    renderMapCard(findVisibleFeature(currentState.place));
  });
  if (railLegend) {
    // Open on a first visit, because a reader who has never seen these shapes
    // needs the key before they need the room. Closed after they close it once.
    try {
      railLegend.open = window.localStorage.getItem('fg03-legend') !== 'closed';
    } catch {
      // Storage can be denied outright. An always-open legend is the safe miss.
    }
    addListener(removeListeners, railLegend, 'toggle', () => {
      try {
        window.localStorage.setItem(
          'fg03-legend',
          railLegend.open ? 'open' : 'closed',
        );
      } catch {
        // Same again: the disclosure still works, it just will not remember.
      }
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
