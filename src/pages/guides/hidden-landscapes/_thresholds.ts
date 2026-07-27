/**
 * The seven threshold glyphs and the words for them, in the order the guide
 * introduces them.
 *
 * The glyph shapes themselves live in three places already (the shared
 * ThresholdSymbol component, the runtime copy in src/scripts/guide-map.ts that
 * cannot import an .astro file, and the print plates). This list holds only
 * the pairing of symbol to label, which is what the map key needs, so the
 * legend and the "How to read this map" specimen list cannot drift apart from
 * each other the way they drifted away from the markers.
 *
 * Underscore-prefixed so Astro treats it as a module, not a route endpoint.
 */
export type ThresholdName =
  | 'stair-descent'
  | 'trail-entrance'
  | 'bridge'
  | 'underpass'
  | 'park-edge'
  | 'path-ending'
  | 'slope-overlook';

export interface ThresholdLegendEntry {
  name: ThresholdName;
  label: string;
}

export const thresholdLegend: ThresholdLegendEntry[] = [
  { name: 'stair-descent', label: 'Stair descent' },
  { name: 'trail-entrance', label: 'Trail entrance' },
  { name: 'bridge', label: 'Bridge' },
  { name: 'underpass', label: 'Underpass' },
  { name: 'park-edge', label: 'Park edge' },
  { name: 'path-ending', label: 'Path ending' },
  { name: 'slope-overlook', label: 'Slope overlook' },
];
