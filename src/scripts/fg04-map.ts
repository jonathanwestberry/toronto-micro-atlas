import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createMapStage } from './map-stage';
import {
  resolveFg04TileTemplate,
} from './fg04-core.mjs';
import {
  createShadeTileProtocol,
  shadeTileTemplate,
} from './fg04-render.mjs';
import {
  createLatestPointRequest,
  loadPointProfile,
  pointStateAtHour,
} from './fg04-point.mjs';
import {
  canonicalFg04Path,
  copyFg04Url,
  writeFg04History,
} from './fg04-runtime.mjs';
import { parseFg04State } from './fg04-state.mjs';
import {
  parseStreetProfiles,
  profileAtHour,
  searchStreets,
  streetById,
} from './fg04-streets.mjs';

/**
 * The shade map: two surfaces, side by side, always both.
 *
 * Every lidar flight over Toronto is leaf-off, and the leaf-on correction
 * REVERSES which neighbourhoods are shadiest. Raw, the three shadiest are
 * downtown tower districts; corrected, all three are leafy midtown. A reader
 * shown one surface at a time has to hold the other in memory to see that,
 * which is the entire finding. So both are on screen at once, and each is
 * labelled in words, because Mauve and Plum sit 2.11 apart in contrast and
 * colour alone cannot carry which surface is which.
 *
 * MapLibre cannot evaluate the selected-hour bit expression in a
 * `color-relief` layer. Its style validator accepts the expression, but the
 * renderer only creates a ramp for a top-level `interpolate` and silently
 * paints every other expression transparent. The browser therefore decodes
 * each visible v3 tile into a two-colour raster for the selected hour, then
 * gives that ordinary raster tile back to MapLibre for pan and zoom.
 *
 * The tiles are built to ride MapLibre's default "mapbox" unpack,
 * `R*6553.6 + G*25.6 + B*0.1 - 10000`, with the shaded-hours count in red and
 * the hour bitmask in green and blue. The mask can add at most 6553.5, just
 * under one step of red, so each count owns a band of the unpacked value that
 * no other count reaches. The band edges come from the manifest.
 *
 * This guide maps SHADE. Not temperature, not heat, not coolness. The ramp is
 * monotonic in luminance and has no hue axis, deliberately: a two-hue ramp
 * invites a reader to decode the hue, and the only hue axis anyone expects on
 * a map like this is the one this guide is not entitled to draw. There is no
 * blue-to-orange ramp here and there never will be.
 */

interface Manifest {
  modelledDate: string;
  timezone: string;
  gridResolutionM: number;
  flightSeason: string;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  nativeZoom: number;
  tileSize: number;
  surfaces: string[];
  surfaceLabels: Record<string, string>;
  tileUrlTemplates: Record<string, string>;
  localTileUrlTemplates: Record<string, string>;
  demUnpack: Record<string, string | number>;
  countBandStarts: Record<string, number>;
  dawnHour: number;
  dawnNote: string;
  firstHour: number;
  lastHour: number;
  hourBits: Record<string, number>;
  classification: {
    tileUrlTemplate: string;
    localTileUrlTemplate: string;
    classBandStarts: Record<string, number>;
  };
  streetProfiles: {
    url: string;
  };
}

const MANIFEST_URL = '/data/fg04/manifest.json';

interface SelectedColors {
  shaded: string;
  sunlit: string;
  noData: string;
  background: string;
}

function readColor(scope: Element, token: string): string {
  const value = getComputedStyle(scope).getPropertyValue(token).trim();
  if (!value) throw new Error(`${token} is not defined on the .fg04 scope`);
  return value;
}

function readSelectedColors(scope: Element): SelectedColors {
  return {
    shaded: readColor(scope, '--fg04-selected-shaded'),
    sunlit: readColor(scope, '--fg04-selected-sunlit'),
    noData: 'rgba(0, 0, 0, 0)',
    background: readColor(scope, '--atlas-ground'),
  };
}

function colorBytes(value: string): [number, number, number, number] {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('browser did not provide a color canvas');
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  return Array.from(context.getImageData(0, 0, 1, 1).data) as [
    number, number, number, number,
  ];
}

function tileTemplate(manifest: Manifest, surface: string): string {
  return resolveFg04TileTemplate(manifest, surface, window.location);
}

