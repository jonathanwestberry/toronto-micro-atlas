/**
 * Prove a change lossless where it is meant to be lossless.
 *
 * Two comparisons, because they catch different things:
 *   HTML  — normalised, with content hashes in asset filenames neutralised.
 *           Catches moved/dropped markup.
 *   CSS   — every emitted stylesheet flattened into a SET of `selector{decls}`
 *           rules and compared as sets. The HTML diff cannot see a dropped
 *           selector or a lost media query when CSS moves between files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const [A, B] = process.argv.slice(2);

const walk = (d, out = []) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};

const dehash = (s) => s
  .replace(/\.[A-Za-z0-9_-]{8}\.(css|js|webp|svg|woff2?|jpg|png)/g, '.HASH.$1')
  .replace(/_[A-Za-z0-9_-]{8}_?\.(css|js)/g, '_HASH.$1');

const normHTML = (s) => dehash(s).replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

/* Flatten a stylesheet into rules, keeping @media/@supports context on each. */
function rules(css) {
  const out = [];
  let i = 0, ctx = [];
  const src = dehash(css);
  let buf = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '{') {
      const head = buf.trim(); buf = '';
      if (head.startsWith('@') && !/^@(font-face|page|property|counter-style|viewport)/.test(head)) {
        ctx.push(head.replace(/\s+/g, ' '));
      } else {
        // read the declaration block
        let depth = 1, j = i + 1, body = '';
        while (j < src.length && depth > 0) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') { depth--; if (!depth) break; }
          body += src[j]; j++;
        }
        const decls = body.split(';').map((d) => d.trim()).filter(Boolean).sort().join('; ');
        out.push(`${ctx.join(' >> ')}${ctx.length ? ' >> ' : ''}${head.replace(/\s+/g, ' ')} { ${decls} }`);
        i = j;
      }
    } else if (c === '}') {
      if (ctx.length) ctx.pop();
      buf = '';
    } else buf += c;
    i++;
  }
  return out;
}

const collect = (root, ext) => {
  const map = new Map();
  for (const f of walk(root).filter((p) => p.endsWith(ext))) {
    map.set(dehash(relative(root, f)), readFileSync(f, 'utf8'));
  }
  return map;
};

/* ---- HTML ---- */
const ha = collect(A, '.html'), hb = collect(B, '.html');
console.log('=== HTML ===');
console.log(`pages: ${ha.size} before, ${hb.size} after`);
const onlyA = [...ha.keys()].filter((k) => !hb.has(k));
const onlyB = [...hb.keys()].filter((k) => !ha.has(k));
if (onlyA.length) console.log('  ONLY BEFORE:', onlyA.join(', '));
if (onlyB.length) console.log('  ONLY AFTER :', onlyB.join(', '));
let same = 0;
const changed = [];
for (const [k, v] of ha) {
  if (!hb.has(k)) continue;
  normHTML(v) === normHTML(hb.get(k)) ? same++ : changed.push(k);
}
console.log(`  identical (normalised, de-hashed): ${same}/${ha.size}`);
if (changed.length) {
  console.log(`  CHANGED: ${changed.length}`);
  for (const k of changed) {
    const a = normHTML(ha.get(k)), b = normHTML(hb.get(k));
    let s = 0; while (s < a.length && a[s] === b[s]) s++;
    let e = 0; while (e < a.length - s && e < b.length - s && a[a.length-1-e] === b[b.length-1-e]) e++;
    console.log(`    ${k}`);
    console.log(`      - ${JSON.stringify(a.slice(Math.max(0,s-40), a.length-e+40))}`);
    console.log(`      + ${JSON.stringify(b.slice(Math.max(0,s-40), b.length-e+40))}`);
  }
}

/* ---- CSS rule sets ---- */
const ca = collect(A, '.css'), cb = collect(B, '.css');
const setA = new Set(), setB = new Set();
for (const v of ca.values()) rules(v).forEach((r) => setA.add(r));
for (const v of cb.values()) rules(v).forEach((r) => setB.add(r));
console.log('\n=== CSS RULES (as a set, across all emitted stylesheets) ===');
console.log(`files: ${ca.size} before, ${cb.size} after`);
console.log(`rules: ${setA.size} before, ${setB.size} after`);
const dropped = [...setA].filter((r) => !setB.has(r));
const added = [...setB].filter((r) => !setA.has(r));
console.log(`dropped: ${dropped.length}   added: ${added.length}`);
const sel = (r) => r.split('{')[0].trim();
const droppedSels = new Set(dropped.map(sel)), addedSels = new Set(added.map(sel));
const gone = [...droppedSels].filter((s) => !addedSels.has(s));
const brandNew = [...addedSels].filter((s) => !droppedSels.has(s));
console.log(`\nselectors that VANISHED entirely (${gone.length}):`);
gone.forEach((s) => console.log('  - ' + s));
console.log(`\nselectors that are BRAND NEW (${brandNew.length}):`);
brandNew.forEach((s) => console.log('  + ' + s));
console.log(`\nsame selector, changed declarations (${dropped.length - gone.length}):`);
for (const r of dropped) {
  if (gone.includes(sel(r))) continue;
  const match = added.find((x) => sel(x) === sel(r));
  console.log('  ~ ' + sel(r));
  console.log('      - ' + r.split('{').slice(1).join('{').replace(/}$/, '').trim());
  if (match) console.log('      + ' + match.split('{').slice(1).join('{').replace(/}$/, '').trim());
}
