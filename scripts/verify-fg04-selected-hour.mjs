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
const CDP_TIMEOUT_MS = 30_000;
const BROWSER_START_ATTEMPTS = 600;
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
let failureScenario = null;
let scenarioPageLoads = 0;
let scenarioStreetRequests = 0;

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
  if (pathname === '/guides/throwing-shade/') scenarioPageLoads += 1;
  if (
    failureScenario === 'manifest-retry'
    && scenarioPageLoads === 1
    && pathname === '/data/fg04/manifest.json'
  ) {
    response.writeHead(503).end('Intentional manifest proof failure');
    return;
  }
  if (
    failureScenario === 'street-retry'
    && pathname === '/data/fg04/street-profiles.json'
  ) {
    scenarioStreetRequests += 1;
    if (scenarioStreetRequests === 1) {
      response.writeHead(503).end('Intentional street proof failure');
      return;
    }
  }
  const upstream = remoteTile(pathname);
  if (upstream) {
    const failMeasured = failureScenario === 'measured-retry'
      && scenarioPageLoads === 1 && upstream.kind === 'raw';
    const failClassification = failureScenario === 'classification-retry'
      && scenarioPageLoads === 1 && upstream.kind === 'classification';
    if (failMeasured || failClassification) {
      response.writeHead(503).end('Intentional tile proof failure');
      return;
    }
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
  for (let attempt = 0; attempt < BROWSER_START_ATTEMPTS; attempt += 1) {
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
      let timeoutId;
      const timeout = new Promise((_, rejectCall) => {
        timeoutId = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error(`${method} did not return in 30 seconds`));
        }, CDP_TIMEOUT_MS);
      });
      try {
        return await Promise.race([result, timeout]);
      } finally {
        clearTimeout(timeoutId);
      }
    },
    close() {
      socket.close();
    },
  };
}

const proofExpression = `(async () => {
  const explorer = window.__fg04Explorer;
  if (!explorer || explorer.maps.length !== 2) return { ready: false };
  if (!explorer.maps.every(({ map }) => map.isStyleLoaded())) return { ready: false };
  if (!Array.from(document.querySelectorAll('[data-map-stage]'))
    .every((stage) => stage.dataset.mapState === 'ready')) return { ready: false };
  const pointProfile = explorer.getPointResult();
  if (!pointProfile) return { ready: false };

  const raw = explorer.maps.find(({ surface }) => surface === 'raw').map;
  const corrected = explorer.maps.find(({ surface }) => surface === 'corrected').map;
  const tileUrl = (map) => map.getStyle().sources.shade.tiles[0];
  const raw13 = tileUrl(raw);
  const corrected13 = tileUrl(corrected);
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
  input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (Array.from(document.querySelectorAll('[data-map-stage]'))
      .every((stage) => stage.dataset.mapState === 'ready')) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const raw16 = tileUrl(raw);
  const corrected16 = tileUrl(corrected);

  const checks = {
    nativeRange: input.type === 'range' && input.min === '6' && input.max === '20' && input.step === '1',
    defaultOutput: initialOutput === '13:00 EDT',
    defaultUrlHasNoHour,
    rasterLayers: explorer.maps.every(({ map }) => (
      map.getLayer('shade-selected-hour')?.type === 'raster'
    )),
    measured13Source: raw13.startsWith('fg04shade://raw/') && raw13.endsWith('?hour=13'),
    corrected13Source: corrected13.startsWith('fg04shade://corrected/')
      && corrected13.endsWith('?hour=13'),
    shared13Hour: new URL(raw13).searchParams.get('hour')
      === new URL(corrected13).searchParams.get('hour'),
    shared16Hour: new URL(raw16).searchParams.get('hour')
      === new URL(corrected16).searchParams.get('hour'),
    sourceChanged: raw13 !== raw16 && corrected13 !== corrected16
      && raw16.endsWith('?hour=16') && corrected16.endsWith('?hour=16'),
    encodedLayersGone: explorer.maps.every(({ map }) => (
      map.getLayer('shade-count') === undefined
      && map.getLayer('shade-under-canopy') === undefined
    )),
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
    malformedStateCleaned: !new URL(location.href).searchParams.has('junk'),
    pointTilesCachedAcrossHour: pointCacheBeforeHour === 3
      && explorer.getPointCacheSize() === pointCacheBeforeHour,
    profileSelectedHourChanged: document.querySelectorAll('[data-fg04-point-strip] [data-selected="true"]').length === 1
      && document.querySelector('[data-fg04-point-selected-time]')?.textContent === 'Selected hour, 16:00 EDT',
  };
  const passed = Object.values(checks).every((value) => value === true);
  return {
    ready: true, passed, checks, centres, pointProfile,
    debug: {
      errors: explorer.errors,
      stages: Array.from(document.querySelectorAll('[data-map-stage]'))
        .map((stage) => stage.dataset.mapState),
    },
  };
})()`;

