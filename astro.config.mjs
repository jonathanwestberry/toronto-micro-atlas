import { defineConfig } from 'astro/config';

import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'static',
  compressHTML: true,

  // Hosted at the root of a Cloudflare Pages project. The code strips any
  // trailing slash from BASE_URL, so this also works unchanged if it later
  // moves to a subpath (e.g. a preview subfolder).
  site: 'https://torontomicroatlas.com',

  base: '/',
  integrations: [
    sitemap({
      // The expanded /map routes are the same guide in a bigger frame, and they
      // now canonicalise to their parent. Submitting them as well asks Google to
      // index pages we have already told it not to treat as separate documents,
      // which is how all three ended up crawled-but-not-indexed.
      filter: (page) => !/\/map\/?$/.test(new URL(page).pathname),
    }),
  ],
});
