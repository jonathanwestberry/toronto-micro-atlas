/**
 * build-contextual-maps.mjs
 *
 * Generates one static SVG contextual map per location for the Toronto field-guide site.
 * Run: node build-contextual-maps.mjs
 *
 * REPO INTEGRATION: see comment at bottom.
 */

import { geoMercator } from 'd3-geo';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR = join(__dirname, '..', 'public', 'data');
const OUT_DIR = join(__dirname, '..', 'public', 'maps');

const W = 800;
const H = 600;
const HALF_M_DEFAULT = 700;

// ── Palette ───────────────────────────────────────────────────────────────────
const P = {
  bg:              '#FAF6EC',
  minorStreet:     '#D3CEC4',
  majorStreet:     '#B8B2A7',
  rail:            '#D3CEC4',
  landscape:       '#147D64',
  landscapeStroke: '#0C6B58',
  water:           '#3994C1',
  lakeFill:        'hsl(200,55%,88%)',
  lakeStroke:      'hsl(200,40%,72%)',
  marker:          '#DE3A11',
  markerRing:      '#27241D',
  markerInner:     '#FFFFFF',
  ui:              '#857F72',
};

// ── Locations ─────────────────────────────────────────────────────────────────
const LOCATIONS = [
  { slug: 'glen-road-bridge',    lat: 43.67256, lng: -79.37489 },
  { slug: 'nordheimer-ravine',   lat: 43.68364, lng: -79.41510 },
  { slug: 'old-mill-bridge',     lat: 43.65129, lng: -79.49179 },
  { slug: 'glen-stewart-ravine', lat: 43.67989, lng: -79.29301 },
  { slug: 'baldwin-steps',       lat: 43.67755, lng: -79.40821 },
  { slug: 'crothers-woods',      lat: 43.68941, lng: -79.36366 },
  { slug: 'blythwood-ravine',    lat: 43.71945, lng: -79.39456 },
  { slug: 'mast-trail',          lat: 43.80637, lng: -79.13594 },
];

// ── GeoJSON loading ───────────────────────────────────────────────────────────
function loadGeoJSON(name) {
  return JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8'));
}

// Pre-compute per-feature bboxes for all features in a collection.
// For large MultiPolygon/MultiLineString features, we build a list of
// sub-geometry bboxes so we can skip clipping for non-overlapping sub-parts.
function indexCollection(fc) {
  return fc.features.map(f => {
    const bbox = computeFullBbox(f.geometry);
    return { ...f, _bbox: bbox };
  });
}

function computeFullBbox(geom) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  function visit(coords) {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number') {
      const [lng, lat] = coords;
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const c of coords) visit(c);
  }
  // For efficiency on massive MultiPolygons, sample every Nth coord
  const SAMPLE = 10;
  function visitSampled(coords, depth = 0) {
    if (!Array.isArray(coords) || coords.length === 0) return;
    if (typeof coords[0] === 'number') {
      const [lng, lat] = coords;
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      return;
    }
    // If these are coordinate arrays (depth is at ring level), sample
    if (Array.isArray(coords[0]) && typeof coords[0][0] === 'number') {
      for (let i = 0; i < coords.length; i += SAMPLE) visitSampled(coords[i], depth + 1);
      // Always include last
      visitSampled(coords[coords.length - 1], depth + 1);
    } else {
      for (const c of coords) visitSampled(c, depth + 1);
    }
  }
  visitSampled(geom.coordinates);
  return { minLng, maxLng, minLat, maxLat };
}

function bboxOverlaps(a, b) {
  return a.maxLng >= b.minLng && a.minLng <= b.maxLng &&
         a.maxLat >= b.minLat && a.minLat <= b.maxLat;
}

// ── Sutherland-Hodgman polygon clip ──────────────────────────────────────────
function clipRingToBbox(ring, bb) {
  const { minLng, minLat, maxLng, maxLat } = bb;
  const inside = [
    p => p[0] >= minLng,
    p => p[0] <= maxLng,
    p => p[1] >= minLat,
    p => p[1] <= maxLat,
  ];
  const intersect = [
    (a, b) => { const t = (minLng - a[0]) / (b[0] - a[0]); return [minLng, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (maxLng - a[0]) / (b[0] - a[0]); return [maxLng, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (minLat - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), minLat]; },
    (a, b) => { const t = (maxLat - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), maxLat]; },
  ];

  let output = ring;
  for (let i = 0; i < 4; i++) {
    if (!output.length) return [];
    const input = output; output = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j - 1 + input.length) % input.length];
      const cIn = inside[i](cur), pIn = inside[i](prev);
      if (cIn) { if (!pIn) output.push(intersect[i](prev, cur)); output.push(cur); }
      else if (pIn) output.push(intersect[i](prev, cur));
    }
  }
  return output;
}

