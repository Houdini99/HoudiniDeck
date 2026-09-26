// System volume: the wpctl watcher, the executor and how the buttons look, without PipeWire.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionError } from '../server/actions/executor.ts';
import { systemExecutor, volumeArgs } from '../server/actions/system.ts';
import { ExtStore } from '../server/ext-store.ts';
import { silentLogger } from '../server/log.ts';
import { AudioWatcher, parseVolume } from '../server/system/audio.ts';
import type { Runner } from '../server/system/process.ts';
import { emptyExtState, type AudioState } from '../shared/ext-types.ts';
import { buttonVisual } from '../shared/feedback.ts';
import { emptyObsState } from '../shared/obs-types.ts';
import type { ActionOf, Button, Deck } from '../shared/schema.ts';
import { waitFor } from './helpers.ts';

type Volume = ActionOf<'system.volume'>;

function deckWith(...actions: Volume[]): Deck {
  const buttons = Object.fromEntries(actions.map((tap, i) => [`0-${i}`, { id: `b${i}`, tap }]));
  return { version: 1, revision: 0, homePageId: 'p', pages: [{ id: 'p', name: 'P', rows: 1, cols: 5, buttons }] };
}

/** A fake wpctl whose answers the test can change. */
function fakeWpctl() {
  const devices: Record<string, string> = { '@DEFAULT_AUDIO_SINK@': 'Volume: 0.45\n', '@DEFAULT_AUDIO_SOURCE@': 'Volume: 1.00 [MUTED]\n' };
  const calls: string[][] = [];
  let missing = false;
  const run: Runner = async (_cmd, args) => {
    calls.push(args);
    if (missing) throw Object.assign(new Error('spawn wpctl ENOENT'), { code: 'ENOENT' });
    const out = devices[args[1]];
    return out === undefined ? { code: 1, stdout: '', stderr: 'Object not found' } : { code: 0, stdout: out, stderr: '' };
  };
  return { devices, calls, run, setMissing: (m: boolean) => (missing = m) };
}

function setup(pollMs = 20) {
  const wpctl = fakeWpctl();
  const store = new ExtStore();
  let changes = 0;
  store.on('change', () => changes++);
  const watcher = new AudioWatcher({ store, run: wpctl.run, log: silentLogger, pollMs });
  return { wpctl, store, watcher, audio: () => store.state.audio, changes: () => changes };
}

const speakers: Volume = { type: 'system.volume', target: 'output', mode: 'toggleMute' };
const mic: Volume = { type: 'system.volume', target: 'input', mode: 'fader' };

test('parseVolume reads what wpctl prints', () => {
  assert.deepEqual(parseVolume('Volume: 0.45\n'), { volume: 0.45, muted: false });
  assert.deepEqual(parseVolume('Volume: 0.45 [MUTED]\n'), { volume: 0.45, muted: true });
  assert.deepEqual(parseVolume('Volume: 1.20'), { volume: 1.2, muted: false });
  assert.equal(parseVolume('Object not found'), null);
});

