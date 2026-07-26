export function toDataAccessMode(access) {
  if (access === 'public') {
    return 'public';
  }
  if (access === 'rider') {
    return 'rider_conditional';
  }
  return null;
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLocaleLowerCase('en-CA').trim().replace(/\s+/gu, ' ')
    : '';
}

function safeRead(source, key) {
  try {
    return source !== null && source !== undefined ? source[key] : undefined;
  } catch {
    return undefined;
  }
}

function safeProperties(feature) {
  const properties = safeRead(feature, 'properties');
  return properties !== null && typeof properties === 'object'
    ? properties
    : null;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFacilities(left, right) {
  const nameOrder = compareText(
    normalizeText(left?.properties?.name),
    normalizeText(right?.properties?.name),
  );
  if (nameOrder !== 0) {
    return nameOrder;
  }
  return compareText(
    String(left?.properties?.id ?? ''),
    String(right?.properties?.id ?? ''),
  );
}

export function filterOpenFacilities(collection, state) {
  const sourceFeatures = safeRead(collection, 'features');
  const features = Array.isArray(sourceFeatures)
    ? sourceFeatures
    : [];
  const time = safeRead(state, 'time');
  const access = safeRead(state, 'access');
  return features
    .filter((feature) => {
      const properties = safeProperties(feature);
      const accessCondition = safeRead(properties, 'accessCondition');
      const accessAllowed = access === 'public'
        ? accessCondition === 'unrestricted'
        : access === 'rider'
          && (
            accessCondition === 'unrestricted'
            || accessCondition === 'fare_paid'
          );
      const stateByTime = safeRead(properties, 'stateByTime');
      const observedState = safeRead(safeRead(stateByTime, time), 'observed');
      return (
        accessAllowed
        && observedState === 'open'
      );
    })
    .sort(compareFacilities);
}

export function getAccessDisclosure(feature) {
  const condition = safeRead(safeProperties(feature), 'accessCondition');
  if (condition === 'fare_paid') {
    return {
      condition,
      requiresFare: true,
      label: 'Fare-paid area, valid fare required',
    };
  }
  if (condition === 'unrestricted') {
    return {
      condition,
      requiresFare: false,
      label: 'No fare required',
    };
  }
  return null;
}

function hasPositiveGain(cell) {
  for (const key of ['activeStops', 'events', 'uniqueRoutes', 'uniqueTrips']) {
    const value = safeRead(cell, key);
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return true;
    }
  }
  return false;
}

function snapshotInterventionState(state) {
  return {
    access: safeRead(state, 'access'),
    action: safeRead(state, 'action'),
    time: safeRead(state, 'time'),
    walk: safeRead(state, 'walk'),
  };
}

function matchingQueryCell(feature, state) {
  const properties = safeProperties(feature);
  const action = safeRead(properties, 'action');
  const materialGain = safeRead(properties, 'materialGain');
  const queryCells = safeRead(properties, 'queryCells');
  const dataAccess = toDataAccessMode(state.access);
  if (
    action !== state.action
    || materialGain !== true
    || dataAccess === null
    || !Array.isArray(queryCells)
  ) {
    return null;
  }

  const matchingCells = queryCells.filter(
    (candidate) => (
      safeRead(candidate, 'time') === state.time
      && safeRead(candidate, 'access') === dataAccess
      && safeRead(candidate, 'walk') === state.walk
    ),
  );
  if (matchingCells.length !== 1) {
    return null;
  }
  const [cell] = matchingCells;
  return safeRead(cell, 'active') === true && hasPositiveGain(cell)
    ? cell
    : null;
}

export function getMatchingQueryCell(feature, state) {
  return matchingQueryCell(feature, snapshotInterventionState(state));
}

export function filterInterventions(collection, state) {
  const sourceFeatures = safeRead(collection, 'features');
  const features = Array.isArray(sourceFeatures)
    ? sourceFeatures
    : [];
  const snapshot = snapshotInterventionState(state);
  const matching = features.filter(
    (feature) => matchingQueryCell(feature, snapshot) !== null,
  );
  return groupRankedInterventions(matching).flatMap((group) => group.items);
}

