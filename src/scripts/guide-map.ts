import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../styles/guide-map.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocationData {
  slug: string;
  title: string;
  thresholdLabel: string;
  thresholdType: string;
  lat: number;
  lng: number;
  preview: string;
  url: string;
  order: number;
}

interface OrientationLabelFeature {
  geometry: { type: string; coordinates: [number, number] };
  properties: { name: string; kind: string };
}

interface OrientationLabelCollection {
  features: OrientationLabelFeature[];
}

interface PanelRefs {
  welcome: HTMLElement;
  selected: HTMLElement;
  chip: HTMLElement;
  name: HTMLElement;
  preview: HTMLElement;
  viewBtn: HTMLAnchorElement;
  mapsLink: HTMLAnchorElement;
  closeBtn: HTMLButtonElement | null;
  announcer: HTMLElement | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The eight markers' bounding box (SW = Old Mill Bridge, NE = Mast Trail). The
// map opens and resets framed to these (plus fitPadding), so every marker stays
// in view while the rest of Toronto spills off the edges. Context data extends
// well past this box, so the resulting zoom floor never reveals paper void.
const INITIAL_BOUNDS: maplibregl.LngLatBoundsLike = [
  [-79.492, 43.651],
  [-79.136, 43.806],
];

// The City of Toronto boundary extent. The zoom-out floor is pinned to this
// fit, so the most zoomed-out view is the whole city framed (surrounded by the
// washed GTA context); pulling back past the visible boundary is disallowed.
const CITY_BOUNDS: maplibregl.LngLatBoundsLike = [
  [-79.6393, 43.5810],
  [-79.1153, 43.8555],
];

/** Zoom applied when easing to a selected marker (never zooms out past current). */
const SELECT_ZOOM = 12;

/**
 * On load and reset the map frames the markers a touch looser than a tight fit
 * (this much below the marker-fit zoom), leaving a little zoom-out headroom
 * before the floor. The floor itself is the citywide fit (see applyZoomLimits).
 */
const ONLOAD_ZOOM_OUT = 0.15;

/** Uniform padding (px) for the citywide floor fit, so at min zoom the city sits
 *  dead-centre with a little breathing room rather than touching the edges. */
const FLOOR_PADDING = 34;

/** maxBounds is the viewport extent at the floor, grown by this tiny factor, so
 *  rounding never clamps the floor zoom while the city stays dead-centre and
 *  effectively unpannable at min zoom (~1px of slack). */
const MAXBOUNDS_SLACK = 1.002;

/** Loose fallback pan limit (matches the outside-wash rectangle) used until the
 *  per-screen limit is computed on load. */
const WASH_BOUNDS: maplibregl.LngLatBoundsLike = [
  [-79.98, 43.30],
  [-78.72, 44.12],
];
/** Safe floor used only until the first fit-based floor is computed on load. */
const FALLBACK_MIN_ZOOM = 8;

/** Below this zoom the densest orientation labels are hidden. */
const DENSE_LABEL_MIN_ZOOM = 10.5;

/** Horizontal pixel shift so a selected marker clears the floating desktop panel. */
const DESKTOP_CENTER_OFFSET_X = 206;

const DESKTOP_QUERY = '(min-width: 1024px)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Threshold glyph inner SVG markup, 24px viewBox.
 * Mirrors src/components/ThresholdSymbol.astro exactly.
 */
const THRESHOLD_GLYPHS: Record<string, string> = {
  'stair-descent': `
    <line x1="4" y1="6" x2="10" y2="6"/>
    <line x1="10" y1="6" x2="10" y2="11"/>
    <line x1="10" y1="11" x2="16" y2="11"/>
    <line x1="16" y1="11" x2="16" y2="16"/>
    <line x1="16" y1="16" x2="20" y2="16"/>
    <polyline points="14,14 20,14 20,20"/>
  `,
  'trail-entrance': `
    <polygon points="5,18 8,8 11,18" fill="none"/>
    <polygon points="13,18 16,8 19,18" fill="none"/>
    <line x1="9" y1="18" x2="9" y2="20"/>
    <line x1="15" y1="18" x2="15" y2="20"/>
    <line x1="11" y1="19" x2="13" y2="19"/>
    <line x1="12" y1="14" x2="12" y2="24"/>
  `,
  bridge: `
    <line x1="2" y1="10" x2="22" y2="10"/>
    <line x1="7" y1="10" x2="7" y2="16"/>
    <line x1="17" y1="10" x2="17" y2="16"/>
    <line x1="5" y1="16" x2="9" y2="16"/>
    <line x1="15" y1="16" x2="19" y2="16"/>
    <line x1="2" y1="9" x2="2" y2="11"/>
    <line x1="22" y1="9" x2="22" y2="11"/>
  `,
  underpass: `
    <path d="M4,18 L4,10 Q12,2 20,10 L20,18" fill="none"/>
    <line x1="4" y1="18" x2="20" y2="18"/>
    <line x1="8" y1="18" x2="8" y2="14"/>
    <line x1="16" y1="18" x2="16" y2="14"/>
  `,
  'park-edge': `
    <line x1="2" y1="14" x2="22" y2="14"/>
    <polyline points="2,14 5,9 8,12 11,7 14,10 17,8 20,11 22,14" fill="none"/>
    <line x1="4" y1="17" x2="4" y2="20"/>
    <line x1="8" y1="17" x2="8" y2="20"/>
    <line x1="12" y1="17" x2="12" y2="20"/>
    <line x1="16" y1="17" x2="16" y2="20"/>
    <line x1="20" y1="17" x2="20" y2="20"/>
  `,
  'path-ending': `
    <line x1="4" y1="12" x2="17" y2="12"/>
    <circle cx="20" cy="12" r="3" fill="none"/>
    <circle cx="20" cy="12" r="1" fill="currentColor"/>
    <line x1="4" y1="10" x2="4" y2="14"/>
  `,
  'slope-overlook': `
    <line x1="3" y1="20" x2="18" y2="6"/>
    <circle cx="18" cy="6" r="2.5" fill="none"/>
    <line x1="18" y1="3.5" x2="18" y2="1"/>
    <line x1="20.5" y1="6" x2="23" y2="6"/>
    <line x1="3" y1="20" x2="21" y2="20"/>
  `,
};

function thresholdGlyphSvg(type: string, size: number): string {
  const paths = THRESHOLD_GLYPHS[type] ?? '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ` +
    `width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${paths}</svg>`
  );
}

