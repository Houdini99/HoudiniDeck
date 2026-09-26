// End-to-end: real server on a random port, talking to the mock OBS, driven over WebSocket/HTTP.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { startApp, type App } from '../server/app.ts';
import { startMockObs, type MockObs } from '../server/dev/mock-obs.ts';
import { readEnv } from '../server/env.ts';
import { deckRunningOn } from '../server/network.ts';
import type { ServerMsg, SettingsView } from '../shared/protocol.ts';
import { tempDir, waitFor } from './helpers.ts';

let mock: MockObs;
let app: App;
let cleanup: () => Promise<void>;

before(async () => {
  mock = await startMockObs({ outputDelayMs: 20 });
  const tmp = await tempDir();
  cleanup = tmp.cleanup;
  app = await startApp({ ...readEnv({}), host: '127.0.0.1', port: 0, dataDir: tmp.dir, obsUrl: mock.url, obsPassword: '' });
  await waitFor(() => app.bridge.connected, 3000, 'OBS connection');
});

after(async () => {
  await app.close();
  await mock.close();
  await cleanup();
});

/** A WebSocket client that records every message; `host` fakes where the browser thinks it is. */
function connect(host?: string, origin?: string) {
  const messages: ServerMsg[] = [];
  const headers = host ? { Host: host } : undefined;
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { headers, origin: origin ?? (host ? `http://${host}` : undefined) });
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  const next = <T extends ServerMsg['t']>(t: T, from = 0) =>
    waitFor(() => messages.slice(from).find((m): m is Extract<ServerMsg, { t: T }> => m.t === t), 3000, `"${t}" message`);
  let reqId = 0;
  const request = async (msg: Record<string, unknown>) => {
    const id = ++reqId;
    ws.send(JSON.stringify({ ...msg, reqId: id }));
    return waitFor(() => messages.find((m): m is Extract<ServerMsg, { t: 'result' }> => m.t === 'result' && m.reqId === id), 3000, 'result');
  };
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('error', () => {});
  return { ws, messages, next, request, closed };
}

test('a browser on the PC itself needs no key', async () => {
  const c = connect(`localhost:${app.port}`);
  assert.equal((await c.next('hello')).needsAuth, false);
  const init = await c.next('init');
  assert.equal(init.obs.connection, 'connected');
  assert.equal(init.deck.pages.length, 1);
  assert.equal(typeof init.ext.media.available, 'boolean', 'state from outside OBS comes along');
  c.ws.close();
});

test('LAN devices must present the access key', async () => {
  const bad = connect('192.168.1.20:3325');
  assert.equal((await bad.next('hello')).needsAuth, true);
  bad.ws.send(JSON.stringify({ t: 'auth', key: 'wrong' }));
  assert.equal((await bad.next('authError')).reason, 'bad-key');
  assert.equal(await bad.closed, 4001);

  const good = connect('192.168.1.20:3325');
  await good.next('hello');
  good.ws.send(JSON.stringify({ t: 'auth', key: app.settingsStore.settings.accessKey }));
  await good.next('init');
  good.ws.close();
});

test('WebSocket upgrades from another origin are refused', async () => {
  const c = connect(`localhost:${app.port}`, 'http://evil.example');
  const failed = await new Promise<boolean>((resolve) => {
    c.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode === 403));
    c.ws.on('open', () => resolve(false));
  });
  assert.ok(failed);
});

test('generate a starter page, press a scene button, see OBS change for everyone', async () => {
  const editor = connect(`localhost:${app.port}`);
  const watcher = connect(`localhost:${app.port}`);
  await editor.next('init');
  await watcher.next('init');

  const res = await editor.request({ t: 'op', op: { op: 'deck.generateStarter' } });
  assert.equal(res.ok, true);
  const deckMsg = await watcher.next('deck');
  const page = deckMsg.deck.pages[0];
  const brb = Object.values(page.buttons).find((b) => b.tap?.type === 'obs.scene' && b.tap.scene.name === 'BRB');
  assert.ok(brb, 'starter page has a BRB scene button');

  const before = watcher.messages.length;
  editor.ws.send(JSON.stringify({ t: 'press', pageId: page.id, buttonId: brb.id, which: 'tap' }));
  await waitFor(
    () => watcher.messages.slice(before).some((m) => m.t === 'obs' && m.obs.programScene === 'BRB'),
    3000,
    'program scene broadcast',
  );
  editor.ws.close();
  watcher.ws.close();
});