function interventionGroupId(feature) {
  const properties = feature?.properties;
  if (properties?.action === 'verify') {
    if (properties.verificationSubtype === 'hours') {
      return 'verify-hours';
    }
    if (properties.verificationSubtype === 'accessibility') {
      return 'verify-accessibility';
    }
    return 'verify-information';
  }
  return typeof properties?.actionClass === 'string'
    ? properties.actionClass
    : 'unknown';
}

function compareInterventionRank(left, right) {
  const leftRank = left?.properties?.primaryRank;
  const rightRank = right?.properties?.primaryRank;
  const safeLeftRank = typeof leftRank === 'number' && Number.isFinite(leftRank)
    ? leftRank
    : Number.POSITIVE_INFINITY;
  const safeRightRank = typeof rightRank === 'number' && Number.isFinite(rightRank)
    ? rightRank
    : Number.POSITIVE_INFINITY;
  if (safeLeftRank !== safeRightRank) {
    return safeLeftRank - safeRightRank;
  }
  return compareText(
    String(left?.properties?.id ?? ''),
    String(right?.properties?.id ?? ''),
  );
}

const INTERVENTION_GROUP_ORDER = new Map([
  ['extend_hours', 0],
  ['new_facility_zone', 1],
  ['verify-hours', 2],
  ['verify-accessibility', 3],
  ['verify-information', 4],
  ['retrofit_accessibility', 5],
]);

const SOURCE_LABELS = Object.freeze({
  automated: 'Automated Public Washrooms',
  crem: 'CREM Portfolio Washrooms',
  library: 'Library Branch General Information',
  museum: 'Museums and Cultural Centres',
  parks: 'Park Washroom Facilities',
  ttc: 'TTC station washrooms',
});
const SAFE_RESULT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function sourceLabelFromProperties(properties) {
  const sourceLabel = safeRead(properties, 'sourceLabel');
  if (typeof sourceLabel === 'string') {
    return sourceLabel;
  }

  const rawSource = safeRead(properties, 'source');
  let source = typeof rawSource === 'string'
    ? rawSource
    : null;
  const facilityId = safeRead(properties, 'facilityId');
  if (source === null && typeof facilityId === 'string') {
    [source] = facilityId.split(':', 1);
  }
  const sourceUrl = safeRead(properties, 'sourceUrl');
  if (
    source === null
    && typeof sourceUrl === 'string'
    && /^https:\/\/(?:www\.)?ttc\.ca(?:\/|$)/i.test(sourceUrl)
  ) {
    source = 'ttc';
  }
  return typeof source === 'string' && Object.hasOwn(SOURCE_LABELS, source)
    ? SOURCE_LABELS[source]
    : '';
}

export function getSourceLabel(feature) {
  return sourceLabelFromProperties(safeProperties(feature));
}

function actionLabelFromProperties(properties) {
  if (properties === null) {
    return '';
  }
  const action = safeRead(properties, 'action') ?? 'open';
  const verificationSubtype = safeRead(properties, 'verificationSubtype');
  if (action === 'verify') {
    if (verificationSubtype === 'hours') {
      return 'Verify hours';
    }
    if (verificationSubtype === 'accessibility') {
      return 'Verify accessibility';
    }
    return 'Verify information';
  }
  return {
    open: 'Open at selected time',
    extend: 'Extend hours',
    new: 'New facility zone',
    retrofit: 'Accessibility retrofit',
  }[action] ?? '';
}

export function getActionLabel(feature) {
  return actionLabelFromProperties(safeProperties(feature));
}

