/**
 * FG03 build-time data.
 *
 * Lifted verbatim out of the guide page's frontmatter so the guide and the
 * expanded map route read the same snapshot, the same manifest, and the same
 * default result set. Nothing here is recomputed per page: both routes import
 * these bindings, so the two can never disagree about what "10 p.m., public
 * access, 400 m" means.
 *
 * Runs at build time only.
 */
import { readdirSync, readFileSync } from 'node:fs';

// The same filter the runtime uses for the open-washroom view, so the
// server-rendered list and the first client render cannot disagree about which
// washrooms count as open at the default snapshot.
import { filterOpenFacilities } from '../scripts/fg03-results.mjs';
// The reader wording, from the one table the runtime detail panel and the row
// disclosure both read. Two of these labels used to be copied here by hand with
// a comment asking future edits to keep them in step, which is not a mechanism.
import { readerLabel } from '../scripts/fg03-map-core.mjs';

export type SnapshotId = '1200' | '2030' | '2200' | '0030';
export type ActionId = 'open' | 'extend' | 'new' | 'verify' | 'retrofit';

export interface Phase1Headline {
  activeTransitPointCount: number;
  farePaidOpenAccessPointCount: number;
  farePaidOpenFacilityRecordCount: number;
  unit: 'grouped transit points';
  unrestrictedCoveredTransitPointCount: number;
  unrestrictedOpenAccessPointCount: number;
  unrestrictedOpenFacilityRecordCount: number;
}

export interface Phase2Headline {
  activeStopCount: number;
  unit: 'GTFS stops and platforms';
  unrestrictedCoveredStopCount: number;
}

export interface Manifest {
  defaultState: {
    access: 'public' | 'rider_conditional';
    action: ActionId;
    time: SnapshotId;
    walk: number;
  };
  files: {
    facilities: string;
    interventions: string;
  };
  gate: {
    auditedOpportunityCount: number;
    passed: boolean;
    reason: string;
  };
  headlines: {
    bySnapshot: Record<
      SnapshotId,
      {
        phase1Grouped: Phase1Headline;
        phase2GtfsStops: Phase2Headline;
      }
    >;
    facilities: number;
    interventions: number;
  };
  limitations: string[];
  snapshotDate: string;
}

export interface QueryCell {
  access: 'public' | 'rider_conditional';
  active: boolean;
  activeStops: number;
  events: number;
  time: SnapshotId;
  uniqueRoutes: number;
  uniqueTrips: number;
  walk: number;
}

export interface InterventionProperties {
  accessCondition: 'unrestricted' | 'fare_paid' | 'unknown';
  accessibility: 'accessible' | 'not_accessible' | 'unknown';
  action: Exclude<ActionId, 'open' | 'retrofit'>;
  actionClass: string;
  auditStatus: 'valid';
  closureCategory: string;
  facilityId: string;
  hours?: string;
  id: string;
  materialGain: boolean;
  name: string;
  primaryRank: number;
  queryCells: QueryCell[];
  reachAvailable: boolean;
  sourceUrl?: string;
  stability: 'robust' | 'sensitive' | 'unstable';
  verificationSubtype?: 'hours' | 'accessibility';
}

export interface FeatureCollection<Properties> {
  features: Array<{
    geometry: {
      coordinates: [number, number];
      type: 'Point';
    };
    properties: Properties;
    type: 'Feature';
  }>;
  type: 'FeatureCollection';
}

/**
 * Held only `id` and `name` while facilities were a client-side concern. The
 * server now renders the open-washroom list, so the fields that list prints
 * are declared here. Everything below is present on every facility feature in
 * the published snapshot.
 */
export interface FacilityProperties {
  accessCondition: 'unknown' | 'unrestricted' | 'fare_paid';
  closureCategory: string;
  hours: string | null;
  id: string;
  name: string;
  source: string;
  sourceUrl?: string;
}

