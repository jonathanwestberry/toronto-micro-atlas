import { readFileSync } from 'node:fs';
const R = JSON.parse(readFileSync(process.argv[2] || './out-baseline/results.json', 'utf8'));

const key = (o) => JSON.stringify(o);
const group = (list, fn) => {
  const m = new Map();
  for (const r of list) for (const item of fn(r) || []) {
    const k = key(item);
    if (!m.has(k)) m.set(k, { item, at: [] });
    m.get(k).at.push(`${r.name}@${r.width}`);
  }
  return [...m.values()];
};

const compress = (at) => {
  const byRoute = new Map();
  for (const a of at) {
    const [n, w] = a.split('@');
    if (!byRoute.has(n)) byRoute.set(n, []);
    byRoute.get(n).push(w);
  }
  return [...byRoute].map(([n, ws]) => `${n}[${ws.length === 6 ? 'all' : ws.join(',')}]`).join(' ');
};

console.log('======================== TEXT CONTRAST < AA ========================');
for (const { item, at } of group(R, (r) => r.contrast).sort((a,b)=>a.item.ratio-b.item.ratio)) {
  console.log(`${String(item.ratio).padEnd(5)} (need ${item.need})  ${item.sel}`);
  console.log(`      "${item.text}"  ${item.color} on ${item.bg}  ${item.px}px/${item.weight}`);
  if (item.overImage) console.log(`      over image: ${item.overImage}`);
  console.log(`      ${compress(at)}`);
}

console.log('\n=================== NON-TEXT CONTRAST < 3:1 (1.4.11) ===================');
for (const { item, at } of group(R, (r) => r.nonText)) console.log(`${item.ratio}  ${item.sel}  border ${item.borderColor} on ${item.against}\n      ${compress(at)}`);

console.log('\n======================== AXE VIOLATIONS ========================');
for (const { item, at } of group(R, (r) => (r.axe?.violations || []).map(v => ({ id: v.id, impact: v.impact, help: v.help, count: v.count, nodes: v.nodes.map(n=>n.target) })))) {
  console.log(`[${item.impact}] ${item.id} — ${item.help} (${item.count} nodes)`);
  item.nodes.forEach(n => console.log(`      ${n}`));
  console.log(`      ${compress(at)}`);
}

console.log('\n======================== AXE INCOMPLETE (manual) ========================');
for (const { item, at } of group(R, (r) => (r.axe?.incomplete || []).map(v => ({ id: v.id, help: v.help, count: v.count, nodes: v.nodes.map(n=>n.target).slice(0,4) })))) {
  console.log(`${item.id} — ${item.help} (${item.count})  ${compress(at)}`);
  item.nodes.forEach(n => console.log(`      ${n}`));
}

console.log('\n======================== TARGET SIZE < 24px (2.5.8) ========================');
for (const { item, at } of group(R, (r) => r.smallTargets)) console.log(`${item.w}x${item.h}  ${item.sel}  "${item.text}"\n      ${compress(at)}`);

console.log('\n======================== STRAY TAB STOPS ========================');
for (const { item, at } of group(R, (r) => r.strayTabStops)) console.log(`${item.sel} role=${item.role} scrollable=${item.scrollable}  ${compress(at)}`);

console.log('\n======================== NEW-TAB LINKS ========================');
for (const { item, at } of group(R, (r) => r.newTab)) console.log(`cue=${item.hasCue}  ${item.sel} "${item.text}" aria=${item.aria}\n      ${compress(at)}`);

console.log('\n======================== HEADING OUTLINES (1280) ========================');
for (const r of R.filter(x => x.width === 1280)) {
  const levels = (r.headings||[]).map(h=>h.level);
  const h1s = levels.filter(l=>l===1).length;
  let skip = null;
  for (let i=1;i<levels.length;i++) if (levels[i] > levels[i-1]+1) skip = `h${levels[i-1]}->h${levels[i]}`;
  const flag = (h1s !== 1 ? ` !!h1count=${h1s}` : '') + (skip ? ` !!skip=${skip}` : '');
  console.log(`${r.name}: ${levels.join(' ')}${flag}`);
  if (flag) (r.headings||[]).forEach(h=>console.log(`      h${h.level} ${h.text}`));
}
console.log('\n-- home headings --');
(R.find(r=>r.name==='home'&&r.width===1280)?.headings||[]).forEach(h=>console.log(`h${h.level} ${h.text}`));

console.log('\n======================== HORIZONTAL OVERFLOW ========================');
for (const r of R) if (r.spills?.length || (r.docW > r.winW + 1)) console.log(`${r.name}@${r.width}: doc ${r.docW} > win ${r.winW}; ${(r.spills||[]).slice(0,5).map(s=>s.sel+'@'+s.right).join(', ')}`);

console.log('\n======================== CONSOLE ERRORS ========================');
for (const { item, at } of group(R, (r) => (r.consoleErrors||[]).map(e=>({e})))) console.log(`${item.e}\n      ${compress(at)}`);