/**
 * Labels hidden below DENSE_LABEL_MIN_ZOOM. Crossroads and landmarks are the
 * smallest, densest names. East York is added by name: at citywide zoom its
 * label crowds Don Valley, which carries more of the map's argument.
 */
function isDenseLabel(props: { name: string; kind: string }): boolean {
  return (
    props.kind === 'crossroad' ||
    props.kind === 'landmark' ||
    props.name === 'East York'
  );
}

// ---------------------------------------------------------------------------
// ResetControl - custom IControl that restores the initial map extent
// ---------------------------------------------------------------------------

class ResetControl implements maplibregl.IControl {
  private _container: HTMLDivElement | undefined;
  private _guideMap: GuideMap;

  constructor(guideMap: GuideMap) {
    this._guideMap = guideMap;
  }

  onAdd(_map: maplibregl.Map): HTMLElement {
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gm-reset-btn';
    button.setAttribute('aria-label', 'Reset map view');
    button.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
      '<circle cx="10" cy="10" r="5" stroke="currentColor" stroke-width="1.5"/>' +
      '<line x1="10" y1="1" x2="10" y2="5" stroke="currentColor" stroke-width="1.5"/>' +
      '<line x1="10" y1="15" x2="10" y2="19" stroke="currentColor" stroke-width="1.5"/>' +
      '<line x1="1" y1="10" x2="5" y2="10" stroke="currentColor" stroke-width="1.5"/>' +
      '<line x1="15" y1="10" x2="19" y2="10" stroke="currentColor" stroke-width="1.5"/>' +
      '</svg>';

    button.addEventListener('click', () => {
      this._guideMap.resetView();
    });

    this._container.appendChild(button);
    return this._container;
  }