const streetProofExpression = `(async () => {
  const explorer = window.__fg04Explorer;
  if (!explorer || explorer.maps.length !== 2) return { ready: false };
  if (!explorer.maps.every(({ map }) => map.isStyleLoaded())) return { ready: false };
  const street = explorer.getStreetResult();
  if (!street) return { ready: false };
  const centres = explorer.maps.map(({ map }) => {
    const center = map.getCenter();
    return [center.lng, center.lat, map.getZoom()];
  });
  const cameraReady = centres.every((camera) => (
    Math.abs(camera[0] - street.center[0]) < 0.0001
    && Math.abs(camera[1] - street.center[1]) < 0.0001
    && camera[2] >= 15
  ));
  if (!cameraReady) return { ready: false };

  const input = document.querySelector('[data-fg04-street-search]');
  const hour = document.querySelector('[data-fg04-hour]');
  const measured13 = document.querySelector('[data-fg04-street-selected-measured]')?.textContent;
  const corrected13 = document.querySelector('[data-fg04-street-selected-corrected]')?.textContent;
  input.value = 'York Street';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const resultButton = Array.from(document.querySelectorAll('.fg04-street__result'))
    .find((button) => button.textContent === 'York Street');
  const ordinaryResultButton = resultButton?.tagName === 'BUTTON'
    && resultButton.type === 'button' && resultButton.tabIndex === 0;
  resultButton?.click();
  hour.value = '16';
  hour.dispatchEvent(new Event('input', { bubbles: true }));
  hour.dispatchEvent(new Event('change', { bubbles: true }));
  const historyLengthBeforeReplay = history.length;
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };
  history.back();
  const backUrlReached = await waitFor(() => (
    document.querySelector('[data-fg04-hour-output]')?.value === '13:00 EDT'
    && !new URL(location.href).searchParams.has('hour')
  ));
  await new Promise((resolve) => setTimeout(resolve, 750));
  const backReplayed = backUrlReached && await waitFor(() => (
    document.querySelector('[data-fg04-hour-output]')?.value === '13:00 EDT'
    && document.querySelectorAll('[data-fg04-street-table] tr').length === 15
    && window.__fg04Explorer?.getStreetResult()?.id === 'york-street'
  ));
  history.forward();
  const forwardUrlReached = await waitFor(() => (
    document.querySelector('[data-fg04-hour-output]')?.value === '16:00 EDT'
    && new URL(location.href).searchParams.get('hour') === '16'
  ));
  await new Promise((resolve) => setTimeout(resolve, 750));
  const forwardReplayed = forwardUrlReached && await waitFor(() => (
    document.querySelector('[data-fg04-hour-output]')?.value === '16:00 EDT'
    && document.querySelectorAll('[data-fg04-street-table] tr').length === 15
    && window.__fg04Explorer?.getStreetResult()?.id === 'york-street'
  ));

  let copiedUrl = null;
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => { copiedUrl = value; } },
    });
  } catch {}
  const share = document.querySelector('[data-fg04-share]');
  share.focus();
  share.click();
  const shareFinished = await waitFor(() => !share.hasAttribute('aria-busy'));

  const checks = {
    streetCount: explorer.getStreetCount() === 8507,
    directStreet: street.id === 'york-street' && street.name === 'York Street',
    directUrl: new URL(location.href).searchParams.get('street') === 'york-street',
    sameStreetCamera: cameraReady,
    inputRestored: input.value === 'York Street' && input.disabled === false,
    ordinaryResultButton,
    pairedKnown13: measured13 === '23.9% shaded' && corrected13 === '24.8% shaded',
    profileHasFifteenRows: document.querySelectorAll('[data-fg04-street-table] tr').length === 15,
    everyRowPaired: Array.from(document.querySelectorAll('[data-fg04-street-table] tr'))
      .every((row) => row.querySelectorAll('td').length === 2),
    selected16: document.querySelector('[data-fg04-street-selected-measured]')?.textContent === '64.6% shaded'
      && document.querySelector('[data-fg04-street-selected-corrected]')?.textContent === '64.9% shaded',
    oneSelectedHour: document.querySelectorAll('[data-fg04-street-strip] [data-selected="true"]').length === 1,
    pointCleared: explorer.getPointResult() === null
      && document.querySelectorAll('.fg04-point-marker').length === 0,
    backForwardReplay: backReplayed && forwardReplayed
      && history.length === historyLengthBeforeReplay,
    shareCopiesCanonicalUrl: shareFinished && copiedUrl === location.href
      && share.textContent.trim() === 'Copied'
      && document.activeElement === share
      && document.querySelector('[data-fg04-share-status]')?.textContent === 'View link copied.',
  };
  return {
    ready: true,
    passed: Object.values(checks).every((value) => value === true),
    checks,
    centres,
    street,
    debug: {
      url: location.href,
      historyLength: history.length,
      historyLengthBeforeReplay,
      hourOutput: document.querySelector('[data-fg04-hour-output]')?.value,
      streetStatus: document.querySelector('[data-fg04-street-status]')?.textContent,
      tableRows: document.querySelectorAll('[data-fg04-street-table] tr').length,
      profileHidden: document.querySelector('[data-fg04-street-profile]')?.hidden,
      shareText: share.textContent,
      shareStatus: document.querySelector('[data-fg04-share-status]')?.textContent,
      copiedUrl,
    },
  };
})()`;

