import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dispatcher } from '../server/actions/dispatch.ts';
import { ActionError } from '../server/actions/executor.ts';
import { createExecutors } from '../server/actions/registry.ts';
import { startMockObs, type MockObs } from '../server/dev/mock-obs.ts';
import { silentLogger } from '../server/log.ts';
import { ObsBridge } from '../server/obs/bridge.ts';
import { runProcess } from '../server/system/process.ts';
import type { Action, Deck } from '../shared/schema.ts';
import { memoryStates, tempDir, waitFor } from './helpers.ts';

// OBS actions don't touch these.
const others = {
  run: runProcess,
  media: { currentInstance: () => undefined },
  audio: { refresh: async () => {} },
  commandsEnabled: () => false,
  states: memoryStates(),
  timerTexts: { update: () => {} },
  sounds: { play: async () => {}, stopAll: () => {} },
};

async function connected(mock: MockObs, password = '') {
  const bridge = new ObsBridge({ url: mock.url, password, log: silentLogger });
  bridge.start();
  await waitFor(() => bridge.connected, 3000, 'OBS connection');
  return bridge;
}

test('bridge mirrors OBS state after connecting', async (t) => {
  const mock = await startMockObs();
  const bridge = await connected(mock);
  t.after(async () => {
    await bridge.stop();
    await mock.close();
  });
  const s = bridge.state;
  assert.deepEqual(s.scenes.map((x) => x.name), ['Starting Soon', 'Gameplay', 'Just Chatting', 'BRB']);
  assert.ok(s.scenes.every((x) => x.uuid));
  assert.equal(s.programScene, 'Gameplay');
  assert.deepEqual(s.sceneItems.Gameplay.map((i) => [i.source, i.enabled]), [
    ['Webcam', true],
    ['Game Capture', true],
    ['Alerts', false],
  ]);
  assert.equal(s.inputs['Mic/Aux'].audio, true);
  assert.equal(s.inputs['Mic/Aux'].volumeMul, 0.8);
  assert.equal(s.inputs.Webcam.audio, false);
  assert.equal(s.inputs.Music.muted, true);
  assert.deepEqual(s.filters['Mic/Aux'].map((f) => f.name), ['Noise Suppression', 'Compressor']);
  assert.equal(s.replayBuffer.available, true);
  assert.equal(s.collections.current, 'Main');
  assert.deepEqual(s.transitions, ['Fade', 'Cut', 'Stinger']);
});

