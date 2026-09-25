// Media keys: the playerctl watcher, the executor and the cover-art route, without real players.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { ActionError } from '../server/actions/executor.ts';
import { mediaExecutor } from '../server/actions/media.ts';
import { ExtStore } from '../server/ext-store.ts';
import { silentLogger } from '../server/log.ts';
import { MediaWatcher, parsePlayerLine, registerMediaRoutes } from '../server/system/media.ts';
import type { LineHandlers, RunResult, Runner, Spawner } from '../server/system/process.ts';
import type { ActionOf, Deck } from '../shared/schema.ts';
import { tempDir, waitFor } from './helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

interface FakeProc {
  args: string[];
  on: LineHandlers;
  killed: boolean;
}

function setup(opts: { run?: Runner } = {}) {
  const procs: FakeProc[] = [];
  const spawn: Spawner = (_cmd, args, on) => {
    const proc = { args, on, killed: false };
    procs.push(proc);
    return { kill: () => (proc.killed = true) };
  };
  const store = new ExtStore();
  const run = opts.run ?? (async () => ({ code: 0, stdout: '', stderr: '' }));
  const watcher = new MediaWatcher({ store, spawn, run, log: silentLogger, restartDelaysMs: [5] });
  const live = () => procs.filter((p) => !p.killed);
  return { procs, live, store, watcher, media: () => store.state.media };
}

function deckWith(...players: string[]): Deck {
  const buttons = Object.fromEntries(
    players.map((player, i) => [`0-${i}`, { id: `b${i}`, tap: { type: 'media.player' as const, command: 'playPause' as const, player } }]),
  );
  return { version: 1, revision: 0, homePageId: 'p', pages: [{ id: 'p', name: 'P', rows: 1, cols: 5, buttons }] };
}

const line = (instance: string, status: string, title: string, art = '') => `${instance}\t${status}\tAn Artist\t${title}\t${art}`;

test('playerctl only runs while a browser is connected', () => {
  const { procs, live, watcher, media } = setup();
  watcher.setDeck(deckWith());
  assert.equal(procs.length, 0);
  watcher.setActive(true);
  assert.equal(live().length, 1);
  assert.deepEqual(live()[0].args.slice(0, 3), ['--follow', 'metadata', '--format']);
  live()[0].on.line(line('spotify', 'Playing', 'Song'));
  assert.equal(media().players['']?.title, 'Song');
  watcher.setActive(false);
  assert.equal(live().length, 0, 'stopped when the last browser left');
  assert.deepEqual(media().players, {});
});

test('lines become player state; https art is passed on, local art gets a token', () => {
  const { live, watcher, media } = setup();
  const cover = join(tmpdir(), 'firefox-mpris', '7_1.png');
  const coverUrl = pathToFileURL(cover).href;
  watcher.setActive(true);
  const out = live()[0].on;

  out.line(line('spotify', 'Playing', 'One', 'https://i.scdn.co/image/abc'));
  assert.deepEqual(media().players[''], { instance: 'spotify', status: 'Playing', artist: 'An Artist', title: 'One', art: 'https://i.scdn.co/image/abc' });
  assert.equal(watcher.currentInstance(), 'spotify');

  out.line(line('firefox.instance_7', 'Playing', 'Video', coverUrl));
  const art = media().players['']!.art!;
  const token = art.replace('/api/media/art/', '');
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(watcher.artFile(token), cover);
  assert.equal(watcher.currentInstance(), 'firefox.instance_7');

  out.line(line('firefox.instance_7', 'Paused', 'Video', coverUrl));
  assert.equal(media().players['']!.art, art, 'pausing keeps the same picture');

  out.line(line('firefox.instance_7', 'Playing', 'Next video', coverUrl));
  assert.notEqual(media().players['']!.art, art, 'a new track gets a new token even for the same file');
  assert.equal(watcher.artFile(token), undefined, 'the old token is gone');

  out.line(line('vlc', 'Playing', 'Clip', 'http://example.com/a.png'));
  assert.equal(media().players['']!.art, undefined, 'plain http art is not used');

  out.line('');
  assert.equal(media().players[''], null, 'an empty line means no player');
  assert.equal(watcher.currentInstance(), undefined);
});

