// Webhook buttons (http.request) against a local HTTP server.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { ActionError } from '../server/actions/executor.ts';
import { httpExecutor } from '../server/actions/http.ts';
import { silentLogger } from '../server/log.ts';
import { ActionSchema, type ActionOf } from '../shared/schema.ts';

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let base: string;
const received: Received[] = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url === '/hang') return; // never answers
      if (req.url === '/missing') return res.writeHead(404).end('nope');
      if (req.url === '/moved') return res.writeHead(302, { location: '/ok' }).end();
      if (req.url === '/to-file') return res.writeHead(302, { location: 'file:///etc/passwd' }).end();
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const run = httpExecutor(silentLogger);
const send = (action: Omit<ActionOf<'http.request'>, 'type'>) => run({ type: 'http.request', ...action }, { kind: 'press' });

/** Send a request and return what the server received. */
async function roundTrip(action: Omit<ActionOf<'http.request'>, 'type'>): Promise<Received> {
  const before = received.length;
  await send(action);
  assert.equal(received.length, before + 1, 'exactly one request arrived');
  return received[before];
}

test('sends the method, URL, headers and body; JSON bodies go out as application/json', async () => {
  const got = await roundTrip({
    method: 'POST',
    url: `${base}/api/webhook/lights?room=desk`,
    headers: { Authorization: 'Bearer abc', 'X-Deck': 'yes' },
    body: '{"on": true}',
  });
  assert.equal(got.method, 'POST');
  assert.equal(got.url, '/api/webhook/lights?room=desk');
  assert.equal(got.headers.authorization, 'Bearer abc');
  assert.equal(got.headers['x-deck'], 'yes');
  assert.equal(got.headers['content-type'], 'application/json');
  assert.equal(got.body, '{"on": true}');
});

test('an explicit Content-Type wins; other bodies go out as plain text', async () => {
  const explicit = await roundTrip({ method: 'PUT', url: `${base}/x`, headers: { 'content-type': 'text/csv' }, body: '[1, 2]' });
  assert.equal(explicit.headers['content-type'], 'text/csv');
  const text = await roundTrip({ method: 'POST', url: `${base}/x`, body: 'hello' });
  assert.match(String(text.headers['content-type']), /^text\/plain/);
});

test('GET requests never send a body', async () => {
  const got = await roundTrip({ method: 'GET', url: `${base}/x`, body: 'ignored' });
  assert.equal(got.method, 'GET');
  assert.equal(got.body, '');
});

test('a user and password in the URL become a Basic Authorization header', async () => {
  const got = await roundTrip({ method: 'POST', url: base.replace('http://', 'http://deck:s%3Acret@') + '/x' });
  assert.equal(got.headers.authorization, `Basic ${Buffer.from('deck:s:cret').toString('base64')}`);
  const stray = await roundTrip({ method: 'POST', url: base.replace('http://', 'http://deck:100%zz@') + '/x' });
  assert.equal(stray.headers.authorization, `Basic ${Buffer.from('deck:100%zz').toString('base64')}`);
});

test('a non-2xx answer fails with its status', async () => {
  await assert.rejects(
    send({ method: 'POST', url: `${base}/missing` }),
    (err: Error) => err instanceof ActionError && /127\.0\.0\.1:\d+ failed: 404 Not Found$/.test(err.message),
  );
});

test('redirects are followed to http(s) URLs only', async () => {
  const before = received.length;
  await send({ method: 'GET', url: `${base}/moved` });
  assert.deepEqual(
    received.slice(before).map((r) => r.url),
    ['/moved', '/ok'],
  );
  await assert.rejects(send({ method: 'GET', url: `${base}/to-file` }), ActionError);
});

test('a request that gets no answer times out', async () => {
  const started = Date.now();
  await assert.rejects(
    send({ method: 'POST', url: `${base}/hang`, timeoutMs: 500 }),
    (err: Error) => err instanceof ActionError && /no answer within 0\.5 s/.test(err.message),
  );
  assert.ok(Date.now() - started < 3000, 'gave up close to the timeout');
});

test('an unreachable service gets a readable message', async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(
    send({ method: 'POST', url: `http://127.0.0.1:${port}/x` }),
    (err: Error) => err instanceof ActionError && /connection refused/.test(err.message),
  );
});

test('the schema only accepts http(s) URLs and well-formed headers', () => {
  const parse = (fields: Record<string, unknown>) => ActionSchema.safeParse({ type: 'http.request', url: 'http://hass.local:8123/x', ...fields });
  const ok = parse({});
  assert.ok(ok.success);
  assert.equal(ok.data.type === 'http.request' && ok.data.method, 'POST', 'POST is the default method');
  for (const url of ['ftp://nas/x', 'file:///etc/passwd', 'javascript:alert(1)', 'hass.local/x', '']) {
    assert.equal(parse({ url }).success, false, url);
  }
  assert.equal(parse({ headers: { 'Bad Name': 'x' } }).success, false);
  assert.equal(parse({ headers: { 'X-Test': 'two\nlines' } }).success, false);
  assert.equal(parse({ headers: { 'X-Test': 'emoji 🎙️' } }).success, false);
  assert.equal(parse({ headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-${i}`, 'v'])) }).success, false);
  assert.equal(parse({ method: 'CONNECT' }).success, false);
  assert.equal(parse({ timeoutMs: 100 }).success, false);
});
