/*
 * The transit stops with no usable shade, as a browsable set.
 *
 * The guide publishes 533 as a count. This module carries the set behind it.
 * The distinction matters: the proof file also records a "sunniest five",
 * which is an argsort slice of a large tied set and can never say how many
 * there are. The whole set can, and every stop in it sits at the same single
 * modelled frame, so nothing here ranks them.
 *
 * That is why filtering preserves the published order instead of scoring
 * matches the way searchStreets() does. A relevance sort would put a stop at
 * the top of the list, and a reader who sees a stop at the top of a list about
 * missing shade will read it as the worst one. There is no worst one.
 */

const STOP_ID = /^stop:[0-9]+$/;

function normalizedText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en-CA')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Parse the published payload, refusing anything that would put a marker in
 * the lake or claim a count the set does not actually contain.
 */
export function parseNoShadeStops(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('stop payload is not an object');
  }
  const { stops, count, ofTotal, sharePercent, order } = payload;
  if (!Array.isArray(stops)) throw new Error('stops is not an array');
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('count is not a whole number');
  }
  if (stops.length !== count) {
    throw new Error(`count says ${count} but the set holds ${stops.length}`);
  }
  if (!Number.isInteger(ofTotal) || ofTotal < count) {
    throw new Error('ofTotal is missing or smaller than the set');
  }
  if (order !== 'name') {
    throw new Error(`unexpected order "${order}"; the set carries no ranking`);
  }

  const seen = new Set();
  const records = stops.map((stop, index) => {
    if (!stop || typeof stop !== 'object') {
      throw new Error(`stop ${index} is not an object`);
    }
    const { id, name, lon, lat } = stop;
    if (typeof id !== 'string' || !STOP_ID.test(id)) {
      throw new Error(`stop ${index} has an unusable id`);
    }
    if (seen.has(id)) throw new Error(`stop id ${id} appears twice`);
    seen.add(id);
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error(`stop ${id} has no name`);
    }
    if (typeof lon !== 'number' || !Number.isFinite(lon)
      || lon < -79.7 || lon > -79.1) {
      throw new Error(`stop ${id} sits outside Toronto in longitude`);
    }
    if (typeof lat !== 'number' || !Number.isFinite(lat)
      || lat < 43.5 || lat > 43.9) {
      throw new Error(`stop ${id} sits outside Toronto in latitude`);
    }
    return {
      id,
      name: name.trim(),
      coordinate: [lon, lat],
      normalizedName: normalizedText(name),
    };
  });

  return {
    count,
    ofTotal,
    sharePercent: typeof sharePercent === 'number' ? sharePercent : null,
    stops: records,
  };
}

/**
 * Every stop whose name contains all of the query's tokens, in published
 * order. An empty query returns the whole set rather than nothing, because
 * this list is meant to be browsed and not only searched.
 */
export function filterStops(records, query) {
  if (!Array.isArray(records)) return [];
  const normalizedQuery = normalizedText(query);
  if (!normalizedQuery) return records.slice();
  const tokens = normalizedQuery.split(' ');
  return records.filter((record) => (
    typeof record?.normalizedName === 'string'
    && tokens.every((token) => record.normalizedName.includes(token))
  ));
}

/**
 * The sentence under the search box. It says how many of the set are showing
 * and, when the reader has filtered, what they filtered out, so the count on
 * screen can never be mistaken for the published total.
 */
export function stopCountLabel(shown, total) {
  if (!Number.isInteger(shown) || !Number.isInteger(total) || total < 0) {
    return '';
  }
  if (shown === total) {
    return `All ${total.toLocaleString('en-CA')} stops, listed by name.`;
  }
  if (shown === 0) {
    return `No stop of the ${total.toLocaleString('en-CA')} matches that name.`;
  }
  return `${shown.toLocaleString('en-CA')} of ${total.toLocaleString('en-CA')} stops match.`;
}

export function stopById(records, id) {
  if (!Array.isArray(records) || typeof id !== 'string') return null;
  return records.find((record) => record.id === id) ?? null;
}