test('invalid deck edits are rejected with a readable error', async () => {
  const c = connect(`localhost:${app.port}`);
  const init = await c.next('init');
  const pageId = init.deck.pages[0].id;
  const outside = await c.request({ t: 'op', op: { op: 'button.set', pageId, slot: '9-9', button: { label: 'x' } } });
  assert.equal(outside.ok, false);
  const badAction = await c.request({ t: 'op', op: { op: 'button.set', pageId, slot: '0-0', button: { tap: { type: 'shell.run' } } } });
  assert.equal(badAction.ok, false);
  assert.match(badAction.ok ? '' : badAction.error, /Invalid request/);
  c.ws.close();
});

test('failed actions come back as a toast for the button', async () => {
  const c = connect(`localhost:${app.port}`);
  const init = await c.next('init');
  const pageId = init.deck.pages[0].id;
  const set = await c.request({
    t: 'op',
    op: { op: 'button.set', pageId, slot: '0-0', button: { tap: { type: 'obs.scene', scene: { name: 'Not A Scene' }, target: 'auto' } } },
  });
  assert.equal(set.ok, true);
  const buttonId = (set.ok && (set.data as { buttonId: string }).buttonId) || '';
  c.ws.send(JSON.stringify({ t: 'press', pageId, buttonId, which: 'tap' }));
  const toast = await c.next('toast');
  assert.equal(toast.buttonId, buttonId);
  assert.match(toast.text, /not found/);
  c.ws.close();
});

test('rotating the key disconnects other paired devices', async () => {
  const paired = connect('192.168.1.20:3325');
  await paired.next('hello');
  paired.ws.send(JSON.stringify({ t: 'auth', key: app.settingsStore.settings.accessKey }));
  await paired.next('init');

  const admin = connect(`localhost:${app.port}`);
  await admin.next('init');
  const res = await admin.request({ t: 'settings', action: 'rotateKey' });
  assert.equal(res.ok, true);
  assert.equal((await paired.next('authError')).reason, 'key-rotated');
  assert.equal(await paired.closed, 4001);
  admin.ws.close();
});

