/**
 * The shared map stage.
 *
 * The three guides do not share a map engine and should not: fg01 is a
 * browsable panel, fg02 is a scrollytelling stage, fg03 is a filtered explorer.
 * What they do share is the *situation* around the canvas, and that is what
 * this module owns:
 *
 *   1. Gesture context. Cooperative gestures are gone. A map embedded in prose
 *      is not a zoom target until the reader makes it one, so scroll-zoom is
 *      held back until first interaction rather than hidden behind a modifier
 *      key nobody discovers. There is no blocking scrim: the first click still
 *      reaches the marker underneath it.
 *   2. Status. One loading / ready / empty / error vocabulary with a retry, so
 *      a dead fetch says so instead of leaving a blank rectangle.
 *   3. A real "How to read this map" disclosure, replacing the ⓘ that was only
 *      ever MapLibre's collapsed attribution wearing a help icon.
 *   4. An "Expand map" link whose href tracks the live camera, so the expanded
 *      view is a URL you can send someone.
 *
 * The expanded view is a real route, not a JS takeover. That is the whole
 * reason this file has no focus trap: routes do not need one, because there is
 * no hidden page behind the map to tab into.
 */

/**
 * The slice of MapLibre the stage actually touches. Kept structural so the
 * stage can be unit tested against a fake and so no guide is forced to hand
 * over its whole map object.
 */
export interface StageMap {
  scrollZoom: { enable(): void; disable(): void };
  dragPan: { enable(): void; disable(): void };
  touchZoomRotate: { enable(): void; disable(): void };
  keyboard?: { enable(): void; disable(): void };
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  on(type: string, listener: () => void): unknown;
  off(type: string, listener: () => void): unknown;
  resize(): void;
}

export type MapStageState = 'loading' | 'ready' | 'empty' | 'error';

export interface MapStageOptions {
  /** The `[data-map-stage]` root. */
  root: HTMLElement;
  /** The live map. Omit to drive status only (no-JS-ish / pre-init shells). */
  map?: StageMap;
  /**
   * True when this stage *is* the expanded route. Gesture gating and the
   * expand link switch off; the map owns the viewport and scroll-zoom is native.
   */
  expanded?: boolean;
  /** Absolute path of the expand route, e.g. `/guides/sidewalk-forest/map`. */
  expandPath?: string;
  /** Called when the reader hits Retry in the error state. */
  onRetry?: () => void;
}

const COARSE_POINTER = '(hover: none), (pointer: coarse)';

function isCoarsePointer(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(COARSE_POINTER).matches;
}

export class MapStage {
  private root: HTMLElement;
  private map: StageMap | undefined;
  private expanded: boolean;
  private expandPath: string | undefined;
  private onRetry: (() => void) | undefined;

  private active = false;
  private state: MapStageState = 'loading';
  private coarse = false;

  private hintEl: HTMLElement | null;
  private statusEl: HTMLElement | null;
  private howtoToggle: HTMLButtonElement | null;
  private howtoPanel: HTMLElement | null;
  private expandLink: HTMLAnchorElement | null;
  private retryBtn: HTMLButtonElement | null;

  private onMove = (): void => this.syncExpandHref();
  private onDocPointerDown: ((event: Event) => void) | null = null;
  private onKeyDown: ((event: KeyboardEvent) => void) | null = null;