export const publicDataRoot = new URL('./public/data/fg03/', `file://${process.cwd()}/`);
export const snapshotDirectory = readdirSync(publicDataRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .at(-1);

if (!snapshotDirectory) {
  throw new Error('FG03 cannot build without a dated public data snapshot.');
}

export const readJson = <Value,>(url: URL): Value =>
  JSON.parse(readFileSync(url, 'utf8')) as Value;
export const manifest = readJson<Manifest>(
  new URL(`./public/data/fg03/${snapshotDirectory}/manifest.json`, `file://${process.cwd()}/`),
);
export const publicFileUrl = (path: string) =>
  new URL(`./public/${path.replace(/^\/+/, '')}`, `file://${process.cwd()}/`);
export const facilities = readJson<FeatureCollection<FacilityProperties>>(
  publicFileUrl(manifest.files.facilities),
);
export const interventions = readJson<FeatureCollection<InterventionProperties>>(
  publicFileUrl(manifest.files.interventions),
);

if (facilities.type !== 'FeatureCollection' || interventions.type !== 'FeatureCollection') {
  throw new Error('FG03 public datasets must be GeoJSON FeatureCollections.');
}

export const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
export const number = new Intl.NumberFormat('en-CA');
export const snapshotDate = new Intl.DateTimeFormat('en-CA', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  year: 'numeric',
}).format(new Date(`${manifest.snapshotDate}T12:00:00Z`));
export const snapshotLabels: Record<SnapshotId, string> = {
  '1200': 'Noon',
  '2030': '8:30 p.m.',
  '2200': '10 p.m.',
  '0030': '12:30 a.m.',
};
export const snapshotOrder: SnapshotId[] = ['1200', '2030', '2200', '0030'];
export const snapshots = snapshotOrder.map((id) => ({
  id,
  label: snapshotLabels[id],
  phase1: manifest.headlines.bySnapshot[id].phase1Grouped,
  phase2: manifest.headlines.bySnapshot[id].phase2GtfsStops,
}));

export const defaultTime = manifest.defaultState.time;
export const defaultWalk = manifest.defaultState.walk;
export const defaultAction = manifest.defaultState.action;
export const defaultAccess = manifest.defaultState.access;
export const gatePassed = manifest.gate.passed === true;
export const defaultUrlAccess = defaultAccess === 'rider_conditional' ? 'rider' : 'public';
export const defaultSnapshotLabel = snapshotLabels[defaultTime];
export const defaultPhase1 = manifest.headlines.bySnapshot[defaultTime].phase1Grouped;
export const actionLabels: Record<ActionId, string> = {
  open: 'Current open facility records',
  extend: 'Extend hours',
  new: 'New facility zone',
  verify: 'Verify published information',
  retrofit: 'Accessibility retrofit',
};
export const actionStatusLabels: Record<ActionId, string> = {
  open: 'current open facility records',
  extend: 'audited extend-hours opportunities',
  new: 'audited new-facility zones',
  verify: 'audited information checks',
  retrofit: 'audited accessibility retrofits',
};
export const sourceLabels: Record<string, string> = {
  automated: 'Automated Public Washrooms',
  crem: 'CREM Portfolio Washrooms',
  library: 'Library Branch General Information',
  museum: 'Museums and Cultural Centres',
  parks: 'Park Washroom Facilities',
  ttc: 'TTC station washrooms',
};
export const safePublishedHref = (value?: string): string | null => {
  if (!value) return null;
  if (
    /^\/data\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]+$/.test(value) &&
    !value.includes('..') &&
    !value.includes('\\') &&
    !value.startsWith('//')
  ) {
    return value;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};
export const sourceLabelFor = (properties: InterventionProperties): string => {
  const [source] = properties.facilityId.split(':', 1);
  return sourceLabels[source] ?? 'Official facility source';
};
/** Facilities carry the dataset directly; interventions encode it in facilityId. */
export const facilitySourceLabelFor = (properties: FacilityProperties): string =>
  sourceLabels[properties.source] ?? 'Official facility source';
