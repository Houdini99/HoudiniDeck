// Play Sound buttons: the player programs (stand-ins made with node), the Windows helper's side, and
// the SoundPlayer's toggle / restart / overlap behavior and "playing" state.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { soundExecutor } from '../server/actions/sound.ts';
import { ActionError } from '../server/actions/executor.ts';
import { ExtStore } from '../server/ext-store.ts';
import { silentLogger } from '../server/log.ts';
import {
  LINUX_SOUND_PROGRAMS,
  SoundPlayer,
  programSoundBackend,
  windowsSoundBackend,
  type Playback,
  type SoundBackend,
  type SoundProgram,
} from '../server/system/sound.ts';
import type { WinRequester } from '../server/system/windows/helper.ts';
import { sniffSound } from '../server/uploads.ts';
import type { ActionOf } from '../shared/schema.ts';
import { tempDir, waitFor } from './helpers.ts';

const node = (script: string): SoundProgram => ({ cmd: process.execPath, args: () => ['-e', script] });
const missing: SoundProgram = { cmd: 'no-such-player-for-the-deck', args: () => [] };

test('the first installed player is used; one that fails right away reports why', async () => {
  const backend = programSoundBackend([missing, node('setTimeout(() => {}, 700)')]);
  let ended = 0;
  const started = Date.now();
  await backend.start('/x.mp3', 1, () => void ended++);
  assert.ok(Date.now() - started < 1500, 'resolves once it plays, not when it ends');
  assert.equal(ended, 0);
  await waitFor(() => ended === 1, 3000, 'the end of the sound');

  const stopped = programSoundBackend([node('setTimeout(() => {}, 30000)')]);
  let stoppedEnd = 0;
  const playback = await stopped.start('/x.mp3', 1, () => void stoppedEnd++);
  playback.stop();
  await waitFor(() => stoppedEnd === 1, 3000, 'the end after stop()');

  const failing = programSoundBackend([node('console.error("sndfile: unsupported format"); process.exit(1)')]);
  await assert.rejects(
    failing.start('/x.mp3', 1, () => {}),
    (err: Error) => err instanceof ActionError && /couldn’t play it: sndfile: unsupported format/.test(err.message),
  );

  const none = programSoundBackend([missing]);
  await assert.rejects(none.start('/x.mp3', 1, () => {}), /No sound player found/);
});

