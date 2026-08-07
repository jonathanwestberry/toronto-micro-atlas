import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createMapStage } from './map-stage';
import {
  resolveFg04TileTemplate,
  selectedHourLayerContracts,
} from './fg04-core.mjs';
import { parseFg04State, serializeFg04State } from './fg04-state.mjs';

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
 * The count is drawn by MapLibre, not by us. The tiles are read as an
 * ordinary `raster-dem` source, and a `color-relief` layer runs the unpacked
 * value through the guide's ramp. No shader of our own, no tile loading of
 * our own.
 *
 * The tiles are built to ride MapLibre's default "mapbox" unpack,
 * `R*6553.6 + G*25.6 + B*0.1 - 10000`, with the shaded-hours count in red and
 * the hour bitmask in green and blue. The mask can add at most 6553.5, just
 * under one step of red, so each count owns a band of the unpacked value that
 * no other count reaches. The band edges come from the manifest.
 *
 * The obvious route was `encoding: "custom"` with blueFactor 1. The style
 * spec documents it and the validator accepts it, and it does not work:
 * MapLibre 5.24 sends `encoding` to the tile worker without the factors, so
 * the decoder runs with them undefined. Found by putting a garish ramp on the
 * layer and looking at what came back, which is also why `step` is not used
 * below: `color-relief-color` accepts a `step` expression and then paints
 * nothing at all.
 *
 * The ramp is read from CSS at runtime rather than written here. It was
 * decided in `src/styles/fg04.css` as --fg04-shade-1 to --fg04-shade-6 and
 * this map does not get to invent its own. Reading the computed values means
 * a change there moves the map, instead of the map holding a stale copy.
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
  tileSize: number;
  surfaces: string[];
  surfaceLabels: Record<string, string>;
  tileUrlTemplates: Record<string, string>;
  localTileUrlTemplates: Record<string, string>;
  demUnpack: Record<string, string | number>;
  countBandStarts: Record<string, number>;
  dawnHour: number;
  dawnNote: string;
  hourBits: Record<string, number>;
  classification: {
    tileUrlTemplate: string;
    localTileUrlTemplate: string;
    classBandStarts: Record<string, number>;
  };
}

const MANIFEST_URL = '/data/fg04/manifest.json';

/**
 * Count bands, matching the comments beside the tokens in fg04.css. A step
 * rather than a smooth interpolation because the ramp is six decisions, not a
 * gradient, and a reader matching a patch of ground to a legend swatch needs
 * the patch to actually be one of the six.
 *
 * The floor is 1, never 0: the 06:00 frame sits at 0.38 degrees above the
 * horizon and is shaded everywhere by construction, so no ground pixel in
 * Toronto scores zero.
 */
const BANDS: Array<{ from: number; token: string; label: string }> = [
  { from: 1, token: '--fg04-shade-1', label: '1' },
  { from: 2, token: '--fg04-shade-2', label: '2 to 4' },
  { from: 5, token: '--fg04-shade-3', label: '5 to 7' },
  { from: 8, token: '--fg04-shade-4', label: '8 to 10' },
  { from: 11, token: '--fg04-shade-5', label: '11 to 13' },
  { from: 14, token: '--fg04-shade-6', label: '14 to 15' },
];

/** Resolve the ramp from CSS, from an element inside the .fg04 scope. */
function readRamp(scope: Element): string[] {
  const styles = getComputedStyle(scope);
  return BANDS.map(({ token }) => {
    const value = styles.getPropertyValue(token).trim();
    if (!value) {
      throw new Error(
        `${token} is not defined on the .fg04 scope. The map reads the ramp `
        + 'from src/styles/fg04.css and does not carry its own copy.',
      );
    }
    return value;
  });
}

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

/**
 * A `color-relief-color` ramp with hard edges between the six bands.
 *
 * Built as an `interpolate` with a flat pair of stops per band rather than
 * the `step` this obviously wants, because `color-relief-color` validates a
 * `step` expression and then renders nothing. The plateaus give the same hard
 * edges: the reader matching a patch of ground to a legend swatch needs the
 * patch to actually be one of the six, not a point on a gradient.
 */
