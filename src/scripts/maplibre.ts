// The one place the atlas imports MapLibre.
//
// MapLibre 6 is ESM-only and finds its web worker through import.meta.url,
// which a bundler rewrites, so under Vite every map failed with "Worker failed
// to load" until the worker was handed over explicitly. `?worker&url` makes
// Vite emit the worker as its own same-origin file (CSP `worker-src 'self'`
// covers it) and gives back its URL. Every map imports MapLibre from here so
// none of them can be built without the worker set.
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);

export * from 'maplibre-gl';
