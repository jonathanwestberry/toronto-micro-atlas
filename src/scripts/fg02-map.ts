import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createMapStage } from './map-stage';
import { parseCameraFromSearch } from './map-url.mjs';

// ---------------------------------------------------------------------------
// Field Guide 02: Sidewalk Forest
//
// One MapLibre map drives both acts of the page. In story mode the map is a
// camera-driven stage behind the scrolly cards (pointer-events off); in
// explore mode it becomes a full tool: tap a tree, isolate a genus, search
// a street.
//
// Data model: below ~z13.5 the trees are exact-count raster renders (one dot
// per record, drawn at build time); above, full-density z13/z14 vector tiles
// take over, overzoomed for tapping. Chapter overlays crossfade between two
// image sources so swaps never flash.
// ---------------------------------------------------------------------------

// Nocturne map paints
const GROUND = 'hsl(150, 44%, 7%)';
const LAKE = 'hsl(188, 42%, 6%)';
const LAKE_SHORE = 'hsl(180, 24%, 17%)';
const STREET_MINOR = 'hsl(150, 20%, 14%)';
const STREET_MAJOR = 'hsl(150, 20%, 19%)';
const BOUNDARY = 'hsl(150, 16%, 32%)';

const CITY_BOUNDS: maplibregl.LngLatBoundsLike = [
  [-79.6393, 43.581],
  [-79.1153, 43.8555],
];
const FLOOR_PADDING = 30;
const MAXBOUNDS_SLACK = 1.002;
const FALLBACK_MIN_ZOOM = 8;
const WASH_BOUNDS: maplibregl.LngLatBoundsLike = [
  [-79.98, 43.3],
  [-78.72, 44.12],
];

// Raster -> vector crossfade window
const XF_LO = 13.2;
const XF_HI = 13.85;

// The selection source starts empty; a tap seats one point in it.
const EMPTY_FC = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const DESKTOP_QUERY = '(min-width: 768px)';

// District labels worth keeping on the nocturne map (sparse on purpose)
const LABEL_ALLOWLIST = new Set([
  'Lake Ontario',
  'Downtown',
  'Etobicoke',
  'Scarborough',
  'North York',
  'Don Valley',
  'Humber River',
]);

/** A street search hit. `id` is its index in streets.json and its `t` in the tiles. */
interface StreetHit {
  id: number;
  name: string;
  lng: number;
  lat: number;
  count: number;
}

interface Category {
  key: string;
  label: string;
  color: string;
  count: number;
}

interface Singleton {
  botanical: string;
  common: string;
  lng: number;
  lat: number;
  address: string;
}

interface Meta {
  total: number;
  distinctSpecies: number;
  categories: Category[];
  species: [string, string, number][];
  stats: Record<string, unknown>;
  singletons: Singleton[];
}

interface Chapter {
  /** matches data-chapter on the step element */
  id: string;
  /** overlay render key, e.g. 'cat-maple' | 'maples-norway' | null */
  overlay: string | null;
  /** base (all-trees) raster opacity while this chapter is active */
  baseOpacity: number;
  camera: 'city' | { center: [number, number]; zoom: number };
  /** circle-layer genus filter for high-zoom moments */
  circleGenus: number | null;
  markers?: 'singletons' | 'wards';
}

const CHAPTERS: Chapter[] = [
  { id: 'hero', overlay: null, baseOpacity: 1, camera: 'city', circleGenus: null },
  { id: 'ledger', overlay: null, baseOpacity: 1, camera: 'city', circleGenus: null },
  { id: 'one-in-four', overlay: 'cat-maple', baseOpacity: 0.16, camera: 'city', circleGenus: 0 },
  { id: 'import-flag', overlay: 'maples-norway', baseOpacity: 0.08, camera: 'city', circleGenus: 0 },
  { id: 'workhorse', overlay: 'cat-locust', baseOpacity: 0.12, camera: { center: [-79.3818, 43.6497], zoom: 13.3 }, circleGenus: 1 },
  { id: 'fossil', overlay: 'cat-ginkgo', baseOpacity: 0.12, camera: 'city', circleGenus: 8 },
  { id: 'elegy', overlay: 'cat-ash', baseOpacity: 0.08, camera: 'city', circleGenus: 9 },
  { id: 'one-of-each', overlay: null, baseOpacity: 0.25, camera: 'city', circleGenus: null, markers: 'singletons' },
  { id: 'thins', overlay: null, baseOpacity: 1, camera: 'city', circleGenus: null, markers: 'wards' },
  { id: 'find-yours', overlay: null, baseOpacity: 1, camera: 'city', circleGenus: null },
];

// Ward callouts for "Where the ledger thins" (2022-2026 ward system;
// names verified against the City's ward profiles).
const WARD_CALLOUTS = [
  // Anchored inside their wards but clear of the desktop story column. The
  // near-identical per-km2 figures under wildly different totals are the
  // chapter's whole point (the raw gap is ward area, not planting).
  { name: 'Etobicoke Centre', count: '52,659 trees', density: 'about the same, street for street', lng: -79.513, lat: 43.692 },
  { name: 'Downtown · Toronto Centre', count: '8,558 trees', density: 'about the same, street for street', lng: -79.369, lat: 43.667 },
];

