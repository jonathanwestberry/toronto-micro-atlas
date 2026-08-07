import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = resolve(ROOT, 'dist');
const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);
const tileRequests = { raw: 0, corrected: 0, classification: 0 };

function browserPath() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
  ].filter(Boolean);
  const browser = candidates.find((candidate) => (
    candidate.includes('/') ? existsSync(candidate) : true
  ));
  if (!browser) throw new Error('Chrome or Chromium is required for this proof');
  return browser;
}

function remoteTile(pathname) {
  const shade = pathname.match(
    /^\/data\/fg04\/tiles\/(raw|corrected)\/(\d+)\/(\d+)\/(\d+\.webp)$/,
  );
  if (shade) {
    return {
      kind: shade[1],
      url: `https://tiles.torontomicroatlas.com/fg04/v3/`
        + `${shade[1]}/${shade[2]}/${shade[3]}/${shade[4]}`,
    };
  }
  const classification = pathname.match(
    /^\/data\/fg04\/class-tiles\/(\d+)\/(\d+)\/(\d+\.webp)$/,
  );
  if (classification) {
    return {
      kind: 'classification',
      url: `https://tiles.torontomicroatlas.com/fg04/class/v2/`
        + `${classification[1]}/${classification[2]}/${classification[3]}`,
    };
  }
  return null;
}

