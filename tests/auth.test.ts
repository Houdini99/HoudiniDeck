import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearerKey, isLoopbackAddress, isTrustedLocal, keyMatches, originAllowed } from '../server/auth.ts';

test('loopback addresses', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopbackAddress(a), a);
  for (const a of ['192.168.1.20', '::ffff:192.168.1.20', '10.8.0.2', undefined]) assert.ok(!isLoopbackAddress(a), String(a));
});

test('only loopback + localhost Host counts as the PC itself', () => {
  assert.ok(isTrustedLocal('127.0.0.1', 'localhost:3325'));
  assert.ok(isTrustedLocal('::1', '[::1]:3325'));
  assert.ok(isTrustedLocal('127.0.0.1', '127.0.0.1:5173'));
  // A LAN device reaching the Vite dev proxy shows up as loopback but keeps its own Host header.
  assert.ok(!isTrustedLocal('127.0.0.1', '192.168.1.20:5173'));
  // DNS rebinding: attacker page resolved to 127.0.0.1 still sends its own hostname.
  assert.ok(!isTrustedLocal('127.0.0.1', 'evil.example:3325'));
  assert.ok(!isTrustedLocal('192.168.1.40', 'localhost:3325'));
});

test('Origin must match Host when present', () => {
  assert.ok(originAllowed(undefined, 'localhost:3325'), 'non-browser clients have no Origin');
  assert.ok(originAllowed('http://192.168.1.20:3325', '192.168.1.20:3325'));
  assert.ok(originAllowed('http://Deck.local:3325', 'deck.local:3325'));
  assert.ok(!originAllowed('http://evil.example', 'localhost:3325'));
  assert.ok(!originAllowed('http://localhost:5173', 'localhost:3325'));
  assert.ok(!originAllowed('null', 'localhost:3325'));
  assert.ok(!originAllowed('http://localhost:3325', undefined));
});

test('key comparison and bearer parsing', () => {
  assert.ok(keyMatches('abc', 'abc'));
  assert.ok(!keyMatches('abd', 'abc'));
  assert.ok(!keyMatches('ab', 'abc'));
  assert.ok(!keyMatches(undefined, 'abc'));
  assert.equal(bearerKey('Bearer xyz-123'), 'xyz-123');
  assert.equal(bearerKey('bearer   xyz'), 'xyz');
  assert.equal(bearerKey('Basic xyz'), undefined);
  assert.equal(bearerKey(undefined), undefined);
});