const manifestRetryExpression = `(() => {
  const key = 'fg04-manifest-retry';
  if (!sessionStorage.getItem(key)) {
    const stages = Array.from(document.querySelectorAll('[data-map-stage]'));
    const status = document.querySelector('[data-fg04-street-status]');
    const retry = document.querySelector('[data-fg04-street-retry]');
    if (
      stages.length !== 2
      || !stages.every((stage) => stage.dataset.mapState === 'error')
      || status?.textContent?.trim() !== 'The explorer data could not load. Try again.'
      || !retry || retry.hidden
    ) return { ready: false };
    sessionStorage.setItem(key, 'saw-error');
    retry.click();
    return { ready: false };
  }
  const explorer = window.__fg04Explorer;
  if (!explorer || explorer.getStreetCount() !== 8507) return { ready: false };
  const mapsReady = Array.from(document.querySelectorAll('[data-map-stage]'))
    .every((stage) => stage.dataset.mapState === 'ready');
  if (!mapsReady) return { ready: false };
  const checks = {
    recoveredMaps: mapsReady,
    recoveredStreetIndex: document.querySelector('[data-fg04-street-search]')?.disabled === false,
  };
  return { ready: true, passed: Object.values(checks).every(Boolean), checks };
})()`;

function mapRetryExpression(failedSurface) {
  return `(() => {
    const key = 'fg04-${failedSurface}-retry';
    const explorer = window.__fg04Explorer;
    const failed = document.querySelector('[data-fg04-map="${failedSurface}"]')
      ?.closest('[data-map-stage]');
    const otherSurface = '${failedSurface}' === 'raw' ? 'corrected' : 'raw';
    const other = document.querySelector('[data-fg04-map="' + otherSurface + '"]')
      ?.closest('[data-map-stage]');
    if (!sessionStorage.getItem(key)) {
      if (!explorer || failed?.dataset.mapState !== 'error'
        || other?.dataset.mapState !== 'ready') return { ready: false };
      const retry = failed.querySelector('[data-map-retry]');
      if (!retry || retry.hidden) return { ready: false };
      sessionStorage.setItem(key, 'saw-error');
      retry.click();
      return { ready: false };
    }
    if (!explorer || explorer.getStreetCount() !== 8507
      || failed?.dataset.mapState !== 'ready'
      || other?.dataset.mapState !== 'ready') return { ready: false };
    const checks = {
      recoveredFailedSurface: failed?.dataset.mapState === 'ready',
      otherSurfaceStayedUseful: other?.dataset.mapState === 'ready',
      noDiagnosticErrorsAfterReload: explorer.errors.length === 0,
    };
    return { ready: true, passed: Object.values(checks).every(Boolean), checks };
  })()`;
}