test('actions go to OBS and the resulting events update the mirror', async (t) => {
  const mock = await startMockObs({ outputDelayMs: 20 });
  const bridge = await connected(mock);
  t.after(async () => {
    await bridge.stop();
    await mock.close();
  });
  const deck: Deck = {
    version: 1,
    revision: 0,
    homePageId: 'p',
    pages: [
      {
        id: 'p',
        name: 'P',
        rows: 3,
        cols: 5,
        buttons: {
          '0-0': { id: 'scene', tap: { type: 'obs.scene', scene: { name: 'BRB' }, target: 'auto' } },
          '0-1': { id: 'cam', tap: { type: 'obs.sceneItem', scene: { name: 'Gameplay' }, source: { name: 'Webcam' }, mode: 'toggle' } },
          '0-2': { id: 'rec', tap: { type: 'obs.record', mode: 'toggle' } },
          '0-3': { id: 'ptt', tap: { type: 'obs.mute', input: { name: 'Mic/Aux' }, mode: 'pushToTalk' } },
          '0-4': { id: 'fader', tap: { type: 'obs.volume', input: { name: 'Desktop Audio' } } },
          '1-0': { id: 'gone', tap: { type: 'obs.scene', scene: { name: 'Deleted Scene' }, target: 'auto' } },
          '1-1': { id: 'nav', tap: { type: 'deck.back' } },
        },
      },
    ],
  };
  const dispatcher = new Dispatcher({ executors: createExecutors({ bridge, screenshotDir: '/nonexistent', log: silentLogger, getDeck: () => deck, ...others }), getDeck: () => deck, log: silentLogger });

  await dispatcher.press('p', 'scene', 'tap');
  await waitFor(() => bridge.state.programScene === 'BRB', 2000, 'program scene change');

  await dispatcher.press('p', 'cam', 'tap');
  await waitFor(() => bridge.state.sceneItems.Gameplay[0].enabled === false, 2000, 'webcam hidden');

  await dispatcher.press('p', 'rec', 'tap');
  await waitFor(() => bridge.state.record.state === 'started', 2000, 'recording');

  // Push-to-talk: pressing unmutes, and a disconnecting client releases its hold (mutes again).
  await dispatcher.hold('client-1', 'p', 'ptt', true);
  await waitFor(() => bridge.state.inputs['Mic/Aux'].muted === false, 2000, 'mic unmuted');
  await dispatcher.releaseAll('client-1');
  await waitFor(() => bridge.state.inputs['Mic/Aux'].muted === true, 2000, 'mic muted on release');

  // Rapid fader moves collapse to the latest position.
  await Promise.all([0.1, 0.2, 0.3, 0.9].map((pos) => dispatcher.fader('p', 'fader', pos)));
  await waitFor(() => Math.abs((bridge.state.inputs['Desktop Audio'].volumeMul ?? 0) - 0.9 ** 3) < 1e-9, 2000, 'final fader value');

  await assert.rejects(dispatcher.press('p', 'gone', 'tap'), (err: Error) => err instanceof ActionError && /not found/.test(err.message));
  await assert.rejects(dispatcher.press('p', 'missing-button', 'tap'), ActionError);
  await dispatcher.press('p', 'nav', 'tap'); // navigation is a browser-side no-op
});

test('wrong password reports auth-failed; right password connects', async (t) => {
  const mock = await startMockObs({ password: 'hunter2' });
  t.after(() => mock.close());

  const bad = new ObsBridge({ url: mock.url, password: 'nope', log: silentLogger });
  bad.start();
  await waitFor(() => bad.state.connection === 'auth-failed', 3000, 'auth failure');
  assert.match(bad.state.error ?? '', /password/);
  await bad.stop();

  const good = await connected(mock, 'hunter2');
  await good.stop();
});

test('bridge reconnects when OBS comes back', async (t) => {
  let mock = await startMockObs();
  const port = mock.port;
  const bridge = await connected(mock);
  t.after(async () => {
    await bridge.stop();
    await mock.close();
  });

  await mock.close();
  await waitFor(() => bridge.state.connection === 'disconnected', 3000, 'disconnect');
  assert.equal(bridge.state.scenes.length, 0, 'stale state is cleared while offline');

  mock = await startMockObs({ port });
  await waitFor(() => bridge.connected, 6000, 'reconnect');
  assert.equal(bridge.state.scenes.length, 4);
});

