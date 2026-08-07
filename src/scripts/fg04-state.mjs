import {
  normalizeCamera,
  parseCameraFromSearch,
  serializeCamera,
  TORONTO_MAP_BOUNDS,
} from './map-url.mjs';

const DEFAULT_HOUR = 13;
const HOUR_WIRE = /^(?:[6-9]|1[0-9]|20)$/;
const POINT_WIRE = /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/;
const STREET_WIRE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export const DEFAULT_FG04_STATE = Object.freeze({
  hour: DEFAULT_HOUR,
  map: null,
  point: null,
  street: null,
});

function singleValue(params, key) {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : null;
}

function normalizeHour(value) {
  return Number.isInteger(value) && value >= 6 && value <= 20
    ? value
    : DEFAULT_HOUR;
}

function normalizePoint(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [longitude, latitude] = value;
  if (
    typeof longitude !== 'number'
    || typeof latitude !== 'number'
    || !Number.isFinite(longitude)
    || !Number.isFinite(latitude)
    || longitude < TORONTO_MAP_BOUNDS.minLongitude
    || longitude > TORONTO_MAP_BOUNDS.maxLongitude
    || latitude < TORONTO_MAP_BOUNDS.minLatitude
    || latitude > TORONTO_MAP_BOUNDS.maxLatitude
  ) {
    return null;
  }
  return [
    Number(longitude.toFixed(5)),
    Number(latitude.toFixed(5)),
  ];
}

function parsePoint(value) {
  if (typeof value !== 'string' || !POINT_WIRE.test(value)) return null;
  return normalizePoint(value.split(',').map(Number));
}

function normalizeStreet(value) {
  return typeof value === 'string' && STREET_WIRE.test(value) ? value : null;
}

function normalizeState(value) {
  const source = value && typeof value === 'object' ? value : {};
  let hour;
  let map;
  let point;
  let street;
  try {
    hour = source.hour;
    map = source.map;
    point = source.point;
    street = source.street;
  } catch {
    return { ...DEFAULT_FG04_STATE };
  }

  const safePoint = normalizePoint(point);
  return {
    hour: normalizeHour(hour),
    map: normalizeCamera(map),
    point: safePoint,
    street: safePoint === null ? normalizeStreet(street) : null,
  };
}

export function parseFg04State(search) {
  const params = new URLSearchParams(search);
  const hourWire = singleValue(params, 'hour');
  const pointWire = singleValue(params, 'point');
  const streetWire = singleValue(params, 'street');
  const point = parsePoint(pointWire);
  const street = normalizeStreet(streetWire);
  const ambiguousSelection = point !== null && street !== null;

  return {
    hour: typeof hourWire === 'string' && HOUR_WIRE.test(hourWire)
      ? Number(hourWire)
      : DEFAULT_HOUR,
    map: parseCameraFromSearch(search),
    point: ambiguousSelection ? null : point,
    street: ambiguousSelection ? null : street,
  };
}

export function serializeFg04State(value) {
  const state = normalizeState(value);
  const params = new URLSearchParams();
  if (state.hour !== DEFAULT_HOUR) params.set('hour', String(state.hour));

  const camera = serializeCamera(state.map);
  if (camera !== null) params.set('map', camera);

  if (state.point !== null) {
    params.set(
      'point',
      `${state.point[0].toFixed(5)},${state.point[1].toFixed(5)}`,
    );
  } else if (state.street !== null) {
    params.set('street', state.street);
  }

  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export function fg04StateEquals(left, right) {
  const a = normalizeState(left);
  const b = normalizeState(right);
  const sameArray = (one, two) => (
    one === two
    || (
      one !== null
      && two !== null
      && one.length === two.length
      && one.every((item, index) => item === two[index])
    )
  );
  return a.hour === b.hour
    && sameArray(a.map, b.map)
    && sameArray(a.point, b.point)
    && a.street === b.street;
}