const streetRetryExpression = `(() => {
  const key = 'fg04-street-retry';
  const explorer = window.__fg04Explorer;
  if (!explorer) return { ready: false };
  const status = document.querySelector('[data-fg04-street-status]');
  const retry = document.querySelector('[data-fg04-street-retry]');
  if (!sessionStorage.getItem(key)) {
    if (status?.textContent?.trim() !== 'The street index could not load. Try again.'
      || !retry || retry.hidden) return { ready: false };
    sessionStorage.setItem(key, 'saw-error');
    retry.click();
    return { ready: false };
  }
  if (explorer.getStreetCount() !== 8507) return { ready: false };
  const checks = {
    recoveredStreetIndex: document.querySelector('[data-fg04-street-search]')?.disabled === false,
    retryHidden: retry.hidden === true,
    readyMessage: status?.textContent?.trim() === 'Search 8,507 named streets.',
  };
  return { ready: true, passed: Object.values(checks).every(Boolean), checks };
})()`;

const missingStreetExpression = `(() => {
  const explorer = window.__fg04Explorer;
  if (!explorer || explorer.getStreetCount() !== 8507) return { ready: false };
  const status = document.querySelector('[data-fg04-street-status]');
  const profile = document.querySelector('[data-fg04-street-profile]');
  const checks = {
    explicitNoData: status?.textContent?.trim()
      === 'The linked street is not in this edition. Search another street.',
    noInventedProfile: profile?.hidden === true && explorer.getStreetResult() === null,
    searchStillAvailable: document.querySelector('[data-fg04-street-search]')?.disabled === false,
  };
  return { ready: true, passed: Object.values(checks).every(Boolean), checks };
})()`;

const keyboardProofExpression = `(() => {
  const proof = window.__fg04KeyboardProof;
  if (!proof?.finished) return { ready: false };
  const checks = {
    defaultHour: proof.defaultOutput === '13:00 EDT' && proof.defaultUrlHasNoHour,
    rangeHome: proof.homeOutput === '06:00 EDT' && proof.homeHour === '6',
    rangeEnd: proof.endOutput === '20:00 EDT' && proof.endHour === '20',
    rangeArrow: proof.arrowOutput === '19:00 EDT' && proof.arrowHour === '19',
    sharedHour: proof.sameMapRasterHour === true,
    mapEnter: proof.pointStatus === 'ground'
      && proof.pointMarkers === 2
      && proof.pointUrl !== null,
    noPointRefetchOnHour: proof.pointCacheBeforeHour === 3
      && proof.pointCacheAfterHour === 3,
    streetSearch: proof.searchValue === 'York Street'
      && proof.focusedResult === 'York Street',
    streetEnter: proof.streetId === 'york-street'
      && proof.streetRows === 15
      && proof.everyStreetRowPaired === true
      && proof.pointCleared === true,
    shareKeyboard: proof.shareText === 'Copied'
      && proof.shareFocused === true
      && proof.shareStatus === 'View link copied.'
      && proof.copiedUrl === proof.finalUrl,
  };
  return {
    ready: true,
    passed: Object.values(checks).every(Boolean),
    checks,
    proof,
  };
})()`;

const KEYBOARD_KEYS = {
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 },
  End: { code: 'End', key: 'End', windowsVirtualKeyCode: 35 },
  Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 },
  Home: { code: 'Home', key: 'Home', windowsVirtualKeyCode: 36 },
  Tab: { code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9 },
};

async function evaluateRuntime(cdp, expression, awaitPromise = false) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitForRuntime(cdp, expression, label) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await evaluateRuntime(cdp, expression, true)) return;
    await delay(100);
  }
  throw new Error(`${label} did not finish in 30 seconds`);
}

async function dispatchKey(cdp, name) {
  const key = KEYBOARD_KEYS[name];
  if (!key) throw new Error(`unknown keyboard proof key: ${name}`);
  if (name === 'Enter') {
    await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'char',
      ...key,
      text: '\r',
      unmodifiedText: '\r',
    });
  } else {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
  }
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

