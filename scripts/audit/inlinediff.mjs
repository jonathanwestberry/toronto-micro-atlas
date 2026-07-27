import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const [A,B] = process.argv.slice(2);
const walk=(d,o=[])=>{for(const e of readdirSync(d)){const p=join(d,e);statSync(p).isDirectory()?walk(p,o):o.push(p)}return o};
const dehash=s=>s.replace(/\.[A-Za-z0-9_-]{8}\.(css|js|webp|svg|woff2?|jpg|png)/g,'.HASH.$1').replace(/_[A-Za-z0-9_-]{8}_?\.(css|js)/g,'_HASH.$1');
const styles=h=>[...h.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
const markup=h=>dehash(h.replace(/<style[^>]*>[\s\S]*?<\/style>/g,'<style/>')).replace(/>\s+</g,'><').replace(/\s+/g,' ').trim();
function rules(css){const out=[];let i=0,ctx=[],buf='';const src=dehash(css);
 while(i<src.length){const c=src[i];
  if(c==='{'){const head=buf.trim();buf='';
   if(head.startsWith('@')&&!/^@(font-face|page|property|counter-style|viewport)/.test(head)){ctx.push(head.replace(/\s+/g,' '))}
   else{let d=1,j=i+1,body='';while(j<src.length&&d>0){if(src[j]==='{')d++;else if(src[j]==='}'){d--;if(!d)break}body+=src[j];j++}
    out.push(`${ctx.join(' >> ')}${ctx.length?' >> ':''}${head.replace(/\s+/g,' ')} { ${body.split(';').map(x=>x.trim()).filter(Boolean).sort().join('; ')} }`);i=j}}
  else if(c==='}'){if(ctx.length)ctx.pop();buf=''}else buf+=c;i++}
 return out}
const get=r=>new Map(walk(r).filter(p=>p.endsWith('.html')).map(f=>[dehash(relative(r,f)),readFileSync(f,'utf8')]));
const a=get(A),b=get(B);
let mSame=0; const mDiff=[];
const sa=new Set(),sb=new Set();
for(const[k,v]of a){ if(!b.has(k))continue;
  markup(v)===markup(b.get(k))?mSame++:mDiff.push(k);
  rules(styles(v)).forEach(r=>sa.add(r)); rules(styles(b.get(k))).forEach(r=>sb.add(r)); }
console.log(`MARKUP (styles stripped): identical ${mSame}/${a.size}`);
if(mDiff.length){console.log('  CHANGED MARKUP:',mDiff.join(', '));
  for(const k of mDiff){const x=markup(a.get(k)),y=markup(b.get(k));let s=0;while(s<x.length&&x[s]===y[s])s++;
   console.log(`   ${k}\n    - ${JSON.stringify(x.slice(Math.max(0,s-60),s+120))}\n    + ${JSON.stringify(y.slice(Math.max(0,s-60),s+120))}`)}}
const dropped=[...sa].filter(r=>!sb.has(r)),added=[...sb].filter(r=>!sa.has(r));
console.log(`\nINLINE <style> RULES: ${sa.size} before, ${sb.size} after; dropped ${dropped.length}, added ${added.length}`);
const sel=r=>r.split('{')[0].trim();
const ds=new Set(dropped.map(sel)),as=new Set(added.map(sel));
console.log('vanished selectors:', [...ds].filter(s=>!as.has(s)).join(' | ')||'(none)');
console.log('brand-new selectors:', [...as].filter(s=>!ds.has(s)).join(' | ')||'(none)');
console.log('\nchanged declarations:');
for(const r of dropped){ if(!as.has(sel(r)))continue; const m=added.find(x=>sel(x)===sel(r));
  const only=(s)=>s.split('{').slice(1).join('{').replace(/}$/,'').trim();
  const A1=only(r).split('; '),B1=only(m).split('; ');
  const d1=A1.filter(x=>!B1.includes(x)),d2=B1.filter(x=>!A1.includes(x));
  console.log(`  ~ ${sel(r)}\n      - ${d1.join('; ')}\n      + ${d2.join('; ')}`)}
