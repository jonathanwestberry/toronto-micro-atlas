import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

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
const GROUND = 'hsl(211, 42%, 9%)';
const LAKE = 'hsl(213, 55%, 6%)';
const LAKE_SHORE = 'hsl(210, 32%, 18%)';
const STREET_MINOR = 'hsl(211, 26%, 16%)';
const STREET_MAJOR = 'hsl(211, 24%, 21%)';
const BOUNDARY = 'hsl(210, 18%, 34%)';

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
  // Anchored inside their wards but clear of the desktop story column.
  { name: 'Ward 2 · Etobicoke Centre', count: '52,659 trees', lng: -79.513, lat: 43.692 },
  { name: 'Ward 13 · Toronto Centre', count: '8,558 trees', lng: -79.369, lat: 43.667 },
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
  private scrollyEl: HTMLElement;

  constructor(container: HTMLElement, base: string, scrollyEl: HTMLElement) {
    this.base = base;
    this.scrollyEl = scrollyEl;
    this.announcer = document.getElementById('fg2-announcer');

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
      cooperativeGestures: true,
      attributionControl: false,
    });
    this.map.touchZoomRotate.disableRotation();

    this.map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: 'Tree data: City of Toronto Open Data · Map data © OpenStreetMap contributors',
      }),
      'bottom-right',
    );
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    this.map.on('load', () => {
      this.applyZoomLimits({ recenter: true });
      void this.addLayers();
    });
    this.map.on('resize', () => this.applyZoomLimits({ recenter: false }));
  }

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------

  private async addLayers(): Promise<void> {
    const [metaRes, renderRes] = await Promise.all([
      fetch(`${this.base}data/fg02/meta.json`),
      fetch(`${this.base}data/fg02/r/render.json`),
    ]);
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

    const colorMatch: unknown[] = ['match', ['get', 'g']];
    this.meta.categories.forEach((c, i) => { colorMatch.push(i, c.color); });
    colorMatch.push('#637388');

    this.map.addLayer({
      id: 'trees-circles',
      type: 'circle',
      source: 'trees',
      'source-layer': 'trees',
      paint: {
        'circle-color': colorMatch as maplibregl.ExpressionSpecification,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.2, 1.6, 14, 2.4, 16, 5, 18.5, 9],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], XF_LO, 0, XF_HI, 1],
        'circle-blur': 0.15,
      },
    });

    // Selected-tree highlight ring
    this.map.addLayer({
      id: 'trees-selected',
      type: 'circle',
      source: 'trees',
      'source-layer': 'trees',
      filter: ['==', ['id'], -1],
      paint: {
        'circle-color': 'transparent',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 7, 18.5, 14],
        'circle-stroke-color': 'hsl(48, 90%, 64%)',
        'circle-stroke-width': 2,
      },
    });

    this.wireTreeTaps();
    void this.addDistrictLabels();
    this.buildMarkers();
    this.applyChapter(this.activeChapter, true);
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
    const filter = genus === null ? null : (['==', ['get', 'g'], genus] as maplibregl.FilterSpecification);
    if (this.map.getLayer('trees-circles')) {
      this.map.setFilter('trees-circles', filter);
    }
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
      this.announce('Explorer active. Zoom in until dots separate, then tap a tree to identify it.');
    } else {
      this.isolate(null);
      this.popup?.remove();
    }
  }

  /** Swap only the overlay raster (the maple chapter's in-card toggle). */
  applyChapterOverlayOnly(key: string): void {
    this.setOverlay(key);
  }

  /** Legend isolation: null restores all categories. */
  isolate(genus: number | null): void {
    if (!this.meta) return;
    if (genus === null) {
      this.map.setPaintProperty('trees-base', 'raster-opacity', this.rasterOpacityExpr(1));
      this.currentBaseOpacity = 1;
      this.setOverlay(null);
      this.setCircleGenus(null);
    } else {
      const key = `cat-${this.meta.categories[genus].key}`;
      this.currentBaseOpacity = 0.12;
      this.map.setPaintProperty('trees-base', 'raster-opacity', this.rasterOpacityExpr(0.12));
      this.setOverlay(key);
      this.setCircleGenus(genus);
      this.announce(`Showing only ${this.meta.categories[genus].label}, ${this.meta.categories[genus].count.toLocaleString('en-CA')} trees.`);
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
      if (hits.length === 0) return;
      this.openTreePopup(hits[0], e.lngLat);
    });

    this.map.on('mousemove', (e) => {
      if (this.mode !== 'explore' || this.map.getZoom() < XF_HI) return;
      const hits = this.map.queryRenderedFeatures(e.point, { layers: ['trees-circles'] });
      this.map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
    });
  }

  private openTreePopup(feature: maplibregl.MapGeoJSONFeature, lngLat: maplibregl.LngLat): void {
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

    this.announce(`${common}. ${botanical}. ${bits.join('. ')}`);
  }

  // --- Street search ---------------------------------------------------------

  async searchStreets(query: string): Promise<[string, number, number, number][]> {
    if (!this.streets) {
      const res = await fetch(`${this.base}data/fg02/streets.json`);
      this.streets = (await res.json()) as [string, number, number, number][];
    }
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const starts: [string, number, number, number][] = [];
    const contains: [string, number, number, number][] = [];
    for (const row of this.streets) {
      const name = row[0].toLowerCase();
      if (name.startsWith(q)) starts.push(row);
      else if (name.includes(q)) contains.push(row);
      if (starts.length >= 8) break;
    }
    return [...starts, ...contains].slice(0, 8);
  }

  goToStreet(lng: number, lat: number, name: string): void {
    this.map.easeTo({ center: [lng, lat], zoom: 15.4, duration: prefersReducedMotion() ? 0 : 1100 });
    this.announce(`Moved to ${name}. Tap any dot to identify the tree.`);
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
      const name = document.createElement('span');
      name.className = 'fg2-ward-name';
      name.textContent = w.name;
      el.append(count, name);
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

  private announce(message: string): void {
    if (this.announcer) this.announcer.textContent = message;
  }

  destroy(): void {
    try { this.map.remove(); } catch { /* already gone */ }
  }
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

export function initSidewalkForest(): void {
  const mapEl = document.getElementById('fg2-map');
  const scrollyEl = document.querySelector<HTMLElement>('.fg2-scrolly');
  if (!mapEl || !scrollyEl) return;

  mapEl.replaceChildren();

  const rawBase = import.meta.env.BASE_URL;
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  const forest = new SidewalkForest(mapEl, base, scrollyEl);

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
      }
    },
    { rootMargin: '-45% 0px -45% 0px' },
  );
  steps.forEach((s) => stepIO.observe(s));

  // --- Explorer sentinel -----------------------------------------------------
  const explorer = document.getElementById('fg2-explorer');
  if (explorer) {
    const modeIO = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          forest.setMode(entry.isIntersecting ? 'explore' : 'story');
        }
      },
      { threshold: 0.35 },
    );
    modeIO.observe(explorer);
  }

  // --- Maple toggle ----------------------------------------------------------
  const mapleBtn = document.getElementById('fg2-maple-toggle');
  if (mapleBtn) {
    let showing: 'norway' | 'sugar' = 'norway';
    mapleBtn.addEventListener('click', () => {
      showing = showing === 'norway' ? 'sugar' : 'norway';
      forest.applyChapterOverlayOnly(`maples-${showing}`);
      mapleBtn.textContent = showing === 'norway' ? 'Show the sugar maples' : 'Show the Norway maples';
    });
  }

  // --- Explore / skip buttons -------------------------------------------------
  document.querySelectorAll<HTMLElement>('[data-scroll-to-explorer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      explorer?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    });
  });
  document.getElementById('fg2-back-to-story')?.addEventListener('click', () => {
    document.querySelector('.fg2-step--hero')?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });
  document.getElementById('fg2-reset')?.addEventListener('click', () => forest.resetView());

  // Panel collapse (matters most on phones, where the panel is a bottom sheet)
  const panelToggle = document.getElementById('fg2-panel-toggle');
  const panel = document.getElementById('fg2-panel');
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
        ...rows.map(([name, lng, lat, count]) => {
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
            forest.goToStreet(lng, lat, name);
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
