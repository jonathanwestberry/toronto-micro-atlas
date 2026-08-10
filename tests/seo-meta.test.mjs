// Every built page must carry a meta description short enough to survive a
// search result. Eleven of fifteen pages once ran between 175 and 278
// characters, so the tail was written and then silently discarded by Google.
// The zod max() in content.config.ts guards the eight location pages; this
// guards everything else, including descriptions built from live data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;

// Google truncates a description snippet around 155-160 characters. 155 is the
// budget; the extra 5 are not worth spending on a sentence nobody reads.
const MAX_DESCRIPTION = 155;

const pages = globSync('**/*.html', { cwd: DIST })
  // 404 is never a search result, so its description is not load-bearing.
  .filter((file) => file !== '404.html');

test('the build produces pages to check', () => {
  assert.ok(pages.length >= 15, `expected the full site, found ${pages.length} pages`);
});

test('every page has a unique meta description inside the snippet budget', () => {
  const seen = new Map();
  const tooLong = [];
  const missing = [];

  for (const file of pages) {
    const html = readFileSync(join(DIST, file), 'utf8');
    const match = html.match(/<meta name="description" content="([^"]*)"/);
    const description = match?.[1]?.trim();

    if (!description) {
      missing.push(file);
      continue;
    }
    if (description.length > MAX_DESCRIPTION) {
      tooLong.push(`${file} (${description.length})`);
    }
    // Map routes canonicalise to their parent guide, so sharing the parent's
    // description is correct rather than duplication.
    if (/\/map\/index\.html$/.test(file)) continue;
    if (seen.has(description)) {
      seen.set(description, [...seen.get(description), file]);
    } else {
      seen.set(description, [file]);
    }
  }

  assert.deepEqual(missing, [], 'pages with no meta description');
  assert.deepEqual(tooLong, [], `descriptions over ${MAX_DESCRIPTION} characters`);

  const duplicates = [...seen.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([description, files]) => `${files.join(', ')} share: ${description.slice(0, 60)}...`);
  assert.deepEqual(duplicates, [], 'pages sharing a meta description');
});

test('every page has exactly one canonical link and one title', () => {
  for (const file of pages) {
    const html = readFileSync(join(DIST, file), 'utf8');
    assert.equal(
      (html.match(/<link rel="canonical"/g) ?? []).length, 1,
      `${file} must declare exactly one canonical`,
    );
    assert.equal(
      (html.match(/<title>/g) ?? []).length, 1,
      `${file} must declare exactly one title`,
    );
  }
});