// Decimate a ring/line: skip points closer than tol degrees
function decimate(coords, tol = 0.00005) {
  if (coords.length <= 2) return coords;
  const out = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const prev = out[out.length - 1];
    const dx = coords[i][0] - prev[0], dy = coords[i][1] - prev[1];
    if (dx * dx + dy * dy >= tol * tol) out.push(coords[i]);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

// Clip a polyline to the viewport (with small buffer so strokes aren't clipped)
function clipLine(coords, bb) {
  const { minLng, minLat, maxLng, maxLat } = bb;
  const buf = 0.001; // ~100m buffer so strokes aren't cut at edge
  const bMinLng = minLng - buf, bMaxLng = maxLng + buf;
  const bMinLat = minLat - buf, bMaxLat = maxLat + buf;

  const segments = [];
  let current = null;
  let prevIn = false;

  const inBox = p => p[0] >= bMinLng && p[0] <= bMaxLng && p[1] >= bMinLat && p[1] <= bMaxLat;

  for (let i = 0; i < coords.length; i++) {
    const p = coords[i];
    const curIn = inBox(p);

    if (curIn) {
      if (!current) {
        current = [];
        if (i > 0) current.push(coords[i - 1]); // include previous for continuity
      }
      current.push(p);
    } else if (current) {
      current.push(p); // one point past the edge for continuity
      if (current.length >= 2) segments.push(current);
      current = null;
    }
    prevIn = curIn;
  }
  if (current && current.length >= 2) segments.push(current);
  return segments;
}

// ── Projection ────────────────────────────────────────────────────────────────
function makeProjection(lat, lng, halfM) {
  const latDeg = halfM / 111320;
  const lngDeg = halfM / (111320 * Math.cos((lat * Math.PI) / 180));
  const minLng = lng - lngDeg, maxLng = lng + lngDeg;

  const tmp = geoMercator().center([lng, lat]).scale(1).translate([0, 0]);
  const [xL] = tmp([minLng, lat]);
  const [xR] = tmp([maxLng, lat]);
  const scale = W / (xR - xL);

  const proj = geoMercator().center([lng, lat]).scale(scale).translate([W / 2, H / 2]);
  return { proj, latDeg, lngDeg };
}

function r2(n) { return Math.round(n * 100) / 100; }

// ── SVG path builders ─────────────────────────────────────────────────────────
function projRing(ring, proj) {
  if (!ring.length) return '';
  const [x0, y0] = proj(ring[0]);
  let d = `M${r2(x0)},${r2(y0)}`;
  for (let i = 1; i < ring.length; i++) {
    const [x, y] = proj(ring[i]);
    d += `L${r2(x)},${r2(y)}`;
  }
  return d + 'Z';
}

function projLine(coords, proj) {
  if (!coords.length) return '';
  const [x0, y0] = proj(coords[0]);
  let d = `M${r2(x0)},${r2(y0)}`;
  for (let i = 1; i < coords.length; i++) {
    const [x, y] = proj(coords[i]);
    d += `L${r2(x)},${r2(y)}`;
  }
  return d;
}

// ── Layer renderers ───────────────────────────────────────────────────────────

// For polygon layers (landscape, ESA, lake)
function renderPolygonLayer(indexedFeatures, proj, viewBb, attrs, filterFn = null) {
  const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  const paths = [];
  let featureCount = 0;

  const features = filterFn ? indexedFeatures.filter(filterFn) : indexedFeatures;

  for (const f of features) {
    if (!bboxOverlaps(f._bbox, viewBb)) continue;

    const geom = f.geometry;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] :
                  geom.type === 'MultiPolygon' ? geom.coordinates : [];

    for (const polyRings of polys) {
      const outerRing = polyRings[0];
      if (!outerRing) continue;

      // Quick bbox check for this sub-polygon
      let subMinLng = Infinity, subMaxLng = -Infinity, subMinLat = Infinity, subMaxLat = -Infinity;
      for (let i = 0; i < outerRing.length; i += 5) { // sample every 5th
        const [lng, lat] = outerRing[i];
        if (lng < subMinLng) subMinLng = lng; if (lng > subMaxLng) subMaxLng = lng;
        if (lat < subMinLat) subMinLat = lat; if (lat > subMaxLat) subMaxLat = lat;
      }
      if (!bboxOverlaps({ minLng: subMinLng, maxLng: subMaxLng, minLat: subMinLat, maxLat: subMaxLat }, viewBb)) continue;

      const clippedOuter = decimate(clipRingToBbox(outerRing, viewBb), 0.00003);
      if (clippedOuter.length < 3) continue;

      let d = projRing(clippedOuter, proj);

      // Clip holes too
      for (let ri = 1; ri < polyRings.length; ri++) {
        const hole = decimate(clipRingToBbox(polyRings[ri], viewBb), 0.00003);
        if (hole.length >= 3) d += projRing(hole, proj);
      }

      if (d) {
        paths.push(`  <path ${attrStr} d="${d}"/>`);
        featureCount++;
      }
    }
  }

  return { markup: paths.join('\n'), count: featureCount };
}