function classificationTemplate(manifest: Manifest): string {
  return resolveFg04TileTemplate(
    {
      tileUrlTemplates: {
        classification: manifest.classification.tileUrlTemplate,
      },
      localTileUrlTemplates: {
        classification: manifest.classification.localTileUrlTemplate,
      },
    },
    'classification',
    window.location,
  );
}

function buildMap(
  container: HTMLElement,
  manifest: Manifest,
  surface: string,
  colors: SelectedColors,
  hour: number,
  camera: [number, number, number] | null,
): maplibregl.Map {
  const [west, south, east, north] = manifest.bounds;

  const sources: Record<string, unknown> = {
    shade: {
      type: 'raster',
      tiles: [shadeTileTemplate(surface, hour)],
      tileSize: manifest.tileSize,
      minzoom: manifest.minZoom,
      maxzoom: manifest.maxZoom,
      bounds: manifest.bounds,
    },
  };
  const view = camera === null
    ? {
        bounds: [[west, south], [east, north]] as [
          [number, number], [number, number],
        ],
        fitBoundsOptions: { padding: 12 },
      }
    : {
        center: [camera[0], camera[1]] as [number, number],
        zoom: camera[2],
      };

  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: sources as never,
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: { 'background-color': colors.background },
        },
        {
          id: 'shade-selected-hour',
          type: 'raster',
          source: 'shade',
          paint: {
            'raster-resampling': 'nearest',
          },
        },
      ],
    },
    ...view,
    minZoom: manifest.minZoom,
    maxZoom: manifest.maxZoom,
    dragRotate: false,
    attributionControl: false,
  });

  map.touchZoomRotate.disableRotation();
  map.addControl(
    new maplibregl.AttributionControl({
      customAttribution:
        'Lidar © Government of Ontario, land cover © City of Toronto',
    }),
    'bottom-left',
  );
  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false }),
    'top-right',
  );
  return map;
}

/**
 * Keep both maps on the same ground.
 *
 * Two panes showing different places is worse than one pane, because it looks
 * like a comparison and is not. The guard stops the echo: A moves B, B fires
 * its own move event, B moves A, forever.
 */
function syncCameras(
  maps: maplibregl.Map[],
  onUserCamera: (camera: [number, number, number]) => void,
): void {
  let syncing = false;
  maps.forEach((source) => {
    let userMove = false;
    source.on('movestart', (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) userMove = true;
    });
    source.on('move', () => {
      if (syncing) return;
      syncing = true;
      const centre = source.getCenter();
      const zoom = source.getZoom();
      maps.forEach((target) => {
        if (target === source) return;
        target.jumpTo({ center: centre, zoom });
      });
      syncing = false;
    });
    source.on('moveend', () => {
      if (!userMove) return;
      userMove = false;
      const centre = source.getCenter();
      onUserCamera([centre.lng, centre.lat, source.getZoom()]);
    });
  });
}

