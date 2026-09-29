// Updates: finding a newer release, downloading it with its checksum, and installing it (AppImage and
// Windows installer), with a fake GitHub and fake programs, so nothing reaches the network or the system.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OpError } from '../server/deck/ops.ts';
import { RELEASES_URL, readEnv } from '../server/env.ts';
import { silentLogger } from '../server/log.ts';
import { downloadVerified, relaunchEnv, type Relaunch } from '../server/update/install.ts';
import { APPIMAGE_PART, Updater, compareVersions, type UpdaterDeps } from '../server/update/updater.ts';
import { tempDir, waitFor } from './helpers.ts';

const FEED = 'https://api.test/releases/latest';
const NEW_FILE = Buffer.from('the new version\n'.repeat(1000));
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function release(version: string, assets: Array<{ name: string; digest?: string | null; size?: number }>) {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/Houdini99/HoudiniDeck/releases/tag/v${version}`,
    published_at: '2026-10-01T12:00:00Z',
    body: `<!-- generated -->\r\n## What's Changed\r\n* Things for ${version}`,
    assets: assets.map((a) => ({
      name: a.name,
      size: a.size ?? NEW_FILE.length,
      digest: a.digest === undefined ? `sha256:${sha256(NEW_FILE)}` : a.digest,
      browser_download_url: `https://github.com/download/${a.name}`,
    })),
  };
}

/** A fake GitHub: the feed answers `answer()`, downloads answer with NEW_FILE. Records every request. */
function fakeGitHub(answer: () => Response | Promise<Response>) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url === FEED) return answer();
    if (url.startsWith('https://github.com/download/')) return new Response(NEW_FILE);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });

function makeUpdater(deps: Partial<UpdaterDeps> & Pick<UpdaterDeps, 'fetch'>) {
  const relaunched: Relaunch[] = [];
  const updater = new Updater({
    version: '0.4.0',
    packaging: 'appimage',
    appImagePath: '/nowhere/HoudiniDeck-x86_64.AppImage',
    feed: FEED,
    dataDir: '/nowhere',
    autoCheck: () => true,
    relaunch: (next) => relaunched.push(next),
    log: silentLogger,
    ...deps,
  });
  return { updater, relaunched };
}

