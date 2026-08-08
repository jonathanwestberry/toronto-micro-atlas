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
const FIXTURE = '/tests/fixtures/fg04-browser-decode.html';
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
]);

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

async function serveFile(request, response) {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const relative = normalize(pathname).replace(/^\/+/, '');
  const file = resolve(ROOT, relative);
  if (!file.startsWith(`${ROOT}/`)) {
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
    if (!target) throw new Error('Chrome did not expose the proof page');
    const cdp = cdpClient(target.webSocketDebuggerUrl);
    try {
      await cdp.call('Runtime.enable');
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const state = await cdp.call('Runtime.evaluate', {
          expression: 'document.body?.dataset.proofState',
          returnByValue: true,
        });
        const value = state.result?.value;
        if (value === 'passed') {
          const output = await cdp.call('Runtime.evaluate', {
            expression: 'document.querySelector("#result")?.textContent',
            returnByValue: true,
          });
          return output.result?.value;
        }
        if (value === 'failed') {
          const output = await cdp.call('Runtime.evaluate', {
            expression: 'document.querySelector("#result")?.textContent',
            returnByValue: true,
          });
          throw new Error(`browser decode proof failed: ${output.result?.value}`);
        }
        await delay(100);
      }
      throw new Error('browser decode proof did not finish in 20 seconds');
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

const server = createServer(serveFile);
const profile = mkdtempSync(join(tmpdir(), 'fg04-browser-proof-'));
try {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no proof server port');
  const url = `http://127.0.0.1:${address.port}${FIXTURE}`;
  const result = await runBrowser(browserPath(), url, profile);
  console.log(`FG04 browser decode proof passed: ${result}`);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