export const accessLabelFor = (access: InterventionProperties['accessCondition']): string =>
  readerLabel('access', access, 'Access condition not published');
export const closureLabelFor = (category: string): string =>
  readerLabel('closure', category, 'Not classified');
// Meta description only: this string never renders on the page, it fills
// <meta name="description"> on the guide and its map route. Search results cut
// a description around 155 characters, so both branches stay inside that while
// keeping the live figures, which are the whole reason to click.
export const guideDescription = gatePassed
  ? `At ${defaultSnapshotLabel}, ${number.format(
      defaultPhase1.activeTransitPointCount,
    )} Toronto transit points still have scheduled service. Only ${number.format(
      defaultPhase1.unrestrictedOpenAccessPointCount,
    )} public washrooms are documented open. This guide maps the gap.`
  : `At ${defaultSnapshotLabel}, ${number.format(
      defaultPhase1.activeTransitPointCount,
    )} Toronto transit points still have scheduled service. Only ${number.format(
      defaultPhase1.unrestrictedOpenAccessPointCount,
    )} public washrooms are documented open. Rankings are withheld.`;

export const defaultResults = gatePassed
  ? interventions.features
      .filter(
        ({ properties }) =>
          properties.action === defaultAction &&
          properties.auditStatus === 'valid' &&
          properties.materialGain,
      )
      .map((feature) => ({
        feature,
        cell: feature.properties.queryCells.find(
          (candidate) =>
            candidate.time === defaultTime &&
            candidate.access === defaultAccess &&
            candidate.walk === defaultWalk,
        ),
      }))
      .filter(
        (
          result,
        ): result is {
          feature: (typeof interventions.features)[number];
          cell: QueryCell;
        } =>
          Boolean(
            result.cell?.active &&
              (result.cell.activeStops > 0 ||
                result.cell.events > 0 ||
                result.cell.uniqueTrips > 0),
          ),
      )
      .sort((a, b) => a.feature.properties.primaryRank - b.feature.properties.primaryRank)
  : [];

/**
 * The open washrooms for the default snapshot, server-rendered.
 *
 * The guide now opens on what the city has rather than on what it should do,
 * and `defaultResults` only ever held interventions, so without this a reader
 * with no JavaScript got an empty list under a heading promising places. These
 * rows carry no rank and no transit metrics because an open washroom is not a
 * ranked proposal: it is a fact with an address, published hours and a source.
 */
export const defaultOpenResults = filterOpenFacilities(facilities, {
  access: defaultUrlAccess,
  time: defaultTime,
}) as typeof facilities.features;

/** What the results list actually shows on first paint, either kind. */
export const defaultResultCount = defaultAction === 'open'
  ? defaultOpenResults.length
  : defaultResults.length;

/**
 * How many audited proposals of each kind this snapshot published.
 *
 * The action control offered "Retrofit accessibility" as an equal option and
 * it returned nothing at every hour, because this snapshot has no retrofits at
 * all: a control that cannot do anything, and no way to tell that apart from a
 * filter combination that happened to be empty. The counts are read off the
 * data so a later snapshot that does publish retrofits needs no code change.
 */
export const interventionCountsByAction: Record<string, number> =
  interventions.features.reduce<Record<string, number>>((tally, { properties }) => {
    tally[properties.action] = (tally[properties.action] ?? 0) + 1;
    return tally;
  }, {});

export const riderConditionalCount =
  manifest.headlines.bySnapshot[defaultTime].phase1Grouped.farePaidOpenFacilityRecordCount;
export const config = JSON.stringify({
  defaultState: {
    ...manifest.defaultState,
    access: manifest.defaultState.access === 'rider_conditional' ? 'rider' : 'public',
  },
  files: manifest.files,
  gate: manifest.gate,
  manifestUrl: `/data/fg03/${snapshotDirectory}/manifest.json`,
  snapshotDate: manifest.snapshotDate,
}).replaceAll('<', '\\u003c');