test('versions compare by number, with or without a v', () => {
  assert.equal(compareVersions('0.4.0', '0.3.9'), 1);
  assert.equal(compareVersions('v0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
  assert.equal(compareVersions('0.3.0', '0.4.0'), -1);
  assert.equal(compareVersions('0.4.0-beta.1', '0.3.0'), undefined, 'pre-releases are not offered');
  assert.equal(compareVersions('latest', '0.3.0'), undefined);
});

test('a newer release with this copy’s download is offered for installing', async () => {
  const github = fakeGitHub(() => json(release('0.5.0', [{ name: 'HoudiniDeck-x86_64.AppImage' }, { name: 'HoudiniDeck-Setup-0.5.0.exe' }])));
  const { updater } = makeUpdater({ fetch: github.fetch });
  let changes = 0;
  updater.on('change', () => changes++);
  const info = await updater.check();
  assert.equal(info.state, 'idle');
  assert.equal(info.error, undefined);
  assert.equal(info.checks, 'on');
  assert.ok(info.checkedAt);
  assert.deepEqual(info.available, {
    version: '0.5.0',
    pageUrl: 'https://github.com/Houdini99/HoudiniDeck/releases/tag/v0.5.0',
    notes: "## What's Changed\n* Things for 0.5.0",
    publishedAt: '2026-10-01T12:00:00Z',
    installable: true,
  });
  assert.ok(changes >= 2, 'browsers hear about "checking" and the result');
  const { headers } = github.requests[0];
  assert.equal(headers.get('user-agent'), 'HoudiniDeck/0.4.0');
  assert.equal(headers.get('accept'), 'application/vnd.github+json');
});

test('the Windows installer is looked up by its versioned name', async () => {
  const github = fakeGitHub(() => json(release('0.5.0', [{ name: 'HoudiniDeck-x86_64.AppImage' }, { name: 'HoudiniDeck-Setup-0.5.0.exe' }])));
  const { updater } = makeUpdater({ fetch: github.fetch, packaging: 'windows-installer' });
  assert.equal((await updater.check()).available?.installable, true);

  const old = fakeGitHub(() => json(release('0.5.0', [{ name: 'HoudiniDeck-Setup-0.4.0.exe' }])));
  const other = makeUpdater({ fetch: old.fetch, packaging: 'windows-installer' });
  assert.equal((await other.updater.check()).available?.installable, false);
});

test('the same or an older version is no update', async () => {
  for (const version of ['0.4.0', '0.3.0']) {
    const github = fakeGitHub(() => json(release(version, [{ name: 'HoudiniDeck-x86_64.AppImage' }])));
    const { updater } = makeUpdater({ fetch: github.fetch });
    assert.equal((await updater.check()).available, undefined, version);
  }
});

test('without its download or checksum, a release is shown but not installable', async () => {
  const cases = [[], [{ name: 'HoudiniDeck-x86_64.AppImage', digest: null }], [{ name: 'HoudiniDeck-x86_64.AppImage', digest: 'md5:abc' }]];
  for (const assets of cases) {
    const github = fakeGitHub(() => json(release('0.5.0', assets)));
    const { updater } = makeUpdater({ fetch: github.fetch });
    const info = await updater.check();
    assert.equal(info.available?.version, '0.5.0');
    assert.equal(info.available?.installable, false);
    await assert.rejects(updater.install(), (err) => err instanceof OpError && /isn't ready yet/.test(err.message));
  }
});

test('a source checkout is told about new versions but never installs them', async () => {
  const github = fakeGitHub(() => json(release('0.5.0', [{ name: 'HoudiniDeck-x86_64.AppImage' }])));
  const { updater } = makeUpdater({ fetch: github.fetch, packaging: 'source', appImagePath: undefined });
  const info = await updater.check();
  assert.equal(info.packaging, 'source');
  assert.equal(info.available?.installable, false);
  await assert.rejects(updater.install(), (err) => err instanceof OpError && /git pull/.test(err.message));
});

test('"not modified" answers keep what was found; the ETag goes along', async () => {
  let calls = 0;
  const github = fakeGitHub(() =>
    ++calls === 1 ? json(release('0.5.0', [{ name: 'HoudiniDeck-x86_64.AppImage' }]), { etag: '"abc"' }) : new Response(null, { status: 304 }),
  );
  const { updater } = makeUpdater({ fetch: github.fetch });
  await updater.check();
  const info = await updater.check();
  assert.equal(github.requests[1].headers.get('if-none-match'), '"abc"');
  assert.equal(info.available?.version, '0.5.0');
  assert.equal(info.error, undefined);
});

test('failed checks say why and keep what was known', async () => {
  let answer: () => Response = () => json(release('0.5.0', [{ name: 'HoudiniDeck-x86_64.AppImage' }]));
  const github = fakeGitHub(() => answer());
  const { updater } = makeUpdater({ fetch: github.fetch });
  await updater.check();

  answer = () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  };
  let info = await updater.check();
  assert.match(info.error ?? '', /Couldn't check for updates: host not found/);
  assert.equal(info.available?.version, '0.5.0');

  answer = () => new Response('{"message":"API rate limit exceeded"}', { status: 403 });
  info = await updater.check();
  assert.match(info.error ?? '', /limiting requests/);

  answer = () => json({ tag_name: 'v0.6.0' });
  info = await updater.check();
  assert.match(info.error ?? '', /isn't what the deck expected/);

  answer = () => new Response('Not Found', { status: 404 });
  info = await updater.check();
  assert.equal(info.error, undefined, 'no release published is no error');
  assert.equal(info.available, undefined);
});

test('checks run one at a time, and not at all when turned off on the server', async () => {
  let release_: (r: Response) => void = () => {};
  const github = fakeGitHub(() => new Promise<Response>((resolve) => (release_ = resolve)));
  const { updater } = makeUpdater({ fetch: github.fetch });
  const first = updater.check();
  const second = updater.check();
  await waitFor(() => github.requests.length === 1, 1000, 'the request');
  assert.equal(updater.info.state, 'checking');
  release_(json(release('0.5.0', [])));
  await Promise.all([first, second]);
  assert.equal(github.requests.length, 1);

  const off = makeUpdater({ fetch: github.fetch, feed: undefined });
  assert.equal(off.updater.info.checks, 'env-off');
  await assert.rejects(off.updater.check(), /turned off on the server/);
  let auto = false;
  const manual = makeUpdater({ fetch: github.fetch, autoCheck: () => auto });
  assert.equal(manual.updater.info.checks, 'off');
  auto = true;
  assert.equal(manual.updater.info.checks, 'on');
});

test('downloads are checked against their size and SHA-256; a bad one leaves nothing behind', async () => {
  const { dir, cleanup } = await tempDir();
  let body = NEW_FILE;
  let status = 200;
  const server = createServer((_req, res) => res.writeHead(status).end(body)).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`;
  const dest = join(dir, 'download');
  const expected = { sha256: sha256(NEW_FILE), size: NEW_FILE.length };
  try {
    const progress: number[] = [];
    await downloadVerified(url, dest, expected, (share) => progress.push(share));
    assert.deepEqual(await readFile(dest), NEW_FILE);
    assert.equal(progress.at(-1), 1);

    body = Buffer.from(NEW_FILE).fill(0x41, 0, 10);
    await assert.rejects(downloadVerified(url, dest, expected), /doesn't match its checksum/);
    assert.deepEqual(await readdir(dir), []);

    body = Buffer.concat([NEW_FILE, Buffer.from('more')]);
    await assert.rejects(downloadVerified(url, dest, expected), /bigger than GitHub said/);
    body = NEW_FILE.subarray(10);
    await assert.rejects(downloadVerified(url, dest, expected), /stopped early/);
    assert.deepEqual(await readdir(dir), []);

    status = 404;
    await assert.rejects(downloadVerified(url, dest, expected), /The download failed: 404/);
    await assert.rejects(downloadVerified(url, dest, { ...expected, size: 400 * 1024 * 1024 }), /too big/);
  } finally {
    server.close();
    await cleanup();
  }
});

test('the AppImage replaces itself and starts again in place of this deck', async () => {
  const { dir, cleanup } = await tempDir();
  const appImage = join(dir, 'HoudiniDeck-x86_64.AppImage');
  await writeFile(appImage, 'the old version');
  await chmod(appImage, 0o755);
  const github = fakeGitHub(() => json(release('0.5.0', [{ name: 'HoudiniDeck-x86_64.AppImage' }])));
  const { updater, relaunched } = makeUpdater({ fetch: github.fetch, appImagePath: appImage, dataDir: dir });
  const states: string[] = [];
  updater.on('change', () => states.push(updater.info.state));
  try {
    await updater.check();
    await updater.install();
    await assert.rejects(updater.install(), /already running/);
    await waitFor(() => relaunched.length === 1, 3000, 'the relaunch');
    assert.deepEqual(await readFile(appImage), NEW_FILE);
    if (process.platform !== 'win32') assert.equal((await stat(appImage)).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(dir), ['HoudiniDeck-x86_64.AppImage'], 'no download left over');
    assert.equal(relaunched[0].command, appImage);
    assert.deepEqual(relaunched[0].args, ['--no-browser']);
    assert.deepEqual(
      states.filter((s, i) => s !== states[i - 1]).slice(-2),
      ['downloading', 'restarting'],
    );
  } finally {
    await cleanup();
  }
});

test('the new AppImage gets its own AppImage variables and doesn’t open another browser', () => {
  const env = relaunchEnv({ PATH: '/usr/bin', APPIMAGE: '/a', APPDIR: '/tmp/.mount_x', ARGV0: 'x', OWD: '/', STREAMDECK_OPEN_BROWSER: '1', STREAMDECK_DATA_DIR: '/d' });
  assert.deepEqual(env, { PATH: '/usr/bin', STREAMDECK_DATA_DIR: '/d' });
});

test('a failed AppImage update leaves the old one alone and says why', { skip: process.platform === 'win32' }, async () => {
  const { dir, cleanup } = await tempDir();
  const appImage = join(dir, 'HoudiniDeck-x86_64.AppImage');
  await writeFile(appImage, 'the old version');
  try {
    const bad = fakeGitHub(() => json(release('0.5.0', [{ name: 'HoudiniDeck-x86_64.AppImage', digest: `sha256:${'0'.repeat(64)}` }])));
    const { updater, relaunched } = makeUpdater({ fetch: bad.fetch, appImagePath: appImage });
    await updater.check();
    await updater.install();
    await waitFor(() => updater.info.state === 'idle', 3000, 'the failure');
    assert.match(updater.info.error ?? '', /checksum/);
    assert.equal(await readFile(appImage, 'utf8'), 'the old version');
    assert.deepEqual(await readdir(dir), ['HoudiniDeck-x86_64.AppImage']);
    assert.equal(relaunched.length, 0);

    // A folder the user can't write to (root can, so this part only runs as a normal user).
    if (process.getuid?.() !== 0) {
      const good = fakeGitHub(() => json(release('0.5.0', [{ name: 'HoudiniDeck-x86_64.AppImage' }])));
      const locked = makeUpdater({ fetch: good.fetch, appImagePath: appImage });
      await chmod(dir, 0o555);
      try {
        await locked.updater.check();
        await locked.updater.install();
        await waitFor(() => locked.updater.info.error, 3000, 'the failure');
        assert.match(locked.updater.info.error ?? '', /isn't writable/);
      } finally {
        await chmod(dir, 0o755);
      }
    }
  } finally {
    await cleanup();
  }
});

test('Windows: the installer runs silently and restarts the deck; a cancelled or failed one is reported', async () => {
  const { dir, cleanup } = await tempDir();
  const github = fakeGitHub(() => json(release('0.5.0', [{ name: 'HoudiniDeck-Setup-0.5.0.exe' }])));
  const events: string[] = [];
  const runs: Array<{ setup: string; args: string[]; content: Buffer }> = [];
  // First as if the user said No at Windows' permission prompt, then as if the installer failed.
  const exitCodes = [2, 1];
  const { updater } = makeUpdater({
    fetch: github.fetch,
    packaging: 'windows-installer',
    appImagePath: undefined,
    dataDir: dir,
    beforeInstall: async () => void events.push('saved'),
    runInstaller: async (setup, args) => {
      events.push('installer');
      runs.push({ setup, args, content: await readFile(setup) });
      return exitCodes.shift()!;
    },
  });
  try {
    await updater.check();
    await updater.install();
    await waitFor(() => updater.info.error, 3000, 'the installer to end');
    assert.deepEqual(events, ['saved', 'installer']);
    const setup = join(dir, 'updates', 'HoudiniDeck-Setup-0.5.0.exe');
    assert.equal(runs[0].setup, setup);
    assert.deepEqual(runs[0].content, NEW_FILE);
    assert.deepEqual(runs[0].args, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/STARTDECK', `/LOG=${join(dir, 'updates', 'install.log')}`]);
    assert.equal(updater.info.state, 'idle');
    assert.equal(updater.info.error, "The update was cancelled at Windows' permission prompt. Press Update now to try again.");

    await updater.install();
    await waitFor(() => updater.info.error?.includes('failed'), 3000, 'the second installer to end');
    assert.equal(updater.info.error, `The update failed (installer exit code 1). Its log: ${join(dir, 'updates', 'install.log')}`);
  } finally {
    await cleanup();
  }
});

test('leftovers of an earlier update are cleaned up at start-up', async () => {
  const { dir, cleanup } = await tempDir();
  await mkdir(join(dir, 'updates'));
  await writeFile(join(dir, 'updates', 'HoudiniDeck-Setup-0.4.0.exe'), 'ran last time');
  await writeFile(join(dir, 'updates', 'install.log'), 'kept');
  await writeFile(join(dir, APPIMAGE_PART), 'cut off');
  const github = fakeGitHub(() => json(release('0.4.0', [])));
  const { updater } = makeUpdater({ fetch: github.fetch, dataDir: dir, appImagePath: join(dir, 'HoudiniDeck-x86_64.AppImage') });
  try {
    updater.start();
    const left = async () => [...(await readdir(dir)), ...(await readdir(join(dir, 'updates')))].sort();
    let files: string[] = [];
    for (let i = 0; i < 50 && (files = await left()).length !== 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(files, ['install.log', 'updates']);
    assert.equal(github.requests.length, 0, 'the first check waits a little after start-up');
  } finally {
    updater.stop();
    await cleanup();
  }
});

test('the environment says how this copy was installed and where updates come from', () => {
  assert.equal(readEnv({}).packaging, 'source');
  assert.equal(readEnv({ STREAMDECK_PACKAGE: 'appimage', APPIMAGE: '/home/me/HoudiniDeck-x86_64.AppImage' }).appImagePath, '/home/me/HoudiniDeck-x86_64.AppImage');
  assert.equal(readEnv({ STREAMDECK_PACKAGE: 'windows-installer' }).packaging, 'windows-installer');
  assert.equal(readEnv({ STREAMDECK_PACKAGE: 'something' }).packaging, 'source');
  assert.equal(readEnv({}).updateFeed, RELEASES_URL);
  assert.equal(readEnv({ STREAMDECK_UPDATE_FEED: 'http://127.0.0.1:4457/release' }).updateFeed, 'http://127.0.0.1:4457/release');
  assert.equal(readEnv({ STREAMDECK_UPDATE_CHECK: '0', STREAMDECK_UPDATE_FEED: 'http://x' }).updateFeed, undefined);
});
