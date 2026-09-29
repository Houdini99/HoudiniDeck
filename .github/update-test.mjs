// CI: the deck updates itself. Serves a made-up newer release (v99.0.0) whose download is the given file,
// asks the deck (as the PC's own browser) to look for it and install it, and waits until the deck has
// stopped and come back by itself.
//   node .github/update-test.mjs --appimage <file>
//       starts a copy of that AppImage (Linux) and updates it; the copy must be replaced by the download
//   node .github/update-test.mjs --installer <HoudiniDeck-Setup-x.exe> --port <port>
//       updates a deck already running from the Windows installer; its .env must set
//       STREAMDECK_UPDATE_FEED=http://127.0.0.1:3390/latest (test-installer.ps1 does)
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const FEED_PORT = 3390;
const VERSION = '99.0.0';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const appimage = arg('--appimage');
const installer = arg('--installer');
if (!appimage === !installer) {
  console.error('Usage: node .github/update-test.mjs --appimage <file> | --installer <setup.exe> --port <port>');
  process.exit(2);
}

async function waitFor(what, fn, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const health = (port) => fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());

/** A WebSocket to the deck as the PC's own browser (loopback, Host localhost): no key needed. */
function connectAsPc(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Host: `localhost:${port}` } });
    const results = new Map();
    let reqId = 0;
    // The deck closes it when it stops for the update (or the installer ends it).
    const closed = new Promise((done) => ws.on('close', done));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'init') resolve({ ws, init: msg, request, closed });
      if (msg.t === 'result') results.set(msg.reqId, msg);
    });
    ws.on('error', reject);
    async function request(msg) {
      const id = ++reqId;
      ws.send(JSON.stringify({ ...msg, reqId: id }));
      const result = await waitFor(`an answer to ${JSON.stringify(msg)}`, async () => results.get(id), 30_000);
      if (!result.ok) throw new Error(`${JSON.stringify(msg)} failed: ${result.error}`);
      return result.data;
    }
  });
}

// The made-up release, as GitHub's API describes it, and its download.
const file = resolve(appimage ?? installer);
const bytes = readFileSync(file);
const assetName = appimage ? 'HoudiniDeck-x86_64.AppImage' : `HoudiniDeck-Setup-${VERSION}.exe`;
let downloads = 0;
const feed = createServer((req, res) => {
  if (req.url === '/latest') {
    const release = {
      tag_name: `v${VERSION}`,
      html_url: 'https://github.com/Houdini99/HoudiniDeck/releases',
      body: 'A made-up release for the update test',
      published_at: new Date().toISOString(),
      assets: [
        {
          name: assetName,
          size: bytes.length,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          browser_download_url: `http://127.0.0.1:${FEED_PORT}/download/${assetName}`,
        },
      ],
    };
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(release));
  }
  if (req.url === `/download/${assetName}`) {
    downloads++;
    return void res.writeHead(200, { 'content-length': bytes.length }).end(bytes);
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => feed.listen(FEED_PORT, '127.0.0.1', resolve));

let dir;
let copy;
const port = Number(arg('--port') ?? 3398);
try {
  if (appimage) {
    // A copy, so the update doesn't replace the file CI attaches to the release.
    dir = mkdtempSync(join(tmpdir(), 'vsd-update-'));
    copy = join(dir, 'HoudiniDeck-x86_64.AppImage');
    copyFileSync(file, copy);
    chmodSync(copy, 0o755);
    const env = {
      ...process.env,
      PORT: String(port),
      STREAMDECK_DATA_DIR: join(dir, 'data'),
      STREAMDECK_UPDATE_FEED: `http://127.0.0.1:${FEED_PORT}/latest`,
    };
    spawn(copy, ['--no-browser'], { detached: true, stdio: 'ignore', env }).unref();
  }
  const before = await waitFor('the deck to run', () => health(port));
  const inode = copy && statSync(copy).ino;

  const pc = await connectAsPc(port);
  if (pc.init.info.update.packaging !== (appimage ? 'appimage' : 'windows-installer')) {
    throw new Error(`the deck says it was installed as ${pc.init.info.update.packaging}`);
  }
  const found = await pc.request({ t: 'update', action: 'check' });
  if (found.available?.version !== VERSION || !found.available.installable) throw new Error(`the deck didn't find the release: ${JSON.stringify(found)}`);
  await pc.request({ t: 'update', action: 'install' });
  console.log(`Updating the deck on port ${port} (version ${before.version}) with ${file}`);

  await Promise.race([pc.closed, waitFor('the deck to stop for the update', async () => false, 180_000)]);
  const after = await waitFor('the deck to come back by itself', () => health(port), 180_000);
  if (downloads !== 1) throw new Error(`the download was fetched ${downloads} times`);
  if (copy) {
    if (statSync(copy).ino === inode) throw new Error("the AppImage wasn't replaced");
    if (readdirSync(dir).some((name) => name.endsWith('.part'))) throw new Error('a download was left behind');
  }
  console.log(`Update: OK (downloaded and checked, the deck restarted by itself: ${JSON.stringify(after)})`);
} finally {
  feed.close();
  if (copy) {
    await promisify(execFile)(copy, ['--stop']).catch((err) => console.log(`--stop: ${err.message}`));
    const log = join(dir, 'data', 'houdinideck.log');
    if (existsSync(log)) process.stdout.write(`[appimage log]\n${readFileSync(log, 'utf8')}`);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}
process.exit(0);
