import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObsStateStore, applyEvent, applyOutputState, sortScenes } from '../server/obs/state.ts';
import { emptyObsState, type ObsState } from '../shared/obs-types.ts';

function state(): ObsState {
  const s = emptyObsState('connected');
  s.scenes = [{ name: 'Game', uuid: 'u-game' }, { name: 'Chat', uuid: 'u-chat' }];
  s.programScene = 'Game';
  s.sceneItems = { Game: [{ id: 1, source: 'Cam', enabled: true, isGroup: false }], Chat: [{ id: 2, source: 'Cam', enabled: false, isGroup: false }] };
  s.inputs = { Mic: { name: 'Mic', kind: 'pulse', audio: true, muted: false, volumeMul: 1 }, Cam: { name: 'Cam', kind: 'v4l2', audio: false } };
  s.filters = { Mic: [{ name: 'Gate', enabled: true }], Game: [] };
  return s;
}

test('scene list is shown in OBS UI order (highest index on top)', () => {
  const scenes = sortScenes([
    { sceneIndex: 0, sceneName: 'Bottom', sceneUuid: 'b' },
    { sceneIndex: 2, sceneName: 'Top', sceneUuid: 't' },
    { sceneIndex: 1, sceneName: 'Middle', sceneUuid: 'm' },
  ]);
  assert.deepEqual(scenes.map((s) => s.name), ['Top', 'Middle', 'Bottom']);
});

test('program/preview scene and scene item visibility', () => {
  const s = state();
  applyEvent(s, 'CurrentProgramSceneChanged', { sceneName: 'Chat' }, 0);
  assert.equal(s.programScene, 'Chat');
  const r = applyEvent(s, 'SceneItemEnableStateChanged', { sceneName: 'Chat', sceneItemId: 2, sceneItemEnabled: true }, 0);
  assert.equal(r.changed, true);
  assert.equal(s.sceneItems.Chat[0].enabled, true);
  // Unknown item → ask for a refetch rather than guessing.
  const missing = applyEvent(s, 'SceneItemEnableStateChanged', { sceneName: 'Chat', sceneItemId: 99, sceneItemEnabled: true }, 0);
  assert.deepEqual(missing.refetch, [{ kind: 'sceneItems', scene: 'Chat' }]);
});

test('scene rename updates every place the name is used', () => {
  const s = state();
  s.sceneItems.Chat.push({ id: 3, source: 'Game', enabled: true, isGroup: false }); // nested scene
  s.previewScene = 'Game';
  applyEvent(s, 'SceneNameChanged', { oldSceneName: 'Game', sceneName: 'Gameplay', sceneUuid: 'u-game' }, 0);
  assert.equal(s.scenes[0].name, 'Gameplay');
  assert.equal(s.programScene, 'Gameplay');
  assert.equal(s.previewScene, 'Gameplay');
  assert.ok(s.sceneItems.Gameplay && !s.sceneItems.Game);
  assert.ok('Gameplay' in s.filters);
  assert.equal(s.sceneItems.Chat[1].source, 'Gameplay');
});

test('input rename, mute and volume', () => {
  const s = state();
  applyEvent(s, 'InputNameChanged', { oldInputName: 'Cam', inputName: 'Webcam' }, 0);
  assert.equal(s.inputs.Webcam.name, 'Webcam');
  assert.equal(s.sceneItems.Game[0].source, 'Webcam');
  applyEvent(s, 'InputMuteStateChanged', { inputName: 'Mic', inputMuted: true }, 0);
  assert.equal(s.inputs.Mic.muted, true);
  applyEvent(s, 'InputVolumeChanged', { inputName: 'Mic', inputVolumeMul: 0.5, inputVolumeDb: -6 }, 0);
  assert.equal(s.inputs.Mic.volumeMul, 0.5);
  assert.equal(applyEvent(s, 'InputMuteStateChanged', { inputName: 'Nope', inputMuted: true }, 0).changed, false);
});

test('new inputs are probed for audio', () => {
  const s = state();
  const r = applyEvent(s, 'InputCreated', { inputName: 'Music', inputKind: 'ffmpeg_source', inputKindCaps: 7 }, 0);
  assert.equal(s.inputs.Music.audio, true);
  assert.deepEqual(r.refetch, [{ kind: 'input', name: 'Music' }]);
});

