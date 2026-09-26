// CI smoke test: start the deck the way a user does (npm start, npm run dev:mock) and check that it
// serves the page, reaches the mock OBS and talks WebSocket. Works on Linux and Windows.
// `node .github/smoke.mjs --appimage <file>` checks a built Linux AppImage the same way instead.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const windows = process.platform === 'win32';

function start(name, script, env = {}) {
  // npm is npm.cmd on Windows, which needs a shell. On Linux, its own process group (for stop()).
  const child = spawn('npm', ['run', script], {
    shell: windows,
    detached: !windows,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  return child;
}

function stop(child) {
  if (child.exitCode !== null) return;
  // npm starts node as a child of its own; stop the whole tree.
  if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
  else process.kill(-child.pid, 'SIGINT');
}

async function waitFor(what, fn, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

const health = (port) => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());

function initMessage(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => reject(new Error('no init message')), 10_000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t !== 'init') return;
      clearTimeout(timer);
      // Only once it's really closed: the deck waits for open connections when it shuts down.
      ws.once('close', () => resolve(msg));
      ws.close();
    });
    ws.on('error', reject);
  });
}

/** The deck on `port` reached the mock OBS, serves the UI and talks WebSocket. */
async function checkDeck(what, port) {
  await waitFor(`${what} to reach the mock OBS`, async () => (await health(port)).obs === 'connected');
  const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  if (!page.includes('<div id="app"')) throw new Error(`${what} doesn't serve the UI:\n${page.slice(0, 300)}`);
  const init = await initMessage(port);
  if (init.info.platform !== process.platform) throw new Error(`server says platform ${init.info.platform}`);
  if (init.obs.connection !== 'connected') throw new Error('init without OBS');
  return init;
}

const procs = [];
const dataDir = mkdtempSync(join(tmpdir(), 'vsd-smoke-'));
const deckEnv = { PORT: '3399', OBS_URL: 'ws://127.0.0.1:4456', OBS_PASSWORD: '', STREAMDECK_DATA_DIR: dataDir };
// --appimage <file>: check that AppImage (the Linux release) instead of npm start and dev:mock.
const appimageArg = process.argv.indexOf('--appimage');
const appimage = appimageArg > 0 ? resolve(process.argv[appimageArg + 1] ?? '') : undefined;
try {
  procs.push(start('mock', 'mock-obs'));
  if (appimage) {
    // Its output goes to houdinideck.log in the data folder: stdout isn't a terminal here.
    const deck = spawn(appimage, ['--no-browser'], { detached: true, env: { ...process.env, ...deckEnv }, stdio: 'ignore' });
    procs.push(deck);
    const init = await checkDeck('the AppImage', 3399);
    if (!existsSync(join(dataDir, 'settings.json'))) throw new Error("the AppImage didn't use STREAMDECK_DATA_DIR");
    const stopped = await promisify(execFile)(appimage, ['--stop']).catch((err) => err);
    if (stopped instanceof Error || !stopped.stdout.includes('stopped')) {
      throw new Error(`--stop failed: ${stopped.message ?? ''}${stopped.stdout}${stopped.stderr}`);
    }
    await waitFor('the AppImage to stop', async () => deck.exitCode !== null || deck.signalCode !== null, 15_000);
    console.log(`AppImage: OK (platform ${init.info.platform}, ${init.obs.scenes.length} scenes, --stop works)`);
  } else {
    // npm start (the built UI) against the mock OBS.
    procs.push(start('start', 'start', deckEnv));
    const init = await checkDeck('npm start', 3399);
    console.log(`npm start: OK (platform ${init.info.platform}, ${init.obs.scenes.length} scenes)`);
    procs.splice(0).forEach(stop);
    await new Promise((r) => setTimeout(r, 2000));

    // npm run dev:mock (server, Vite and the mock OBS through concurrently and cross-env).
    procs.push(start('dev', 'dev:mock'));
    await waitFor('dev:mock to reach the mock OBS', async () => (await health(3325)).obs === 'connected');
    await waitFor('Vite on 5173', async () => (await fetch('http://127.0.0.1:5173/')).ok);
    const proxied = await waitFor('the Vite proxy', async () => {
      const h = await health(5173);
      return h.ok && h;
    });
    console.log(`npm run dev:mock: OK (${JSON.stringify(proxied)})`);
  }
} finally {
  procs.forEach(stop);
  const log = join(dataDir, 'houdinideck.log');
  if (existsSync(log)) process.stdout.write(`[appimage log]\n${readFileSync(log, 'utf8')}`);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(0);