async function prepareKeyboardProof(cdp) {
  await waitForRuntime(
    cdp,
    `Boolean(window.__fg04Explorer
      && window.__fg04Explorer.maps.length === 2
      && window.__fg04Explorer.maps.every(({ map }) => map.isStyleLoaded())
      && window.__fg04Explorer.getStreetCount() === 8507)`,
    'keyboard explorer readiness',
  );
  await evaluateRuntime(cdp, `(() => {
    const input = document.querySelector('[data-fg04-hour]');
    const output = document.querySelector('[data-fg04-hour-output]');
    window.__fg04KeyboardProof = {
      defaultOutput: output?.value,
      defaultUrlHasNoHour: !new URL(location.href).searchParams.has('hour'),
    };
    input.focus();
    return document.activeElement === input;
  })()`);

  await dispatchKey(cdp, 'Home');
  await waitForRuntime(
    cdp,
    `document.querySelector('[data-fg04-hour-output]')?.value === '06:00 EDT'`,
    'range Home key',
  );
  await evaluateRuntime(cdp, `Object.assign(window.__fg04KeyboardProof, {
    homeOutput: document.querySelector('[data-fg04-hour-output]')?.value,
    homeHour: new URL(location.href).searchParams.get('hour'),
  })`);

  await dispatchKey(cdp, 'End');
  await waitForRuntime(
    cdp,
    `document.querySelector('[data-fg04-hour-output]')?.value === '20:00 EDT'`,
    'range End key',
  );
  await evaluateRuntime(cdp, `Object.assign(window.__fg04KeyboardProof, {
    endOutput: document.querySelector('[data-fg04-hour-output]')?.value,
    endHour: new URL(location.href).searchParams.get('hour'),
  })`);

  await dispatchKey(cdp, 'ArrowLeft');
  await waitForRuntime(
    cdp,
    `document.querySelector('[data-fg04-hour-output]')?.value === '19:00 EDT'`,
    'range ArrowLeft key',
  );
  await evaluateRuntime(cdp, `(() => {
    const hours = window.__fg04Explorer.maps.map(({ map }) => (
      new URL(map.getStyle().sources.shade.tiles[0]).searchParams.get('hour')
    ));
    Object.assign(window.__fg04KeyboardProof, {
      arrowOutput: document.querySelector('[data-fg04-hour-output]')?.value,
      arrowHour: new URL(location.href).searchParams.get('hour'),
      sameMapRasterHour: hours[0] === '19' && hours[1] === '19',
    });
    document.querySelector('[data-fg04-map="raw"] .maplibregl-canvas')?.focus();
  })()`);

  await dispatchKey(cdp, 'Enter');
  await waitForRuntime(
    cdp,
    `Boolean(window.__fg04Explorer.getPointResult()
      && document.querySelectorAll('.fg04-point-marker').length === 2)`,
    'map Enter key',
  );
  await evaluateRuntime(cdp, `Object.assign(window.__fg04KeyboardProof, {
    pointStatus: window.__fg04Explorer.getPointResult()?.status,
    pointMarkers: document.querySelectorAll('.fg04-point-marker').length,
    pointUrl: new URL(location.href).searchParams.get('point'),
    pointCacheBeforeHour: window.__fg04Explorer.getPointCacheSize(),
  })`);

  await evaluateRuntime(cdp, `document.querySelector('[data-fg04-hour]').focus()`);
  await dispatchKey(cdp, 'ArrowRight');
  await waitForRuntime(
    cdp,
    `document.querySelector('[data-fg04-hour-output]')?.value === '20:00 EDT'`,
    'cached point hour key',
  );
  await evaluateRuntime(cdp, `(() => {
    Object.assign(window.__fg04KeyboardProof, {
      pointCacheAfterHour: window.__fg04Explorer.getPointCacheSize(),
    });
    document.querySelector('[data-fg04-street-search]').focus();
  })()`);

  await cdp.call('Input.insertText', { text: 'York Street' });
  await waitForRuntime(
    cdp,
    `document.querySelector('.fg04-street__result')?.textContent === 'York Street'`,
    'keyboard street search',
  );
  await dispatchKey(cdp, 'Tab');
  const tabState = await evaluateRuntime(cdp, `Object.assign(window.__fg04KeyboardProof, {
    searchValue: document.querySelector('[data-fg04-street-search]')?.value,
    focusedResult: document.activeElement?.classList.contains('fg04-street__result')
      ? document.activeElement.textContent : null,
    focusedTag: document.activeElement?.tagName,
    focusedClass: document.activeElement?.className,
  })`);
  if (tabState.focusedResult !== 'York Street') {
    throw new Error(`Tab did not focus York Street: ${JSON.stringify(tabState)}`);
  }
  await dispatchKey(cdp, 'Enter');
  await waitForRuntime(
    cdp,
    `window.__fg04Explorer.getStreetResult()?.id === 'york-street'`,
    'street result Enter key',
  );
  await evaluateRuntime(cdp, `Object.assign(window.__fg04KeyboardProof, {
    streetId: window.__fg04Explorer.getStreetResult()?.id,
    streetRows: document.querySelectorAll('[data-fg04-street-table] tr').length,
    everyStreetRowPaired: Array.from(document.querySelectorAll('[data-fg04-street-table] tr'))
      .every((row) => row.querySelectorAll('td').length === 2),
    pointCleared: window.__fg04Explorer.getPointResult() === null
      && document.querySelectorAll('.fg04-point-marker').length === 0,
  })`);

  await evaluateRuntime(cdp, `(() => {
    window.__fg04KeyboardProof.copiedUrl = null;
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (value) => {
          window.__fg04KeyboardProof.copiedUrl = value;
        } },
      });
    } catch {}
    document.querySelector('[data-fg04-share]').focus();
  })()`);
  await dispatchKey(cdp, 'Enter');
  await waitForRuntime(
    cdp,
    `document.querySelector('[data-fg04-share]')?.textContent.trim() === 'Copied'`,
    'share Enter key',
  );
  await evaluateRuntime(cdp, `(() => {
    const share = document.querySelector('[data-fg04-share]');
    Object.assign(window.__fg04KeyboardProof, {
      shareText: share?.textContent.trim(),
      shareFocused: document.activeElement === share,
      shareStatus: document.querySelector('[data-fg04-share-status]')?.textContent,
      finalUrl: location.href,
      finished: true,
    });
  })()`);
}