test('output state machine keeps a pause-aware clock', () => {
  const s = state();
  applyEvent(s, 'RecordStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' }, 1000);
  assert.equal(s.record.state, 'starting');
  applyEvent(s, 'RecordStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' }, 2000);
  assert.deepEqual([s.record.state, s.record.durationMs, s.record.sampledAt], ['started', 0, 2000]);
  const paused = applyEvent(s, 'RecordStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_PAUSED' }, 7000);
  assert.equal(s.record.paused, true);
  assert.equal(s.record.durationMs, 5000, 'time recorded before the pause is kept');
  assert.deepEqual(paused.refetch, [{ kind: 'record' }]);
  applyEvent(s, 'RecordStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_RESUMED' }, 9000);
  assert.deepEqual([s.record.paused, s.record.durationMs, s.record.sampledAt], [false, 5000, 9000]);
  applyEvent(s, 'RecordStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' }, 12000);
  assert.deepEqual([s.record.state, s.record.durationMs], ['stopped', 0]);
});

test('studio mode fetches the preview scene when turned on and clears it when off', () => {
  const s = state();
  assert.deepEqual(applyEvent(s, 'StudioModeStateChanged', { studioModeEnabled: true }, 0).refetch, [{ kind: 'preview' }]);
  s.previewScene = 'Chat';
  applyEvent(s, 'StudioModeStateChanged', { studioModeEnabled: false }, 0);
  assert.equal(s.studioMode, false);
  assert.equal(s.previewScene, undefined);
});

test('filters, collections and unknown events', () => {
  const s = state();
  applyEvent(s, 'SourceFilterEnableStateChanged', { sourceName: 'Mic', filterName: 'Gate', filterEnabled: false }, 0);
  assert.equal(s.filters.Mic[0].enabled, false);
  applyEvent(s, 'SourceFilterNameChanged', { sourceName: 'Mic', oldFilterName: 'Gate', filterName: 'Noise Gate' }, 0);
  assert.equal(s.filters.Mic[0].name, 'Noise Gate');
  assert.deepEqual(applyEvent(s, 'SourceFilterCreated', { sourceName: 'Mic', filterName: 'EQ' }, 0).refetch, [{ kind: 'filters', source: 'Mic' }]);
  assert.deepEqual(applyEvent(s, 'CurrentSceneCollectionChanged', { sceneCollectionName: 'B' }, 0).refetch, [{ kind: 'full' }]);
  assert.deepEqual(applyEvent(s, 'SomethingNew', {}, 0), { changed: false, refetch: [] });
});

test('while streaming, polls work out the bitrate and keep the network-dropped frames', async () => {
  const store = new ObsStateStore();
  store.state.connection = 'connected';
  applyOutputState(store.state.stream, 'OBS_WEBSOCKET_OUTPUT_STARTED', Date.now());
  let bytes = 1_000_000;
  const caller = {
    call: async () => ({}),
    callBatch: async (requests: { requestType: string }[]) =>
      requests.map((r) => ({
        requestType: r.requestType,
        requestStatus: { result: true, code: 100 },
        responseData:
          r.requestType === 'GetStreamStatus'
            ? { outputActive: true, outputDuration: 5000, outputBytes: bytes, outputSkippedFrames: 3, outputTotalFrames: 300 }
            : { cpuUsage: 5, activeFps: 60, renderSkippedFrames: 0, renderTotalFrames: 100, outputSkippedFrames: 0, outputTotalFrames: 100 },
      })),
  };
  await store.poll(caller as never);
  assert.equal(store.state.stream.bytes, 1_000_000);
  assert.equal(store.state.stream.bitrateKbps, undefined, 'one reading isn’t a rate yet');
  store.state.stream.sampledAt = Date.now() - 2000; // two seconds later…
  bytes += 1_500_000; // …1.5 MB more: 6000 kbit/s
  await store.poll(caller as never);
  assert.ok(Math.abs(store.state.stream.bitrateKbps! - 6000) < 30, String(store.state.stream.bitrateKbps));
  assert.deepEqual([store.state.stream.skippedFrames, store.state.stream.totalFrames], [3, 300]);
  applyOutputState(store.state.stream, 'OBS_WEBSOCKET_OUTPUT_STOPPED', Date.now());
  assert.equal(store.state.stream.bitrateKbps, undefined, 'a new stream starts from zero');
});
