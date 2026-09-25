// The real helper (server/system/windows/helper.ps1) in Windows PowerShell: it compiles, answers, and
// copes with what a PC may not have (speakers, media players, a desktop to type into). Windows only.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ActionError } from '../server/actions/executor.ts';
import { silentLogger } from '../server/log.ts';
import { WinHelper, type WinMediaState } from '../server/system/windows/helper.ts';
import { windowsKeyEvents } from '../server/system/windows/keys.ts';
import type { AudioDevice } from '../shared/ext-types.ts';
import { tempDir } from './helpers.ts';

/** A WAV file with a quarter second of silence (8 kHz, 8 bit, mono). */
function silentWav(): Buffer {
  const samples = 2000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + samples, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); // format chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24); // sample rate
  header.writeUInt32LE(8000, 28); // bytes per second
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 0x80)]);
}

const skip = process.platform !== 'win32' && 'needs Windows';

test('the Windows helper starts and answers every kind of request', { skip, timeout: 120_000 }, async (t) => {
  const helper = new WinHelper({ log: silentLogger });
  t.after(() => helper.stop());
  assert.deepEqual(await helper.request('ping'), { pong: true });

  // Text beyond ASCII survives both ways (the error echoes the request's name).
  await assert.rejects(helper.request('Motörhead–ü'), (err: Error) => err instanceof ActionError && err.message === 'Unknown request: Motörhead–ü');

  // A PC without speakers (like a CI machine) answers null instead of failing.
  for (const target of ['output', 'input']) {
    const device = await helper.request<AudioDevice | null>('volume.get', { target });
    if (device !== null) {
      assert.ok(device.volume >= 0 && device.volume <= 1, `volume ${device.volume}`);
      assert.equal(typeof device.muted, 'boolean');
    }
  }

  // Windows Server (e.g. a CI machine) may not have the media API; Windows 10/11 do.
  try {
    const media = await helper.request<WinMediaState>('media.state');
    assert.ok(Array.isArray(media.sessions), JSON.stringify(media));
  } catch (err) {
    assert.ok(err instanceof ActionError, String(err));
    t.diagnostic(`media API: ${err.message}`);
  }

  // Shift alone changes nothing. Without a desktop session Windows may refuse; then it must say so.
  try {
    await helper.request('keys', { events: windowsKeyEvents(['KEY_RIGHTSHIFT']) });
  } catch (err) {
    assert.ok(err instanceof ActionError, String(err));
    t.diagnostic(`SendInput refused: ${err.message}`);
  }

  // Typing nothing sends nothing, but reaches the C# that types.
  assert.equal(await helper.request('text', { text: '', enter: false }), null);

  // Sounds: a PC without speakers (like a CI machine) may refuse to open one; then it must say so.
  const tmp = await tempDir();
  t.after(tmp.cleanup);
  const wav = join(tmp.dir, 'silence.wav');
  await writeFile(wav, silentWav());
  try {
    const { lengthMs } = await helper.request<{ lengthMs: number }>('sound.play', { alias: 'hdtest1', path: wav, volume: 0 });
    assert.ok(lengthMs >= 0 && lengthMs < 5000, `length ${lengthMs}`);
    assert.equal(typeof (await helper.request('sound.playing', { alias: 'hdtest1' })), 'boolean');
    t.diagnostic(`sound: ${lengthMs} ms`);
  } catch (err) {
    assert.ok(err instanceof ActionError, String(err));
    t.diagnostic(`MCI refused the sound: ${err.message}`);
  }
  assert.equal(await helper.request('sound.close', { alias: 'hdtest1' }), null);
  assert.equal(await helper.request('sound.playing', { alias: 'hdtest1' }), false, 'closed');
  await assert.rejects(helper.request('sound.play', { alias: 'bad alias', path: wav, volume: 0 }), /Bad sound name/);
  await assert.rejects(helper.request('sound.play', { alias: 'hdtest2', path: join(tmp.dir, 'nope.wav'), volume: 0 }), /Sound file not found/);

  const updates: WinMediaState[] = [];
  helper.on('media', (state) => updates.push(state));
  helper.setMediaWatch(true);
  const until = Date.now() + 15_000;
  while (updates.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  assert.equal(updates.length, 1, 'a first media update while watching');
  assert.ok(Array.isArray(updates[0].sessions) || updates[0].error, JSON.stringify(updates[0]));
  t.diagnostic(`media: ${JSON.stringify(updates[0])}`);
});