async function captureRenderedPixels(cdp) {
  const layout = await evaluateRuntime(cdp, `(() => {
    const scope = document.querySelector('[data-fg04-maps]');
    const color = (token) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      context.fillStyle = getComputedStyle(scope).getPropertyValue(token).trim();
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    return {
      colors: {
        shaded: color('--fg04-selected-shaded'),
        sunlit: color('--fg04-selected-sunlit'),
      },
      maps: ['raw', 'corrected'].map((surface) => {
        const canvas = document.querySelector(
          '[data-fg04-map="' + surface + '"] .maplibregl-canvas',
        );
        const rect = canvas.getBoundingClientRect();
        return {
          surface,
          x: rect.left + scrollX,
          y: rect.top + scrollY,
          width: rect.width,
          height: rect.height,
        };
      }),
    };
  })()`);

  const results = [];
  for (const map of layout.maps) {
    const screenshot = await cdp.call('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: map.x,
        y: map.y,
        width: map.width,
        height: map.height,
        scale: 1,
      },
    });
    const pixels = await evaluateRuntime(cdp, `(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(`data:image/png;base64,${screenshot.data}`)};
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const shaded = ${JSON.stringify(layout.colors.shaded)};
      const sunlit = ${JSON.stringify(layout.colors.sunlit)};
      let shadedPixels = 0;
      let sunlitPixels = 0;
      for (let offset = 0; offset < bytes.length; offset += 4) {
        if (bytes[offset] === shaded[0] && bytes[offset + 1] === shaded[1]
          && bytes[offset + 2] === shaded[2]) shadedPixels += 1;
        if (bytes[offset] === sunlit[0] && bytes[offset + 1] === sunlit[1]
          && bytes[offset + 2] === sunlit[2]) sunlitPixels += 1;
      }
      return { width: canvas.width, height: canvas.height, shadedPixels, sunlitPixels };
    })()`, true);
    results.push({ surface: map.surface, ...pixels });
  }
  if (results.some(({ shadedPixels, sunlitPixels }) => (
    shadedPixels < 25 || sunlitPixels < 25
  ))) {
    throw new Error(`selected-hour canvas has no visible shade data: ${JSON.stringify(results)}`);
  }
  return results;
}