test('volumes are read only while a browser is connected and a button needs them', async (t) => {
  const { wpctl, watcher, audio, changes } = setup();
  t.after(() => watcher.stop());
  watcher.setActive(true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(wpctl.calls.length, 0, 'no System Volume buttons yet');

  watcher.setDeck(deckWith(speakers));
  await waitFor(() => audio().output, 1000, 'first read');
  assert.deepEqual(audio().output, { volume: 0.45, muted: false });
  assert.equal(audio().input, undefined, 'the mic is not on the deck');

  const before = changes();
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(changes(), before, 'unchanged volumes are not broadcast again');

  wpctl.devices['@DEFAULT_AUDIO_SINK@'] = 'Volume: 0.30 [MUTED]\n';
  await waitFor(() => audio().output?.muted, 1000, 'mute noticed');
  assert.equal(audio().output?.volume, 0.3);

  watcher.setDeck(deckWith(speakers, mic));
  await waitFor(() => audio().input, 1000, 'mic read');
  delete wpctl.devices['@DEFAULT_AUDIO_SOURCE@'];
  await waitFor(() => audio().input === null, 1000, 'mic gone');

  watcher.setActive(false);
  assert.equal(audio().output, undefined, 'nothing stale once no one is looking');
  const calls = wpctl.calls.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(wpctl.calls.length, calls, 'polling stopped');
});

test('a missing wpctl turns system volume off until the next browser connects', async (t) => {
  const { wpctl, watcher, audio } = setup();
  t.after(() => watcher.stop());
  wpctl.setMissing(true);
  watcher.setDeck(deckWith(speakers));
  watcher.setActive(true);
  await waitFor(() => !audio().available, 1000, 'unavailable');
  const calls = wpctl.calls.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(wpctl.calls.length, calls, 'no more tries');

  wpctl.setMissing(false);
  watcher.setActive(false);
  watcher.setActive(true);
  assert.equal(audio().available, true);
  await waitFor(() => audio().output, 1000, 'read again');
});

test('each mode becomes the right wpctl command', () => {
  const press = { kind: 'press' } as const;
  const args = (action: Partial<Volume>, phase: Parameters<typeof volumeArgs>[1] = press) => volumeArgs({ ...speakers, ...action }, phase);
  assert.deepEqual(args({}), ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']);
  assert.deepEqual(args({ mode: 'mute', target: 'input' }), ['set-mute', '@DEFAULT_AUDIO_SOURCE@', '1']);
  assert.deepEqual(args({ mode: 'unmute' }), ['set-mute', '@DEFAULT_AUDIO_SINK@', '0']);
  assert.deepEqual(args({ mode: 'step' }), ['set-volume', '--limit=1.0', '@DEFAULT_AUDIO_SINK@', '5%+']);
  assert.deepEqual(args({ mode: 'step', step: -10 }), ['set-volume', '@DEFAULT_AUDIO_SINK@', '10%-']);
  assert.deepEqual(args({ mode: 'fader' }), ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle'], 'tapping a fader mutes');
  assert.deepEqual(args({ mode: 'fader' }, { kind: 'fader', pos: 0.4567 }), ['set-volume', '@DEFAULT_AUDIO_SINK@', '0.457']);
  assert.deepEqual(args({ mode: 'fader' }, { kind: 'fader', pos: 1.5 }), ['set-volume', '@DEFAULT_AUDIO_SINK@', '1.000']);
});

test('the executor runs wpctl, re-reads the volume and explains failures', async () => {
  const calls: string[][] = [];
  let refreshed = 0;
  let answer = { code: 0, stdout: '', stderr: '' };
  const execute = systemExecutor({
    run: async (_cmd, args) => {
      calls.push(args);
      return answer;
    },
    audio: { refresh: async () => void refreshed++ },
    commandsEnabled: () => false,
  });
  await execute(speakers, { kind: 'press' });
  assert.deepEqual(calls, [['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']]);
  assert.equal(refreshed, 1);

  answer = { code: 1, stdout: '', stderr: 'Could not connect to PipeWire\n' };
  await assert.rejects(execute(speakers, { kind: 'press' }), (err: Error) => err instanceof ActionError && err.message === 'wpctl: Could not connect to PipeWire');

  const missing = systemExecutor({
    run: async () => {
      throw Object.assign(new Error('spawn wpctl ENOENT'), { code: 'ENOENT' });
    },
    audio: { refresh: async () => {} },
    commandsEnabled: () => false,
  });
  await assert.rejects(missing(speakers, { kind: 'press' }), /wpctl is not installed/);
});

test('system volume buttons: red while muted, faders show the percentage, dimmed without a device', () => {
  const deck = deckWith();
  const look = (tap: Volume, audio: AudioState) =>
    buttonVisual({ id: 'x', tap } as Button, { obs: emptyObsState('disconnected'), deck, ext: { ...emptyExtState(), audio }, now: 0 });

  const muted = look(speakers, { available: true, output: { volume: 0.5, muted: true } });
  assert.equal(muted.active, true);
  assert.deepEqual(muted.icon, { set: 'mdi', name: 'volume-off' });
  assert.equal(muted.offline, undefined, 'OBS being offline does not matter');

  const fader = look(mic, { available: true, input: { volume: 0.456, muted: false } });
  assert.deepEqual(fader.fader, { pos: 0.456, muted: false, text: '46%', mic: true });
  assert.equal(fader.label, 'Mic');
  assert.equal(look(mic, { available: true, input: { volume: 1.3, muted: false } }).fader?.pos, 1, 'amplified volumes pin the fader at the top');

  assert.equal(look(speakers, { available: true }).disabled, undefined, 'not read yet: not dimmed');
  assert.equal(look(speakers, { available: true, output: null }).disabled, true, 'no device');
  assert.equal(look(speakers, { available: false }).disabled, true, 'wpctl missing');
  assert.equal(look({ ...speakers, mode: 'step', step: -5 }, { available: true, output: { volume: 0.5, muted: true } }).active, false);
  assert.equal(look({ ...speakers, mode: 'step', step: -5 }, { available: true }).label, 'Speakers -5%');
});
