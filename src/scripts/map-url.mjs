/**
 * Shared `?map=lng,lat,z` camera state.
 *
 * FG03 got here first (src/scripts/fg03-state.mjs) and its format is now the
 * atlas-wide contract: five decimals of longitude and latitude, two of zoom,
 * comma separated, rejected outright when it falls outside Toronto. This module
 * is the generic version every guide's map stage uses so an expanded map URL
 * means the same thing on all three guides.
 *
 * fg03-state.mjs deliberately keeps its own copy: it is guarded by the contract
 * test and carries filter state this module has no business knowing about.
 * tests/map-url.test.mjs asserts the two stay byte-identical on the map param.
 */

/** Same window fg03 validates against: the city plus a little slack. */
export const TORONTO_MAP_BOUNDS = Object.freeze({
  minLongitude: -79.6393,
  maxLongitude: -79.1153,
  minLatitude: 43.581,
  maxLatitude: 43.8555,
  minZoom: 8,
  maxZoom: 18.5,
});

const ORDINARY_DECIMAL = /^-?\d+(?:\.\d+)?$/;

function roundCamera([longitude, latitude, zoom]) {
  return [
    Number(longitude.toFixed(5)),
    Number(latitude.toFixed(5)),
    Number(zoom.toFixed(2)),
  ];
}

/**
 * Reject anything that is not three finite numbers inside `bounds`. Returning
 * null rather than clamping is deliberate: a truncated or hand-mangled URL
 * should drop the reader at the guide's default view, not at a silently
 * different place that looks intentional.
 *
 * @param {unknown} value
 * @param {typeof TORONTO_MAP_BOUNDS} [bounds]
 * @returns {[number, number, number] | null}
 */
export function normalizeCamera(value, bounds = TORONTO_MAP_BOUNDS) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const parts = [value[0], value[1], value[2]];
  if (parts.some((part) => typeof part !== 'number' || !Number.isFinite(part))) {
    return null;
  }

  const [longitude, latitude, zoom] = parts;
  if (
    longitude < bounds.minLongitude
    || longitude > bounds.maxLongitude
    || latitude < bounds.minLatitude
    || latitude > bounds.maxLatitude
    || zoom < bounds.minZoom
    || zoom > bounds.maxZoom
  ) {
    return null;
  }

  return roundCamera(parts);
}

/**
 * Parse the raw `map` query value.
 *
 * @param {string | null | undefined} value
 * @param {typeof TORONTO_MAP_BOUNDS} [bounds]
 * @returns {[number, number, number] | null}
 */
export function parseCamera(value, bounds = TORONTO_MAP_BOUNDS) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  if (parts.length !== 3 || parts.some((part) => !ORDINARY_DECIMAL.test(part))) {
    return null;
  }
  return normalizeCamera(parts.map(Number), bounds);
}

/**
 * Pull the camera out of a full query string.
 *
 * Repeated `?map=` keys are rejected the way fg03 rejects them: an ambiguous
 * URL has no single right answer, so it gets the default view.
 *
 * @param {string} search
 * @param {typeof TORONTO_MAP_BOUNDS} [bounds]
 * @returns {[number, number, number] | null}
 */
export function parseCameraFromSearch(search, bounds = TORONTO_MAP_BOUNDS) {
  const values = new URLSearchParams(search).getAll('map');
  return values.length === 1 ? parseCamera(values[0], bounds) : null;
}

/**
 * Render the camera back to the wire format. Returns null when the camera is
 * not representable, so callers can drop the param instead of writing junk.
 *
 * @param {unknown} value
 * @param {typeof TORONTO_MAP_BOUNDS} [bounds]
 * @returns {string | null}
 */
export function serializeCamera(value, bounds = TORONTO_MAP_BOUNDS) {
  const camera = normalizeCamera(value, bounds);
  if (camera === null) return null;
  const [longitude, latitude, zoom] = camera;
  return `${longitude.toFixed(5)},${latitude.toFixed(5)},${zoom.toFixed(2)}`;
}

/**
 * Build the href for a guide's expanded map, preserving any other query state
 * the guide already put in the URL (fg03's filters, fg01's `?place=`).
 *
 * @param {object} options
 * @param {string} options.mapPath   absolute path of the expand route
 * @param {string} [options.search]  current query string to carry across
 * @param {unknown} [options.camera] [lng, lat, zoom] to write as `map`
 * @param {typeof TORONTO_MAP_BOUNDS} [options.bounds]
 * @returns {string}
 */
export function buildExpandedMapHref({ mapPath, search = '', camera = null, bounds = TORONTO_MAP_BOUNDS }) {
  const params = new URLSearchParams(search);
  const serialized = serializeCamera(camera, bounds);
  if (serialized === null) {
    params.delete('map');
  } else {
    params.set('map', serialized);
  }
  const query = params.toString();
  return query === '' ? mapPath : `${mapPath}?${query}`;
}