  constructor(options: MapStageOptions) {
    this.root = options.root;
    this.map = options.map;
    this.expanded = options.expanded ?? false;
    this.expandPath = options.expandPath;
    this.onRetry = options.onRetry;

    this.hintEl = this.root.querySelector<HTMLElement>('[data-map-hint]');
    this.statusEl = this.root.querySelector<HTMLElement>('[data-map-status]');
    this.howtoToggle = this.root.querySelector<HTMLButtonElement>('[data-map-howto-toggle]');
    this.howtoPanel = this.root.querySelector<HTMLElement>('[data-map-howto]');
    this.expandLink = this.root.querySelector<HTMLAnchorElement>('[data-map-expand]');
    this.retryBtn = this.root.querySelector<HTMLButtonElement>('[data-map-retry]');

    this.coarse = isCoarsePointer();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  init(): this {
    this.root.dataset.mapStageMode = this.expanded ? 'expanded' : 'embedded';
    this.bindHowTo();
    this.bindRetry();

    if (this.expanded) {
      // The expanded route is the map's own page: every gesture is native and
      // the hint has nothing left to say.
      this.hintEl?.setAttribute('hidden', '');
      this.bindExpandedKeys();
    } else {
      this.applyGate();
      this.bindActivation();
      this.syncExpandHref();
      this.map?.on('moveend', this.onMove);
    }

    return this;
  }

  destroy(): void {
    this.map?.off('moveend', this.onMove);
    if (this.onDocPointerDown) {
      document.removeEventListener('pointerdown', this.onDocPointerDown, true);
      document.removeEventListener('focusin', this.onDocPointerDown, true);
      this.onDocPointerDown = null;
    }
    if (this.onKeyDown) {
      document.removeEventListener('keydown', this.onKeyDown);
      this.onKeyDown = null;
    }
  }

  // -------------------------------------------------------------------------
  // Gesture context
  // -------------------------------------------------------------------------

  /**
   * Hold back the gestures that fight the page.
   *
   * Scroll-zoom always waits for activation: it is the one gesture that steals
   * a scroll the reader meant for the article. Drag-pan and pinch only wait on
   * touch, where a one-finger drag is also a page scroll. On a mouse or
   * trackpad, dragging inside a canvas was never ambiguous, so panning stays
   * live from the start and the map does not feel dead on arrival.
   */
  private applyGate(): void {
    if (!this.map) return;
    if (this.active) {
      this.map.scrollZoom.enable();
      this.map.dragPan.enable();
      this.map.touchZoomRotate.enable();
    } else {
      this.map.scrollZoom.disable();
      if (this.coarse) {
        this.map.dragPan.disable();
        this.map.touchZoomRotate.disable();
      } else {
        this.map.dragPan.enable();
        this.map.touchZoomRotate.enable();
      }
    }
    this.root.dataset.mapActive = this.active ? 'true' : 'false';
    this.updateHint();
  }

  activate(): void {
    if (this.expanded || this.active) return;
    this.active = true;
    this.applyGate();
  }

  deactivate(): void {
    if (this.expanded || !this.active) return;
    this.active = false;
    this.applyGate();
  }

  isActive(): boolean {
    return this.active;
  }

  private updateHint(): void {
    if (!this.hintEl) return;
    const verb = this.coarse ? 'Tap' : 'Click';
    this.hintEl.textContent = this.active
      ? this.coarse
        ? 'Pinch to zoom, drag to pan'
        : 'Scroll to zoom · Esc to release'
      : `${verb} the map to zoom and pan`;
    this.hintEl.dataset.mapHintState = this.active ? 'active' : 'idle';
  }

  private bindActivation(): void {
    // Activate on any real interaction with the stage. No scrim, so this same
    // click also reaches whatever marker is under it.
    this.root.addEventListener('pointerdown', () => this.activate());
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') this.activate();
    });

    // Release when attention leaves, so a reader who scrolls on past the map
    // does not leave a live scroll-zoom target behind them.
    this.onDocPointerDown = (event: Event): void => {
      // Duck-typed rather than `instanceof Node`: the global Node identity is
      // per-realm, so an event crossing an iframe boundary would read as
      // "outside" and release the map mid-drag.
      const target = event.target as Node | null;
      if (target !== null && typeof target === 'object' && this.root.contains(target)) return;
      this.deactivate();
    };
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    document.addEventListener('focusin', this.onDocPointerDown, true);