test('uploads need the key from LAN devices and are served with a locked-down CSP', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const boundary = '----vsdtest';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const headers = { host: '192.168.1.20:3325', 'content-type': `multipart/form-data; boundary=${boundary}` };

  const denied = await app.http.inject({ method: 'POST', url: '/api/uploads', headers, payload: body });
  assert.equal(denied.statusCode, 401);

  const ok = await app.http.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { ...headers, authorization: `Bearer ${app.settingsStore.settings.accessKey}` },
    payload: body,
  });
  assert.equal(ok.statusCode, 200);
  const { file } = ok.json() as { file: string };
  assert.match(file, /^[a-f0-9]{16}\.png$/);

  const served = await app.http.inject({ method: 'GET', url: `/uploads/${file}` });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.match(String(served.headers['content-security-policy']), /sandbox/);

  const notImage = await app.http.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { ...headers, authorization: `Bearer ${app.settingsStore.settings.accessKey}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.from('#!/bin/sh\necho hi\n'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  assert.equal(notImage.statusCode, 415);
});

test('a second start can tell the deck already runs (to open it in the browser instead)', async () => {
  assert.equal(await deckRunningOn(app.port), true);
  const other = createServer((_req, res) => res.end('not the deck')).listen(0, '127.0.0.1');
  await new Promise((resolve) => other.once('listening', resolve));
  try {
    assert.equal(await deckRunningOn((other.address() as AddressInfo).port), false, 'some other program on the port');
  } finally {
    other.close();
  }
  assert.equal(readEnv({ STREAMDECK_OPEN_BROWSER: '1' }).openBrowser, true);
  assert.equal(readEnv({}).openBrowser, false);
});

test('icons and health endpoints', async () => {
  const icon = await app.http.inject({ method: 'GET', url: '/icons/mdi/broadcast.svg' });
  assert.equal(icon.statusCode, 200);
  assert.match(icon.body, /^<svg/);
  assert.equal((await app.http.inject({ method: 'GET', url: '/icons/mdi/not-an-icon-xyz.svg' })).statusCode, 404);
  assert.equal((await app.http.inject({ method: 'GET', url: '/icons/evil/../x.svg' })).statusCode, 404);
  const health = await app.http.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.json().obs, 'connected');
});

test('changing the OBS address without a password drops the saved one', async () => {
  // This app's OBS connection comes from env vars, so exercise the rule on a second instance.
  const tmp = await tempDir();
  const second = await startApp({ ...readEnv({}), host: '127.0.0.1', port: 0, dataDir: tmp.dir, obsUrl: undefined, obsPassword: undefined });
  try {
    await second.settingsStore.update((s) => {
      s.obs.url = mock.url;
      s.obs.password = 'secret';
    });
    const ws = new WebSocket(`ws://127.0.0.1:${second.port}/ws`, { headers: { Host: `localhost:${second.port}` } });
    const messages: ServerMsg[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await waitFor(() => messages.some((m) => m.t === 'init'), 3000, 'init');
    const send = (msg: object) => ws.send(JSON.stringify(msg));
    const result = (reqId: number) =>
      waitFor(() => messages.find((m): m is Extract<ServerMsg, { t: 'result' }> => m.t === 'result' && m.reqId === reqId), 3000, 'result');

    send({ t: 'settings.obs', reqId: 1, url: mock.url }); // same address: password kept
    assert.equal((await result(1)).ok, true);
    assert.equal(second.settingsStore.settings.obs.password, 'secret');

    send({ t: 'settings.obs', reqId: 2, url: 'ws://192.0.2.10:4455' }); // new address, no password
    assert.equal((await result(2)).ok, true);
    assert.equal(second.settingsStore.settings.obs.password, '');
    ws.close();
  } finally {
    await second.close();
    await tmp.cleanup();
  }
});