function fillLegend(root: HTMLElement, manifest: Manifest): void {
  // Every fact in the legend comes from the manifest the tiles were written
  // with, so the legend and the layers cannot disagree about the instrument.
  const facts = root.querySelector('[data-fg04-legend-facts]');
  if (facts) {
    const date = new Date(`${manifest.modelledDate}T12:00:00`);
    const readable = date.toLocaleDateString('en-CA', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    const hours = Object.keys(manifest.hourBits).map(Number).sort((a, b) => a - b);
    const first = `${String(hours[0]).padStart(2, '0')}:00`;
    const last = `${String(hours[hours.length - 1]).padStart(2, '0')}:00`;
    facts.textContent =
      `Selected from ${hours.length} frames, ${readable}, ${first} to ${last} EDT, `
      + `on a ${manifest.gridResolutionM} m grid. Lidar flown `
      + `${manifest.flightSeason}. ${manifest.dawnNote}`;
  }
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00 EDT`;
}

function updateHourChrome(root: HTMLElement, hour: number): void {
  const text = formatHour(hour);
  const output = root.querySelector<HTMLOutputElement>('[data-fg04-hour-output]');
  const legend = root.querySelector<HTMLElement>('[data-fg04-hour-legend]');
  if (output) output.value = text;
  if (legend) legend.textContent = `Shade state at ${text}`;
}

interface PointProfile {
  status: 'ground' | 'non-ground' | 'missing' | 'error';
  coordinate: [number, number];
  underCanopy: boolean;
  measured: boolean[] | null;
  corrected: boolean[] | null;
}

function shadeStateLabel(shaded: boolean): string {
  return shaded ? 'Shaded' : 'Direct sun';
}

function renderPointSelection(
  root: HTMLElement,
  profile: PointProfile,
  hour: number,
  manifest: Manifest,
): void {
  const selected = pointStateAtHour(profile, hour, manifest);
  if (!selected) return;
  const time = root.querySelector<HTMLElement>('[data-fg04-point-selected-time]');
  const measured = root.querySelector<HTMLElement>(
    '[data-fg04-point-selected-measured]',
  );
  const corrected = root.querySelector<HTMLElement>(
    '[data-fg04-point-selected-corrected]',
  );
  if (time) time.textContent = `Selected hour, ${formatHour(hour)}`;
  if (measured) measured.textContent = shadeStateLabel(selected.measured);
  if (corrected) corrected.textContent = shadeStateLabel(selected.corrected);
}

function renderPointProfile(
  root: HTMLElement,
  profile: PointProfile,
  hour: number,
  manifest: Manifest,
): void {
  const status = root.querySelector<HTMLElement>('[data-fg04-point-status]');
  const panel = root.querySelector<HTMLElement>('[data-fg04-point-profile]');
  const coordinate = root.querySelector<HTMLElement>('[data-fg04-point-coordinate]');
  const strip = root.querySelector<HTMLOListElement>('[data-fg04-point-strip]');
  const table = root.querySelector<HTMLTableSectionElement>('[data-fg04-point-table]');

  if (coordinate) {
    coordinate.textContent = `${profile.coordinate[1].toFixed(5)}, ${profile.coordinate[0].toFixed(5)}`;
    coordinate.hidden = false;
  }
  if (profile.status !== 'ground' || !profile.measured || !profile.corrected) {
    if (panel) panel.hidden = true;
    if (status) {
      if (profile.status === 'non-ground') {
        status.textContent = 'This point is not sampled ground. Choose a nearby point.';
      } else if (profile.status === 'missing') {
        status.textContent = 'This point is outside the lidar coverage. Choose another point.';
      } else {
        status.textContent = 'The point profile could not load. Try another point.';
      }
    }
    return;
  }

  if (status) {
    status.textContent = profile.underCanopy
      ? 'Profile loaded. The corrected surface treats this point as ground under leaf-on canopy.'
      : 'Profile loaded.';
  }
  if (panel) panel.hidden = false;
  if (strip) strip.replaceChildren();
  if (table) table.replaceChildren();

  for (let current = manifest.firstHour; current <= manifest.lastHour; current += 1) {
    const index = current - manifest.firstHour;
    const measured = shadeStateLabel(profile.measured[index]);
    const corrected = shadeStateLabel(profile.corrected[index]);

    const item = document.createElement('li');
    item.className = 'fg04-point__strip-hour';
    if (current === hour) item.dataset.selected = 'true';
    const label = document.createElement('span');
    label.className = 'fg04-point__strip-label';
    label.textContent = `${String(current).padStart(2, '0')}:00`;
    const pair = document.createElement('span');
    pair.className = 'fg04-point__strip-pair';
    const rawCell = document.createElement('span');
    rawCell.className = `fg04-point__strip-cell fg04-point__strip-cell--${profile.measured[index] ? 'shaded' : 'sunlit'}`;
    rawCell.textContent = `Measured: ${measured}`;
    const correctedCell = document.createElement('span');
    correctedCell.className = `fg04-point__strip-cell fg04-point__strip-cell--${profile.corrected[index] ? 'shaded' : 'sunlit'}`;
    correctedCell.textContent = `Corrected: ${corrected}`;
    pair.append(rawCell, correctedCell);
    item.append(label, pair);
    strip?.append(item);

    const row = document.createElement('tr');
    const hourCell = document.createElement('th');
    hourCell.scope = 'row';
    hourCell.textContent = formatHour(current);
    const measuredCell = document.createElement('td');
    measuredCell.textContent = measured;
    const correctedTableCell = document.createElement('td');
    correctedTableCell.textContent = corrected;
    row.append(hourCell, measuredCell, correctedTableCell);
    table?.append(row);
  }
  renderPointSelection(root, profile, hour, manifest);
}

function renderPointLoading(root: HTMLElement, coordinate: [number, number]): void {
  const status = root.querySelector<HTMLElement>('[data-fg04-point-status]');
  const panel = root.querySelector<HTMLElement>('[data-fg04-point-profile]');
  const label = root.querySelector<HTMLElement>('[data-fg04-point-coordinate]');
  if (status) status.textContent = 'Loading the point profile.';
  if (panel) panel.hidden = true;
  if (label) {
    label.textContent = `${coordinate[1].toFixed(5)}, ${coordinate[0].toFixed(5)}`;
    label.hidden = false;
  }
}

interface StreetRecord {
  id: string;
  name: string;
  center: [number, number];
  lengthM: number;
  groundPixels: number;
  measured: number[];
  corrected: number[];
}

interface StreetProfiles {
  hours: number[];
  streets: StreetRecord[];
}

function shadeFraction(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderStreetSelectedHour(
  root: HTMLElement,
  street: StreetRecord,
  hour: number,
  hours: number[],
): void {
  const selected = profileAtHour(street, hour, hours);
  const time = root.querySelector<HTMLElement>('[data-fg04-street-selected-time]');
  const measured = root.querySelector<HTMLElement>(
    '[data-fg04-street-selected-measured]',
  );
  const corrected = root.querySelector<HTMLElement>(
    '[data-fg04-street-selected-corrected]',
  );
  if (time) time.textContent = `Selected hour, ${formatHour(hour)}`;
  if (measured) measured.textContent = `${shadeFraction(selected.measured)} shaded`;
  if (corrected) corrected.textContent = `${shadeFraction(selected.corrected)} shaded`;
}

function renderStreetProfile(
  root: HTMLElement,
  street: StreetRecord,
  hour: number,
  profiles: StreetProfiles,
): void {
  const panel = root.querySelector<HTMLElement>('[data-fg04-street-profile]');
  const name = root.querySelector<HTMLElement>('[data-fg04-street-name]');
  const sample = root.querySelector<HTMLElement>('[data-fg04-street-sample]');
  const strip = root.querySelector<HTMLOListElement>('[data-fg04-street-strip]');
  const table = root.querySelector<HTMLTableSectionElement>('[data-fg04-street-table]');
  if (panel) panel.hidden = false;
  if (name) name.textContent = street.name;
  if (sample) sample.textContent = 'Named street profile at the explorer grain.';
  if (strip) strip.replaceChildren();
  if (table) table.replaceChildren();

  profiles.hours.forEach((current, index) => {
    const measured = shadeFraction(street.measured[index]);
    const corrected = shadeFraction(street.corrected[index]);
    const item = document.createElement('li');
    item.className = 'fg04-street__strip-hour';
    if (current === hour) {
      item.dataset.selected = 'true';
      item.setAttribute('aria-current', 'true');
    }
    const label = document.createElement('span');
    label.className = 'fg04-street__strip-label';
    label.textContent = `${String(current).padStart(2, '0')}:00`;
    const rawValue = document.createElement('span');
    rawValue.className = 'fg04-street__strip-value';
    rawValue.textContent = `Measured ${measured}`;
    const correctedValue = document.createElement('span');
    correctedValue.className = 'fg04-street__strip-value';
    correctedValue.textContent = `Corrected ${corrected}`;
    item.append(label, rawValue, correctedValue);
    strip?.append(item);

    const row = document.createElement('tr');
    if (current === hour) row.dataset.selected = 'true';
    const hourCell = document.createElement('th');
    hourCell.scope = 'row';
    hourCell.textContent = formatHour(current);
    const measuredCell = document.createElement('td');
    measuredCell.textContent = `${measured} shaded`;
    const correctedCell = document.createElement('td');
    correctedCell.textContent = `${corrected} shaded`;
    row.append(hourCell, measuredCell, correctedCell);
    table?.append(row);
  });
  renderStreetSelectedHour(root, street, hour, profiles.hours);
}

function localTileOptIn(): boolean {
  const localHost = window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1';
  const params = new URLSearchParams(window.location.search);
  return localHost && params.getAll('tiles').length === 1
    && params.get('tiles') === 'local';
}

function stateUrl(state: ReturnType<typeof parseFg04State>): string {
  return canonicalFg04Path(
    window.location.pathname,
    window.location.hash,
    state,
    localTileOptIn(),
  );
}

export async function initShadeMap(): Promise<void> {
  const root = document.querySelector<HTMLElement>('[data-fg04-maps]');
  if (!root) return;
  if (root.dataset.fg04Initialized === 'true') return;
  root.dataset.fg04Initialized = 'true';

  const shells = Array.from(
    root.querySelectorAll<HTMLElement>('[data-map-stage]'),
  );
  const input = root.querySelector<HTMLInputElement>('[data-fg04-hour]');
  root.querySelector<HTMLFormElement>('[data-fg04-clock]')
    ?.addEventListener('submit', (event) => event.preventDefault());
  let state = parseFg04State(window.location.search);
  let committedState = { ...state };
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const canonicalPath = stateUrl(state);
  if (currentPath !== canonicalPath) {
    writeFg04History(window.history, 'replace', canonicalPath, state);
  }
  if (input) input.value = String(state.hour);
  updateHourChrome(root, state.hour);

  let manifest: Manifest;
  try {
    const response = await fetch(MANIFEST_URL);
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    manifest = (await response.json()) as Manifest;
  } catch (error) {
    // A blank rectangle is not a state. Say the map failed.
    shells.forEach((shell) => {
      createMapStage({ root: shell })?.setState(
        'error', 'The shade map could not load.',
      );
    });
    const streetStatus = root.querySelector<HTMLElement>('[data-fg04-street-status]');
    const streetRetry = root.querySelector<HTMLButtonElement>('[data-fg04-street-retry]');
    if (streetStatus) {
      streetStatus.textContent = 'The explorer data could not load. Try again.';
    }
    if (streetRetry) {
      streetRetry.hidden = false;
      streetRetry.addEventListener('click', () => window.location.reload());
    }
    return;
  }

  if (state.point !== null && state.map === null) {
    state = { ...state, map: [state.point[0], state.point[1], manifest.nativeZoom] };
    committedState = { ...state };
  }

  const colors = readSelectedColors(root);
  maplibregl.removeProtocol('fg04shade');
  maplibregl.addProtocol(
    'fg04shade',
    createShadeTileProtocol({
      manifest: {
        ...manifest,
        tileUrlTemplates: {
          raw: tileTemplate(manifest, 'raw'),
          corrected: tileTemplate(manifest, 'corrected'),
        },
        classification: {
          ...manifest.classification,
          tileUrlTemplate: classificationTemplate(manifest),
        },
      },
      colors: {
        shaded: colorBytes(colors.shaded),
        sunlit: colorBytes(colors.sunlit),
        noData: colorBytes(colors.noData),
      },
    }),
  );
  const maps: Array<{
    map: maplibregl.Map;
    surface: string;
    stage: ReturnType<typeof createMapStage>;
    failed: boolean;
  }> = [];
  const stages: Array<NonNullable<ReturnType<typeof createMapStage>>> = [];
  const diagnosticErrors: string[] = [];

  manifest.surfaces.forEach((surface) => {
    const container = root.querySelector<HTMLElement>(
      `[data-fg04-map="${surface}"]`,
    );
    const shell = container?.closest<HTMLElement>('[data-map-stage]');
    if (!container || !shell) return;

    // The map is built before the stage wraps it: the stage holds scroll-zoom
    // back until the reader interacts, and it needs a live map to hold.
    const map = buildMap(
      container, manifest, surface, colors, state.hour, state.map,
    );

    const stage = createMapStage({
      root: shell,
      map,
      onRetry: () => window.location.reload(),
    });
    if (stage) stages.push(stage);
    const entry = { map, surface, stage, failed: false };
    maps.push(entry);
    map.on('load', () => {
      if (!entry.failed) stage?.setState('ready');
    });
    map.on('error', (event) => {
      entry.failed = true;
      diagnosticErrors.push(event.error?.message ?? 'unknown map error');
      stage?.setState('error', 'The shade tiles could not load.');
    });
  });

  syncCameras(maps.map(({ map }) => map), (camera) => {
    state = { ...state, map: camera };
    committedState = { ...committedState, map: camera };
    writeFg04History(window.history, 'replace', stateUrl(state), state);
  });
  fillLegend(root, manifest);

  const pointManifest = {
    ...manifest,
    tileUrlTemplates: {
      raw: tileTemplate(manifest, 'raw'),
      corrected: tileTemplate(manifest, 'corrected'),
    },
    classification: {
      ...manifest.classification,
      tileUrlTemplate: classificationTemplate(manifest),
    },
  };
  const pointCache = new Map();
  let activePoint: PointProfile | null = null;
  let pointMarkers: maplibregl.Marker[] = [];
  let clearStreetSelection = (): void => {};

  const placePointMarkers = (coordinate: [number, number]): void => {
    pointMarkers.forEach((marker) => marker.remove());
    pointMarkers = maps.map(({ map, surface }) => {
      const marker = document.createElement('span');
      marker.className = 'fg04-point-marker';
      marker.setAttribute('role', 'img');
      marker.setAttribute('aria-label', `Selected point, ${manifest.surfaceLabels[surface]}`);
      return new maplibregl.Marker({ element: marker, anchor: 'center' })
        .setLngLat(coordinate)
        .addTo(map);
    });
  };

  const loadLatestPoint = createLatestPointRequest(
    (coordinate: [number, number]) => loadPointProfile(
      coordinate, pointManifest, pointCache,
    ),
    (profile: PointProfile) => {
      if (
        state.point === null
        || profile.coordinate[0] !== state.point[0]
        || profile.coordinate[1] !== state.point[1]
      ) return;
      activePoint = profile;
      renderPointProfile(root, profile, state.hour, manifest);
    },
  );

  const selectPoint = (
    coordinate: [number, number],
    historyMode: 'none' | 'push' = 'push',
  ): void => {
    const rounded: [number, number] = [
      Number(coordinate[0].toFixed(5)),
      Number(coordinate[1].toFixed(5)),
    ];
    clearStreetSelection();
    const centre = maps[0]?.map.getCenter();
    const camera: [number, number, number] | null = centre
      ? [centre.lng, centre.lat, maps[0].map.getZoom()]
      : state.map;
    state = { ...state, map: camera, point: rounded, street: null };
    activePoint = null;
    renderPointLoading(root, rounded);
    placePointMarkers(rounded);
    if (historyMode === 'push') {
      writeFg04History(window.history, 'push', stateUrl(state), state);
      committedState = { ...state };
    }
    void loadLatestPoint(rounded);
  };

  maps.forEach(({ map }) => {
    map.on('click', (event) => {
      selectPoint([event.lngLat.lng, event.lngLat.lat]);
    });
    map.getCanvas().addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const centre = map.getCenter();
      selectPoint([centre.lng, centre.lat]);
    });
  });

  if (state.point !== null) {
    selectPoint([state.point[0], state.point[1]], 'none');
  }

  const streetInput = root.querySelector<HTMLInputElement>(
    '[data-fg04-street-search]',
  );
  const streetResults = root.querySelector<HTMLUListElement>(
    '[data-fg04-street-results]',
  );
  const streetStatus = root.querySelector<HTMLElement>(
    '[data-fg04-street-status]',
  );
  const streetProfile = root.querySelector<HTMLElement>(
    '[data-fg04-street-profile]',
  );
  const streetRetry = root.querySelector<HTMLButtonElement>(
    '[data-fg04-street-retry]',
  );
  let streetData: StreetProfiles | null = null;
  let activeStreet: StreetRecord | null = null;
  let currentStreetResults: StreetRecord[] = [];
  let streetLoadGeneration = 0;

  const clearPointSelection = (): void => {
    activePoint = null;
    pointMarkers.forEach((marker) => marker.remove());
    pointMarkers = [];
    const panel = root.querySelector<HTMLElement>('[data-fg04-point-profile]');
    const coordinate = root.querySelector<HTMLElement>('[data-fg04-point-coordinate]');
    const status = root.querySelector<HTMLElement>('[data-fg04-point-status]');
    if (panel) panel.hidden = true;
    if (coordinate) coordinate.hidden = true;
    if (status) {
      status.textContent = 'Select a point to see its shade profile from 06:00 to 20:00 EDT.';
    }
  };

  clearStreetSelection = (): void => {
    activeStreet = null;
    currentStreetResults = [];
    streetResults?.replaceChildren();
    if (streetProfile) streetProfile.hidden = true;
    if (streetInput) streetInput.value = '';
    if (streetStatus && streetData) {
      streetStatus.textContent = 'Type a street name to search.';
    }
  };

  const renderStreetResults = (query: string): void => {
    streetResults?.replaceChildren();
    if (!streetData) return;
    currentStreetResults = searchStreets(streetData.streets, query);
    if (!query.trim()) {
      if (streetStatus) streetStatus.textContent = 'Type a street name to search.';
      return;
    }
    if (currentStreetResults.length === 0) {
      if (streetStatus) streetStatus.textContent = 'No matching street. Try another name.';
      return;
    }
    if (streetStatus) {
      streetStatus.textContent = `${currentStreetResults.length} matching ${currentStreetResults.length === 1 ? 'street' : 'streets'}.`;
    }
    currentStreetResults.forEach((street) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fg04-street__result';
      button.textContent = street.name;
      button.addEventListener('click', () => selectStreet(street));
      item.append(button);
      streetResults?.append(item);
    });
  };

  const selectStreet = (
    street: StreetRecord,
    historyMode: 'none' | 'push' = 'push',
    moveCamera = true,
  ): void => {
    if (!streetData) return;
    clearPointSelection();
    activeStreet = street;
    currentStreetResults = [];
    streetResults?.replaceChildren();
    if (streetInput) streetInput.value = street.name;
    if (streetStatus) streetStatus.textContent = `Showing ${street.name}.`;
    renderStreetProfile(root, street, state.hour, streetData);

    let camera = state.map;
    if (moveCamera && maps[0]) {
      const zoom = Math.max(15, maps[0].map.getZoom());
      camera = [street.center[0], street.center[1], zoom];
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      maps[0].map.easeTo({ center: street.center, zoom, duration: reducedMotion ? 0 : 650 });
    }
    state = { ...state, map: camera, point: null, street: street.id };
    if (historyMode === 'push') {
      writeFg04History(window.history, 'push', stateUrl(state), state);
      committedState = { ...state };
    }
  };

  const loadStreetData = async (): Promise<void> => {
    streetLoadGeneration += 1;
    const generation = streetLoadGeneration;
    streetData = null;
    currentStreetResults = [];
    streetResults?.replaceChildren();
    if (streetInput) streetInput.disabled = true;
    if (streetRetry) streetRetry.hidden = true;
    if (streetProfile) streetProfile.hidden = true;
    if (streetStatus) streetStatus.textContent = 'Loading the street index.';
    try {
      const response = await fetch(manifest.streetProfiles.url);
      if (!response.ok) throw new Error(`street profiles ${response.status}`);
      const parsed = parseStreetProfiles(await response.json()) as StreetProfiles;
      if (generation !== streetLoadGeneration) return;
      streetData = parsed;
      if (streetInput) streetInput.disabled = false;
      if (state.street !== null) {
        const linked = streetById(parsed.streets, state.street) as StreetRecord | null;
        if (!linked) {
          if (streetStatus) {
            streetStatus.textContent = 'The linked street is not in this edition. Search another street.';
          }
          return;
        }
        selectStreet(linked, 'none', state.map === null);
      } else if (streetStatus) {
        streetStatus.textContent = `Search ${parsed.streets.length.toLocaleString('en-CA')} named streets.`;
      }
    } catch {
      if (generation !== streetLoadGeneration) return;
      if (streetStatus) {
        streetStatus.textContent = 'The street index could not load. Try again.';
      }
      if (streetRetry) streetRetry.hidden = false;
    }
  };

  streetInput?.addEventListener('input', () => {
    renderStreetResults(streetInput.value);
  });
  streetInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    currentStreetResults = [];
    streetResults?.replaceChildren();
    if (streetStatus) streetStatus.textContent = 'Search results cleared.';
  });
  root.querySelector<HTMLFormElement>('[data-fg04-street-form]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (currentStreetResults[0]) selectStreet(currentStreetResults[0]);
    });
  streetRetry?.addEventListener('click', () => void loadStreetData());
  void loadStreetData();

  const applyHour = (hour: number): void => {
    state = { ...state, hour };
    maps.forEach((entry) => {
      entry.failed = false;
      entry.stage?.setState('loading', `Loading shade at ${hour}:00 EDT`);
      entry.map.once('idle', () => {
        if (state.hour === hour && !entry.failed) entry.stage?.setState('ready');
      });
      const source = entry.map.getSource('shade') as maplibregl.RasterTileSource;
      source.setTiles([shadeTileTemplate(entry.surface, hour)]);
    });
    updateHourChrome(root, hour);
    if (activePoint) renderPointProfile(root, activePoint, hour, manifest);
    if (activeStreet && streetData) {
      renderStreetProfile(root, activeStreet, hour, streetData);
    }
  };

  input?.addEventListener('input', () => {
    const hour = Number(input.value);
    applyHour(hour);
    writeFg04History(window.history, 'replace', stateUrl(state), state);
  });
  input?.addEventListener('change', () => {
    if (state.hour === committedState.hour) return;
    const finalState = { ...state };
    writeFg04History(
      window.history, 'replace', stateUrl(committedState), committedState,
    );
    writeFg04History(window.history, 'push', stateUrl(finalState), finalState);
    committedState = finalState;
  });

  const replayUrlState = (): void => {
    const next = parseFg04State(window.location.search);
    state = next;
    committedState = { ...next };
    if (input) input.value = String(next.hour);
    applyHour(next.hour);

    if (next.point !== null) {
      const camera = next.map
        ?? [next.point[0], next.point[1], manifest.nativeZoom] as [number, number, number];
      maps[0]?.map.jumpTo({ center: [camera[0], camera[1]], zoom: camera[2] });
      selectPoint([next.point[0], next.point[1]], 'none');
      return;
    }

    if (next.street !== null) {
      clearPointSelection();
      const linked = streetData
        ? streetById(streetData.streets, next.street) as StreetRecord | null
        : null;
      if (linked) {
        if (next.map !== null) {
          maps[0]?.map.jumpTo({
            center: [next.map[0], next.map[1]], zoom: next.map[2],
          });
        }
        selectStreet(linked, 'none', next.map === null);
      } else if (streetStatus && streetData) {
        clearStreetSelection();
        streetStatus.textContent = 'The linked street is not in this edition. Search another street.';
      }
      return;
    }

    clearPointSelection();
    clearStreetSelection();
    if (next.map !== null) {
      maps[0]?.map.jumpTo({
        center: [next.map[0], next.map[1]], zoom: next.map[2],
      });
    } else {
      maps[0]?.map.fitBounds(
        [[manifest.bounds[0], manifest.bounds[1]], [manifest.bounds[2], manifest.bounds[3]]],
        { padding: 12, duration: 0 },
      );
    }
  };
  window.addEventListener('popstate', replayUrlState);

  const shareButton = root.querySelector<HTMLButtonElement>('[data-fg04-share]');
  const shareStatus = root.querySelector<HTMLElement>('[data-fg04-share-status]');
  let shareRestoreTimer = 0;
  shareButton?.addEventListener('click', async () => {
    window.clearTimeout(shareRestoreTimer);
    shareButton.setAttribute('aria-busy', 'true');
    const result = await copyFg04Url(window.location.href);
    const copied = result !== 'error';
    shareButton.textContent = copied ? 'Copied' : 'Copy failed';
    if (shareStatus) {
      shareStatus.textContent = copied
        ? 'View link copied.'
        : 'The view link could not be copied. Copy it from the address bar.';
    }
    shareButton.removeAttribute('aria-busy');
    shareRestoreTimer = window.setTimeout(() => {
      shareButton.textContent = 'Copy this view';
    }, 2500);
  });

  if (localTileOptIn()) {
    const diagnosticWindow = window as typeof window & {
      __fg04Explorer?: {
        maps: Array<{ map: maplibregl.Map; surface: string }>;
        errors: string[];
        getPointResult: () => PointProfile | null;
        getPointCacheSize: () => number;
        getStreetResult: () => StreetRecord | null;
        getStreetCount: () => number;
      };
    };
    diagnosticWindow.__fg04Explorer = {
      maps,
      errors: diagnosticErrors,
      getPointResult: () => activePoint,
      getPointCacheSize: () => pointCache.size,
      getStreetResult: () => activeStreet,
      getStreetCount: () => streetData?.streets.length ?? 0,
    };
  }

  const cleanupWindow = window as typeof window & {
    __fg04Cleanup?: () => void;
    __fg04Explorer?: unknown;
  };
  cleanupWindow.__fg04Cleanup = () => {
    window.removeEventListener('popstate', replayUrlState);
    window.clearTimeout(shareRestoreTimer);
    streetLoadGeneration += 1;
    stages.forEach((stage) => stage.destroy());
    maps.forEach(({ map }) => map.remove());
    maplibregl.removeProtocol('fg04shade');
    delete cleanupWindow.__fg04Explorer;
    delete cleanupWindow.__fg04Cleanup;
  };
}

if (typeof window !== 'undefined') {
  const lifecycleWindow = window as typeof window & {
    __fg04Cleanup?: () => void;
    __fg04Lifecycle?: boolean;
  };
  if (!lifecycleWindow.__fg04Lifecycle) {
    lifecycleWindow.__fg04Lifecycle = true;
    document.addEventListener('astro:before-swap', () => {
      lifecycleWindow.__fg04Cleanup?.();
    });
    document.addEventListener('astro:page-load', () => void initShadeMap());
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void initShadeMap());
  } else {
    void initShadeMap();
  }
}