test('buttons that name a player get a follower of their own', () => {
  const { live, watcher, media } = setup();
  watcher.setDeck(deckWith('spotify'));
  watcher.setActive(true);
  assert.deepEqual(
    live().map((p) => p.args[0]),
    ['--follow', '--player=spotify'],
  );
  live()[1].on.line(line('spotify', 'Paused', 'Song'));
  assert.equal(media().players.spotify?.status, 'Paused');
  watcher.setDeck(deckWith());
  assert.equal(live().length, 1, 'no button needs it any more');
  assert.equal('spotify' in media().players, false);
});

test('a follower that stops is restarted; a missing playerctl turns media off until next time', async () => {
  const { procs, live, watcher, media } = setup();
  watcher.setActive(true);
  live()[0].on.line(line('spotify', 'Playing', 'Song'));
  procs[0].on.exit(1, undefined, 'Connection to the bus was lost');
  assert.equal(media().players[''], null, 'no stale song while restarting');
  await waitFor(() => procs.length === 2, 1000, 'restart');

  procs[1].on.exit(null, Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' }));
  assert.equal(media().available, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(procs.length, 2, 'no restarts while playerctl is missing');

  watcher.setActive(false);
  watcher.setActive(true); // e.g. the next time a tablet connects
  assert.equal(media().available, true);
  assert.equal(procs.length, 3);
});

test('parsePlayerLine handles tabs in titles, odd statuses and junk', () => {
  assert.deepEqual(parsePlayerLine('vlc\tPlaying\tArtist\tA\tB\tfile:///x.png'), {
    instance: 'vlc',
    status: 'Playing',
    artist: 'Artist',
    title: 'A\tB',
    artUrl: 'file:///x.png',
  });
  assert.equal(parsePlayerLine('mpv\tBuffering\t\tT\t')?.status, 'Stopped');
  assert.equal(parsePlayerLine('garbage'), null);
  assert.equal(parsePlayerLine(''), null);
});

test('listPlayers reports player names without their instance suffix', async () => {
  const run: Runner = async () => ({ code: 0, stdout: 'spotify\nfirefox.instance_12\nfirefox.instance_34\n', stderr: '' });
  const { watcher } = setup({ run });
  assert.deepEqual(await watcher.listPlayers(), ['spotify', 'firefox']);
  const missing: Runner = async () => {
    throw Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' });
  };
  assert.deepEqual(await setup({ run: missing }).watcher.listPlayers(), []);
});

test('media keys go to the player the buttons show, or the one they name', async () => {
  const calls: string[][] = [];
  let answer: RunResult = { code: 0, stdout: '', stderr: '' };
  const run: Runner = async (_cmd, args) => {
    calls.push(args);
    return answer;
  };
  let current: string | undefined;
  const execute = mediaExecutor(run, { currentInstance: () => current });
  const press = (action: Omit<ActionOf<'media.player'>, 'type'>) => execute({ type: 'media.player', ...action }, { kind: 'press' });

  await press({ command: 'playPause' });
  current = 'firefox.instance_7';
  await press({ command: 'playPause' });
  await press({ command: 'next', player: 'spotify' });
  assert.deepEqual(calls, [['play-pause'], ['--player=firefox.instance_7', 'play-pause'], ['--player=spotify', 'next']]);

  answer = { code: 1, stdout: '', stderr: 'No players found\n' };
  await assert.rejects(press({ command: 'stop' }), (err: Error) => err instanceof ActionError && err.message === 'No media player is running');
  await assert.rejects(press({ command: 'stop', player: 'spotify' }), /“spotify” is not running/);

  const missing = mediaExecutor(
    async () => {
      throw Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' });
    },
    { currentInstance: () => undefined },
  );
  await assert.rejects(missing({ type: 'media.player', command: 'playPause' }, { kind: 'press' }), /playerctl is not installed/);
});

test('cover art is served only for current tokens, and only if it is an image', async (t) => {
  const tmp = await tempDir();
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await tmp.cleanup();
  });
  const png = join(tmp.dir, 'cover.png');
  const text = join(tmp.dir, 'secret.txt');
  await writeFile(png, PNG);
  await writeFile(text, 'not an image');
  const files: Record<string, string> = { ['a'.repeat(32)]: png, ['b'.repeat(32)]: text };
  registerMediaRoutes(app, { artFile: (token) => files[token] });

  const ok = await app.inject({ method: 'GET', url: `/api/media/art/${'a'.repeat(32)}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal((await app.inject({ method: 'GET', url: `/api/media/art/${'b'.repeat(32)}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/media/art/${'c'.repeat(32)}` })).statusCode, 404);
});
