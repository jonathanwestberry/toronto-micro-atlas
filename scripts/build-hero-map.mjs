/**
 * build-hero-map.mjs
 *
 * Generates a single optimized static SVG hero map (Toronto boundary + green
 * network) for use in a website hero section.
 *
 * Run: node scripts/build-hero-map.mjs
 *   (or: npm run build-hero-map)
 */

import { geoMercator, geoPath } from 'd3-geo';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR = join(__dirname, '..', 'data', 'processed');
const OUT_DIR = join(__dirname, '..', 'public', 'hero');
const OUT_FILE = join(OUT_DIR, 'toronto-hero.svg');

const BOUNDARY_PATH = join(DATA_DIR, 'toronto-boundary.geojson');
const GREEN_PATH = join(DATA_DIR, 'green-spaces.geojson');

// ── Config ────────────────────────────────────────────────────────────────────
const WIDTH = 1600;
const MARGIN = 40;
const MIN_GREEN_AREA_PX = 6; // drop projected polygons smaller than this (sq px)
const COORD_DIGITS = 1;
// The source green-spaces data carries survey-grade vertex density (~50k
// projected points across 1852 features), which at 1-decimal precision alone
// produces a file several times over the 300KB hero-asset budget with no
// visible benefit at hero-image scale. A sub-pixel Douglas-Peucker tolerance
// removes redundant vertices without a perceptible shape change.
const SIMPLIFY_TOLERANCE_PX = 0.6;

// The hero used to draw the boundary with fill="none", so the land was the
// page cream and the city existed only as a hairline. Next to a headline
// sitting at roughly 15:1 on the same background, that read as a watermark
// rather than as the product, and scaling it up only enlarged the ghost: a
// land fill one step off the cream was rendered and rejected for the same
// reason. Give the land a body instead. Ink ground with the green network cut
// out of it gives the map the same weight as the headline, and it is the
// language the atlas already speaks on the Sidewalk Forest card.
const P = {
  ink: '#27241D',
  // Kelly lifted for legibility on the ink ground. The paper-side #45A26A goes
  // muddy against the ink and loses the ravine threads, which are the whole
  // reason the green layer is on the hero at all.
  green: '#5FBF83',
};

// ── Load data ─────────────────────────────────────────────────────────────────
function loadGeoJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// d3-geo's spherical clipping requires exterior rings wound CLOCKWISE and
// holes wound COUNTERCLOCKWISE in [lng, lat] space (the opposite of the
// RFC 7946 "right-hand rule" convention many GeoJSON exporters produce).
// Rings with the wrong winding get treated as "the rest of the world" by
// d3's antimeridian clipper, producing giant clip-rectangle artifacts.
// Rewind every ring here so the data is safe for d3-geo regardless of
// which convention the source export used.
function ringSignedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function rewindPolygonCoords(rings) {
  return rings.map((ring, i) => {
    const area = ringSignedArea(ring);
    const isExterior = i === 0;
    const needsCW = isExterior; // exterior: CW (negative area); holes: CCW (positive area)
    const isCW = area < 0;
    if (needsCW !== isCW) {
      return ring.slice().reverse();
    }
    return ring;
  });
}

function rewindGeometry(geom) {
  if (!geom) return geom;
  if (geom.type === 'Polygon') {
    return { ...geom, coordinates: rewindPolygonCoords(geom.coordinates) };
  }
  if (geom.type === 'MultiPolygon') {
    return {
      ...geom,
      coordinates: geom.coordinates.map((poly) => rewindPolygonCoords(poly)),
    };
  }
  return geom;
}

function rewindFeature(feature) {
  return { ...feature, geometry: rewindGeometry(feature.geometry) };
}

const boundaryFC = loadGeoJSON(BOUNDARY_PATH);
const boundaryFeature = rewindFeature(boundaryFC.features[0]);
const greenFCRaw = loadGeoJSON(GREEN_PATH);
const greenFC = {
  ...greenFCRaw,
  features: greenFCRaw.features.map(rewindFeature),
};

// ── Determine output height from the boundary's true aspect ratio ────────────
// Fit into a temporary square to get an undistorted projected width/height,
// then derive H so the final viewBox matches Toronto's actual aspect ratio.
const probeProjection = geoMercator().fitSize([1000, 1000], boundaryFeature);
const probePath = geoPath(probeProjection);
const [[px0, py0], [px1, py1]] = probePath.bounds(boundaryFeature);
const aspect = (px1 - px0) / (py1 - py0); // width / height

