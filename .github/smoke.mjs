// CI smoke test: start the deck the way a user does (npm start, npm run dev:mock) and check that it
// serves the page, reaches the mock OBS and talks WebSocket. Works on Linux and Windows.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      ws.close();
      resolve(msg);
    });
    ws.on('error', reject);
  });
}

const procs = [];
const dataDir = mkdtempSync(join(tmpdir(), 'vsd-smoke-'));
try {
  // npm start (the built UI) against the mock OBS.
  procs.push(start('mock', 'mock-obs'));
  procs.push(start('start', 'start', { PORT: '3399', OBS_URL: 'ws://127.0.0.1:4456', OBS_PASSWORD: '', STREAMDECK_DATA_DIR: dataDir }));
  await waitFor('npm start to reach the mock OBS', async () => (await health(3399)).obs === 'connected');
  const page = await fetch('http://127.0.0.1:3399/').then((r) => r.text());
  if (!page.includes('<div id="app"')) throw new Error(`npm start doesn't serve the UI:\n${page.slice(0, 300)}`);
  const init = await initMessage(3399);
  if (init.info.platform !== process.platform) throw new Error(`server says platform ${init.info.platform}`);
  if (init.obs.connection !== 'connected') throw new Error('init without OBS');
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
} finally {
  procs.forEach(stop);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(0);
