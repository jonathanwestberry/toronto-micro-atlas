export function toDataAccessMode(access) {
  if (access === 'public') {
    return 'public';
  }
  if (access === 'rider') {
    return 'rider_conditional';
  }
  return null;
}

function foldCase(value) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u00df/gu, 'ss')
    .replace(/\u03c2/gu, '\u03c3')
    .normalize('NFKC');
}

function normalizeText(value) {
  return typeof value === 'string'
    ? foldCase(value).trim().replace(/\s+/gu, ' ')
    : '';
}

function safeRead(source, key) {
  try {
    return source !== null && source !== undefined ? source[key] : undefined;
  } catch {
    return undefined;
  }
}

function safeArraySnapshot(value) {
  try {
    if (!Array.isArray(value)) {
      return null;
    }
  } catch {
    return null;
  }

  const length = safeRead(value, 'length');
  if (!Number.isSafeInteger(length) || length < 0) {
    return null;
  }

  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    snapshot.push(safeRead(value, index));
  }
  return snapshot;
}

function safeProperties(feature) {
  const properties = safeRead(feature, 'properties');
  return properties !== null && typeof properties === 'object'
    ? properties
    : null;
}

function snapshotString(properties, key, fallback = null) {
  const value = safeRead(properties, key);
  return typeof value === 'string' ? value : fallback;
}

function snapshotOptionalString(properties, key) {
  const value = safeRead(properties, key);
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : '';
}

function snapshotBoolean(properties, key) {
  const value = safeRead(properties, key);
  return typeof value === 'boolean' ? value : null;
}

