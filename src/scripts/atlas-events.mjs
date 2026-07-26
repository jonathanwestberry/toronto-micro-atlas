function values(...items) {
  return new Set(items);
}

const STATE_SHAPES = values('default', 'filtered', 'selected', 'mapped');
const TIMES = values('1200', '2030', '2200', '0030');
const ACTIONS = values('open', 'extend', 'new', 'verify', 'retrofit');

const EVENT_PROPERTIES = new Map([
  ['fg03_entry', new Map([
    ['state_shape', STATE_SHAPES],
  ])],
  ['fg03_engage', new Map([
    ['surface', values('controls', 'map', 'results', 'detail')],
  ])],
  ['fg03_time_change', new Map([
    ['time', TIMES],
  ])],
  ['fg03_access_change', new Map([
    ['access', values('public', 'rider')],
  ])],
  ['fg03_walk_change', new Map([
    ['walk', values('300', '400', '500')],
  ])],
  ['fg03_action_change', new Map([
    ['action', ACTIONS],
  ])],
  ['fg03_search_use', new Map([
    ['result_bucket', values('0', '1-5', '6-20', '21+')],
  ])],
  ['fg03_feature_select', new Map([
    ['kind', values('facility', 'intervention')],
    ['source', values('map', 'list', 'search')],
    ['action', ACTIONS],
  ])],
  ['fg03_method_view', new Map([
    ['section', values('method', 'definitions', 'sources', 'limitations')],
  ])],
  ['fg03_data_download', new Map([
    ['asset', values('manifest', 'facilities', 'interventions', 'stops', 'phase2')],
  ])],
  ['fg03_share', new Map([
    ['method', values('native', 'clipboard')],
    ['state_shape', STATE_SHAPES],
  ])],
  ['fg03_series_navigation', new Map([
    ['destination', values('guide-01', 'guide-02', 'home')],
  ])],
  ['fg03_error', new Map([
    [
      'stage',
      values(
        'manifest',
        'facilities',
        'snapshot',
        'interventions',
        'stops',
        'map',
        'share',
        'explorer',
      ),
    ],
    [
      'kind',
      values(
        'offline',
        'network',
        'http',
        'parse',
        'invalid_data',
        'webgl',
        'unsupported',
        'unknown',
      ),
    ],
  ])],
  ['fg03_journey_complete', new Map([
    ['outcome', values('detail', 'method', 'download', 'share')],
  ])],
]);

function sanitizeProperties(schema, properties) {
  let source = {};
  if (properties && typeof properties === 'object') {
    try {
      source = Array.isArray(properties) ? {} : properties;
    } catch {
      source = {};
    }
  }
  const sanitized = {};

  for (const [key, allowedValues] of schema) {
    let candidate;
    try {
      if (!Object.hasOwn(source, key)) {
        continue;
      }
      candidate = source[key];
    } catch {
      continue;
    }

    if (allowedValues.has(candidate)) {
      sanitized[key] = candidate;
    }
  }

  return sanitized;
}

export function trackAtlasEvent(name, properties = {}) {
  const schema = EVENT_PROPERTIES.get(name);
  if (!schema) {
    return;
  }

  const sanitized = sanitizeProperties(schema, properties);
  const detail = { name, properties: { ...sanitized } };
  const plausibleProperties = { ...sanitized };

  if (typeof window === 'undefined') {
    return;
  }

  try {
    const EventConstructor = window.CustomEvent ?? globalThis.CustomEvent;
    if (
      typeof window.dispatchEvent === 'function'
      && typeof EventConstructor === 'function'
    ) {
      window.dispatchEvent(
        new EventConstructor('tma:analytics', { detail }),
      );
    }
  } catch {
    // Analytics must never interrupt the explorer.
  }

  try {
    if (typeof window.plausible === 'function') {
      window.plausible(name, { props: plausibleProperties });
    }
  } catch {
    // The optional analytics callback is outside the interface contract.
  }
}
