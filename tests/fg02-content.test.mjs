import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';


const routePath = new URL('../dist/guides/sidewalk-forest/index.html', import.meta.url);
const metaPath = new URL('../public/data/fg02/meta.json', import.meta.url);

const visibleText = (html) =>
  html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#39;', "'")
    .replaceAll('&rsquo;', "'")
    .replace(/\s+/g, ' ')
    .trim();

test('published maple statistics group cultivars with their parent species', () => {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

  assert.equal(meta.stats.norwayMaple, 99736);
  assert.equal(meta.stats.sugarMaple, 12896);
});

test('the rendered guide states the corrected comparison without a flag claim', () => {
  const copy = visibleText(readFileSync(routePath, 'utf8'));

  assert.match(copy, /99,736 Norway maple records/);
  assert.match(copy, /12,896 sugar maple records/);
  assert.match(copy, /7\.73 to one/);
  assert.doesNotMatch(copy, /tree on the flag|national tree|six to one/i);
});
