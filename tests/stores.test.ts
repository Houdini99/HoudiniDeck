import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { silentLogger } from '../server/log.ts';
import { DeckStore } from '../server/store/deck-store.ts';
import { SettingsStore } from '../server/store/settings-store.ts';
import { tempDir } from './helpers.ts';

test('DeckStore creates a default deck on first run', async (t) => {
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);
  const store = await DeckStore.load(dir, silentLogger);
  assert.equal(store.deck.pages.length, 1);
  assert.equal(store.deck.homePageId, store.deck.pages[0].id);
  const onDisk = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));
  assert.deepEqual(onDisk, store.deck);
});

test('DeckStore moves a corrupt deck.json aside instead of crashing', async (t) => {
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);
  await writeFile(join(dir, 'deck.json'), '{ this is not json');
  const store = await DeckStore.load(dir, silentLogger);
  assert.equal(store.deck.pages.length, 1);
  const files = await readdir(dir);
  assert.ok(files.some((f) => f.startsWith('deck.json.corrupt-')), 'broken file kept for inspection');
});

test('DeckStore moves a deck that fails validation aside', async (t) => {
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);
  await writeFile(join(dir, 'deck.json'), JSON.stringify({ version: 1, homePageId: 'x', pages: [] }));
  await DeckStore.load(dir, silentLogger);
  assert.ok((await readdir(dir)).some((f) => f.startsWith('deck.json.corrupt-')));
});

test('DeckStore.replace bumps the revision, persists and backs up', async (t) => {
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);
  const store = await DeckStore.load(dir, silentLogger);
  const next = structuredClone(store.deck);
  next.pages[0].name = 'Renamed';
  await store.replace(next, { backupReason: 'import' });
  assert.equal(store.deck.revision, 1);
  const reloaded = await DeckStore.load(dir, silentLogger);
  assert.equal(reloaded.deck.pages[0].name, 'Renamed');
  const backups = await readdir(join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^deck-.*-import\.json$/);
});

test('SettingsStore generates a key once, keeps it, and only the user can read the file', async (t) => {
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);
  const first = await SettingsStore.load(dir, silentLogger);
  assert.ok(first.settings.accessKey.length >= 40);
  assert.equal(first.settings.obs.url, 'ws://127.0.0.1:4455');
  if (process.platform === 'win32') {
    // Windows ignores file modes; the access list must name this user and nobody else.
    const acl = execFileSync('icacls', [first.path], { encoding: 'utf8' });
    assert.match(acl, new RegExp(`\\\\${process.env.USERNAME}:\\(F\\)`, 'i'));
    assert.equal(acl.split(/\r?\n/).filter((line) => /:\(/.test(line)).length, 1, `only one entry:\n${acl}`);
  } else {
    const mode = (await stat(first.path)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  const second = await SettingsStore.load(dir, silentLogger);
  assert.equal(second.settings.accessKey, first.settings.accessKey);
});

test('SettingsStore: environment overrides win and are reported', async (t) => {
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);
  const store = await SettingsStore.load(dir, silentLogger);
  await store.update((s) => (s.obs.password = 'saved'));
  assert.deepEqual(store.obsConfig({}), { url: 'ws://127.0.0.1:4455', password: 'saved', fromEnv: false });
  assert.deepEqual(store.obsConfig({ obsPassword: '' }), { url: 'ws://127.0.0.1:4455', password: '', fromEnv: true });
  assert.equal(store.obsConfig({ obsUrl: 'ws://pc:4455' }).url, 'ws://pc:4455');
});