function reliefRamp(ramp: string[], bandStart: (count: number) => number): unknown[] {
  const expression: unknown[] = ['interpolate', ['linear'], ['elevation']];
  // A count of zero is not "never shaded", it is not ground: a roof, a tree
  // crown, the lake, or ground the flight never covered. Every figure in this
  // guide is a ground figure, so anything that is not ground shows the page
  // behind it rather than the lightest step of the ramp.
  expression.push(bandStart(0), 'rgba(0, 0, 0, 0)');
  expression.push(bandStart(1) - 0.001, 'rgba(0, 0, 0, 0)');
  BANDS.forEach((band, index) => {
    const from = bandStart(band.from);
    const next = index + 1 < BANDS.length
      ? bandStart(BANDS[index + 1].from)
      : bandStart(16);
    expression.push(from, ramp[index]);
    // Just inside the top of the band, so the colour is flat across it and
    // the change to the next colour happens in a hair rather than a gradient.
    expression.push(next - 0.001, ramp[index]);
  });
  return expression;
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
  ramp: string[],
  colors: SelectedColors,
  hour: number,
  camera: [number, number, number] | null,
): maplibregl.Map {
  const [west, south, east, north] = manifest.bounds;
  const bandStart = (count: number): number => {
    const value = manifest.countBandStarts[String(count)];
    if (value === undefined) {
      throw new Error(`the manifest has no band start for a count of ${count}`);
    }
    return value;
  };

  const sources: Record<string, unknown> = {
    shade: {
      type: 'raster-dem',
      tiles: [tileTemplate(manifest, surface)],
      tileSize: manifest.tileSize,
      minzoom: manifest.minZoom,
      maxzoom: manifest.maxZoom,
      encoding: 'mapbox',
    },
  };
  if (surface === 'corrected') {
    sources.classification = {
      type: 'raster-dem',
      tiles: [classificationTemplate(manifest)],
      tileSize: manifest.tileSize,
      minzoom: manifest.minZoom,
      maxzoom: manifest.maxZoom,
      encoding: 'mapbox',
    };
  }
  const selectedLayers = selectedHourLayerContracts(
    surface, hour, manifest, colors,
  );
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
          id: 'shade-count',
          type: 'color-relief',
          source: 'shade',
          layout: { visibility: 'none' },
          paint: {
            'color-relief-color': reliefRamp(ramp, bandStart) as never,
          },
        },
        ...(selectedLayers as never[]),
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

function localTileOptIn(): boolean {
  const localHost = window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1';
  const params = new URLSearchParams(window.location.search);
  return localHost && params.getAll('tiles').length === 1
    && params.get('tiles') === 'local';
}

function stateUrl(state: ReturnType<typeof parseFg04State>): string {
  const params = new URLSearchParams(serializeFg04State(state));
  if (localTileOptIn()) params.set('tiles', 'local');
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
}

export async function initShadeMap(): Promise<void> {
  const root = document.querySelector<HTMLElement>('[data-fg04-maps]');
  if (!root) return;

  const shells = Array.from(
    root.querySelectorAll<HTMLElement>('[data-map-stage]'),
  );
  const input = root.querySelector<HTMLInputElement>('[data-fg04-hour]');
  root.querySelector<HTMLFormElement>('[data-fg04-clock]')
    ?.addEventListener('submit', (event) => event.preventDefault());
  let state = parseFg04State(window.location.search);
  let committedState = { ...state };
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
    throw error;
  }

  const ramp = readRamp(root);
  const colors = readSelectedColors(root);
  const maps: Array<{ map: maplibregl.Map; surface: string }> = [];
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
      container, manifest, surface, ramp, colors, state.hour, state.map,
    );
    maps.push({ map, surface });

    const stage = createMapStage({ root: shell, map });
    map.on('load', () => stage?.setState('ready'));
    map.on('error', (event) => {
      diagnosticErrors.push(event.error?.message ?? 'unknown map error');
      stage?.setState('error', 'The shade tiles could not load.');
    });
  });

  syncCameras(maps.map(({ map }) => map), (camera) => {
    state = { ...state, map: camera };
    committedState = { ...committedState, map: camera };
    window.history.replaceState(null, '', stateUrl(state));
  });
  fillLegend(root, manifest);

  const applyHour = (hour: number): void => {
    state = { ...state, hour };
    maps.forEach(({ map, surface }) => {
      const layers = selectedHourLayerContracts(
        surface, hour, manifest, colors,
      );
      layers.forEach((layer) => {
        map.setPaintProperty(
          layer.id,
          'color-relief-color',
          layer.paint['color-relief-color'] as never,
        );
      });
    });
    updateHourChrome(root, hour);
  };

  input?.addEventListener('input', () => {
    const hour = Number(input.value);
    applyHour(hour);
    window.history.replaceState(null, '', stateUrl(state));
  });
  input?.addEventListener('change', () => {
    if (state.hour === committedState.hour) return;
    const finalState = { ...state };
    window.history.replaceState(null, '', stateUrl(committedState));
    window.history.pushState(null, '', stateUrl(finalState));
    committedState = finalState;
  });

  if (localTileOptIn()) {
    const diagnosticWindow = window as typeof window & {
      __fg04Explorer?: {
        maps: Array<{ map: maplibregl.Map; surface: string }>;
        errors: string[];
      };
    };
    diagnosticWindow.__fg04Explorer = { maps, errors: diagnosticErrors };
  }
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void initShadeMap());
  } else {
    void initShadeMap();
  }
}
