import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  // Hosted at the root of a Cloudflare Pages project. The code strips any
  // trailing slash from BASE_URL, so this also works unchanged if it later
  // moves to a subpath (e.g. a preview subfolder).
  site: 'https://toronto-micro-atlas.pages.dev',
  base: '/',
});