const HEIGHT = Math.round(WIDTH / aspect);

// ── Final projection, fitted with a small margin ─────────────────────────────
const projection = geoMercator().fitExtent(
  [
    [MARGIN, MARGIN],
    [WIDTH - MARGIN, HEIGHT - MARGIN],
  ],
  boundaryFeature
);

const path = geoPath(projection).digits(COORD_DIGITS);

// ── Boundary layer ────────────────────────────────────────────────────────────
const boundaryD = path(boundaryFeature);

// ── Green-space layer ────────────────────────────────────────────────────────
// Project each ring to pixel space by hand (rather than d3.geoPath) so we can
// run Douglas-Peucker simplification and a literal shoelace-on-the-projected-
// ring area check per the size/noise-filtering requirements.

function projectRing(ring) {
  const pts = [];
  for (const [lng, lat] of ring) {
    const p = projection([lng, lat]);
    if (p) pts.push(p);
  }
  return pts;
}

function perpendicularDistance(point, lineStart, lineEnd) {
  const [x, y] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(x - x1, y - y1);
  let t = ((x - x1) * dx + (y - y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function douglasPeucker(points, epsilon) {
  if (points.length < 3) return points.slice();
  let maxDist = 0;
  let index = 0;
  const start = points[0];
  const end = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], start, end);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, index + 1), epsilon);
    const right = douglasPeucker(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [start, end];
}

// Shoelace area on a projected (planar pixel-space) ring.
function shoelaceArea(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

function pathFromRing(pts) {
  let d = `M${pts[0][0].toFixed(COORD_DIGITS)},${pts[0][1].toFixed(COORD_DIGITS)}`;
  for (let i = 1; i < pts.length; i++) {
    d += `L${pts[i][0].toFixed(COORD_DIGITS)},${pts[i][1].toFixed(COORD_DIGITS)}`;
  }
  return `${d}Z`;
}

let kept = 0;
let dropped = 0;
const greenSegments = [];

for (const feature of greenFC.features) {
  const geom = feature.geometry;
  const polys =
    geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];

  let featureArea = 0;
  const simplifiedPolyRings = [];

  for (const poly of polys) {
    const rings = [];
    for (const ring of poly) {
      let pts = projectRing(ring);
      pts = douglasPeucker(pts, SIMPLIFY_TOLERANCE_PX);
      if (pts.length < 4) continue; // degenerate after simplification
      featureArea += shoelaceArea(pts);
      rings.push(pts);
    }
    if (rings.length) simplifiedPolyRings.push(rings);
  }

  if (simplifiedPolyRings.length === 0 || featureArea < MIN_GREEN_AREA_PX) {
    dropped++;
    continue;
  }

  kept++;
  for (const rings of simplifiedPolyRings) {
    for (const pts of rings) {
      greenSegments.push(pathFromRing(pts));
    }
  }
}

const greenD = greenSegments.join('');

// ── Assemble SVG ──────────────────────────────────────────────────────────────
// The generated-file comment lives just inside the root element (rather than
// before it) so the file's byte content still literally starts with "<svg".
// Land first, green over it. The boundary carries the fill and the stroke on a
// single path rather than a filled copy beneath an outlined one, so the ground
// costs no extra bytes: the path data is the largest thing in the file and
// duplicating it would push a 215KB asset toward the 300KB budget for nothing.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<!-- Generated by scripts/build-hero-map.mjs; do not hand-edit. -->
<path id="toronto-outline" d="${boundaryD}" fill="${P.ink}" stroke="${P.ink}" stroke-width="3" stroke-linejoin="round"/>
<g id="green" fill="${P.green}"><path d="${greenD}"/></g>
</svg>`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, svg, 'utf8');

const sizeKB = statSync(OUT_FILE).size / 1024;

console.log(`viewBox: 0 0 ${WIDTH} ${HEIGHT}`);
console.log(`green polygons kept: ${kept}, dropped: ${dropped}`);
console.log(`output file: ${OUT_FILE}`);
console.log(`output size: ${sizeKB.toFixed(1)} KB`);