test('player arguments: the file as its own argument and the volume in each program’s scale', () => {
  const args = Object.fromEntries(LINUX_SOUND_PROGRAMS.map((p) => [p.cmd, p.args('/data/uploads/a.mp3', 0.5)]));
  assert.deepEqual(args['pw-play'], ['--volume=0.50', '/data/uploads/a.mp3']);
  assert.deepEqual(args.paplay, ['--volume=32768', '/data/uploads/a.mp3']);
  assert.deepEqual(args.ffplay, ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', '50', '/data/uploads/a.mp3']);
});

/** A backend whose sounds play until the test ends them. */
function fakeBackend() {
  const sounds: { file: string; volume: number; end: () => void; stopped: boolean }[] = [];
  const backend: SoundBackend = {
    async start(file, volume, onEnd) {
      const sound = { file, volume, end: onEnd, stopped: false };
      sounds.push(sound);
      const playback: Playback = {
        stop: () => {
          sound.stopped = true;
          onEnd();
        },
      };
      return playback;
    },
  };
  return { backend, sounds };
}

async function setup() {
  const tmp = await tempDir();
  await writeFile(join(tmp.dir, 'aaaaaaaaaaaaaaaa.mp3'), 'ID3');
  const store = new ExtStore();
  const { backend, sounds } = fakeBackend();
  const player = new SoundPlayer({ store, backend, dir: tmp.dir, log: silentLogger });
  return { tmp, store, player, sounds };
}

const airhorn = (mode: ActionOf<'sound.play'>['mode'], volume?: number): ActionOf<'sound.play'> => ({
  type: 'sound.play',
  sound: 'aaaaaaaaaaaaaaaa.mp3',
  name: 'airhorn.mp3',
  mode,
  volume,
});

test('toggle: a second press stops the sound; the button shows it plays', async (t) => {
  const { tmp, store, player, sounds } = await setup();
  t.after(tmp.cleanup);
  await player.play('b1', airhorn('toggle', 40));
  assert.deepEqual(store.state.sounds, ['b1/aaaaaaaaaaaaaaaa.mp3']);
  assert.equal(sounds[0].volume, 0.4);
  assert.equal(sounds[0].file, join(tmp.dir, 'aaaaaaaaaaaaaaaa.mp3'));
  await player.play('b1', airhorn('toggle'));
  assert.equal(sounds[0].stopped, true);
  assert.equal(sounds.length, 1, 'stopping doesn’t start it again');
  assert.deepEqual(store.state.sounds, []);

  await player.play('b1', airhorn('toggle'));
  sounds[1].end(); // it played to the end
  assert.deepEqual(store.state.sounds, []);
});

test('restart starts it over; overlap plays it again on top; Stop All stops everything', async (t) => {
  const { tmp, store, player, sounds } = await setup();
  t.after(tmp.cleanup);
  await player.play('r', airhorn('restart'));
  await player.play('r', airhorn('restart'));
  assert.deepEqual(
    sounds.map((s) => s.stopped),
    [true, false],
  );
  await player.play('o', airhorn('overlap'));
  await player.play('o', airhorn('overlap'));
  assert.equal(sounds.filter((s) => !s.stopped).length, 3);
  assert.deepEqual(store.state.sounds.sort(), ['o/aaaaaaaaaaaaaaaa.mp3', 'r/aaaaaaaaaaaaaaaa.mp3']);
  sounds[2].end();
  assert.equal(store.state.sounds.length, 2, 'the other copy still plays');

  const execute = soundExecutor(player);
  await execute({ type: 'sound.stop' }, { kind: 'press' });
  assert.equal(sounds.filter((s) => !s.stopped && s !== sounds[2]).length, 0);
  assert.deepEqual(store.state.sounds, []);
});

test('a sound whose file is gone, or that fails to start, says so and doesn’t show as playing', async (t) => {
  const { tmp, store } = await setup();
  t.after(tmp.cleanup);
  const failing: SoundBackend = { start: async () => Promise.reject(new ActionError('pw-play couldn’t play it: bad file')) };
  const player = new SoundPlayer({ store, backend: failing, dir: tmp.dir, log: silentLogger });
  await assert.rejects(player.play('b', airhorn('toggle')), /bad file/);
  assert.deepEqual(store.state.sounds, []);
  await assert.rejects(player.play('b', { ...airhorn('toggle'), sound: 'bbbbbbbbbbbbbbbb.wav' }), /sound file is gone/);
});

test('on Windows the helper plays the sound; the deck closes it after its length, or once it stopped playing', async () => {
  const requests: { op: string; args: Record<string, unknown> }[] = [];
  let playing = true;
  const helper: WinRequester = {
    async request<T>(op: string, args: Record<string, unknown> = {}) {
      requests.push({ op, args });
      if (op === 'sound.play') return { lengthMs: args.path === 'C:\\short.wav' ? 50 : 0 } as T;
      if (op === 'sound.playing') return playing as T;
      return null as T;
    },
  };
  const backend = windowsSoundBackend(helper, 20);
  let ends = 0;
  await backend.start('C:\\short.wav', 0.8, () => void ends++);
  assert.deepEqual(requests[0], { op: 'sound.play', args: { alias: 'hd1', path: 'C:\\short.wav', volume: 800 } });
  await waitFor(() => ends === 1, 2000, 'the end after its length');
  assert.deepEqual(requests.at(-1), { op: 'sound.close', args: { alias: 'hd1' } });

  await backend.start('C:\\unknown-length.mp3', 1, () => void ends++);
  await waitFor(() => requests.filter((r) => r.op === 'sound.playing').length >= 2, 2000, 'polling');
  playing = false;
  await waitFor(() => ends === 2, 2000, 'the end once it stopped playing');
  assert.deepEqual(requests.at(-1), { op: 'sound.close', args: { alias: 'hd2' } });

  const stoppable = await backend.start('C:\\short.wav', 1, () => void ends++);
  stoppable.stop();
  stoppable.stop();
  assert.equal(ends, 3, 'stop ends it once');
});

test('uploads recognize MP3 and WAV by their bytes', () => {
  assert.equal(sniffSound(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1')), 'mp3');
  assert.equal(sniffSound(Buffer.from([0xff, 0xfb, 0x90, 0x64])), 'mp3', 'a bare MPEG-1 layer III frame');
  assert.equal(sniffSound(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1')), 'wav');
  assert.equal(sniffSound(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1')), undefined, 'a WebP image is RIFF too');
  assert.equal(sniffSound(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), undefined, 'a JPEG');
  assert.equal(sniffSound(Buffer.from('OggS')), undefined);
});