export function searchFg03Results(features, query) {
  if (!Array.isArray(features)) {
    return [];
  }
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery === '') {
    return features.slice();
  }
  const tokens = normalizedQuery.split(' ');

  return features.filter((feature) => {
    const properties = safeProperties(feature);
    const searchableText = normalizeText([
      safeRead(properties, 'name'),
      safeRead(properties, 'address'),
      sourceLabelFromProperties(properties),
      actionLabelFromProperties(properties),
    ].filter((value) => typeof value === 'string').join(' '));
    return tokens.every((token) => searchableText.includes(token));
  });
}

export function collectFg03ResultIds(facilities, interventions) {
  const ids = new Set();
  for (const collection of [facilities, interventions]) {
    if (!Array.isArray(collection?.features)) {
      throw new TypeError('FG03 result data must contain a features array');
    }
    for (const feature of collection.features) {
      const id = feature?.properties?.id;
      if (typeof id !== 'string' || !SAFE_RESULT_ID.test(id)) {
        throw new TypeError('Every FG03 result must have a valid ID');
      }
      if (ids.has(id)) {
        throw new Error(`Duplicate FG03 result ID: ${id}`);
      }
      ids.add(id);
    }
  }
  return ids;
}

export function reconcileFg03Selection(selectedId, visibleFeatures) {
  if (selectedId === null || selectedId === undefined) {
    return {
      selectedId: null,
      invalidated: false,
    };
  }
  const visible = Array.isArray(visibleFeatures) ? visibleFeatures : [];
  const remainsVisible = visible.some(
    (feature) => safeRead(safeProperties(feature), 'id') === selectedId,
  );
  return {
    selectedId: remainsVisible ? selectedId : null,
    invalidated: !remainsVisible,
  };
}

const PUSH_HISTORY_CAUSES = new Set([
  'time-change',
  'access-change',
  'walk-change',
  'action-change',
  'selection',
  'close',
  'reset',
]);
const REPLACE_HISTORY_CAUSES = new Set([
  'initial-cleanup',
  'camera',
  'search-invalidation',
]);

export function getFg03HistoryEffect(cause) {
  if (PUSH_HISTORY_CAUSES.has(cause)) {
    return 'push';
  }
  if (REPLACE_HISTORY_CAUSES.has(cause)) {
    return 'replace';
  }
  return 'none';
}

function snapshotResultState(state) {
  return {
    access: safeRead(state, 'access'),
    action: safeRead(state, 'action'),
    place: safeRead(state, 'place'),
    time: safeRead(state, 'time'),
    walk: safeRead(state, 'walk'),
  };
}

export function deriveFg03Results({
  facilities,
  interventions,
  state,
  search = '',
} = {}) {
  const snapshot = snapshotResultState(state);
  const filtered = snapshot.action === 'open'
    ? filterOpenFacilities(facilities, snapshot)
    : filterInterventions(interventions, snapshot);
  const features = searchFg03Results(filtered, search);
  const groups = snapshot.action === 'open'
    ? [{ id: 'open', items: features }]
    : groupRankedInterventions(features);
  const selection = reconcileFg03Selection(snapshot.place, features);

  return {
    features,
    groups,
    selectedId: selection.selectedId,
    selectionInvalidated: selection.invalidated,
  };
}

export function groupRankedInterventions(features) {
  if (!Array.isArray(features)) {
    return [];
  }

  const groups = new Map();
  for (const feature of features) {
    const id = interventionGroupId(feature);
    if (!groups.has(id)) {
      groups.set(id, []);
    }
    groups.get(id).push(feature);
  }

  return [...groups]
    .sort(([leftId], [rightId]) => {
      const leftOrder = INTERVENTION_GROUP_ORDER.get(leftId)
        ?? Number.POSITIVE_INFINITY;
      const rightOrder = INTERVENTION_GROUP_ORDER.get(rightId)
        ?? Number.POSITIVE_INFINITY;
      return leftOrder - rightOrder || compareText(leftId, rightId);
    })
    .map(([id, items]) => ({
      id,
      items: items.sort(compareInterventionRank),
    }));
}