async function runBrowser(
  executable, url, profile, expression, label, prepare = null, provePixels = false,
) {
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
    for (let attempt = 0; attempt < BROWSER_START_ATTEMPTS; attempt += 1) {
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
      await cdp.call('Page.enable');
      if (prepare) await prepare(cdp);
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const result = await cdp.call('Runtime.evaluate', {
          expression,
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
            throw new Error(`${label} browser proof failed: ${JSON.stringify(value)}`);
          }
          if (provePixels) value.renderedPixels = await captureRenderedPixels(cdp);
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
        `${label} browser proof did not finish in 30 seconds: `
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
const pointBrowserProfile = mkdtempSync(join(tmpdir(), 'fg04-point-proof-'));
const streetBrowserProfile = mkdtempSync(join(tmpdir(), 'fg04-street-proof-'));
const keyboardBrowserProfile = mkdtempSync(join(tmpdir(), 'fg04-keyboard-proof-'));
const recoveryProfiles = Array.from({ length: 5 }, (_, index) => (
  mkdtempSync(join(tmpdir(), `fg04-recovery-${index}-`))
));
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
    junk: 'drop-me',
  });
  const url = `http://127.0.0.1:${address.port}`
    + `/guides/throwing-shade/?${query}`;
  const result = await runBrowser(
    browserPath(), url, pointBrowserProfile, proofExpression, 'selected-hour', null, true,
  );
  const streetQuery = new URLSearchParams({
    tiles: 'local',
    street: 'york-street',
  });
  const streetUrl = `http://127.0.0.1:${address.port}`
    + `/guides/throwing-shade/?${streetQuery}`;
  const streetResult = await runBrowser(
    browserPath(), streetUrl, streetBrowserProfile,
    streetProofExpression, 'street-profile',
  );
  const keyboardQuery = new URLSearchParams({
    tiles: 'local',
    map: '-79.38445,43.65395,16',
  });
  const keyboardUrl = `http://127.0.0.1:${address.port}`
    + `/guides/throwing-shade/?${keyboardQuery}`;
  const keyboardResult = await runBrowser(
    browserPath(), keyboardUrl, keyboardBrowserProfile,
    keyboardProofExpression, 'keyboard', prepareKeyboardProof,
  );
  const recoveryCases = [
    ['manifest-retry', manifestRetryExpression, ''],
    ['measured-retry', mapRetryExpression('raw'), ''],
    ['classification-retry', mapRetryExpression('corrected'), ''],
    ['street-retry', streetRetryExpression, ''],
    ['missing-street', missingStreetExpression, '&street=not-in-this-edition'],
  ];
  const recoveryResults = {};
  for (let index = 0; index < recoveryCases.length; index += 1) {
    const [scenario, expression, extraQuery] = recoveryCases[index];
    failureScenario = scenario === 'missing-street' ? null : scenario;
    scenarioPageLoads = 0;
    scenarioStreetRequests = 0;
    const recoveryUrl = `http://127.0.0.1:${address.port}`
      + `/guides/throwing-shade/?tiles=local${extraQuery}`;
    recoveryResults[scenario] = await runBrowser(
      browserPath(), recoveryUrl, recoveryProfiles[index], expression, scenario,
    );
  }
  failureScenario = null;
  if (Object.values(tileRequests).some((count) => count === 0)) {
    throw new Error(`browser did not request every tile product: ${JSON.stringify(tileRequests)}`);
  }
  result.tileRequests = tileRequests;
  result.streetProof = streetResult;
  result.keyboardProof = keyboardResult;
  result.recoveryProofs = recoveryResults;
  console.log(`FG04 selected-hour browser proof passed: ${JSON.stringify(result)}`);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(pointBrowserProfile, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  });
  rmSync(streetBrowserProfile, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  });
  rmSync(keyboardBrowserProfile, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  });
  recoveryProfiles.forEach((profile) => rmSync(profile, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  }));
}