async function serve(request, response) {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const upstream = remoteTile(pathname);
  if (upstream) {
    try {
      tileRequests[upstream.kind] += 1;
      const tile = await fetch(upstream.url, {
        headers: { 'user-agent': 'Mozilla/5.0 Chrome/151 FG04 explorer proof' },
      });
      response.writeHead(tile.status, {
        'content-type': tile.headers.get('content-type') ?? 'image/webp',
        'cache-control': 'no-store',
      });
      response.end(Buffer.from(await tile.arrayBuffer()));
    } catch (error) {
      response.writeHead(502).end(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  const route = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const relative = normalize(route).replace(/^\/+/, '');
  const file = resolve(DIST, relative);
  if (!file.startsWith(`${DIST}/`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'content-type': MIME.get(extname(file)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(readFileSync(file));
  } catch {
    response.writeHead(404).end('Not found');
  }
}

const delay = (milliseconds) => new Promise((resolveDelay) => {
  setTimeout(resolveDelay, milliseconds);
});

async function waitForDebugPort(profile) {
  const activePort = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(activePort)) {
      const [port] = readFileSync(activePort, 'utf8').trim().split('\n');
      return Number(port);
    }
    await delay(50);
  }
  throw new Error('Chrome did not open its debugging port');
}

function cdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolveCall, rejectCall } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectCall(new Error(message.error.message));
    else resolveCall(message.result);
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
      const result = new Promise((resolveCall, rejectCall) => {
        pending.set(id, { resolveCall, rejectCall });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

const proofExpression = `(() => {
  const explorer = window.__fg04Explorer;
  if (!explorer || explorer.maps.length !== 2) return { ready: false };
  if (!explorer.maps.every(({ map }) => map.isStyleLoaded())) return { ready: false };
  const pointProfile = explorer.getPointResult();
  if (!pointProfile) return { ready: false };

  const evaluate = (expression, elevation, scope = new Map()) => {
    if (!Array.isArray(expression)) return expression;
    const [operator, ...args] = expression;
    if (operator === 'elevation') return elevation;
    if (operator === '+') return evaluate(args[0], elevation, scope) + evaluate(args[1], elevation, scope);
    if (operator === '/') return evaluate(args[0], elevation, scope) / evaluate(args[1], elevation, scope);
    if (operator === '%') return evaluate(args[0], elevation, scope) % evaluate(args[1], elevation, scope);
    if (operator === 'round') return Math.round(evaluate(args[0], elevation, scope));
    if (operator === 'floor') return Math.floor(evaluate(args[0], elevation, scope));
    if (operator === '==') return evaluate(args[0], elevation, scope) === evaluate(args[1], elevation, scope);
    if (operator === '>=') return evaluate(args[0], elevation, scope) >= evaluate(args[1], elevation, scope);
    if (operator === '<') return evaluate(args[0], elevation, scope) < evaluate(args[1], elevation, scope);
    if (operator === 'all') return args.every((value) => evaluate(value, elevation, scope));
    if (operator === 'var') return scope.get(args[0]);
    if (operator === 'case') {
      for (let index = 0; index < args.length - 1; index += 2) {
        if (evaluate(args[index], elevation, scope)) return evaluate(args[index + 1], elevation, scope);
      }
      return evaluate(args.at(-1), elevation, scope);
    }
    if (operator === 'let') {
      const local = new Map(scope);
      for (let index = 0; index < args.length - 1; index += 2) {
        local.set(args[index], evaluate(args[index + 1], elevation, local));
      }
      return evaluate(args.at(-1), elevation, local);
    }
    throw new Error('unsupported proof operator ' + operator);
  };

  const raw = explorer.maps.find(({ surface }) => surface === 'raw').map;
  const corrected = explorer.maps.find(({ surface }) => surface === 'corrected').map;
  const rawExpression = raw.getPaintProperty('shade-selected-hour', 'color-relief-color');
  const correctedExpression = corrected.getPaintProperty('shade-selected-hour', 'color-relief-color');
  const knownShaded = evaluate(rawExpression, 64982.3);
  const knownSunlit = evaluate(rawExpression, 58720.7);
  const input = document.querySelector('[data-fg04-hour]');
  const output = document.querySelector('[data-fg04-hour-output]');
  const initialOutput = output.value;
  const defaultUrlHasNoHour = !new URL(location.href).searchParams.has('hour');
  const initialHistoryLength = history.length;
  const pointCacheBeforeHour = explorer.getPointCacheSize();
  const expectedProfile = Array.from(
    { length: 15 }, (_, bit) => ((0x70ff >> bit) & 1) === 1,
  );
  const selectedPointBeforeHour = {
    measured: document.querySelector('[data-fg04-point-selected-measured]')?.textContent,
    corrected: document.querySelector('[data-fg04-point-selected-corrected]')?.textContent,
  };

  const centres = explorer.maps.map(({ map }) => {
    const center = map.getCenter();
    return [center.lng, center.lat, map.getZoom()];
  });
  const sameCamera = centres.every((camera) => (
    Math.abs(camera[0] - centres[0][0]) < 1e-8
    && Math.abs(camera[1] - centres[0][1]) < 1e-8
    && Math.abs(camera[2] - centres[0][2]) < 1e-8
  ));

  input.value = '16';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const raw16 = raw.getPaintProperty('shade-selected-hour', 'color-relief-color');
  const corrected16 = corrected.getPaintProperty('shade-selected-hour', 'color-relief-color');
  input.dispatchEvent(new Event('change', { bubbles: true }));

  const checks = {
    nativeRange: input.type === 'range' && input.min === '6' && input.max === '20' && input.step === '1',
    defaultOutput: initialOutput === '13:00 EDT',
    defaultUrlHasNoHour,
    known13Separation: knownShaded !== knownSunlit,
    known13Pixels: { shaded: knownShaded, sunlit: knownSunlit },
    same13Expression: JSON.stringify(rawExpression) === JSON.stringify(correctedExpression),
    same16Expression: JSON.stringify(raw16) === JSON.stringify(corrected16),
    expressionChanged: JSON.stringify(rawExpression) !== JSON.stringify(raw16),
    correctedCanopy: corrected.getLayer('shade-under-canopy') !== undefined && raw.getLayer('shade-under-canopy') === undefined,
    countHidden: explorer.maps.every(({ map }) => map.getLayoutProperty('shade-count', 'visibility') === 'none'),
    sameCamera,
    selectedOutput: output.value === '16:00 EDT',
    selectedUrl: new URL(location.href).searchParams.get('hour') === '16',
    historyPushed: history.length === initialHistoryLength + 1,
    stagesReady: Array.from(document.querySelectorAll('[data-map-stage]')).every((stage) => stage.dataset.mapState === 'ready'),
    pointIsGround: pointProfile.status === 'ground' && pointProfile.underCanopy === false,
    pointProfileMatchesPython: JSON.stringify(pointProfile.measured) === JSON.stringify(expectedProfile)
      && JSON.stringify(pointProfile.corrected) === JSON.stringify(expectedProfile),
    selectedPointAt13: selectedPointBeforeHour.measured === 'Shaded'
      && selectedPointBeforeHour.corrected === 'Shaded',
    pairedPointMarkers: document.querySelectorAll('.fg04-point-marker').length === 2,
    profileHasFifteenRows: document.querySelectorAll('[data-fg04-point-table] tr').length === 15,
    pointUrlRestored: new URL(location.href).searchParams.get('point') === '-79.38445,43.65395',
    pointTilesCachedAcrossHour: pointCacheBeforeHour === 3
      && explorer.getPointCacheSize() === pointCacheBeforeHour,
    profileSelectedHourChanged: document.querySelectorAll('[data-fg04-point-strip] [data-selected="true"]').length === 1
      && document.querySelector('[data-fg04-point-selected-time]')?.textContent === 'Selected hour, 16:00 EDT',
  };
  const passed = Object.entries(checks).every(([key, value]) => (
    key === 'known13Pixels' || value === true
  ));
  return { ready: true, passed, checks, centres, pointProfile };
})()`;

async function runBrowser(executable, url, profile) {
  const child = spawn(executable, [
    '--headless=new',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    url,
  ], { stdio: 'ignore' });

  try {
    const port = await waitForDebugPort(profile);
    let target;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then((response) => response.json());
      target = targets.find((candidate) => candidate.type === 'page');
      if (target) break;
      await delay(50);
    }
    if (!target) throw new Error('Chrome did not expose the explorer page');
    const cdp = cdpClient(target.webSocketDebuggerUrl);
    try {
      await cdp.call('Runtime.enable');
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const result = await cdp.call('Runtime.evaluate', {
          expression: proofExpression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description
            ?? result.exceptionDetails.text);
        }
        const value = result.result?.value;
        if (value?.ready) {
          if (!value.passed) {
            throw new Error(`selected-hour browser proof failed: ${JSON.stringify(value)}`);
          }
          return value;
        }
        await delay(100);
      }
      const diagnostic = await cdp.call('Runtime.evaluate', {
        expression: `({
          hook: Boolean(window.__fg04Explorer),
          maps: window.__fg04Explorer?.maps?.length ?? 0,
          styles: window.__fg04Explorer?.maps?.map(({ map }) => map.isStyleLoaded()) ?? [],
          errors: window.__fg04Explorer?.errors ?? [],
          stages: Array.from(document.querySelectorAll('[data-map-stage]')).map((stage) => stage.dataset.mapState),
        })`,
        returnByValue: true,
      });
      throw new Error(
        `selected-hour browser proof did not finish in 30 seconds: `
        + JSON.stringify(diagnostic.result?.value),
      );
    } finally {
      cdp.close();
    }
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveClose) => child.once('close', resolveClose)),
      delay(3000),
    ]);
  }
}

if (!existsSync(resolve(DIST, 'guides/throwing-shade/index.html'))) {
  throw new Error('run the production build before the selected-hour proof');
}

const server = createServer(serve);
const profile = mkdtempSync(join(tmpdir(), 'fg04-explorer-proof-'));
try {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no proof server port');
  const query = new URLSearchParams({
    tiles: 'local',
    map: '-79.38445,43.65395,16',
    point: '-79.38445,43.65395',
  });
  const url = `http://127.0.0.1:${address.port}`
    + `/guides/throwing-shade/?${query}`;
  const result = await runBrowser(browserPath(), url, profile);
  if (Object.values(tileRequests).some((count) => count === 0)) {
    throw new Error(`browser did not request every tile product: ${JSON.stringify(tileRequests)}`);
  }
  result.tileRequests = tileRequests;
  console.log(`FG04 selected-hour browser proof passed: ${JSON.stringify(result)}`);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