    this.onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (this.howtoToggle?.getAttribute('aria-expanded') === 'true') {
        this.closeHowTo({ restoreFocus: true });
        return;
      }
      if (this.active) this.deactivate();
    };
    document.addEventListener('keydown', this.onKeyDown);
  }

  /**
   * On the expanded route Escape is a way out of the map, not out of a mode.
   * It follows the back link so the reader lands where they came from.
   */
  private bindExpandedKeys(): void {
    this.onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (this.howtoToggle?.getAttribute('aria-expanded') === 'true') {
        this.closeHowTo({ restoreFocus: true });
        return;
      }
      const back = this.root.querySelector<HTMLAnchorElement>('[data-map-back]');
      if (back) window.location.assign(back.href);
    };
    document.addEventListener('keydown', this.onKeyDown);
  }

  /**
   * Send focus into the map region. Called on the expanded route once the map
   * is up, so a keyboard reader who followed "Expand map" arrives *at* the map
   * rather than at the top of a new document.
   */
  focusMap(): void {
    const region = this.root.querySelector<HTMLElement>('[data-map-canvas]')
      ?? this.root.querySelector<HTMLElement>('[data-map-region]');
    if (!region) return;
    if (!region.hasAttribute('tabindex')) region.setAttribute('tabindex', '-1');
    region.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // "How to read this map"
  // -------------------------------------------------------------------------

  private bindHowTo(): void {
    const toggle = this.howtoToggle;
    const panel = this.howtoPanel;
    if (!toggle || !panel) return;

    toggle.setAttribute('aria-expanded', 'false');
    panel.hidden = true;

    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      if (open) this.closeHowTo({ restoreFocus: false });
      else this.openHowTo();
    });

    panel.querySelector<HTMLButtonElement>('[data-map-howto-close]')
      ?.addEventListener('click', () => this.closeHowTo({ restoreFocus: true }));
  }

  openHowTo(): void {
    if (!this.howtoToggle || !this.howtoPanel) return;
    this.howtoToggle.setAttribute('aria-expanded', 'true');
    this.howtoPanel.hidden = false;
  }

  closeHowTo({ restoreFocus }: { restoreFocus: boolean }): void {
    if (!this.howtoToggle || !this.howtoPanel) return;
    this.howtoToggle.setAttribute('aria-expanded', 'false');
    this.howtoPanel.hidden = true;
    if (restoreFocus) this.howtoToggle.focus();
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * @param state  loading / ready / empty / error
   * @param message Optional override. The stage ships plain-language defaults
   *   so a guide can never fail into an unlabelled blank rectangle.
   */
  setState(state: MapStageState, message?: string): void {
    this.state = state;
    this.root.dataset.mapState = state;
    if (!this.statusEl) return;

    this.statusEl.dataset.mapState = state;
    this.statusEl.hidden = state === 'ready';

    // An error is the only state worth interrupting a screen reader for; the
    // rest are progress reports.
    this.statusEl.setAttribute('role', state === 'error' ? 'alert' : 'status');
    this.statusEl.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite');

    const text = this.statusEl.querySelector<HTMLElement>('[data-map-status-text]');
    if (text) text.textContent = message ?? defaultMessage(state);
    if (this.retryBtn) this.retryBtn.hidden = state !== 'error';
  }

  getState(): MapStageState {
    return this.state;
  }

  private bindRetry(): void {
    this.retryBtn?.addEventListener('click', () => {
      this.setState('loading');
      this.onRetry?.();
    });
  }

  // -------------------------------------------------------------------------
  // Expand link
  // -------------------------------------------------------------------------

  /**
   * Keep the expand href pointed at what the reader is currently looking at,
   * carrying whatever other query state the guide already owns (fg01's
   * `?place=`, fg03's filters) so expanding never silently resets it.
   */
  syncExpandHref(): void {
    const link = this.expandLink;
    const map = this.map;
    if (!link || !map || !this.expandPath) return;

    const center = map.getCenter();
    const href = buildHref(
      this.expandPath,
      window.location.search,
      [center.lng, center.lat, map.getZoom()],
    );
    link.setAttribute('href', href);
  }
}

function defaultMessage(state: MapStageState): string {
  switch (state) {
    case 'loading':
      return 'Loading the map';
    case 'empty':
      return 'Nothing to show here yet. Widen the filters or reset the view.';
    case 'error':
      return 'The map data could not be loaded. Retry, or read the entries listed below the map.';
    default:
      return '';
  }
}

/**
 * Local mirror of buildExpandedMapHref so map-stage.ts stays free of a runtime
 * import into .mjs; the format is asserted identical in tests/map-url.test.mjs.
 */
function buildHref(
  path: string,
  search: string,
  camera: [number, number, number],
): string {
  const params = new URLSearchParams(search);
  const [lng, lat, zoom] = camera;
  if ([lng, lat, zoom].every((n) => Number.isFinite(n))) {
    params.set('map', `${lng.toFixed(5)},${lat.toFixed(5)},${zoom.toFixed(2)}`);
  } else {
    params.delete('map');
  }
  const query = params.toString();
  return query === '' ? path : `${path}?${query}`;
}

/**
 * Convenience wiring for a guide: find the stage, build it, return it.
 * Returns null when the page has no stage (404, about, forthcoming guides).
 */
export function createMapStage(
  options: Omit<MapStageOptions, 'root'> & { root?: HTMLElement | null },
): MapStage | null {
  const root = options.root ?? document.querySelector<HTMLElement>('[data-map-stage]');
  if (!root) return null;
  return new MapStage({ ...options, root }).init();
}