function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function isDesktop(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

// ---------------------------------------------------------------------------

class SidewalkForest {
  private map: maplibregl.Map;
  private base: string;
  private meta: Meta | null = null;
  private renderBounds: [[number, number], [number, number], [number, number], [number, number]] | null = null;

  private mode: 'story' | 'explore' = 'story';
  private activeChapter = 'hero';
  private overlayFront: 'a' | 'b' = 'a';
  private overlayUrl: Record<'a' | 'b', string | null> = { a: null, b: null };
  private popup: maplibregl.Popup | null = null;

  private singletonMarkers: maplibregl.Marker[] = [];
  private wardMarkers: maplibregl.Marker[] = [];
  private streets: [string, number, number, number][] | null = null;
  private announcer: HTMLElement | null;
  private banner: HTMLElement | null;
  private statusTimer = 0;
  /** True while an event line is holding the banner against the zoom rule. */
  private statusHeld = false;
  private locatorEl: HTMLElement | null = null;
  private exploreControlsAdded = false;
  private scrollyEl: HTMLElement;
  private bloomRaf = 0;

  /** The live map, so the page can hand it to the shared MapStage. */
  get maplibreMap(): maplibregl.Map {
    return this.map;
  }

  /** Set by initSidewalkForest so the shared MapStage can report load state. */
  onReady: (() => void) | undefined;
  onDataError: ((error: unknown) => void) | undefined;

  /** Which narrowings are live. Composed into one filter, never overwritten. */
  private genusFilter: number | null = null;
  private streetFilter: number | null = null;

  /**
   * Told what the map is narrowed to, as one finished sentence, or null when
   * nothing is. A change the reader can only hear in a live region is a change
   * most readers never learn about.
   *
   * Family and street both report here. They used to differ: a street painted
   * a gold chip, a family wrote to the announcer and nothing else, so the same
   * act of dimming nine tenths of the map was accounted for or not depending
   * on which control you happened to use.
   */
  onNarrowed: ((sentence: string | null) => void) | undefined;

  /** Re-run the data load after the stage's Retry. */
  reloadLayers(): void {
    void this.addLayers();
  }

  constructor(container: HTMLElement, base: string, scrollyEl: HTMLElement) {
    this.base = base;
    this.scrollyEl = scrollyEl;
    this.announcer = document.getElementById('fg2-announcer');
    this.banner = document.getElementById('fg2-banner');

    this.map = new maplibregl.Map({
      container,
      style: { version: 8, sources: {}, layers: [
        { id: 'background', type: 'background', paint: { 'background-color': GROUND } },
      ] },
      bounds: CITY_BOUNDS,
      fitBoundsOptions: { padding: FLOOR_PADDING },
      maxBounds: WASH_BOUNDS,
      minZoom: FALLBACK_MIN_ZOOM,
      maxZoom: 18.5,
      dragRotate: false,
      pitchWithRotate: false,
      // Cooperative gestures removed; MapStage holds scroll-zoom back until the
      // reader interacts, and the /map route hands over everything.
      attributionControl: false,
    });
    this.map.touchZoomRotate.disableRotation();

    // Attribution moves to bottom-left, out of the corner it was sharing with
    // zoom. `compact` is left unset so MapLibre expands it where there is room
    // and collapses it only on narrow screens: the audit asked for attribution
    // uncollapsed "where space allows", and the reason its ⓘ was read as a help
    // button was that it was the only info affordance on the map. It no longer
    // is, so a compact button on a phone is honest rather than misleading.
    this.map.addControl(
      new maplibregl.AttributionControl({
        customAttribution: 'Tree data: City of Toronto Open Data · Map data © OpenStreetMap contributors',
      }),
      'bottom-left',
    );
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    this.map.on('load', () => {
      this.applyZoomLimits({ recenter: true });
      void this.addLayers();
    });
    this.map.on('resize', () => this.applyZoomLimits({ recenter: false }));
  }

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------

  /**
   * Fetch the inventory metadata and the render manifest, then build every
   * layer from them.
   *
   * The whole body is guarded. It used to be a bare `Promise.all` with no
   * `.ok` check and no `catch`, called as `void this.addLayers()`, so a 404 or
   * an offline reader got a rejected promise nobody was listening to and a map
   * that simply stayed empty. Both files are load-bearing: without them there
   * are no colours, no bounds, and no dots, so a failure here is a dead map and
   * gets the covering error state rather than `partial`.
   */
  private async addLayers(): Promise<void> {
    try {
      await this.loadLayers();
      this.onReady?.();
    } catch (error) {
      this.onDataError?.(error);
    }
  }

  private async loadLayers(): Promise<void> {
    const [metaRes, renderRes] = await Promise.all([
      fetch(`${this.base}data/fg02/meta.json`),
      fetch(`${this.base}data/fg02/r/render.json`),
    ]);
    // fetch only rejects on network failure; a 404 arrives as a perfectly happy
    // Response whose body is HTML, so .json() would throw somewhere far less
    // legible than here.
    if (!metaRes.ok || !renderRes.ok) {
      throw new Error(
        `Sidewalk Forest data unavailable (meta ${metaRes.status}, render ${renderRes.status})`,
      );
    }
    this.meta = (await metaRes.json()) as Meta;
    const rb = (await renderRes.json()) as { bounds: { west: number; south: number; east: number; north: number } };
    const { west, south, east, north } = rb.bounds;
    this.renderBounds = [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ];

    const src = (filename: string): maplibregl.GeoJSONSourceSpecification => ({
      type: 'geojson',
      data: `${this.base}data/${filename}`,
      buffer: 128,
      tolerance: 0.375,
    });

    this.map.addSource('lake', src('lake-ontario.geojson'));
    this.map.addSource('boundary', src('toronto-boundary.geojson'));
    this.map.addSource('outside', src('outside-mask.geojson'));
    this.map.addSource('streets-major', src('streets-major.geojson'));
    this.map.addSource('streets-minor', src('streets-minor.geojson'));

    this.map.addLayer({ id: 'lake', type: 'fill', source: 'lake', paint: { 'fill-color': LAKE } });
    this.map.addLayer({
      id: 'lake-shore', type: 'line', source: 'lake',
      paint: { 'line-color': LAKE_SHORE, 'line-width': 1 },
    });
    this.map.addLayer({
      id: 'streets-minor', type: 'line', source: 'streets-minor',
      paint: {
        'line-color': STREET_MINOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 16, 1.5],
      },
    });
    this.map.addLayer({
      id: 'streets-major', type: 'line', source: 'streets-major',
      paint: {
        'line-color': STREET_MAJOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 2.6],
      },
    });
    this.map.addLayer({
      id: 'outside-mask', type: 'fill', source: 'outside',
      paint: { 'fill-color': GROUND, 'fill-opacity': 0.82 },
    });
    this.map.addLayer({
      id: 'toronto-boundary', type: 'line', source: 'boundary',
      paint: { 'line-color': BOUNDARY, 'line-width': 1.5, 'line-opacity': 0.9 },
    });

    // Ward boundaries: hidden until the "A Question of Size" chapter, where
    // seeing the outlines (Etobicoke Centre six times Toronto Centre's area) is
    // the argument that the raw-count gap is geography, not planting.
    this.map.addSource('wards', src('city-wards.geojson'));
    // Dark casing under a bright dashed line so the outlines stay legible over
    // the dense, colourful dot field.
    this.map.addLayer({
      id: 'ward-lines-casing', type: 'line', source: 'wards',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': 'hsl(150, 45%, 4%)',
        'line-width': 4,
        'line-opacity': 0,
      },
    });
    this.map.addLayer({
      id: 'ward-lines', type: 'line', source: 'wards',
      paint: {
        'line-color': 'hsl(150, 12%, 78%)',
        'line-width': 1.5,
        'line-dasharray': [3, 2.5],
        'line-opacity': 0,
      },
    });
    for (const id of ['ward-lines-casing', 'ward-lines']) {
      this.map.setPaintProperty(id, 'line-opacity-transition', { duration: 400 });
    }

    // --- Tree rasters -------------------------------------------------------
    const coords = this.renderBounds;
    this.map.addSource('trees-base-lo', { type: 'image', url: `${this.base}data/fg02/r/base-lo.webp`, coordinates: coords });
    this.map.addSource('trees-base', { type: 'image', url: `${this.base}data/fg02/r/base.webp`, coordinates: coords });
    this.map.addSource('trees-ov-a', { type: 'image', url: `${this.base}data/fg02/r/base-lo.webp`, coordinates: coords });
    this.map.addSource('trees-ov-b', { type: 'image', url: `${this.base}data/fg02/r/base-lo.webp`, coordinates: coords });

    for (const id of ['trees-base-lo', 'trees-base', 'trees-ov-a', 'trees-ov-b']) {
      this.map.addLayer({
        id, type: 'raster', source: id,
        paint: {
          'raster-opacity': id === 'trees-base-lo' ? this.rasterOpacityExpr(1) : 0,
          'raster-fade-duration': 0,
          'raster-resampling': 'linear',
        },
      });
      this.map.setPaintProperty(id, 'raster-opacity-transition', { duration: 450 });
    }
    // The hi-res base takes over as soon as it has loaded.
    this.map.on('idle', this.promoteBaseOnce);

    // --- Vector tiles -------------------------------------------------------
    this.map.addSource('trees', {
      type: 'vector',
      tiles: [`${location.origin}${this.base}tiles/trees/{z}/{x}/{y}.pbf`],
      minzoom: 13,
      maxzoom: 14,
      bounds: [-79.6593, 43.561, -79.0953, 43.8755],
    });

    // Colour by genus: the small-int 'g' maps to a category hue, else slate.
    const colorMatch: unknown[] = ['match', ['get', 'g']];
    this.meta.categories.forEach((c, i) => { colorMatch.push(i, c.color); });
    colorMatch.push('#637388');
    const colorExpr = colorMatch as maplibregl.ExpressionSpecification;

    // Trunk-driven size. The ledger's DBH (cm) scales every dot so a veteran
    // reads larger than a sapling; interpolate clamps the ends, which also tames
    // the data's junk outliers (a 9380 cm "trunk" simply pins to the cap).
    const dbhFactor = (): unknown[] => [
      'interpolate', ['linear'], ['coalesce', ['get', 'd'], 18],
      5, 0.8,
      80, 2.0,
    ];
    const radius = (mult: number, add = 0): maplibregl.ExpressionSpecification =>
      ([
        'interpolate', ['linear'], ['zoom'],
        13.2, ['+', ['*', 1.6 * mult, dbhFactor()], add],
        14, ['+', ['*', 2.4 * mult, dbhFactor()], add],
        16, ['+', ['*', 5 * mult, dbhFactor()], add],
        18.5, ['+', ['*', 9 * mult, dbhFactor()], add],
      ] as unknown as maplibregl.ExpressionSpecification);
    const fadeIn = (peak: number): maplibregl.ExpressionSpecification =>
      (['interpolate', ['linear'], ['zoom'], XF_LO, 0, XF_HI, peak] as maplibregl.ExpressionSpecification);

    // Canopy glow: a soft, low-opacity halo under each dot so the street trees
    // read as luminous crowns at dusk. Cheap: the vector tiles only ever hand us
    // the culled on-screen subset at z13+.
    this.map.addLayer({
      id: 'trees-glow',
      type: 'circle',
      source: 'trees',
      'source-layer': 'trees',
      paint: {
        'circle-color': colorExpr,
        'circle-radius': radius(2.2),
        'circle-opacity': fadeIn(0.22),
        'circle-blur': 1,
      },
    });

    this.map.addLayer({
      id: 'trees-circles',
      type: 'circle',
      source: 'trees',
      'source-layer': 'trees',
      paint: {
        'circle-color': colorExpr,
        'circle-radius': radius(1),
        'circle-opacity': fadeIn(1),
        'circle-blur': 0.15,
      },
    });

    // Selection sits on its own one-feature source, independent of tile feature
    // ids (the vector tiles don't guarantee them). trees-bloom is the transient
    // ripple on tap; trees-selected is the steady gold ring the tapped tree keeps.
    this.map.addSource('sel', { type: 'geojson', data: EMPTY_FC });
    this.map.addLayer({
      id: 'trees-bloom',
      type: 'circle',
      source: 'sel',
      paint: {
        'circle-color': 'hsl(72, 62%, 62%)',
        'circle-radius': 0,
        'circle-opacity': 0,
        'circle-blur': 0.6,
      },
    });
    this.map.addLayer({
      id: 'trees-selected',
      type: 'circle',
      source: 'sel',
      paint: {
        'circle-color': 'transparent',
        'circle-radius': radius(1, 5),
        'circle-stroke-color': 'hsl(72, 62%, 62%)',
        'circle-stroke-width': 2,
      },
    });

    this.wireTreeTaps();
    this.wireKeyboard();
    void this.addDistrictLabels();
    this.buildMarkers();
    this.applyChapter(this.activeChapter, true);
  }

  /**
   * Keyboard path to the core interaction. The MapLibre canvas is focusable and
   * already pans with the arrow keys and zooms with +/-; this adds Enter to
   * identify the tree under the centre reticle, so a keyboard or switch user can
   * reach the same "what is this tree" answer a tap gives. Announced live.
   */
  private wireKeyboard(): void {
    const canvas = this.map.getCanvas();
    canvas.addEventListener('keydown', (e: KeyboardEvent) => {
      if (this.mode !== 'explore') return;
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (this.map.getZoom() < XF_HI) {
        this.map.easeTo({ zoom: 15.6, duration: prefersReducedMotion() ? 0 : 700 });
        this.showStatus('Zooming in. Press Enter again to identify the tree at the crosshair.');
        return;
      }
      const centre = this.map.getCenter();
      const pt = this.map.project(centre);
      const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
        [pt.x - 12, pt.y - 12],
        [pt.x + 12, pt.y + 12],
      ];
      const hits = this.map.queryRenderedFeatures(bbox, { layers: ['trees-circles'] });
      if (hits.length > 0) {
        this.openTreePopup(hits[0], centre, true);
      } else {
        this.showStatus('No tree at the crosshair. Use the arrow keys to move, or press plus to zoom in.', 3000);
      }
    });
    canvas.addEventListener('focus', () => this.scrollyEl.classList.add('fg2-map-focused'));
    canvas.addEventListener('blur', () => this.scrollyEl.classList.remove('fg2-map-focused'));
    // The stage focuses the canvas on the map's first idle, and with only a
    // background layer in the initial style that idle beats the tree data, so
    // it also beats these listeners. The reader arrived with the canvas focused
    // and no crosshair, and a second focus event was never coming.
    if (document.activeElement === canvas) this.scrollyEl.classList.add('fg2-map-focused');
  }

  private promoteBaseOnce = (): void => {
    if (this.map.getLayer('trees-base')) {
      this.map.setPaintProperty('trees-base', 'raster-opacity', this.rasterOpacityExpr(this.currentBaseOpacity));
      this.map.setPaintProperty('trees-base-lo', 'raster-opacity', 0);
      this.map.off('idle', this.promoteBaseOnce);
    }
  };

  private currentBaseOpacity = 1;

  /** Base/overlay rasters fade out across the vector crossfade window. */
  private rasterOpacityExpr(peak: number): maplibregl.ExpressionSpecification | number {
    if (peak === 0) return 0;
    return ['interpolate', ['linear'], ['zoom'], XF_LO, peak, XF_HI, peak * 0.05] as maplibregl.ExpressionSpecification;
  }

  // -------------------------------------------------------------------------
  // Chapter engine
  // -------------------------------------------------------------------------

  applyChapter(id: string, instant = false): void {
    const ch = CHAPTERS.find((c) => c.id === id);
    if (!ch || !this.map.getLayer('trees-base')) return;
    this.activeChapter = id;

    // Base raster
    this.currentBaseOpacity = ch.baseOpacity;
    this.map.setPaintProperty('trees-base', 'raster-opacity', this.rasterOpacityExpr(ch.baseOpacity));

    // Overlay crossfade
    this.setOverlay(ch.overlay);

    // Circle genus filter (matters on the downtown dive)
    this.setCircleGenus(ch.circleGenus);

    // Camera
    this.moveCamera(ch.camera, instant);

    // Markers
    this.showMarkerSet(ch.markers ?? null);

    // Ward outlines ride with the ward callouts.
    if (this.map.getLayer('ward-lines')) {
      const on = ch.markers === 'wards';
      this.map.setPaintProperty('ward-lines', 'line-opacity', on ? 0.95 : 0);
      this.map.setPaintProperty('ward-lines-casing', 'line-opacity', on ? 0.55 : 0);
    }
  }

  /** Swap the chapter overlay via A/B crossfade; url key like 'cat-maple'. */
  private setOverlay(key: string | null): void {
    const front = this.overlayFront;
    const back: 'a' | 'b' = front === 'a' ? 'b' : 'a';
    const frontId = `trees-ov-${front}`;
    const backId = `trees-ov-${back}`;

    if (key === null) {
      this.map.setPaintProperty(frontId, 'raster-opacity', 0);
      this.map.setPaintProperty(backId, 'raster-opacity', 0);
      return;
    }

    const url = `${this.base}data/fg02/r/${key}.webp`;
    if (this.overlayUrl[front] === url) {
      this.map.setPaintProperty(frontId, 'raster-opacity', this.rasterOpacityExpr(1));
      this.map.setPaintProperty(backId, 'raster-opacity', 0);
      return;
    }

    const backSrc = this.map.getSource(backId) as maplibregl.ImageSource;
    backSrc.updateImage({ url, coordinates: this.renderBounds! });
    this.overlayUrl[back] = url;
    // Give the texture a beat to decode before fading it in.
    window.setTimeout(() => {
      this.map.setPaintProperty(backId, 'raster-opacity', this.rasterOpacityExpr(1));
      this.map.setPaintProperty(frontId, 'raster-opacity', 0);
    }, 120);
    this.overlayFront = back;
  }

  private setCircleGenus(genus: number | null): void {
    this.genusFilter = genus;
    this.applyCircleFilter();
  }

  /**
   * Genus and street are two independent ways to narrow the same dots, so the
   * filter is composed rather than overwritten. Searching a street clears the
   * genus first (see isolateStreet): two overlapping narrowings leave a reader
   * unable to attribute what they are seeing to either one.
   */
  private applyCircleFilter(): void {
    if (!this.map.getLayer('trees-circles')) return;
    const clauses: unknown[] = [];
    if (this.genusFilter !== null) clauses.push(['==', ['get', 'g'], this.genusFilter]);
    if (this.streetFilter !== null) clauses.push(['==', ['get', 't'], this.streetFilter]);
    this.map.setFilter(
      'trees-circles',
      clauses.length === 0
        ? null
        : (clauses.length === 1
            ? clauses[0]
            : ['all', ...clauses]) as maplibregl.FilterSpecification,
    );
  }

  /**
   * Show only the trees on one street.
   *
   * Searching a street used to ease the camera and stop there, which left the
   * reader in front of an unchanged field of dots with no way to tell which of
   * them were the answer. Now the answer is the only thing drawn in full: the
   * rest of the inventory drops to the dim base raster for context.
   */
  isolateStreet(id: number, name: string, count: number): void {
    this.clearSelection();
    this.streetFilter = id;
    this.genusFilter = null;
    this.currentBaseOpacity = 0.12;
    this.map.setPaintProperty('trees-base', 'raster-opacity', this.rasterOpacityExpr(0.12));
    this.setOverlay(null);
    this.applyCircleFilter();
    document.querySelectorAll<HTMLButtonElement>('.fg2-legend button[data-genus]')
      .forEach((b) => b.setAttribute('aria-pressed', 'false'));
    const sentence = `Showing ${name} only, ${count.toLocaleString('en-CA')} trees. Everything else is dimmed.`;
    this.onNarrowed?.(sentence);
    this.showStatus(sentence);
  }

  private moveCamera(camera: Chapter['camera'], instant: boolean): void {
    const opts: maplibregl.EaseToOptions =
      camera === 'city'
        ? (() => {
            const cam = this.map.cameraForBounds(CITY_BOUNDS, { padding: this.cityPadding() });
            return cam ? { center: cam.center, zoom: cam.zoom } : {};
          })()
        : { center: camera.center, zoom: camera.zoom };

    if (instant || prefersReducedMotion()) {
      this.map.jumpTo(opts as maplibregl.JumpToOptions);
    } else {
      this.map.easeTo({ ...opts, duration: 1400, essential: false });
    }
  }

  private cityPadding(): maplibregl.PaddingOptions | number {
    // Desktop story cards sit left; bias the city fit right so the glow
    // isn't hidden behind the column.
    if (isDesktop() && this.mode === 'story') {
      return { top: 40, right: 60, bottom: 40, left: 320 };
    }
    return FLOOR_PADDING;
  }

  // -------------------------------------------------------------------------
  // Explore mode
  // -------------------------------------------------------------------------

  setMode(mode: 'story' | 'explore'): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.scrollyEl.dataset.mode = mode;
    if (mode === 'explore') {
      this.applyChapter('find-yours');
      this.addExploreControls();
      // The zoom rule takes over as soon as this one expires, so the reader
      // never has to remember the greeting to know what the dots will do.
      this.showStatus('Explorer active. Zoom in until dots separate, then tap a tree to identify it.');
      // Zoom changes what a click can do, so it changes what the banner says.
      this.map.on('zoom', this.onZoomForStatus);
    } else {
      this.map.off('zoom', this.onZoomForStatus);
      this.isolate(null);
      this.popup?.remove();
      this.paintBanner('', 'idle');
    }
  }

  private onZoomForStatus = (): void => {
    if (!this.statusHeld) this.restStatus();
  };

  /*
   * enterExplore / exitExplore are gone.
   *
   * The explorer used to be a full-screen takeover driven by a class toggle and
   * a body scroll lock, which meant the most useful view in the guide had no
   * URL: it could not be linked, bookmarked, or returned to with Back, and it
   * needed a focus trap because the whole story stayed live underneath it.
   *
   * It is now /guides/sidewalk-forest/map, a real page that starts in explore
   * mode. The takeover machinery, the scroll lock, and the focus trap it would
   * have required all go away with it.
   */

  /** Swap only the overlay raster (the maple chapter's in-card toggle). */
  applyChapterOverlayOnly(key: string): void {
    this.setOverlay(key);
  }

  /**
   * Legend isolation: null restores all categories, and is also the single
   * "show all trees" used by the chip, both reset buttons and the story exit,
   * whichever narrowing is live.
   */
  isolate(genus: number | null): void {
    if (!this.meta) return;
    this.clearSelection();
    // Picking a family is a new question, so it drops any street narrowing
    // rather than silently intersecting with it.
    const wasNarrowed = this.streetFilter !== null || this.genusFilter !== null;
    this.streetFilter = null;
    if (genus === null) {
      this.map.setPaintProperty('trees-base', 'raster-opacity', this.rasterOpacityExpr(1));
      this.currentBaseOpacity = 1;
      this.setOverlay(null);
      this.setCircleGenus(null);
      this.onNarrowed?.(null);
      if (wasNarrowed) this.showStatus('Showing every street tree again.');
    } else {
      const cat = this.meta.categories[genus];
      this.currentBaseOpacity = 0.12;
      this.map.setPaintProperty('trees-base', 'raster-opacity', this.rasterOpacityExpr(0.12));
      this.setOverlay(`cat-${cat.key}`);
      this.setCircleGenus(genus);
      const sentence = `Showing ${cat.label} only, ${cat.count.toLocaleString('en-CA')} trees. Everything else is dimmed.`;
      this.onNarrowed?.(sentence);
      this.showStatus(sentence);
    }
    document.querySelectorAll<HTMLButtonElement>('.fg2-legend button[data-genus]').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.genus) === genus));
    });
  }

  resetView(): void {
    this.isolate(null);
    this.popup?.remove();
    const cam = this.map.cameraForBounds(CITY_BOUNDS, { padding: this.cityPadding() });
    if (cam) {
      if (prefersReducedMotion()) this.map.jumpTo({ center: cam.center, zoom: cam.zoom });
      else this.map.easeTo({ center: cam.center, zoom: cam.zoom, duration: 900 });
    }
  }

  // --- Tap a tree -----------------------------------------------------------

  private wireTreeTaps(): void {
    this.map.on('click', (e) => {
      if (this.mode !== 'explore') return;

      const zoom = this.map.getZoom();
      if (zoom < XF_HI) {
        // Dots aren't individually resolvable yet: dive toward the tap.
        this.map.easeTo({ center: e.lngLat, zoom: 15.4, duration: prefersReducedMotion() ? 0 : 900 });
        return;
      }

      const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - 8, e.point.y - 8],
        [e.point.x + 8, e.point.y + 8],
      ];
      const hits = this.map.queryRenderedFeatures(bbox, { layers: ['trees-circles'] });
      if (hits.length === 0) {
        // A miss used to be a silent no-op, which reads as a broken map rather
        // than as a near miss. Short hold: this is a correction, not news.
        this.showStatus('No tree there. Try tapping a dot directly.', 2000);
        return;
      }
      this.openTreePopup(hits[0], e.lngLat);
    });

    this.map.on('mousemove', (e) => {
      if (this.mode !== 'explore' || this.map.getZoom() < XF_HI) return;
      const hits = this.map.queryRenderedFeatures(e.point, { layers: ['trees-circles'] });
      this.map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
    });
  }

  private openTreePopup(
    feature: maplibregl.MapGeoJSONFeature,
    lngLat: maplibregl.LngLat,
    focus = false,
  ): void {
    if (!this.meta) return;
    const p = feature.properties as { g: number; s: number; d?: number; a?: string };
    const sp = this.meta.species[p.s];
    if (!sp) return;
    const [botanical, commonRaw] = sp;
    const common = formatCommonName(commonRaw);
    const geom = feature.geometry;
    const coords = geom.type === 'Point' ? (geom.coordinates as [number, number]) : [lngLat.lng, lngLat.lat];

    const el = document.createElement('div');
    const h = document.createElement('p');
    h.className = 'fg2-pop-common';
    h.textContent = common;
    const b = document.createElement('p');
    b.className = 'fg2-pop-botanical';
    b.textContent = botanical;
    const m = document.createElement('p');
    m.className = 'fg2-pop-meta';
    const bits: string[] = [];
    if (typeof p.d === 'number') bits.push(`Trunk ${p.d} cm across`);
    if (p.a) bits.push(p.a);
    m.textContent = bits.join(' · ');
    const a = document.createElement('a');
    a.className = 'fg2-pop-maps';
    a.href = `https://www.google.com/maps?q=${coords[1]},${coords[0]}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Open in Maps';
    el.append(h, b, m, a);

    this.popup?.remove();
    this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px', offset: 10 })
      .setLngLat([coords[0], coords[1]])
      .setDOMContent(el)
      .addTo(this.map);
    this.popup.on('close', () => this.clearSelection());
    this.selectTree([coords[0], coords[1]], p.d, p.g);

    this.showStatus(`${common}. ${botanical}. ${bits.join('. ')}`);

    // Keyboard-opened popups move focus into the popup so the answer, the map
    // link, and dismissal are all reachable without a pointer.
    if (focus) {
      const closeBtn = this.popup
        .getElement()
        ?.querySelector<HTMLButtonElement>('.maplibregl-popup-close-button');
      closeBtn?.focus();
    }
  }

  // --- Grow-on-tap: bloom + ring --------------------------------------------

  /** Light up the tapped tree: seat the ring on it and fire the bloom ripple. */
  private selectTree(coords: [number, number], d: number | undefined, g: number): void {
    const src = this.map.getSource('sel') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: { d: d ?? 18, g } },
      ],
    } as GeoJSON.FeatureCollection);
    this.bloom(d);
  }

  /** A one-shot gold ripple, scaled up for bigger trunks. */
  private bloom(d: number | undefined): void {
    if (!this.map.getLayer('trees-bloom')) return;
    cancelAnimationFrame(this.bloomRaf);
    if (prefersReducedMotion()) {
      this.map.setPaintProperty('trees-bloom', 'circle-opacity', 0);
      return;
    }
    const peak = 30 * dbhFactorJs(d);
    const start = performance.now();
    const dur = 480;
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      this.map.setPaintProperty('trees-bloom', 'circle-radius', 4 + eased * peak);
      this.map.setPaintProperty('trees-bloom', 'circle-opacity', 0.5 * (1 - t));
      if (t < 1) this.bloomRaf = requestAnimationFrame(step);
      else this.map.setPaintProperty('trees-bloom', 'circle-opacity', 0);
    };
    this.bloomRaf = requestAnimationFrame(step);
  }

  private clearSelection(): void {
    cancelAnimationFrame(this.bloomRaf);
    const src = this.map.getSource('sel') as maplibregl.GeoJSONSource | undefined;
    src?.setData(EMPTY_FC);
    if (this.map.getLayer('trees-bloom')) this.map.setPaintProperty('trees-bloom', 'circle-opacity', 0);
  }

  // --- Street search ---------------------------------------------------------

  /**
   * A hit carries its index in streets.json, which is the same id the tiles
   * store in `t`. That is what lets a search result isolate its own trees.
   */
  async searchStreets(query: string): Promise<StreetHit[]> {
    const streets = await this.loadStreets();
    if (!streets) return [];
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const starts: StreetHit[] = [];
    const contains: StreetHit[] = [];
    streets.forEach(([name, lng, lat, count], id) => {
      if (starts.length >= 8) return;
      const lower = name.toLowerCase();
      if (lower.startsWith(q)) starts.push({ id, name, lng, lat, count });
      else if (lower.includes(q)) contains.push({ id, name, lng, lat, count });
    });
    return [...starts, ...contains].slice(0, 8);
  }

  /**
   * The street table, fetched once and shared by search and the locator chip.
   * Null on failure: search degrades to no results and the locator stays
   * hidden, neither of which is worth an error state over.
   */
  private async loadStreets(): Promise<[string, number, number, number][] | null> {
    if (this.streets) return this.streets;
    try {
      const res = await fetch(`${this.base}data/fg02/streets.json`);
      if (!res.ok) return null;
      this.streets = (await res.json()) as [string, number, number, number][];
      return this.streets;
    } catch {
      return null;
    }
  }

  /** Fly to a search hit. isolateStreet, called right after, does the talking. */
  goToStreet(lng: number, lat: number): void {
    this.map.easeTo({ center: [lng, lat], zoom: 15.4, duration: prefersReducedMotion() ? 0 : 1100 });
  }

  // -------------------------------------------------------------------------
  // Markers
  // -------------------------------------------------------------------------

  private buildMarkers(): void {
    if (!this.meta) return;

    for (const s of this.meta.singletons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fg2-single fg2-marker-hidden';
      btn.setAttribute('aria-label', `${formatCommonName(s.common)}, the only one in the inventory, near ${s.address}`);
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.openSingletonPopup(s);
      });
      // The button itself is the marker root; MapLibre positions it and we
      // keep its own role and label intact.
      const marker = new maplibregl.Marker({ element: btn, anchor: 'center' })
        .setLngLat([s.lng, s.lat])
        .addTo(this.map);
      this.singletonMarkers.push(marker);
    }

    for (const w of WARD_CALLOUTS) {
      const el = document.createElement('div');
      el.className = 'fg2-ward-label fg2-marker-hidden';
      el.setAttribute('aria-hidden', 'true');
      const count = document.createElement('span');
      count.className = 'fg2-ward-count';
      count.textContent = w.count;
      const density = document.createElement('span');
      density.className = 'fg2-ward-density';
      density.textContent = w.density;
      const name = document.createElement('span');
      name.className = 'fg2-ward-name';
      name.textContent = w.name;
      el.append(count, density, name);
      this.wardMarkers.push(
        new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([w.lng, w.lat])
          .addTo(this.map),
      );
    }
  }

  private openSingletonPopup(s: Singleton): void {
    const el = document.createElement('div');
    const h = document.createElement('p');
    h.className = 'fg2-pop-common';
    h.textContent = formatCommonName(s.common);
    const b = document.createElement('p');
    b.className = 'fg2-pop-botanical';
    b.textContent = s.botanical;
    const m = document.createElement('p');
    m.className = 'fg2-pop-meta';
    m.textContent = `The only one in the ledger · ${s.address}`;
    el.append(h, b, m);
    this.popup?.remove();
    this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px', offset: 12 })
      .setLngLat([s.lng, s.lat])
      .setDOMContent(el)
      .addTo(this.map);
  }

  private showMarkerSet(set: 'singletons' | 'wards' | null): void {
    const toggle = (markers: maplibregl.Marker[], on: boolean) => {
      for (const m of markers) {
        const el = m.getElement();
        el.classList.toggle('fg2-marker-shown', on);
        el.classList.toggle('fg2-marker-hidden', !on);
      }
    };
    toggle(this.singletonMarkers, set === 'singletons');
    toggle(this.wardMarkers, set === 'wards');
    if (set !== 'singletons' && this.popup) this.popup.remove();
  }

  // --- District labels -------------------------------------------------------

  private async addDistrictLabels(): Promise<void> {
    try {
      const res = await fetch(`${this.base}data/orientation-labels.geojson`);
      if (!res.ok) return;
      const collection = (await res.json()) as {
        features: { geometry: { coordinates: [number, number] }; properties: { name: string; kind: string } }[];
      };
      for (const f of collection.features) {
        if (!LABEL_ALLOWLIST.has(f.properties.name)) continue;
        const el = document.createElement('div');
        el.className = `fg2-olabel fg2-olabel--${f.properties.kind}`;
        el.textContent = f.properties.name;
        el.setAttribute('aria-hidden', 'true');
        new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat(f.geometry.coordinates)
          .addTo(this.map);
      }
    } catch {
      // decorative; fail silently
    }
  }

  // -------------------------------------------------------------------------
  // Zoom limits (FG01's measured-floor approach)
  // -------------------------------------------------------------------------

  private applyZoomLimits(options: { recenter: boolean }): void {
    const cam = this.map.cameraForBounds(CITY_BOUNDS, { padding: FLOOR_PADDING });
    if (!cam || typeof cam.zoom !== 'number' || !Number.isFinite(cam.zoom)) return;

    const restore = { center: this.map.getCenter(), zoom: this.map.getZoom() };
    this.map.setMaxBounds(null);
    this.map.jumpTo({ center: cam.center, zoom: cam.zoom });
    const floor = this.map.getBounds();
    this.map.setMinZoom(cam.zoom - 0.05);
    this.map.setMaxBounds(this.padBounds(floor, MAXBOUNDS_SLACK));

    if (options.recenter) {
      const fit = this.map.cameraForBounds(CITY_BOUNDS, { padding: this.cityPadding() });
      if (fit) this.map.jumpTo({ center: fit.center, zoom: fit.zoom });
    } else {
      this.map.jumpTo(restore);
    }
  }

  private padBounds(b: maplibregl.LngLatBounds, f: number): maplibregl.LngLatBoundsLike {
    const w = b.getWest(); const e = b.getEast();
    const s = b.getSouth(); const n = b.getNorth();
    const cx = (w + e) / 2; const cy = (s + n) / 2;
    return [
      [cx - (cx - w) * f, cy - (cy - s) * f],
      [cx + (e - cx) * f, cy + (n - cy) * f],
    ];
  }

  /**
   * Say something once, in both registers.
   *
   * Everything this map had to report went to #fg2-announcer alone, which is
   * clipped to a one-pixel box: the strings were good and almost nobody read
   * them. The banner is the same words, on screen. After `holdMs` the banner
   * falls back to the standing rule for the current zoom, so a message never
   * outlives the moment it described.
   */
  private showStatus(message: string, holdMs = 4200): void {
    if (this.announcer) this.announcer.textContent = message;
    window.clearTimeout(this.statusTimer);
    if (this.mode !== 'explore') return;
    this.statusHeld = true;
    this.paintBanner(message, 'event');
    this.statusTimer = window.setTimeout(() => {
      this.statusHeld = false;
      this.restStatus();
    }, holdMs);
  }

  /**
   * The banner's resting text: what the dots will do if you touch them right
   * now. Below the crossfade a click cannot resolve one tree, so it dives
   * instead, and nothing on screen said so.
   */
  private restStatus(): void {
    if (this.mode !== 'explore') {
      this.paintBanner('', 'idle');
      return;
    }
    this.paintBanner(
      this.map.getZoom() < XF_HI
        ? 'Too far out to pick a single tree. Zoom in, or click anywhere to jump closer.'
        : 'Tap any dot to identify it.',
      'idle',
    );
  }

  private paintBanner(message: string, tone: 'idle' | 'event'): void {
    if (!this.banner) return;
    this.banner.textContent = message;
    this.banner.dataset.tone = tone;
    this.banner.hidden = message === '';
  }

  // --- Where am I ------------------------------------------------------------

  /**
   * Scale bar and street readout, added on the way into explore mode rather
   * than in the constructor: the story map is a camera the reader never
   * drives, and measurement furniture on it is decoration.
   */
  private addExploreControls(): void {
    if (this.exploreControlsAdded) return;
    this.exploreControlsAdded = true;

    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');

    // Chosen over map labels because the style carries no glyph endpoint, and
    // because the tiles already answer the question directly: every tree knows
    // its street, so the trees around the centre of the screen are the most
    // reliable statement of where the centre of the screen is.
    const locator = document.createElement('div');
    locator.className = 'fg2-locator maplibregl-ctrl';
    locator.hidden = true;
    this.locatorEl = locator;
    this.map.addControl(
      { onAdd: () => locator, onRemove: () => locator.remove() } as maplibregl.IControl,
      'bottom-left',
    );

    this.map.on('moveend', this.updateLocator);
    void this.updateLocator();
  }

  private updateLocator = async (): Promise<void> => {
    const el = this.locatorEl;
    if (!el) return;
    if (this.mode !== 'explore' || this.map.getZoom() < XF_HI) {
      el.hidden = true;
      return;
    }
    // The glow layer, not the circles: circles carry the family and street
    // filters, so once the reader narrows anything the answer would go blank
    // exactly when knowing where you are matters most.
    const c = this.map.project(this.map.getCenter());
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [c.x - 60, c.y - 60],
      [c.x + 60, c.y + 60],
    ];
    // The nearest tree, not the most common street in the box. A wide box on a
    // downtown grid holds four or five streets, and the busiest of them is
    // often the one you are not standing on: searching Ossington and being told
    // "near Concord" is worse than no readout at all.
    let best = -1;
    let bestDist = Infinity;
    for (const f of this.map.queryRenderedFeatures(box, { layers: ['trees-glow'] })) {
      const t = (f.properties as { t?: number }).t;
      if (typeof t !== 'number' || f.geometry.type !== 'Point') continue;
      const [lng, lat] = f.geometry.coordinates as [number, number];
      const pt = this.map.project([lng, lat]);
      const dist = (pt.x - c.x) ** 2 + (pt.y - c.y) ** 2;
      if (dist < bestDist) { bestDist = dist; best = t; }
    }
    if (best < 0) {
      el.hidden = true;
      return;
    }
    const streets = await this.loadStreets();
    const row = streets?.[best];
    if (!row) {
      el.hidden = true;
      return;
    }
    el.textContent = `Near ${row[0]}`;
    el.hidden = false;
  };

  destroy(): void {
    try { this.map.remove(); } catch { /* already gone */ }
  }
}

/** Mirror of the map's DBH size expression: trunk cm -> radius multiplier. */
function dbhFactorJs(d: number | undefined): number {
  const v = typeof d === 'number' ? d : 18;
  const c = Math.max(5, Math.min(80, v));
  return 0.8 + ((c - 5) / 75) * 1.2;
}

/** 'Maple, Norway' -> 'Norway maple'; 'Ginkgo' stays 'Ginkgo'. */
function formatCommonName(raw: string): string {
  if (!raw.includes(',')) return raw;
  const [family, qualifier] = raw.split(',', 2).map((s) => s.trim());
  if (!qualifier) return family;
  return `${qualifier.charAt(0).toUpperCase()}${qualifier.slice(1)} ${family.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Page wiring
// ---------------------------------------------------------------------------

export interface InitSidewalkForestOptions {
  /** True on /guides/sidewalk-forest/map: the explorer is the whole page. */
  expanded?: boolean;
}

/**
 * Roots already mounted.
 *
 * The map routes call boot() directly and also register it for
 * `astro:page-load`, which the ClientRouter fires on a first load too, so this
 * ran twice on every visit to /guides/sidewalk-forest/map. The second run
 * rebuilt the map (mapEl is emptied first, so only one canvas ever appeared)
 * but bound a second listener to every control outside the map element: the
 * Families legend, the panel toggle and "How to read this map" each fired
 * twice per click and toggled straight back off. On a phone that left a
 * sealed panel with no search, no key, no reset and no help.
 *
 * Keyed on the element, so a real client-side navigation to a fresh DOM still
 * mounts. fg03 has guarded this way from the start.
 */
const mountedRoots = new WeakSet<HTMLElement>();

export function initSidewalkForest(options: InitSidewalkForestOptions = {}): void {
  const mapEl = document.getElementById('fg2-map');
  const scrollyEl = document.querySelector<HTMLElement>('.fg2-scrolly');
  if (!mapEl || !scrollyEl) return;
  if (mountedRoots.has(mapEl)) return;
  mountedRoots.add(mapEl);

  const expanded = options.expanded ?? false;

  mapEl.replaceChildren();

  const rawBase = import.meta.env.BASE_URL;
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  const forest = new SidewalkForest(mapEl, base, scrollyEl);

  // --- Shared map stage ------------------------------------------------------
  const map = forest.maplibreMap;
  const stage = createMapStage({
    map,
    expanded,
    // Story mode is scrollytelling: the scroll drives the chapters and the map
    // is the camera they move. There is no reading of a scroll here that means
    // "zoom", so the embedded stage never takes one. Driving the map yourself
    // is what /guides/sidewalk-forest/map is for.
    gestures: expanded ? 'gated' : 'inert',
    expandPath: expanded ? undefined : `${base}guides/sidewalk-forest/map`.replace(/\/{2,}/g, '/'),
    onRetry: () => forest.reloadLayers(),
  });

  // Both files are load-bearing, so a failure is a dead map, not a partial one.
  forest.onReady = () => stage?.setState('ready');
  forest.onDataError = () =>
    stage?.setState(
      'error',
      'The street tree data could not be loaded. Retry, or read the guide for the short version.',
    );

  if (expanded) {
    // The explorer is the page here: tap-to-identify and the keyboard reticle
    // are live from the first frame, with no story to scroll through first.
    forest.setMode('explore');
    map.once('idle', () => stage?.focusMap());
  }

  const camera = parseCameraFromSearch(window.location.search);
  if (camera !== null) {
    const [lng, lat, zoom] = camera;
    map.once('load', () => map.jumpTo({ center: [lng, lat], zoom }));
  }

  // --- Scrolly steps ---------------------------------------------------------
  const steps = Array.from(document.querySelectorAll<HTMLElement>('.fg2-step'));
  const stepIO = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = (entry.target as HTMLElement).dataset.chapter;
        if (!id) continue;
        steps.forEach((s) => s.classList.toggle('is-active', s === entry.target));
        forest.applyChapter(id);
        // Re-entering the chapter repaints the Norway overlay, so the toggle's
        // own copy has to come back with it or the caption starts lying.
        if (id === 'import-flag' && mapleShowing !== 'norway') {
          mapleShowing = 'norway';
          paintMaple();
        }
      }
    },
    { rootMargin: '-45% 0px -45% 0px' },
  );
  steps.forEach((s) => stepIO.observe(s));

  // The explorer is opened as a full-screen takeover by the "Explore" buttons
  // (wired below), not by scrolling a sentinel into view.

  // --- Maple toggle ----------------------------------------------------------
  //
  // The button says what pressing it will do, which is the opposite of what is
  // on the map, and it was the only text near the toggle. A reader arriving
  // mid-chapter read "Show the sugar maples" over a field of dots and had no
  // way to know those dots were the Norway ones. The caption states the
  // present tense; the button keeps the future.
  const MAPLE_COPY = {
    norway: { button: 'Show the sugar maples', state: 'On the map: Norway maples, 69,474' },
    sugar: { button: 'Show the Norway maples', state: 'On the map: sugar maples, 11,325' },
  } as const;
  const mapleBtn = document.getElementById('fg2-maple-toggle');
  const mapleState = document.getElementById('fg2-maple-state');
  let mapleShowing: 'norway' | 'sugar' = 'norway';
  const paintMaple = (): void => {
    if (mapleBtn) mapleBtn.textContent = MAPLE_COPY[mapleShowing].button;
    if (mapleState) mapleState.textContent = MAPLE_COPY[mapleShowing].state;
  };
  if (mapleBtn) {
    mapleBtn.addEventListener('click', () => {
      mapleShowing = mapleShowing === 'norway' ? 'sugar' : 'norway';
      forest.applyChapterOverlayOnly(`maples-${mapleShowing}`);
      paintMaple();
    });
    paintMaple();
  }

  // The "Explore" and "Back" controls are plain links to and from
  // /guides/sidewalk-forest/map now, so there is nothing to wire here. Only the
  // in-map reset stays a button, because it changes the view rather than the page.
  document.getElementById('fg2-reset')?.addEventListener('click', () => forest.resetView());

  // Panel collapse (matters most on phones, where the panel is a bottom sheet)
  const panelToggle = document.getElementById('fg2-panel-toggle');
  const panel = document.getElementById('fg2-panel');
  const expandPanel = (): void => {
    if (!panel || !panelToggle) return;
    panel.classList.remove('is-collapsed');
    panelToggle.setAttribute('aria-expanded', 'true');
  };
  if (panelToggle && panel) {
    panelToggle.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('is-collapsed');
      panelToggle.setAttribute('aria-expanded', String(!collapsed));
    });
    // Phones start collapsed so the map is tappable immediately.
    if (!isDesktop()) {
      panel.classList.add('is-collapsed');
      panelToggle.setAttribute('aria-expanded', 'false');
    }
  }

  // --- Legend -----------------------------------------------------------------
  document.querySelectorAll<HTMLButtonElement>('.fg2-legend button[data-genus]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const genus = Number(btn.dataset.genus);
      const active = btn.getAttribute('aria-pressed') === 'true';
      forest.isolate(active ? null : genus);
    });
  });
  document.getElementById('fg2-legend-reset')?.addEventListener('click', () => forest.isolate(null));

  // --- Street search ------------------------------------------------------------
  const input = document.getElementById('fg2-street-input') as HTMLInputElement | null;
  const results = document.getElementById('fg2-street-results');
  if (input && results) {
    let seq = 0;
    input.addEventListener('input', async () => {
      const mySeq = ++seq;
      const rows = await forest.searchStreets(input.value);
      if (mySeq !== seq) return;
      results.replaceChildren(
        ...rows.map(({ id, name, lng, lat, count }) => {
          const li = document.createElement('li');
          const b = document.createElement('button');
          b.type = 'button';
          const label = document.createElement('span');
          label.textContent = name;
          const c = document.createElement('span');
          c.className = 'fg2-search-count';
          c.textContent = `${count.toLocaleString('en-CA')} trees`;
          b.append(label, c);
          b.addEventListener('click', () => {
            forest.goToStreet(lng, lat);
            forest.isolateStreet(id, name, count);
            results.replaceChildren();
            input.value = name;
          });
          li.appendChild(b);
          return li;
        }),
      );
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') results.replaceChildren();
    });
  }

  // Search's permanent door on phones, where the panel starts shut. It has to
  // do both halves of the job: open the drawer and land the caret, or the
  // reader arrives at an expanded panel still hunting for the field.
  document.getElementById('fg2-panel-search-jump')?.addEventListener('click', () => {
    expandPanel();
    input?.focus();
    input?.select();
  });

  // --- "Showing ..." chip ---------------------------------------------------
  const isolated = document.getElementById('fg2-isolated');
  const isolatedText = document.getElementById('fg2-isolated-text');
  document.getElementById('fg2-isolated-clear')?.addEventListener('click', () => {
    // One way out, whichever narrowing put the chip there.
    forest.isolate(null);
    input?.focus();
  });
  forest.onNarrowed = (sentence) => {
    if (!isolated || !isolatedText) return;
    isolatedText.textContent = sentence ?? '';
    isolated.hidden = sentence === null;
  };

  // --- Cleanup on view transition ----------------------------------------------
  if (!mapEl.dataset.viewTransitionCleanupRegistered) {
    mapEl.dataset.viewTransitionCleanupRegistered = '1';
    const cleanup = () => {
      forest.destroy();
      document.removeEventListener('astro:before-swap', cleanup);
    };
    document.addEventListener('astro:before-swap', cleanup);
  }
}
