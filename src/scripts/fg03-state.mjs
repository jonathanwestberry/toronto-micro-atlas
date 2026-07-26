const TIMES = new Set(['1200', '2030', '2200', '0030']);
const ACCESS_MODES = new Set(['public', 'rider']);
const WALK_DISTANCES = new Set([300, 400, 500]);
const ACTIONS = new Set(['open', 'extend', 'new', 'verify', 'retrofit']);
const SAFE_PLACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ORDINARY_DECIMAL = /^-?\d+(?:\.\d+)?$/;

const MAP_BOUNDS = Object.freeze({
  minLongitude: -79.6393,
  maxLongitude: -79.1153,
  minLatitude: 43.581,
  maxLatitude: 43.8555,
  minZoom: 8,
  maxZoom: 18.5,
});

export const DEFAULT_FG03_STATE = Object.freeze({
  time: '2200',
  access: 'public',
  walk: 400,
  action: 'extend',
  place: null,
  map: null,
});

function roundMap([longitude, latitude, zoom]) {
  return [
    Number(longitude.toFixed(5)),
    Number(latitude.toFixed(5)),
    Number(zoom.toFixed(2)),
  ];
}

function snapshotMap(value) {
  try {
    if (!Array.isArray(value) || value.length !== 3) {
      return null;
    }
    return [value[0], value[1], value[2]];
  } catch {
    return null;
  }
}

function normalizeMap(value) {
  const snapshot = snapshotMap(value);
  if (
    snapshot === null
    || snapshot.some(
      (part) => typeof part !== 'number' || !Number.isFinite(part),
    )
  ) {
    return null;
  }

  const [longitude, latitude, zoom] = snapshot;
  if (
    longitude < MAP_BOUNDS.minLongitude
    || longitude > MAP_BOUNDS.maxLongitude
    || latitude < MAP_BOUNDS.minLatitude
    || latitude > MAP_BOUNDS.maxLatitude
    || zoom < MAP_BOUNDS.minZoom
    || zoom > MAP_BOUNDS.maxZoom
  ) {
    return null;
  }

  return roundMap(snapshot);
}

function parseMap(value) {
  const parts = value.split(',');
  if (
    parts.length !== 3
    || parts.some((part) => !ORDINARY_DECIMAL.test(part))
  ) {
    return null;
  }

  return normalizeMap(parts.map(Number));
}

function snapshotState(state) {
  const source = state && typeof state === 'object' ? state : {};
  const snapshot = {};

  for (const key of ['time', 'access', 'walk', 'action', 'place', 'map']) {
    try {
      snapshot[key] = source[key];
    } catch {
      snapshot[key] = undefined;
    }
  }

  return snapshot;
}

function normalizeState(state) {
  const {
    time,
    access,
    walk,
    action,
    place,
    map,
  } = snapshotState(state);

  return {
    time: TIMES.has(time) ? time : DEFAULT_FG03_STATE.time,
    access: ACCESS_MODES.has(access)
      ? access
      : DEFAULT_FG03_STATE.access,
    walk: WALK_DISTANCES.has(walk)
      ? walk
      : DEFAULT_FG03_STATE.walk,
    action: ACTIONS.has(action)
      ? action
      : DEFAULT_FG03_STATE.action,
    place: typeof place === 'string' && SAFE_PLACE_ID.test(place)
      ? place
      : null,
    map: normalizeMap(map),
  };
}

function singleValue(params, key) {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : null;
}

export function parseFg03State(search, validPlaceIds) {
  const params = new URLSearchParams(search);
  const time = singleValue(params, 'time');
  const access = singleValue(params, 'access');
  const walk = singleValue(params, 'walk');
  const action = singleValue(params, 'action');
  const place = singleValue(params, 'place');
  const map = singleValue(params, 'map');

  let safePlace = typeof place === 'string' && SAFE_PLACE_ID.test(place)
    ? place
    : null;
  if (safePlace !== null && validPlaceIds !== null && validPlaceIds !== undefined) {
    safePlace = typeof validPlaceIds.has === 'function'
      && validPlaceIds.has(safePlace)
      ? safePlace
      : null;
  }

  return {
    time: TIMES.has(time) ? time : DEFAULT_FG03_STATE.time,
    access: ACCESS_MODES.has(access) ? access : DEFAULT_FG03_STATE.access,
    walk: typeof walk === 'string' && /^(?:300|400|500)$/.test(walk)
      ? Number(walk)
      : DEFAULT_FG03_STATE.walk,
    action: ACTIONS.has(action) ? action : DEFAULT_FG03_STATE.action,
    place: safePlace,
    map: typeof map === 'string' ? parseMap(map) : null,
  };
}

export function serializeFg03State(state) {
  const normalized = normalizeState(state);
  const params = new URLSearchParams();

  if (normalized.time !== DEFAULT_FG03_STATE.time) {
    params.set('time', normalized.time);
  }
  if (normalized.access !== DEFAULT_FG03_STATE.access) {
    params.set('access', normalized.access);
  }
  if (normalized.walk !== DEFAULT_FG03_STATE.walk) {
    params.set('walk', String(normalized.walk));
  }
  if (normalized.action !== DEFAULT_FG03_STATE.action) {
    params.set('action', normalized.action);
  }
  if (normalized.place !== null) {
    params.set('place', normalized.place);
  }
  if (normalized.map !== null) {
    const [longitude, latitude, zoom] = normalized.map;
    params.set(
      'map',
      `${longitude.toFixed(5)},${latitude.toFixed(5)},${zoom.toFixed(2)}`,
    );
  }

  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export function stateEquals(left, right) {
  const a = normalizeState(left);
  const b = normalizeState(right);

  return (
    a.time === b.time
    && a.access === b.access
    && a.walk === b.walk
    && a.action === b.action
    && a.place === b.place
    && (
      a.map === b.map
      || (
        a.map !== null
        && b.map !== null
        && a.map.every((value, index) => value === b.map[index])
      )
    )
  );
}
