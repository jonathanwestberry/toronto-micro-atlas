import { TORONTO_MAP_BOUNDS } from './map-url.mjs';

const STREET_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const EXPECTED_HOURS = Object.freeze(
  Array.from({ length: 15 }, (_, index) => index + 6),
);

function normalizedText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replaceAll('ß', 'ss')
    .replaceAll('Æ', 'AE')
    .replaceAll('æ', 'ae')
    .replaceAll('Œ', 'OE')
    .replaceAll('œ', 'oe')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en-CA')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function searchStreets(records, query, limit = 8) {
  if (!Array.isArray(records) || !Number.isInteger(limit) || limit < 1) {
    return [];
  }
  const normalizedQuery = normalizedText(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(' ');

  return records
    .map((record) => ({ record, normalizedName: normalizedText(record?.name) }))
    .filter(({ normalizedName }) => (
      normalizedName && tokens.every((token) => normalizedName.includes(token))
    ))
    .sort((left, right) => {
      const leftStarts = left.normalizedName.startsWith(normalizedQuery);
      const rightStarts = right.normalizedName.startsWith(normalizedQuery);
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return compareText(left.normalizedName, right.normalizedName)
        || compareText(left.record.id, right.record.id);
    })
    .slice(0, limit)
    .map(({ record }) => record);
}

function assertFiniteNumber(value, message) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(message);
  }
}

function validateProfile(values, label) {
  if (!Array.isArray(values) || values.length !== EXPECTED_HOURS.length) {
    throw new Error(`${label} must contain fifteen hourly fractions`);
  }
  values.forEach((value) => {
    assertFiniteNumber(value, `${label} contains a non-numeric fraction`);
    if (value < 0 || value > 1) {
      throw new Error(`${label} contains a fraction outside zero to one`);
    }
  });
}

function validateStreet(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('street profile row is not an object');
  }
  if (typeof record.id !== 'string' || !STREET_ID.test(record.id)) {
    throw new Error('street profile has an invalid public id');
  }
  if (
    typeof record.name !== 'string'
    || record.name.trim() !== record.name
    || record.name.length < 1
    || record.name.length > 200
  ) {
    throw new Error(`street ${record.id} has an invalid name`);
  }
  if (!Array.isArray(record.center) || record.center.length !== 2) {
    throw new Error(`street ${record.id} has an invalid centre`);
  }
  const [longitude, latitude] = record.center;
  assertFiniteNumber(longitude, `street ${record.id} has an invalid longitude`);
  assertFiniteNumber(latitude, `street ${record.id} has an invalid latitude`);
  if (
    longitude < TORONTO_MAP_BOUNDS.minLongitude
    || longitude > TORONTO_MAP_BOUNDS.maxLongitude
    || latitude < TORONTO_MAP_BOUNDS.minLatitude
    || latitude > TORONTO_MAP_BOUNDS.maxLatitude
  ) {
    throw new Error(`street ${record.id} has a centre outside Toronto`);
  }
  assertFiniteNumber(record.lengthM, `street ${record.id} has an invalid length`);
  if (record.lengthM < 100) {
    throw new Error(`street ${record.id} is shorter than the explorer grain`);
  }
  if (!Number.isInteger(record.groundPixels) || record.groundPixels < 1) {
    throw new Error(`street ${record.id} has no sampled ground`);
  }
  validateProfile(record.measured, `street ${record.id} measured profile`);
  validateProfile(record.corrected, `street ${record.id} corrected profile`);
}

export function parseStreetProfiles(payload) {
  if (!payload || typeof payload !== 'object' || payload.schemaVersion !== 1) {
    throw new Error('street profiles use an unsupported schema');
  }
  if (
    !Array.isArray(payload.hours)
    || payload.hours.length !== EXPECTED_HOURS.length
    || payload.hours.some((hour, index) => hour !== EXPECTED_HOURS[index])
  ) {
    throw new Error('street profiles do not cover 06:00 to 20:00');
  }
  if (
    !Array.isArray(payload.surfaceOrder)
    || payload.surfaceOrder.length !== 2
    || payload.surfaceOrder[0] !== 'measured'
    || payload.surfaceOrder[1] !== 'corrected'
  ) {
    throw new Error('street profiles do not carry both surfaces in order');
  }
  const grain = payload.grain;
  if (
    !grain
    || grain.included !== 'named walkable street features clipped to Toronto'
    || grain.source !== 'OpenStreetMap named ways'
    || grain.minimumCenterlineM !== 100
    || grain.walkingBandM?.inner !== 8
    || grain.walkingBandM?.outer !== 15
  ) {
    throw new Error('street profile grain does not match the explorer contract');
  }
  if (!Array.isArray(payload.streets)) {
    throw new Error('street profile asset has no street rows');
  }
  const seen = new Set();
  payload.streets.forEach((street) => {
    validateStreet(street);
    if (seen.has(street.id)) throw new Error(`duplicate street id ${street.id}`);
    seen.add(street.id);
  });
  return payload;
}

export function streetById(records, id) {
  if (!Array.isArray(records) || typeof id !== 'string') return null;
  return records.find((record) => record.id === id) ?? null;
}

export function profileAtHour(record, hour, hours = EXPECTED_HOURS) {
  const index = Array.isArray(hours) ? hours.indexOf(hour) : -1;
  if (index < 0 || !record?.measured || !record?.corrected) {
    throw new RangeError('street hour is outside the modelled day');
  }
  return {
    measured: record.measured[index],
    corrected: record.corrected[index],
  };
}
