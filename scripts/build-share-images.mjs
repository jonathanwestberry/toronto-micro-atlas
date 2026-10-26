// Builds the share images that are pictures of the site itself.
//
// og-default.jpg (every page without its own card) and og-sidewalk-forest.jpg
// were hand-made screenshots, so when the atlas changed colour they could not
// be remade, and the Sidewalk Forest one still carried a retired "FIELD GUIDE
// 02" and a browser scrollbar. This takes them from the built site instead, so
// a card always shows the page as it ships.
//
// Usage: npm run build && node scripts/build-share-images.mjs
//
// It serves dist/ itself, drives the system Chrome over the DevTools protocol
// (the same way scripts/verify-fg04-selected-hour.mjs does, so nothing is
// added to package.json), and writes 1200 x 630 JPEGs to public/social/.
//
// The other two cards are built from data, not pages:
// scripts/build-fg03-social.py and data/scripts/36_fg04_social.py.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const SOCIAL = join(ROOT, 'public', 'social');
const WIDTH = 1200;
const HEIGHT = 630;

// Every card hides the same chrome: the site header (and the offset it
// reserves), and every control drawn over a map. What is left is the page's
// own picture.
const CHROME = `
  :root { --header-h: 0px !important; }
  .site-header, .skip-link, .map-stage__chrome, .maplibregl-control-container {
    display: none !important;
  }
`;

const SHOTS = [
  {
    // The atlas's front door when a page has no card of its own: the Hidden
    // Landscapes map, the guide that started the atlas, with nothing over it.
    file: 'og-default.jpg',
    route: '/guides/hidden-landscapes/map/',
    css: '.guide-panel { display: none !important; }',
    // Rendered 60 px wider and cropped to the centre: at exactly 1200 the
    // map's west edge, where the context data stops, showed as a blank
    // strip, and the lake label sat half off the bottom.
    viewportWidth: 1260,
  },
  {
    // The guide's opening screen: title card over every street tree.
    file: 'og-sidewalk-forest.jpg',
    route: '/guides/sidewalk-forest/',
    css: '.fg2-hero-cue { display: none !important; }',
  },
];

// Long enough for tiles, the tree renders and web fonts to land after the
// first canvas appears. The page signals nothing better to wait on.
const SETTLE_MS = 5000;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/geo+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.pbf': 'application/x-protobuf', '.xml': 'application/xml',
};

function serve(request, response) {
  let pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(DIST, pathname));
  if (!file.startsWith(DIST)) {
    response.writeHead(403).end();
    return;
  }
  let target = file;
  let body;
  try {
    if (existsSync(file) && statSync(file).isDirectory()) target = join(file, 'index.html');
    body = readFileSync(target);
  } catch {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' });
  response.end(body);
}

function browserPath() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
  ].filter(Boolean);
  const browser = candidates.find((candidate) => (candidate.includes('/') ? existsSync(candidate) : true));
  if (!browser) throw new Error('Chrome or Chromium is required to build the share images');
  return browser;
}

const delay = (ms) => new Promise((resolveDelay) => { setTimeout(resolveDelay, ms); });

async function debugPort(profile) {
  const file = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(file)) {
      // The file exists before Chrome has written the port into it.
      const port = Number(readFileSync(file, 'utf8').trim().split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await delay(50);
  }
  throw new Error('Chrome did not open its debugging port');
}

function cdpClient(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  const opened = new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  return {
    async call(method, params = {}) {
      await opened;
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

async function pageTarget(port) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      // The port file can be written before the port accepts connections.
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = targets.find((target) => target.type === 'page');
      if (page) return page;
    } catch {
      // not listening yet
    }
    await delay(50);
  }
  throw new Error('Chrome did not expose a page');
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.call('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function shoot(cdp, origin, shot) {
  const viewportWidth = shot.viewportWidth ?? WIDTH;
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: viewportWidth, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.call('Page.navigate', { url: origin + shot.route });
  const css = JSON.stringify(CHROME + shot.css);
  // Wait for the document and a map canvas, then inject the chrome rules.
  for (let attempt = 0; ; attempt += 1) {
    const ready = await evaluate(cdp, `document.readyState === 'complete'
      && !!document.querySelector('canvas.maplibregl-canvas')`).catch(() => false);
    if (ready) break;
    if (attempt > 300) throw new Error(`${shot.route}: no map canvas after 30 seconds`);
    await delay(100);
  }
  await evaluate(cdp, `(() => {
    const style = document.createElement('style');
    style.textContent = ${css};
    document.head.append(style);
    window.dispatchEvent(new Event('resize'));
    return document.fonts.ready.then(() => true);
  })()`);
  await delay(SETTLE_MS);
  const { data } = await cdp.call('Page.captureScreenshot', {
    format: 'jpeg', quality: 86, captureBeyondViewport: false,
    clip: { x: Math.round((viewportWidth - WIDTH) / 2), y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
  });
  const out = join(SOCIAL, shot.file);
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(`wrote public/social/${shot.file}`);
}

if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error('dist/ is missing: run `npm run build` first');
}

const server = createServer(serve);
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'atlas-share-'));
const chrome = spawn(browserPath(), [
  '--headless=new',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--window-size=${WIDTH},${HEIGHT}`,
  '--disable-background-networking',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });
// The finally below does not run if Node dies on an uncaught error or Ctrl-C,
// and a headless Chrome left behind keeps running and writing to its profile.
process.on('exit', () => chrome.kill());
process.once('SIGINT', () => process.exit(130));

try {
  const cdp = cdpClient((await pageTarget(await debugPort(profile))).webSocketDebuggerUrl);
  await cdp.call('Page.enable');
  await cdp.call('Runtime.enable');
  for (const shot of SHOTS) await shoot(cdp, origin, shot);
  cdp.close();
} finally {
  // Chrome keeps writing to its profile while it shuts down, so wait for it
  // to exit before removing the profile.
  const exited = new Promise((resolveExit) => chrome.once('exit', resolveExit));
  chrome.kill();
  await Promise.race([exited, delay(5000)]);
  server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