test('an unreachable OBS gets a friendly message, not a raw socket error', async (t) => {
  const mock = await startMockObs();
  const url = mock.url;
  await mock.close(); // nothing listens on this port any more
  const bridge = new ObsBridge({ url, password: '', log: silentLogger });
  t.after(() => bridge.stop());
  bridge.start();
  await waitFor(() => bridge.state.connection === 'disconnected', 3000, 'disconnected state');
  assert.match(bridge.state.error ?? '', /Can't reach OBS at ws:\/\/127\.0\.0\.1:\d+/);
});

test('every OBS action type reaches OBS with the right request', async (t) => {
  const mock = await startMockObs({ outputDelayMs: 10 });
  const bridge = await connected(mock);
  const tmp = await tempDir();
  t.after(async () => {
    await bridge.stop();
    await mock.close();
    await tmp.cleanup();
  });
  const actions: Record<string, Action> = {
    filter: { type: 'obs.filter', source: { name: 'Mic/Aux' }, filter: 'Compressor', mode: 'toggle' },
    hide: { type: 'obs.sceneItem', scene: { name: 'Gameplay' }, source: { name: 'Webcam' }, mode: 'hide' },
    step: { type: 'obs.volumeStep', input: { name: 'Mic/Aux' }, db: -6 },
    replayOn: { type: 'obs.replay', mode: 'start' },
    replaySave: { type: 'obs.replay', mode: 'save' },
    vcam: { type: 'obs.virtualCam', mode: 'toggle' },
    studio: { type: 'obs.studioMode', mode: 'on' },
    preview: { type: 'obs.scene', scene: { name: 'BRB' }, target: 'auto' },
    cut: { type: 'obs.transition', transition: 'Cut', durationMs: 100 },
    hotkey: { type: 'obs.hotkey', name: 'OBSBasic.Screenshot' },
    collection: { type: 'obs.collection', name: 'Testing' },
    profile: { type: 'obs.profile', name: 'Recording Only' },
    media: { type: 'obs.media', input: { name: 'Music' }, action: 'playPause' },
    shot: { type: 'obs.screenshot' },
  };
  const deck: Deck = {
    version: 1,
    revision: 0,
    homePageId: 'p',
    pages: [
      {
        id: 'p',
        name: 'P',
        rows: 3,
        cols: 5,
        buttons: Object.fromEntries(Object.entries(actions).map(([id, tap], i) => [`${Math.floor(i / 5)}-${i % 5}`, { id, tap }])),
      },
    ],
  };
  const dispatcher = new Dispatcher({ executors: createExecutors({ bridge, screenshotDir: tmp.dir, log: silentLogger, getDeck: () => deck, ...others }), getDeck: () => deck, log: silentLogger });
  const press = (id: string) => dispatcher.press('p', id, 'tap');
  const s = () => bridge.state;

  await press('filter');
  await waitFor(() => s().filters['Mic/Aux'][1].enabled, 2000, 'compressor enabled');
  await press('hide');
  await waitFor(() => !s().sceneItems.Gameplay[0].enabled, 2000, 'webcam hidden');
  await press('step');
  await waitFor(() => Math.abs((s().inputs['Mic/Aux'].volumeDb ?? 0) - (20 * Math.log10(0.8) - 6)) < 1e-6, 2000, 'volume -6 dB');
  await press('replayOn');
  await waitFor(() => s().replayBuffer.active, 2000, 'replay buffer on');
  await press('replaySave');
  await press('vcam');
  await waitFor(() => s().virtualCam.active, 2000, 'virtual cam on');
  await press('studio');
  await waitFor(() => s().studioMode, 2000, 'studio mode on');
  await press('preview');
  await waitFor(() => s().previewScene === 'BRB' && s().programScene === 'Gameplay', 2000, 'BRB in preview');
  await press('cut');
  await waitFor(() => s().programScene === 'BRB' && s().currentTransition === 'Cut', 2000, 'transitioned with Cut');
  await press('hotkey');
  await press('profile');
  await waitFor(() => s().profiles.current === 'Recording Only', 2000, 'profile switched');
  await press('media');
  await press('shot');
  await press('collection');
  await waitFor(() => s().collections.current === 'Testing', 2000, 'collection switched');

  const sent = mock.state.log.map((r) => r.requestType);
  for (const request of ['TriggerHotkeyByName', 'SaveReplayBuffer', 'SetCurrentSceneTransitionDuration', 'TriggerMediaInputAction', 'SaveSourceScreenshot']) {
    assert.ok(sent.includes(request), `${request} was sent`);
  }
  const shot = mock.state.log.find((r) => r.requestType === 'SaveSourceScreenshot')!.requestData;
  assert.equal(shot.sourceName, 'BRB', 'screenshot defaults to the program scene');
  assert.ok(String(shot.imageFilePath).startsWith(tmp.dir));
  assert.equal(mock.state.log.find((r) => r.requestType === 'TriggerMediaInputAction')!.requestData.mediaAction, 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY');
});
