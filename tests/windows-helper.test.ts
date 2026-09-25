// The real helper (server/system/windows/helper.ps1) in Windows PowerShell: it compiles, answers, and
// copes with what a PC may not have (speakers, media players, a desktop to type into). Windows only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionError } from '../server/actions/executor.ts';
import { silentLogger } from '../server/log.ts';
import { WinHelper, type WinMediaState } from '../server/system/windows/helper.ts';
import { windowsKeyEvents } from '../server/system/windows/keys.ts';
import type { AudioDevice } from '../shared/ext-types.ts';

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

  const updates: WinMediaState[] = [];
  helper.on('media', (state) => updates.push(state));
  helper.setMediaWatch(true);
  const until = Date.now() + 15_000;
  while (updates.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  assert.equal(updates.length, 1, 'a first media update while watching');
  assert.ok(Array.isArray(updates[0].sessions) || updates[0].error, JSON.stringify(updates[0]));
  t.diagnostic(`media: ${JSON.stringify(updates[0])}`);
});