test('webhook buttons call their URL when pressed', async () => {
  const hits: string[] = [];
  const hook = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
  try {
    const c = connect(`localhost:${app.port}`);
    const init = await c.next('init');
    const pageId = init.deck.pages[0].id;
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/api/webhook/deck`;
    const set = await c.request({ t: 'op', op: { op: 'button.set', pageId, slot: '0-1', button: { tap: { type: 'http.request', url } } } });
    assert.equal(set.ok, true);
    const buttonId = (set.ok && (set.data as { buttonId: string }).buttonId) || '';
    c.ws.send(JSON.stringify({ t: 'press', pageId, buttonId, which: 'tap' }));
    await waitFor(() => hits.length > 0, 3000, 'webhook call');
    assert.deepEqual(hits, ['POST /api/webhook/deck'], 'POST is the default method');
    c.ws.close();
  } finally {
    hook.close();
  }
});

test('a macro runs its steps on OBS in order', async () => {
  const c = connect(`localhost:${app.port}`);
  const init = await c.next('init');
  const pageId = init.deck.pages[0].id;
  const tap = {
    type: 'macro',
    steps: [{ action: { type: 'obs.scene', scene: { name: 'Just Chatting' }, target: 'program' } }, { delayMs: 50 }, { action: { type: 'obs.record', mode: 'start' } }],
  };
  const set = await c.request({ t: 'op', op: { op: 'button.set', pageId, slot: '0-2', button: { tap } } });
  assert.equal(set.ok, true);
  const buttonId = (set.ok && (set.data as { buttonId: string }).buttonId) || '';
  c.ws.send(JSON.stringify({ t: 'press', pageId, buttonId, which: 'tap' }));
  await waitFor(() => app.bridge.state.programScene === 'Just Chatting', 3000, 'scene switched');
  await waitFor(() => app.bridge.state.record.state === 'started', 3000, 'recording started');
  c.ws.close();
});

test('Run Command buttons are refused unless the server allows commands', async () => {
  const c = connect(`localhost:${app.port}`);
  const init = await c.next('init');
  assert.equal(init.info.commands, false, 'off by default, and the browser is told');
  const res = await c.request({
    t: 'op',
    op: { op: 'button.set', pageId: init.deck.pages[0].id, slot: '1-0', button: { tap: { type: 'system.command', command: 'id' } } },
  });
  assert.equal(res.ok, false);
  assert.match(res.ok ? '' : res.error, /turned off.*Settings/);
  c.ws.close();
});

test('only the PC itself can turn Run Command buttons on or off; every browser is told', async (t) => {
  t.after(() => app.settingsStore.update((s) => (s.commands = false)));
  const paired = connect('192.168.1.20:3325');
  await paired.next('hello');
  paired.ws.send(JSON.stringify({ t: 'auth', key: app.settingsStore.settings.accessKey }));
  const pairedInit = await paired.next('init');
  const pageId = pairedInit.deck.pages[0].id;

  const view = await paired.request({ t: 'settings', action: 'get' });
  assert.deepEqual(view.ok && (view.data as SettingsView).commands, { enabled: false, canChange: false });
  const refused = await paired.request({ t: 'settings.commands', enabled: true });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /PC itself/);
  assert.equal(app.settingsStore.settings.commands, false);

  const pc = connect(`localhost:${app.port}`);
  await pc.next('init');
  const from = paired.messages.length;
  const on = await pc.request({ t: 'settings.commands', enabled: true });
  assert.deepEqual(on.ok && (on.data as SettingsView).commands, { enabled: true, canChange: true });
  assert.equal(app.settingsStore.settings.commands, true, 'saved in settings.json');
  assert.equal((await paired.next('info', from)).info.commands, true, 'paired devices learn it at once');

  // Now a paired device may add one.
  const button = { tap: { type: 'system.command', command: process.platform === 'win32' ? 'ver' : 'true' } };
  const set = await paired.request({ t: 'op', op: { op: 'button.set', pageId, slot: '1-1', button } });
  assert.equal(set.ok, true);

  const off = await pc.request({ t: 'settings.commands', enabled: false });
  assert.equal(off.ok, true);
  assert.equal(app.settingsStore.settings.commands, false);
  const del = await pc.request({ t: 'op', op: { op: 'button.set', pageId, slot: '1-1', button: null } });
  assert.equal(del.ok, true, 'a command button can still be deleted while they are off');
  paired.ws.close();
  pc.ws.close();
});

test('stats tiles on screen get live CPU and memory readings', async () => {
  const c = connect(`localhost:${app.port}`);
  await c.next('init');
  c.ws.send(JSON.stringify({ t: 'stats', metrics: ['cpu', 'memory'] }));
  const msg = await waitFor(
    () => c.messages.findLast((m): m is Extract<ServerMsg, { t: 'ext' }> => m.t === 'ext' && typeof m.ext.stats.cpu === 'number'),
    4000,
    'a CPU reading',
  );
  assert.ok(msg.ext.stats.cpu! >= 0 && msg.ext.stats.cpu! <= 100);
  assert.ok(msg.ext.stats.memory!.used > 0 && msg.ext.stats.memory!.used < msg.ext.stats.memory!.total);
  c.ws.close();
  await waitFor(() => Object.keys(app.ext.state.stats).length === 0, 3000, 'readings stop when no one looks');
});

test('counters, toggles and timers live on the server; OBS text sources follow them', async () => {
  const c = connect(`localhost:${app.port}`);
  await c.next('init');
  const added = await c.request({ t: 'op', op: { op: 'page.add', name: 'Tools', rows: 2, cols: 5 } });
  assert.equal(added.ok, true);
  const pageId = ((added.ok && added.data) as { pageId: string }).pageId;
  const put = async (slot: string, button: Record<string, unknown>) => {
    const res = await c.request({ t: 'op', op: { op: 'button.set', pageId, slot, button } });
    assert.equal(res.ok, true, res.ok ? '' : res.error);
    return ((res.ok && res.data) as { buttonId: string }).buttonId;
  };
  const press = (buttonId: string, which = 'tap') => c.ws.send(JSON.stringify({ t: 'press', pageId, buttonId, which }));
  const text = (name: string) => mock.state.inputs.find((i) => i.name === name)!.settings.text;
  const ext = () => c.messages.findLast((m): m is Extract<ServerMsg, { t: 'ext' }> => m.t === 'ext')?.ext;

  const counter = await put('0-0', {
    tap: { type: 'counter', mode: 'add', textSource: { name: 'BRB Text' }, textFormat: 'Deaths: {n}' },
    longPress: { type: 'counter', mode: 'set' },
  });
  press(counter);
  press(counter);
  await waitFor(() => ext()?.counters[counter] === 2, 3000, 'the count in a broadcast');
  await waitFor(() => text('BRB Text') === 'Deaths: 2', 3000, 'the text source');
  press(counter, 'longPress');
  await waitFor(() => text('BRB Text') === 'Deaths: 0', 3000, 'reset');

  const toggle = await put('0-1', {
    tap: {
      type: 'toggle',
      on: { type: 'obs.text', input: { name: 'Countdown' }, text: 'Lights on' },
      off: { type: 'obs.text', input: { name: 'Countdown' }, text: 'Lights off' },
    },
  });
  press(toggle);
  await waitFor(() => text('Countdown') === 'Lights on' && ext()?.toggles[toggle] === true, 3000, 'toggled on');
  press(toggle);
  await waitFor(() => text('Countdown') === 'Lights off' && !ext()?.toggles[toggle], 3000, 'toggled off');

  const timer = await put('0-2', { tap: { type: 'timer', mode: 'toggle', durationSec: 90, textSource: { name: 'Countdown' }, textFormat: 'Back in {time}' } });
  await waitFor(() => text('Countdown') === 'Back in 1:30', 3000, 'a new timer shows its full time');
  press(timer);
  await waitFor(() => ext()?.timers[timer]?.startedAt !== undefined, 3000, 'running');

  const refresh = await put('0-3', { tap: { type: 'obs.browserRefresh', input: { name: 'Alerts' } } });
  press(refresh);
  await waitFor(() => mock.state.inputs.find((i) => i.name === 'Alerts')!.refreshes === 1, 3000, 'browser source refreshed');

  await app.states.flush();
  const saved = JSON.parse(await readFile(join(app.deckStore.path, '..', 'button-state.json'), 'utf8'));
  assert.equal(saved.counters[counter], 0);
  assert.equal(saved.timers[timer].elapsedMs, 0);
  c.ws.close();
});

test('undo and redo over the WebSocket, with the history sent to every browser', async () => {
  const c = connect(`localhost:${app.port}`);
  const init = await c.next('init');
  assert.equal(typeof init.history, 'object');
  const pageId = init.deck.pages[0].id;
  const set = await c.request({ t: 'op', op: { op: 'button.set', pageId, slot: '2-4', button: { label: 'Undo me' } } });
  assert.equal(set.ok, true);
  const from = c.messages.length;
  assert.equal((await c.request({ t: 'op', op: { op: 'deck.undo' } })).ok, true);
  const undone = await c.next('deck', from);
  assert.equal(undone.deck.pages[0].buttons['2-4']?.label, undefined);
  assert.equal(undone.history.redo, 'button change');
  assert.equal((await c.request({ t: 'op', op: { op: 'deck.redo' } })).ok, true);
  assert.equal(app.deckStore.deck.pages[0].buttons['2-4']?.label, 'Undo me');
  c.ws.close();
});

test('MP3 and WAV sounds can be uploaded and are served as audio', async () => {
  const wav = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'), Buffer.alloc(32)]);
  const boundary = '----vsdsound';
  const res = await app.http.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { host: `localhost:${app.port}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="horn.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  assert.equal(res.statusCode, 200);
  const { file } = res.json() as { file: string };
  assert.match(file, /^[a-f0-9]{16}\.wav$/);
  const served = await app.http.inject({ method: 'GET', url: `/uploads/${file}` });
  assert.equal(served.headers['content-type'], 'audio/wav');
  assert.equal((await app.http.inject({ method: 'GET', url: '/uploads/aaaaaaaaaaaaaaaa.ogg' })).statusCode, 404);
});

test('other programs can press buttons over HTTP with the access key', async () => {
  const c = connect(`localhost:${app.port}`);
  await c.next('init');
  const added = await c.request({ t: 'op', op: { op: 'page.add', name: 'API', rows: 1, cols: 4 } });
  const pageId = ((added.ok && added.data) as { pageId: string }).pageId;
  const put = async (slot: string, button: Record<string, unknown>) => {
    const res = await c.request({ t: 'op', op: { op: 'button.set', pageId, slot, button } });
    return ((res.ok && res.data) as { buttonId: string }).buttonId;
  };
  const counter = await put('0-0', { label: 'Wins', tap: { type: 'counter', mode: 'add' }, longPress: { type: 'counter', mode: 'set', value: 10 } });
  const ptt = await put('0-1', { tap: { type: 'obs.mute', input: { name: 'Mic/Aux' }, mode: 'pushToTalk' } });
  const broken = await put('0-2', { tap: { type: 'obs.scene', scene: { name: 'No Such Scene' }, target: 'auto' } });
  c.ws.close();

  const lan = { host: '192.168.1.20:3325' };
  const key = { ...lan, authorization: `Bearer ${app.settingsStore.settings.accessKey}` };
  const press = (id: string, headers: Record<string, string>, query = '') =>
    app.http.inject({ method: 'POST', url: `/api/buttons/${id}/press${query}`, headers });

  assert.equal((await press(counter, lan)).statusCode, 401, 'LAN callers need the key');
  assert.equal((await press(counter, { ...key, origin: 'http://evil.example' })).statusCode, 403, 'other websites are refused');
  const ok = await press(counter, { ...key, 'content-type': 'application/json' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(app.ext.state.counters[counter], 1);
  assert.equal((await press(counter, { host: `localhost:${app.port}` })).statusCode, 200, 'this PC needs no key');
  assert.equal((await press(counter, key, '?which=longPress')).statusCode, 200);
  assert.equal(app.ext.state.counters[counter], 10);

  assert.equal((await press('nope', key)).statusCode, 404);
  assert.match((await press(ptt, key)).json().error, /has to be held/);
  const failed = await press(broken, key);
  assert.equal(failed.statusCode, 422);
  assert.match(failed.json().error, /not found/);

  const list = await app.http.inject({ method: 'GET', url: '/api/buttons', headers: key });
  const wins = (list.json().buttons as { id: string; label: string; page: string; tap: string }[]).find((b) => b.id === counter);
  assert.deepEqual(wins && { label: wins.label, page: wins.page, tap: wins.tap }, { label: 'Wins', page: 'API', tap: 'counter' });
  assert.equal((await app.http.inject({ method: 'GET', url: '/api/buttons', headers: lan })).statusCode, 401);
});

test('live scene pictures go to the browsers that show them', async () => {
  const a = connect(`localhost:${app.port}`);
  await a.next('init');
  a.ws.send(JSON.stringify({ t: 'thumbs', scenes: ['BRB'] }));
  const first = await a.next('thumbs');
  assert.match(first.images.BRB, /^data:image\//);
  assert.deepEqual(Object.keys(first.images), ['BRB']);

  const b = connect(`localhost:${app.port}`);
  await b.next('init');
  const from = b.messages.length;
  b.ws.send(JSON.stringify({ t: 'thumbs', scenes: ['BRB'] }));
  assert.ok((await b.next('thumbs', from)).images.BRB, 'a picture taken already comes right away');
  a.ws.close();
  b.ws.close();
  await waitFor(() => Object.keys(app.thumbnails.images).length === 0, 3000, 'pictures stop when no one looks');
});
