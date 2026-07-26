# Toronto Micro-Atlas

Toronto Micro-Atlas is an independent web publication of interactive guides about noticing and using Toronto. Each guide starts with a specific claim about how the city works, supports it with geographic evidence, and makes the evidence available through maps, writing, and downloads.

Published guides:

- **Hidden Landscapes** records eight places where Toronto's street surface opens into ravines, valleys, escarpments, and watercourses.
- **Sidewalk Forest** renders Toronto's municipal street-tree inventory as a citywide field guide.
- **When Toronto Has to Go** audits documented public washroom access against scheduled late-night transit and publishes a dated intervention explorer.

The site uses Astro, TypeScript, and MapLibre GL JS. It is statically built and deployed to Cloudflare Pages at [torontomicroatlas.com](https://torontomicroatlas.com).

## Local development

Requirements:

- Node.js 22.12.0 or newer
- npm
- Python 3.14 for the FG03 proof pipeline

```bash
npm ci
npm run dev
```

Run the web release checks:

```bash
npm run test:web
npm run check
npm run build
npm run test:web:contract
npm audit --omit=dev
```

Set up and test the FG03 data pipeline:

```bash
python3 -m venv data/scripts/.venv
data/scripts/.venv/bin/pip install -r data/scripts/requirements-fg03.txt
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover \
  -s data/scripts/tests -p 'test_fg03*.py' -v
```

The committed site build consumes dated, browser-safe files in `public/data/fg03/`. Rebuilding the proof from frozen raw inputs is a separate maintainer operation. See [data/README.md](data/README.md) for data provenance and [docs/fg03-maintenance.md](docs/fg03-maintenance.md) for the complete refresh, audit, release, and production-verification sequence.

## Deployment

Pushes to `main` run the GitHub Actions release gate, then deploy `dist/` to Cloudflare Pages. The workflow requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Data tests, web logic tests, Astro checks, the production build, built-site contracts, and the production dependency audit all run before deployment.

Preview deployments on `pages.dev` are marked `noindex`. The custom production domain remains indexable.

## License

Code is MIT licensed. Written content and illustrations are all rights reserved, copyright 2026 Jonathan Westberry.