// For line layers (streets, rail, watercourses)
function renderLineLayer(indexedFeatures, proj, viewBb, attrs, filterFn = null) {
  const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  const paths = [];
  let featureCount = 0;

  const features = filterFn ? indexedFeatures.filter(filterFn) : indexedFeatures;

  for (const f of features) {
    if (!bboxOverlaps(f._bbox, viewBb)) continue;

    const geom = f.geometry;
    const lines = geom.type === 'LineString'      ? [geom.coordinates] :
                  geom.type === 'MultiLineString'  ? geom.coordinates   : [];

    for (const line of lines) {
      // Quick bbox for this sub-line
      let sMinLng = Infinity, sMaxLng = -Infinity, sMinLat = Infinity, sMaxLat = -Infinity;
      for (let i = 0; i < line.length; i += 5) {
        const [lng, lat] = line[i];
        if (lng < sMinLng) sMinLng = lng; if (lng > sMaxLng) sMaxLng = lng;
        if (lat < sMinLat) sMinLat = lat; if (lat > sMaxLat) sMaxLat = lat;
      }
      if (!bboxOverlaps({ minLng: sMinLng, maxLng: sMaxLng, minLat: sMinLat, maxLat: sMaxLat }, viewBb)) continue;

      const segs = clipLine(line, viewBb);
      for (const seg of segs) {
        const dec = decimate(seg, 0.000025); // ~2.5m skip
        if (dec.length < 2) continue;
        const d = projLine(dec, proj);
        if (d) {
          paths.push(`  <path ${attrStr} d="${d}"/>`);
          featureCount++;
        }
      }
    }
  }

  return { markup: paths.join('\n'), count: featureCount };
}

// ── Scale bar ─────────────────────────────────────────────────────────────────
function computeScaleBar(proj, lat) {
  const [x0] = proj([0, lat]);
  const [x1] = proj([1, lat]);
  const pxPerDeg = Math.abs(x1 - x0);
  const mPerDeg  = 111320 * Math.cos((lat * Math.PI) / 180);
  const pxPerM   = pxPerDeg / mPerDeg;

  const targetM = (W * 0.15) / pxPerM;
  const nice    = [100, 200, 250, 500];
  const barM    = nice.reduce((b, c) => Math.abs(c - targetM) < Math.abs(b - targetM) ? c : b);
  return { barM, barPx: barM * pxPerM };
}