function snapshotNumber(properties, key) {
  const value = safeRead(properties, key);
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function snapshotFeature(feature) {
  const properties = safeProperties(feature);
  return {
    feature,
    hasProperties: properties !== null,
    accessCondition: snapshotString(properties, 'accessCondition'),
    action: snapshotOptionalString(properties, 'action'),
    actionClass: snapshotString(properties, 'actionClass'),
    address: snapshotString(properties, 'address'),
    facilityId: snapshotString(properties, 'facilityId'),
    id: snapshotString(properties, 'id', ''),
    materialGain: snapshotBoolean(properties, 'materialGain'),
    name: snapshotString(properties, 'name'),
    primaryRank: snapshotNumber(properties, 'primaryRank'),
    queryCells: safeArraySnapshot(safeRead(properties, 'queryCells')),
    source: snapshotString(properties, 'source'),
    sourceLabel: snapshotString(properties, 'sourceLabel'),
    sourceUrl: snapshotString(properties, 'sourceUrl'),
    stateByTime: safeRead(properties, 'stateByTime'),
    verificationSubtype: snapshotString(properties, 'verificationSubtype'),
  };
}

function snapshotCollection(collection, required = false) {
  const features = safeArraySnapshot(safeRead(collection, 'features'));
  if (features === null) {
    if (required) {
      throw new TypeError('FG03 result data must contain a features array');
    }
    return [];
  }
  return features.map(snapshotFeature);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFacilities(left, right) {
  const nameOrder = compareText(
    normalizeText(left.name),
    normalizeText(right.name),
  );
  if (nameOrder !== 0) {
    return nameOrder;
  }
  return compareText(
    left.id,
    right.id,
  );
}

function filterOpenSnapshots(snapshots, state) {
  return snapshots
    .filter((feature) => {
      const accessAllowed = state.access === 'public'
        ? feature.accessCondition === 'unrestricted'
        : state.access === 'rider'
          && (
            feature.accessCondition === 'unrestricted'
            || feature.accessCondition === 'fare_paid'
          );
      const observedState = safeRead(
        safeRead(feature.stateByTime, state.time),
        'observed',
      );
      return (
        accessAllowed
        && observedState === 'open'
      );
    })
    .sort(compareFacilities);
}

function snapshotOpenState(state) {
  return {
    access: safeRead(state, 'access'),
    time: safeRead(state, 'time'),
  };
}

export function filterOpenFacilities(collection, state) {
  return filterOpenSnapshots(
    snapshotCollection(collection),
    snapshotOpenState(state),
  ).map((snapshot) => snapshot.feature);
}

function accessDisclosure(condition) {
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

export function getAccessDisclosure(feature) {
  return accessDisclosure(snapshotFeature(feature).accessCondition);
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

function matchingQueryCell(snapshot, state) {
  const dataAccess = toDataAccessMode(state.access);
  if (
    snapshot.action !== state.action
    || snapshot.materialGain !== true
    || dataAccess === null
    || snapshot.queryCells === null
  ) {
    return null;
  }

  const matchingCells = snapshot.queryCells.filter(
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
  return matchingQueryCell(
    snapshotFeature(feature),
    snapshotInterventionState(state),
  );
}

export function filterInterventions(collection, state) {
  const snapshots = snapshotCollection(collection);
  const snapshot = snapshotInterventionState(state);
  const matching = snapshots.filter(
    (feature) => matchingQueryCell(feature, snapshot) !== null,
  );
  return groupRankedSnapshots(matching).flatMap(
    (group) => group.snapshots.map((item) => item.feature),
  );
}

function interventionGroupId(snapshot) {
  if (snapshot.action === 'verify') {
    if (snapshot.verificationSubtype === 'hours') {
      return 'verify-hours';
    }
    if (snapshot.verificationSubtype === 'accessibility') {
      return 'verify-accessibility';
    }
    return 'verify-information';
  }
  return typeof snapshot.actionClass === 'string'
    ? snapshot.actionClass
    : 'unknown';
}

function compareInterventionRank(left, right) {
  const leftRank = left.primaryRank;
  const rightRank = right.primaryRank;
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
    left.id,
    right.id,
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

function sourceLabelFromSnapshot(snapshot) {
  if (typeof snapshot.sourceLabel === 'string') {
    return snapshot.sourceLabel;
  }

  let source = typeof snapshot.source === 'string'
    ? snapshot.source
    : null;
  if (source === null && typeof snapshot.facilityId === 'string') {
    [source] = snapshot.facilityId.split(':', 1);
  }
  if (
    source === null
    && typeof snapshot.sourceUrl === 'string'
    && /^https:\/\/(?:www\.)?ttc\.ca(?:\/|$)/i.test(snapshot.sourceUrl)
  ) {
    source = 'ttc';
  }
  return typeof source === 'string' && Object.hasOwn(SOURCE_LABELS, source)
    ? SOURCE_LABELS[source]
    : '';
}

export function getSourceLabel(feature) {
  return sourceLabelFromSnapshot(snapshotFeature(feature));
}

function actionLabelFromSnapshot(snapshot) {
  if (!snapshot.hasProperties) {
    return '';
  }
  const action = snapshot.action ?? 'open';
  if (action === 'verify') {
    if (snapshot.verificationSubtype === 'hours') {
      return 'Verify hours';
    }
    if (snapshot.verificationSubtype === 'accessibility') {
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
  return actionLabelFromSnapshot(snapshotFeature(feature));
}

function searchSnapshots(snapshots, query) {
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery === '') {
    return snapshots.slice();
  }
  const tokens = normalizedQuery.split(' ');

  return snapshots.filter((snapshot) => {
    const searchableText = normalizeText([
      snapshot.name,
      snapshot.address,
      sourceLabelFromSnapshot(snapshot),
      actionLabelFromSnapshot(snapshot),
    ].filter((value) => typeof value === 'string').join(' '));
    return tokens.every((token) => searchableText.includes(token));
  });
}

export function searchFg03Results(features, query) {
  const featureSnapshot = safeArraySnapshot(features);
  if (featureSnapshot === null) {
    return [];
  }
  return searchSnapshots(featureSnapshot.map(snapshotFeature), query).map(
    (snapshot) => snapshot.feature,
  );
}

export function collectFg03ResultIds(facilities, interventions) {
  const ids = new Set();
  for (const collection of [facilities, interventions]) {
    for (const snapshot of snapshotCollection(collection, true)) {
      const { id } = snapshot;
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

function reconcileSnapshotSelection(selectedId, visibleSnapshots) {
  if (selectedId === null || selectedId === undefined) {
    return {
      selectedId: null,
      invalidated: false,
    };
  }
  const remainsVisible = visibleSnapshots.some(
    (snapshot) => snapshot.id === selectedId,
  );
  return {
    selectedId: remainsVisible ? selectedId : null,
    invalidated: !remainsVisible,
  };
}

export function reconcileFg03Selection(selectedId, visibleFeatures) {
  const featureSnapshot = safeArraySnapshot(visibleFeatures);
  const snapshots = featureSnapshot === null
    ? []
    : featureSnapshot.map(snapshotFeature);
  return reconcileSnapshotSelection(selectedId, snapshots);
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
  const stateSnapshot = snapshotResultState(state);
  const filteredSnapshots = stateSnapshot.action === 'open'
    ? filterOpenSnapshots(
        snapshotCollection(facilities),
        stateSnapshot,
      )
    : groupRankedSnapshots(
        snapshotCollection(interventions).filter(
          (feature) => matchingQueryCell(feature, stateSnapshot) !== null,
        ),
      ).flatMap((group) => group.snapshots);
  const visibleSnapshots = searchSnapshots(filteredSnapshots, search);
  const features = visibleSnapshots.map((snapshot) => snapshot.feature);
  const groups = stateSnapshot.action === 'open'
    ? [{ id: 'open', items: features }]
    : groupRankedSnapshots(visibleSnapshots).map((group) => ({
        id: group.id,
        items: group.snapshots.map((snapshot) => snapshot.feature),
      }));
  const selection = reconcileSnapshotSelection(
    stateSnapshot.place,
    visibleSnapshots,
  );

  return {
    features,
    groups,
    selectedId: selection.selectedId,
    selectionInvalidated: selection.invalidated,
  };
}

function groupRankedSnapshots(snapshots) {
  const groups = new Map();
  for (const snapshot of snapshots) {
    const id = interventionGroupId(snapshot);
    if (!groups.has(id)) {
      groups.set(id, []);
    }
    groups.get(id).push(snapshot);
  }

  return [...groups]
    .sort(([leftId], [rightId]) => {
      const leftOrder = INTERVENTION_GROUP_ORDER.get(leftId)
        ?? Number.POSITIVE_INFINITY;
      const rightOrder = INTERVENTION_GROUP_ORDER.get(rightId)
        ?? Number.POSITIVE_INFINITY;
      return leftOrder - rightOrder || compareText(leftId, rightId);
    })
    .map(([id, snapshotsInGroup]) => ({
      id,
      snapshots: snapshotsInGroup.sort(compareInterventionRank),
    }));
}

export function groupRankedInterventions(features) {
  const featureSnapshot = safeArraySnapshot(features);
  if (featureSnapshot === null) {
    return [];
  }
  return groupRankedSnapshots(featureSnapshot.map(snapshotFeature)).map(
    (group) => ({
      id: group.id,
      items: group.snapshots.map((snapshot) => snapshot.feature),
    }),
  );
}