  onRemove(): void {
    this._container?.parentNode?.removeChild(this._container);
    this._container = undefined;
  }
}

// ---------------------------------------------------------------------------
// GuideMap
// ---------------------------------------------------------------------------

export class GuideMap {
  private map: maplibregl.Map;
  private baseUrl: string;
  private locations: LocationData[] = [];
  private markerButtons = new Map<string, HTMLButtonElement>();
  private refs: PanelRefs | null = null;
  private selectedSlug: string | null = null;

  constructor(containerId: string, baseUrl: string) {
    this.baseUrl = baseUrl;

    this.map = new maplibregl.Map({
      container: containerId,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: 'background',
            type: 'background',
            paint: { 'background-color': '#FAF6EC' },
          },
        ],
      },
      bounds: INITIAL_BOUNDS,
      fitBoundsOptions: { padding: this.fitPadding() },
      cooperativeGestures: true,
      // Loose fallback pan limit; the real per-screen limit (the viewport at the
      // citywide floor, so the city is dead-centre and unpannable at min zoom)
      // is computed on load and resize in applyZoomLimits.
      maxBounds: WASH_BOUNDS,
      // Safe initial floor; tightened to just under the marker fit once the map
      // has measured (applyMinZoomFloor, on 'load' and 'resize').
      minZoom: FALLBACK_MIN_ZOOM,
      maxZoom: 16,
      dragRotate: false,
      attributionControl: false,
    });

    // Disable pinch-rotation on touch devices
    this.map.touchZoomRotate.disableRotation();

    // Attribution
    this.map.addControl(
      new maplibregl.AttributionControl({
        compact: false,
        customAttribution:
          'Map data © OpenStreetMap contributors, City of Toronto',
      }),
      'bottom-right',
    );

    // Navigation control (zoom only; rotation is disabled)
    this.map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      'top-right',
    );

    // Reset control - added after NavigationControl so it sits below it
    this.map.addControl(new ResetControl(this), 'top-right');

    this.map.on('load', () => {
      this.addSourcesAndLayers();
      this.applyZoomLimits({ recenter: true });
    });

    // Recompute the floor + pan limit as the viewport/aspect changes (window
    // resize, breakpoint crossing, mobile URL-bar show/hide), preserving the
    // user's current view instead of re-framing.
    this.map.on('resize', () => this.applyZoomLimits({ recenter: false }));
  }

  // -------------------------------------------------------------------------
  // Sources and layers
  // -------------------------------------------------------------------------

  /**
   * All sources are added in one pass: MapLibre fetches every GeoJSON in
   * parallel and paints each layer independently as its data arrives, so
   * first paint (paper background, then lake and landscape, the smallest
   * of the heavy files) is never blocked by streets-minor (2.5 MB).
   * Sources are declared in priority order so constrained connections
   * queue the landscape argument first.
   */
  private addSourcesAndLayers(): void {
    const src = (filename: string): maplibregl.GeoJSONSourceSpecification => ({
      type: 'geojson',
      data: `${this.baseUrl}data/${filename}`,
      // MapLibre's default (128). buffer: 0 clips features exactly at each 512px
      // tile edge with no overlap, so the semi-transparent wash and strokes fail
      // to meet across seams and the darker layer beneath shows through as a grid
      // of hairlines (more of them the further you zoom in). A real buffer makes
      // features overlap the tile edge and the seams disappear.
      buffer: 128,
      tolerance: 0.375,
    });

    // Priority group: the figure/ground argument (lake + hidden landscape)
    this.map.addSource('lake', src('lake-ontario.geojson'));
    this.map.addSource('rnfp', src('ravine-rnfp.geojson'));
    this.map.addSource('esa', src('esa.geojson'));

    // Context group: streets, water (arrive as they load)
    // Rail source intentionally omitted: buried watercourses are the only
    // dashed device on the map; rail used the same dash and was removed to
    // maintain single-symbol semantics.
    this.map.addSource('waterways', src('watercourses.geojson'));
    this.map.addSource('boundary', src('toronto-boundary.geojson'));
    this.map.addSource('outside', src('outside-mask.geojson'));
    this.map.addSource('streets-major', src('streets-major.geojson'));
    this.map.addSource('streets-minor', src('streets-minor.geojson'));

    // Layer order, bottom to top:
    // background (in base style), lake, lake-shore, streets-minor,
    // streets-major, hidden-landscape, hidden-landscape-esa,
    // hidden-landscape-esa-edge, hidden-landscape-edge, waterways-buried,
    // waterways, outside-mask, toronto-boundary
    // (rail removed: buried watercourses are the only dashed device;
    //  feather removed: GTA context data + maxBounds put the wash's outer edge
    //  out of reach, so it needs no soft fade)

    this.map.addLayer({
      id: 'lake',
      type: 'fill',
      source: 'lake',
      paint: {
        'fill-color': 'hsl(200, 55%, 88%)',
        'fill-opacity': 1,
      },
    });

    this.map.addLayer({
      id: 'lake-shore',
      type: 'line',
      source: 'lake',
      paint: {
        'line-color': '#B8B2A7',
        'line-opacity': 0.4,
        'line-width': 0.75,
      },
    });

    this.map.addLayer({
      id: 'streets-minor',
      type: 'line',
      source: 'streets-minor',
      paint: {
        'line-color': '#D3CEC4',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 16, 1.6],
      },
    });

    this.map.addLayer({
      id: 'streets-major',
      type: 'line',
      source: 'streets-major',
      paint: {
        'line-color': '#B8B2A7',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 16, 3],
      },
    });

    // The hidden-landscape fill sits above major streets at 0.95 opacity:
    // streets ghost through where they bridge the ravines.
    this.map.addLayer({
      id: 'hidden-landscape',
      type: 'fill',
      source: 'rnfp',
      paint: {
        'fill-color': '#147D64',
        'fill-opacity': 0.95,
      },
    });

    // ESA fill with identical paint: reads as one layer with the RNFP fill.
    this.map.addLayer({
      id: 'hidden-landscape-esa',
      type: 'fill',
      source: 'esa',
      paint: {
        'fill-color': '#147D64',
        'fill-opacity': 0.95,
      },
    });

    // ESA polygons get the same edge as RNFP so the two sources keep
    // reading as one layer at close zoom.
    this.map.addLayer({
      id: 'hidden-landscape-esa-edge',
      type: 'line',
      source: 'esa',
      paint: {
        'line-color': '#0C6B58',
        'line-width': 1.25,
      },
    });

    this.map.addLayer({
      id: 'hidden-landscape-edge',
      type: 'line',
      source: 'rnfp',
      paint: {
        'line-color': '#0C6B58',
        'line-width': 1.25,
      },
    });

    // Buried watercourses (culverted creeks) draw dashed beneath surface water:
    // the hidden hydrology the guide documents, distinguished honestly from
    // daylighted streams.
    this.map.addLayer({
      id: 'waterways-buried',
      type: 'line',
      source: 'waterways',
      filter: ['==', ['get', 'buried'], true],
      paint: {
        'line-color': '#3994C1',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 16, 1.6],
        'line-dasharray': [2.5, 2],
      },
    });

    this.map.addLayer({
      id: 'waterways',
      type: 'line',
      source: 'waterways',
      filter: ['==', ['get', 'buried'], false],
      paint: {
        'line-color': '#3994C1',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 2],
      },
    });

    // Outside-survey wash: a paper fill over everything beyond the municipal
    // boundary, cut from a rectangle larger than maxBounds so its outer edge is
    // never reachable. Mutes the GTA context (streets, water) to a faint ghost
    // so Toronto reads as the figure, with real data underneath instead of the
    // old clipped-data void.
    this.map.addLayer({
      id: 'outside-mask',
      type: 'fill',
      source: 'outside',
      paint: {
        'fill-color': '#FAF6EC', // --paper
        'fill-opacity': 0.72,
      },
    });

    // Municipal boundary: sits on top of the wash edge, drawn distinctly darker
    // and heavier than any street so it reads as an administrative edge, not a
    // road. Solid; dashes are reserved for buried watercourses only.
    this.map.addLayer({
      id: 'toronto-boundary',
      type: 'line',
      source: 'boundary',
      paint: {
        'line-color': '#57513F', // darker than every street tone
        'line-width': 2,
        'line-opacity': 0.95,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Orientation labels (HTML markers, not MapLibre symbol layers)
  // -------------------------------------------------------------------------

  // Labels shown on mobile below zoom 10 (the "sparse mobile" set).
  // All others are hidden on narrow viewports below that zoom threshold.
  private static MOBILE_LABEL_SPARSE_SET = new Set([
    'Lake Ontario',
    'Don Valley',
    'Humber River',
    'Rouge',
    'Downtown',
  ]);

  private async addOrientationLabels(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}data/orientation-labels.geojson`);
      if (!res.ok) return;
      const collection = (await res.json()) as OrientationLabelCollection;

      for (const feature of collection.features) {
        const { name, kind } = feature.properties;
        const el = document.createElement('div');
        el.className = `gm-label gm-label--${kind}`;
        if (isDenseLabel(feature.properties)) {
          el.classList.add('gm-label--dense');
        }
        // data-label-name is used by CSS to show/hide on narrow viewports
        // below DENSE_LABEL_MIN_ZOOM. Labels not in MOBILE_LABEL_SPARSE_SET
        // get the gm-label--mobile-hide class and are hidden on containers
        // narrower than 640px when zoomed out.
        el.dataset.labelName = name;
        if (!GuideMap.MOBILE_LABEL_SPARSE_SET.has(name)) {
          el.classList.add('gm-label--mobile-hide');
        }
        el.textContent = name;
        el.setAttribute('aria-hidden', 'true');

        new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat(feature.geometry.coordinates)
          .addTo(this.map);
      }

      this.updateLabelDensity();
    } catch {
      // Labels are decorative orientation aids; fail silently.
    }
  }

  private updateLabelDensity(): void {
    const zoomedOut = this.map.getZoom() < DENSE_LABEL_MIN_ZOOM;
    this.map.getContainer().classList.toggle('gm-zoomed-out', zoomedOut);
    // Mobile width class: narrow containers get a separate density level
    const isNarrow = this.map.getContainer().offsetWidth < 640;
    this.map.getContainer().classList.toggle('gm-narrow', isNarrow);
  }

  // -------------------------------------------------------------------------
  // Threshold markers
  // -------------------------------------------------------------------------

  private addThresholdMarkers(): void {
    for (const loc of this.locations) {
      const wrap = document.createElement('div');
      wrap.className = 'gm-marker-wrap';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gm-marker';
      button.setAttribute('aria-label', `${loc.title}, ${loc.thresholdLabel}`);
      button.setAttribute('aria-pressed', 'false');
      button.dataset.slug = loc.slug;
      button.innerHTML = thresholdGlyphSvg(loc.thresholdType, 16);

      button.addEventListener('click', (event) => {
        // Keep the click from bubbling to the map (which clears selection).
        event.stopPropagation();
        this.selectLocation(loc.slug);
      });

      wrap.appendChild(button);

      new maplibregl.Marker({ element: wrap, anchor: 'center' })
        .setLngLat([loc.lng, loc.lat])
        .addTo(this.map);

      // MapLibre gives the marker element a redundant button role; the inner
      // <button> is the real control, and nested interactives fail axe.
      wrap.removeAttribute('role');
      wrap.removeAttribute('tabindex');
      wrap.removeAttribute('aria-label');

      this.markerButtons.set(loc.slug, button);
    }
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  selectLocation(slug: string, options: { animate?: boolean } = {}): void {
    const { animate = true } = options;
    const loc = this.locations.find((l) => l.slug === slug);
    if (!loc) return;

    this.selectedSlug = slug;

    for (const [buttonSlug, button] of this.markerButtons) {
      const isSelected = buttonSlug === slug;
      button.classList.toggle('gm-marker--selected', isSelected);
      button.setAttribute('aria-pressed', String(isSelected));
    }

    this.populatePanel(loc);
    this.showSelectedPanel();
    this.setPlaceParam(slug);
    this.announce(`Selected: ${loc.title}, ${loc.thresholdLabel}`);
    this.moveToLocation(loc, animate);
  }

  clearSelection(): void {
    if (this.selectedSlug === null) return;

    const previousSlug = this.selectedSlug;
    this.selectedSlug = null;

    const focusWasInPanel =
      this.refs !== null &&
      document.activeElement !== null &&
      this.refs.selected.contains(document.activeElement);

    for (const button of this.markerButtons.values()) {
      button.classList.remove('gm-marker--selected');
      button.setAttribute('aria-pressed', 'false');
    }

    this.showWelcomePanel();
    this.setPlaceParam(null);
    this.announce('Selection cleared');

    if (focusWasInPanel) {
      this.markerButtons.get(previousSlug)?.focus();
    }
  }

  /** Reset map to the citywide extent and clear any active selection */
  resetView(): void {
    this.frameMarkers(true);
    this.clearSelection();
  }

  private moveToLocation(loc: LocationData, animate: boolean): void {
    const zoom = Math.max(this.map.getZoom(), SELECT_ZOOM);
    let center: [number, number] = [loc.lng, loc.lat];

    // On desktop the floating panel covers the left edge of the map; shift
    // the camera so the marker lands in the clear area right of the panel.
    if (this.isDesktop()) {
      const worldSize = 512 * Math.pow(2, zoom);
      const degPerPx = 360 / worldSize;
      center = [loc.lng - DESKTOP_CENTER_OFFSET_X * degPerPx, loc.lat];
    }

    if (animate && !this.prefersReducedMotion()) {
      this.map.easeTo({ center, zoom, duration: 800 });
    } else {
      this.map.jumpTo({ center, zoom });
    }
  }

  // -------------------------------------------------------------------------
  // Panel wiring
  // -------------------------------------------------------------------------

  private populatePanel(loc: LocationData): void {
    if (!this.refs) return;

    this.refs.chip.innerHTML =
      `<span class="gm-chip">` +
      `<span class="gm-chip-marker" aria-hidden="true">${thresholdGlyphSvg(loc.thresholdType, 10)}</span>` +
      `<span class="gm-chip-label"></span>` +
      `</span>`;
    const label = this.refs.chip.querySelector('.gm-chip-label');
    if (label) label.textContent = loc.thresholdLabel;

    this.refs.name.textContent = loc.title;
    this.refs.preview.textContent = loc.preview;
    this.refs.viewBtn.href = loc.url;
    this.refs.mapsLink.href = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
  }

  private showSelectedPanel(): void {
    if (!this.refs) return;
    this.refs.welcome.hidden = true;
    this.refs.selected.hidden = false;
    this.refs.selected.removeAttribute('aria-hidden');
  }

  private showWelcomePanel(): void {
    if (!this.refs) return;
    this.refs.selected.hidden = true;
    this.refs.selected.setAttribute('aria-hidden', 'true');
    this.refs.welcome.hidden = false;
  }

  private setPlaceParam(slug: string | null): void {
    const url = new URL(window.location.href);
    if (slug === null) {
      url.searchParams.delete('place');
    } else {
      url.searchParams.set('place', slug);
    }
    history.replaceState(null, '', url);
  }

  private announce(message: string): void {
    if (this.refs?.announcer) {
      this.refs.announcer.textContent = message;
    }
  }

  private collectPanelRefs(): PanelRefs | null {
    const welcome = document.getElementById('guide-welcome-panel');
    const selected = document.getElementById('guide-selected-panel');
    const chip = document.getElementById('guide-selected-chip');
    const name = document.getElementById('guide-selected-name');
    const preview = document.getElementById('guide-selected-preview');
    const viewBtn = document.getElementById('guide-selected-view-btn');
    const mapsLink = document.getElementById('guide-selected-maps-link');
    const closeBtn = document.getElementById('guide-panel-close');
    const announcer = document.getElementById('guide-map-announcer');

    if (
      !welcome ||
      !selected ||
      !chip ||
      !name ||
      !preview ||
      !(viewBtn instanceof HTMLAnchorElement) ||
      !(mapsLink instanceof HTMLAnchorElement)
    ) {
      return null;
    }

    return {
      welcome,
      selected,
      chip,
      name,
      preview,
      viewBtn,
      mapsLink,
      closeBtn: closeBtn instanceof HTMLButtonElement ? closeBtn : null,
      announcer,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private fitPadding(): maplibregl.PaddingOptions | number {
    // Desktop: the floating panel renders 430px wide (its 380px basis plus
    // padding), inset 32px from the left edge, so its right edge sits at
    // x=462. Left padding = 462 + 24 breathing room = 486px, measured from
    // the live layout rather than the stylesheet basis. This keeps all
    // eight markers (Old Mill Bridge at lng -79.495 westernmost) clear of
    // the panel on a 1440x900 viewport.
    if (this.isDesktop()) {
      return { top: 48, right: 48, bottom: 48, left: 486 };
    }
    // Mobile / tablet: panels render below the map as a normal flow block,
    // so no horizontal offset is needed. Uniform padding keeps markers
    // away from map controls at the edges.
    return 40;
  }

  private isDesktop(): boolean {
    return window.matchMedia(DESKTOP_QUERY).matches;
  }

  /**
   * Frame the eight markers a touch looser than a tight fit. This is the on-load
   * and reset view: every marker in frame with a little zoom-out headroom before
   * the floor.
   */
  private frameMarkers(animate: boolean): void {
    const cam = this.map.cameraForBounds(INITIAL_BOUNDS, {
      padding: this.fitPadding(),
    });
    if (!cam || typeof cam.zoom !== 'number') return;
    const target = { center: cam.center, zoom: cam.zoom - ONLOAD_ZOOM_OUT };
    if (animate && !this.prefersReducedMotion()) {
      this.map.easeTo({ ...target, duration: 600 });
    } else {
      this.map.jumpTo(target);
    }
  }

  /**
   * Set the zoom-out floor to the citywide fit and clamp maxBounds to the
   * viewport at that floor, centred on the city. Effect: zooming all the way out
   * shows the whole City of Toronto dead-centre and cannot be panned; zooming in
   * frees panning within that same extent. Recomputed per screen so every size
   * and aspect ratio behaves identically.
   *
   * The floor extent is measured, not derived: jump the camera to the floor,
   * read getBounds (exact for this viewport), then either re-frame the markers
   * (on load) or restore the user's view (on resize). All synchronous, so only
   * the final camera renders, no flash.
   */
  private applyZoomLimits(options: { recenter: boolean }): void {
    const cam = this.map.cameraForBounds(CITY_BOUNDS, { padding: FLOOR_PADDING });
    if (!cam || typeof cam.zoom !== 'number' || !Number.isFinite(cam.zoom)) return;

    const restore = { center: this.map.getCenter(), zoom: this.map.getZoom() };

    this.map.setMaxBounds(null); // clear first: a stale-tight bound can clamp the floor
    this.map.jumpTo({ center: cam.center, zoom: cam.zoom });
    const floor = this.map.getBounds();
    this.map.setMinZoom(cam.zoom);
    this.map.setMaxBounds(this.padBounds(floor, MAXBOUNDS_SLACK));

    if (options.recenter) {
      this.frameMarkers(false);
    } else {
      this.map.jumpTo(restore); // re-clamped to the new maxBounds if needed
    }
  }

  /** Grow a bounds about its centre by factor `f` (adds maxBounds slack). */
  private padBounds(
    b: maplibregl.LngLatBounds,
    f: number,
  ): maplibregl.LngLatBoundsLike {
    const w = b.getWest();
    const e = b.getEast();
    const s = b.getSouth();
    const n = b.getNorth();
    const cx = (w + e) / 2;
    const cy = (s + n) / 2;
    return [
      [cx - (cx - w) * f, cy - (cy - s) * f],
      [cx + (e - cx) * f, cy + (n - cy) * f],
    ];
  }

  private prefersReducedMotion(): boolean {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  }

  // -------------------------------------------------------------------------
  // Public init entry point
  // -------------------------------------------------------------------------

  init(locations: LocationData[]): void {
    this.locations = [...locations].sort((a, b) => a.order - b.order);
    this.refs = this.collectPanelRefs();

    // Markers and labels are HTML overlays; they do not wait for style load.
    this.addThresholdMarkers();
    void this.addOrientationLabels();

    this.map.on('zoom', () => this.updateLabelDensity());
    this.updateLabelDensity();

    // Clicking empty map space clears the selection. Marker buttons stop
    // propagation, so this only fires for genuine empty-space clicks.
    this.map.on('click', () => this.clearSelection());

    // Escape anywhere clears the selection.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.clearSelection();
    });

    this.refs?.closeBtn?.addEventListener('click', () => this.clearSelection());

    // Clean up the MapLibre instance before Astro's ClientRouter swaps the
    // DOM. Leaving a mounted map causes a canvas leak and a zombie WebGL
    // context. Guard against double-registration with a flag on the element.
    const container = this.map.getContainer();
    if (!container.dataset.viewTransitionCleanupRegistered) {
      container.dataset.viewTransitionCleanupRegistered = '1';
      const cleanupHandler = () => {
        try {
          this.map.remove();
        } catch {
          // Already removed; ignore.
        }
        document.removeEventListener('astro:before-swap', cleanupHandler);
      };
      document.addEventListener('astro:before-swap', cleanupHandler);
    }

    // Preselect from ?place= without animation.
    const place = new URLSearchParams(window.location.search).get('place');
    if (place !== null) {
      this.selectLocation(place, { animate: false });
    }
  }
}

// ---------------------------------------------------------------------------
// Page entry point
// ---------------------------------------------------------------------------

export function initGuideMap(): void {
  const container = document.getElementById('guide-map');
  const dataEl = document.getElementById('guide-map-data');
  if (!container || !dataEl) return;

  let locations: LocationData[];
  try {
    locations = JSON.parse(dataEl.textContent ?? '[]') as LocationData[];
  } catch {
    return;
  }
  if (!Array.isArray(locations) || locations.length === 0) return;

  // MapLibre warns when the container is not empty; the placeholder and
  // noscript children are only meaningful without JS, so drop them.
  container.replaceChildren();

  // The static shell exposes the div as an image; once interactive it is a
  // labelled region containing focusable marker buttons.
  container.setAttribute('role', 'region');

  const rawBase = import.meta.env.BASE_URL;
  const baseUrl = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

  const guideMap = new GuideMap('guide-map', baseUrl);
  guideMap.init(locations);
}