// ── Build one SVG ─────────────────────────────────────────────────────────────
function buildSVG(loc, indexed, halfM = HALF_M_DEFAULT) {
  const { lat, lng } = loc;
  const { proj, latDeg, lngDeg } = makeProjection(lat, lng, halfM);

  const viewBb = {
    minLng: lng - lngDeg, maxLng: lng + lngDeg,
    minLat: lat - latDeg, maxLat: lat + latDeg,
  };

  const lake    = renderPolygonLayer(indexed.lake,         proj, viewBb, { fill: P.lakeFill,  stroke: P.lakeStroke,        'stroke-width': '1',   'stroke-linejoin': 'round' });
  const esa     = renderPolygonLayer(indexed.esa,          proj, viewBb, { fill: P.landscape, 'fill-opacity': '0.85', stroke: P.landscapeStroke, 'stroke-width': '1',   'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const ravine  = renderPolygonLayer(indexed.landscape,    proj, viewBb, { fill: P.landscape, 'fill-opacity': '0.95', stroke: P.landscapeStroke, 'stroke-width': '1.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const minor   = renderLineLayer(indexed.streetsMinor,    proj, viewBb, { fill: 'none', stroke: P.minorStreet, 'stroke-width': '2',   'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const major   = renderLineLayer(indexed.streetsMajor,    proj, viewBb, { fill: 'none', stroke: P.majorStreet, 'stroke-width': '3.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const rail    = renderLineLayer(indexed.rail,            proj, viewBb, { fill: 'none', stroke: P.rail,        'stroke-width': '1.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': '4,4' });
  // Watercourses: buried/culverted segments (OSM tunnel=* / location=underground)
  // render dashed and slightly thinner; surface segments unchanged.
  const streamsBuried = renderLineLayer(indexed.watercourses, proj, viewBb, { fill: 'none', stroke: P.water,  'stroke-width': '1',   'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': '5,4' }, f => f.properties?.tier !== 'river' && f.properties?.buried === true);
  const riversBuried  = renderLineLayer(indexed.watercourses, proj, viewBb, { fill: 'none', stroke: P.water,  'stroke-width': '1.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': '5,4' }, f => f.properties?.tier === 'river' && f.properties?.buried === true);
  const streams = renderLineLayer(indexed.watercourses,    proj, viewBb, { fill: 'none', stroke: P.water,       'stroke-width': '1.25','stroke-linejoin': 'round', 'stroke-linecap': 'round' }, f => f.properties?.tier !== 'river' && f.properties?.buried !== true);
  const rivers  = renderLineLayer(indexed.watercourses,    proj, viewBb, { fill: 'none', stroke: P.water,       'stroke-width': '2',   'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, f => f.properties?.tier === 'river' && f.properties?.buried !== true);

  const hasLandscape = ravine.count > 0 || esa.count > 0;
  const hasWater     = streams.count > 0 || rivers.count > 0 || streamsBuried.count > 0 || riversBuried.count > 0 || lake.count > 0;
  const counts = {
    landscape: ravine.count, esa: esa.count, lake: lake.count,
    water: streams.count + rivers.count + streamsBuried.count + riversBuried.count,
    buriedWater: streamsBuried.count + riversBuried.count,
    major: major.count, minor: minor.count, rail: rail.count,
  };

  const { barM, barPx } = computeScaleBar(proj, lat);
  const sbX = 20, sbY = H - 22, sbH = 6;
  const [cx, cy] = proj([lng, lat]);
  const naX = W - 32, naY = 28;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <filter id="mshad" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="1.5" dy="2" stdDeviation="2.5" flood-color="#00000033"/>
    </filter>
    <style>text { font-family: Archivo, sans-serif; }</style>
  </defs>

  <!-- background -->
  <rect width="${W}" height="${H}" fill="${P.bg}"/>

  <!-- lake ontario -->
${lake.markup || '  <!-- lake: none in view -->'}

  <!-- ESA (environmentally sensitive areas) -->
${esa.markup || '  <!-- esa: none in view -->'}

  <!-- ravine / landscape -->
${ravine.markup || '  <!-- landscape: none in view -->'}

  <!-- minor streets -->
${minor.markup || '  <!-- minor streets: none in view -->'}

  <!-- major streets -->
${major.markup || '  <!-- major streets: none in view -->'}

  <!-- rail -->
${rail.markup || '  <!-- rail: none in view -->'}

  <!-- buried streams (culverted / underground) -->
${streamsBuried.markup || '  <!-- buried streams: none in view -->'}

  <!-- buried rivers (culverted / underground) -->
${riversBuried.markup || '  <!-- buried rivers: none in view -->'}

  <!-- streams -->
${streams.markup || '  <!-- streams: none in view -->'}

  <!-- rivers -->
${rivers.markup || '  <!-- rivers: none in view -->'}

  <!-- threshold marker -->
  <circle cx="${r2(cx + 1.5)}" cy="${r2(cy + 2)}" r="16" fill="#00000026" filter="url(#mshad)"/>
  <circle cx="${r2(cx)}" cy="${r2(cy)}" r="16" fill="${P.marker}" stroke="${P.markerRing}" stroke-width="1.5"/>
  <circle cx="${r2(cx)}" cy="${r2(cy)}" r="5" fill="${P.markerInner}"/>

  <!-- scale bar: ${barM}m -->
  <g fill="none" stroke="${P.ui}" stroke-width="1.25" stroke-linecap="round">
    <line x1="${sbX}" y1="${sbY}" x2="${r2(sbX + barPx)}" y2="${sbY}"/>
    <line x1="${sbX}" y1="${sbY - sbH}" x2="${sbX}" y2="${sbY}"/>
    <line x1="${r2(sbX + barPx)}" y1="${sbY - sbH}" x2="${r2(sbX + barPx)}" y2="${sbY}"/>
  </g>
  <text x="${r2(sbX + barPx / 2)}" y="${sbY - 9}" fill="${P.ui}" font-size="10" text-anchor="middle">${barM}m</text>

  <!-- north indicator (halo keeps it visible over street linework) -->
  <circle cx="${naX}" cy="${naY + 8}" r="22" fill="${P.bg}" fill-opacity="0.9" stroke="${P.ui}" stroke-opacity="0.3" stroke-width="1"/>
  <g fill="${P.ui}" stroke="${P.ui}" stroke-width="2">
    <line x1="${naX}" y1="${naY + 14}" x2="${naX}" y2="${naY - 4}" stroke-linecap="round"/>
    <polygon points="${naX},${naY - 12} ${naX - 5.5},${naY - 1} ${naX + 5.5},${naY - 1}" stroke-width="1" stroke-linejoin="round"/>
  </g>
  <text x="${naX}" y="${naY + 27}" fill="${P.ui}" font-size="13" text-anchor="middle" font-weight="700">N</text>
</svg>`;

  return { svg, counts, barM, barPx, hasLandscape, hasWater };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log('Loading and indexing GeoJSON data...');
  const raw = {
    landscape:    loadGeoJSON('ravine-rnfp.geojson'),
    esa:          loadGeoJSON('esa.geojson'),
    lake:         loadGeoJSON('lake-ontario.geojson'),
    watercourses: loadGeoJSON('watercourses.geojson'),
    streetsMajor: loadGeoJSON('streets-major.geojson'),
    streetsMinor: loadGeoJSON('streets-minor.geojson'),
    rail:         loadGeoJSON('rail.geojson'),
  };

  // Pre-compute bboxes so per-location filtering is fast
  const indexed = Object.fromEntries(
    Object.entries(raw).map(([k, fc]) => [k, indexCollection(fc)])
  );
  console.log('Indexed. Generating maps...\n');

  const report = [];

  for (const loc of LOCATIONS) {
    let result = buildSVG(loc, indexed, HALF_M_DEFAULT);

    // Widen to 1000m if no landscape visible
    if (!result.hasLandscape) {
      console.log(`  ${loc.slug}: no landscape at 700m, retrying at 1000m...`);
      result = buildSVG(loc, indexed, 1000);
    }

    const { svg, counts, barM, hasLandscape, hasWater } = result;
    const outPath = join(OUT_DIR, `context-${loc.slug}.svg`);
    writeFileSync(outPath, svg, 'utf8');
    const sizeKB = Math.round(Buffer.byteLength(svg, 'utf8') / 1024);

    const note = [
      hasLandscape ? `landscape ok (ravine=${counts.landscape}, esa=${counts.esa})` : 'LANDSCAPE MISSING',
      hasWater     ? `water ok (wc=${counts.water}, buried=${counts.buriedWater}, lake=${counts.lake})` : 'no water in view',
      `streets maj=${counts.major} min=${counts.minor}`,
      `rail=${counts.rail}`,
      `scale=${barM}m`,
    ].join(' | ');

    report.push({ slug: loc.slug, sizeKB, note, counts, barM });
    console.log(`${loc.slug}: ${sizeKB}KB  ${note}`);
  }

  console.log(`\nDone. Files in: ${OUT_DIR}`);
}

main().catch(console.error);

/**
 * REPO INTEGRATION
 * ----------------
 * When moving this script into the toronto-micro-atlas repo:
 *
 * 1. Place script at: scripts/build-contextual-maps.mjs
 *
 * 2. Change the two path constants at the top of the file:
 *    DATA_DIR -> relative path to your processed GeoJSON data, e.g.:
 *      new URL('../data/processed', import.meta.url).pathname
 *    OUT_DIR  -> output directory, e.g.:
 *      new URL('../public/maps', import.meta.url).pathname
 *      (or wherever Astro serves static assets from)
 *
 * 3. In package.json, add:
 *    "scripts": { "maps": "node scripts/build-contextual-maps.mjs" }
 *    Run once: npm run maps
 *
 * 4. Install d3-geo in the repo (already a common dep if you use it elsewhere):
 *    npm install d3-geo
 *
 * 5. In Astro location pages, reference with:
 *    <img src={`/maps/context-${slug}.svg`} alt="..."/>
 *    Or inline via <Fragment set:html={...}> for hover/animation possibilities.
 */
