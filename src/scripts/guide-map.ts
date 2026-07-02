import maplibregl from 'maplibre-gl';

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

// ---------------------------------------------------------------------------
// ResetControl - custom IControl that restores the initial map extent
// ---------------------------------------------------------------------------

class ResetControl implements maplibregl.IControl {
  private _container: HTMLDivElement | undefined;
  private _button: HTMLButtonElement | undefined;
  private _guideMap: GuideMap;

  constructor(guideMap: GuideMap) {
    this._guideMap = guideMap;
  }

  onAdd(_map: maplibregl.Map): HTMLElement {
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

    this._button = document.createElement('button');
    this._button.type = 'button';
    this._button.className = 'maplibregl-ctrl-icon';
    this._button.setAttribute('aria-label', 'Reset map view');
    // Inline SVG: a simple home/reset icon (target reticle)
    this._button.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
      '<circle cx="10" cy="10" r="5" stroke="currentColor" stroke-width="1.5"/>' +
      '<line x1="10" y1="1" x2="10" y2="5" stroke="currentColor" stroke-width="1.5"/>' +
      '<line x1="10" y1="15" x2="10" y2="19" stroke="currentColor" stroke-width="1.5"/>' +
      '<line x1="1" y1="10" x2="5" y2="10" stroke="currentColor" stroke-width="1.5"/>' +
      '<line x1="15" y1="10" x2="19" y2="10" stroke="currentColor" stroke-width="1.5"/>' +
      '</svg>';

    this._button.addEventListener('click', () => {
      this._guideMap.resetView();
    });

    this._container.appendChild(this._button);
    return this._container;
  }

  onRemove(): void {
    if (this._container?.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
    this._container = undefined;
    this._button = undefined;
  }
}

// ---------------------------------------------------------------------------
// GuideMap - main class
// ---------------------------------------------------------------------------

const INITIAL_BOUNDS: maplibregl.LngLatBoundsLike = [[-79.65, 43.57], [-79.10, 43.87]];
const FIT_BOUNDS_OPTIONS: maplibregl.FitBoundsOptions = { padding: 40 };

export class GuideMap {
  private map: maplibregl.Map;
  private baseUrl: string;
  private locations: LocationData[] = [];

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
      fitBoundsOptions: FIT_BOUNDS_OPTIONS,
      minZoom: 9.3,
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
        customAttribution: 'Map data © OpenStreetMap contributors, City of Toronto',
      }),
      'bottom-right',
    );

    // Navigation control (no compass - rotation is disabled)
    this.map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      'top-right',
    );

    // Reset control - added after NavigationControl so it sits below it
    this.map.addControl(new ResetControl(this), 'top-right');

    // Kick off source + layer setup
    void this.initMap();
  }

  // -------------------------------------------------------------------------
  // Private: wire up sources and layers once the map canvas is ready
  // -------------------------------------------------------------------------

  private initMap(): Promise<void> {
    return new Promise((resolve) => {
      this.map.on('load', () => {
        this.addSources();
        this.addLayers();
        resolve();
      });
    });
  }

  private addSources(): void {
    const src = (filename: string): maplibregl.GeoJSONSourceSpecification => ({
      type: 'geojson',
      data: `${this.baseUrl}data/${filename}`,
      buffer: 0,
      tolerance: 0.375,
    });

    this.map.addSource('lake', src('lake-ontario.geojson'));
    this.map.addSource('streets-minor', src('streets-minor.geojson'));
    this.map.addSource('streets-major', src('streets-major.geojson'));
    this.map.addSource('rail', src('rail.geojson'));
    this.map.addSource('rnfp', src('ravine-rnfp.geojson'));
    this.map.addSource('esa', src('esa.geojson'));
    this.map.addSource('waterways', src('watercourses.geojson'));
    // Source for orientation labels - consumed by Task 2
    this.map.addSource('orientation-labels', src('orientation-labels.geojson'));
  }

  private addLayers(): void {
    // Layer 1: background - already in base style object passed to Map constructor

    // Layer 2: lake fill
    this.map.addLayer({
      id: 'lake',
      type: 'fill',
      source: 'lake',
      paint: {
        'fill-color': 'hsl(200, 55%, 88%)',
        'fill-opacity': 1,
      },
    });

    // Layer 2b: lake shoreline
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

    // Layer 3: streets-minor
    this.map.addLayer({
      id: 'streets-minor',
      type: 'line',
      source: 'streets-minor',
      paint: {
        'line-color': '#D3CEC4',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 16, 1.6],
      },
    });

    // Layer 4: rail
    this.map.addLayer({
      id: 'rail',
      type: 'line',
      source: 'rail',
      paint: {
        'line-color': '#D3CEC4',
        'line-width': 1,
        'line-dasharray': [2, 2],
      },
    });

    // Layer 5: streets-major
    this.map.addLayer({
      id: 'streets-major',
      type: 'line',
      source: 'streets-major',
      paint: {
        'line-color': '#B8B2A7',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 16, 3],
      },
    });

    // Layer 6: hidden-landscape fill (rnfp)
    this.map.addLayer({
      id: 'hidden-landscape',
      type: 'fill',
      source: 'rnfp',
      paint: {
        'fill-color': '#147D64',
        'fill-opacity': 0.95,
      },
    });

    // Layer 7: hidden-landscape-esa fill (esa) - same paint, reads as one visual layer
    this.map.addLayer({
      id: 'hidden-landscape-esa',
      type: 'fill',
      source: 'esa',
      paint: {
        'fill-color': '#147D64',
        'fill-opacity': 0.95,
      },
    });

    // Layer 8: hidden-landscape edge (rnfp outline)
    this.map.addLayer({
      id: 'hidden-landscape-edge',
      type: 'line',
      source: 'rnfp',
      paint: {
        'line-color': '#0C6B58',
        'line-width': 1.25,
      },
    });

    // Layer 9: waterways
    this.map.addLayer({
      id: 'waterways',
      type: 'line',
      source: 'waterways',
      paint: {
        'line-color': '#3994C1',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 2],
      },
    });

    // Orientation labels and threshold markers sit above waterways but are
    // HTML markers, not MapLibre layers - see stubs below.
  }

  // -------------------------------------------------------------------------
  // Stubs: to be implemented in later tasks
  // -------------------------------------------------------------------------

  /** TODO: Task 2 - add HTML marker labels for orientation-labels.geojson points */
  addOrientationLabels(): void {
    // TODO: Task 2
  }

  /** TODO: Task 3 - create HTML marker buttons for each LocationData entry */
  addThresholdMarkers(_locations: LocationData[]): void {
    // TODO: Task 3
  }

  /** TODO: Task 5 - highlight the selected location on map and in the panel */
  selectLocation(_slug: string): void {
    // TODO: Task 5
  }

  /** TODO: Task 5 - clear active selection state */
  clearSelection(): void {
    // TODO: Task 5
  }

  /** Reset map to initial extent and clear any active selection */
  resetView(): void {
    this.map.fitBounds(INITIAL_BOUNDS, FIT_BOUNDS_OPTIONS);
    this.clearSelection();
  }

  // -------------------------------------------------------------------------
  // Public init entry point
  // -------------------------------------------------------------------------

  /**
   * Call after constructing GuideMap. Stores location data for use by marker
   * and selection tasks (Tasks 3-5). Orientation labels and threshold markers
   * are deferred to their respective tasks.
   */
  async init(locations: LocationData[]): Promise<void> {
    this.locations = locations;
    // TODO: Task 3 - call this.addThresholdMarkers(this.locations) once implemented
    // TODO: Task 2 - call this.addOrientationLabels() once implemented
  }
}
