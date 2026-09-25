// A small fake obs-websocket v5 server (JSON protocol) for tests and for UI work without OBS.
// Run it with `npm run mock-obs` (ws://127.0.0.1:4456). Only implements what the deck uses.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

const Op = { Hello: 0, Identify: 1, Identified: 2, Reidentify: 3, Event: 5, Request: 6, RequestResponse: 7, RequestBatch: 8, RequestBatchResponse: 9 };
const Intent = {
  General: 1,
  Config: 2,
  Scenes: 4,
  Inputs: 8,
  Transitions: 16,
  Filters: 32,
  Outputs: 64,
  SceneItems: 128,
  MediaInputs: 256,
  Ui: 1024,
  All: 2047,
  InputVolumeMeters: 1 << 16,
};
const Status = {
  Success: 100,
  UnknownRequestType: 204,
  MissingRequestField: 300,
  ResourceNotFound: 600,
  InvalidResourceState: 604,
  OutputRunning: 500,
  OutputNotRunning: 501,
  StudioModeNotActive: 506,
};
const CAPS = { video: 1, audio: 2, async: 4 };

class RequestError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface MockItem {
  id: number;
  source: string;
  enabled: boolean;
}
interface MockScene {
  name: string;
  uuid: string;
  items: MockItem[]; // OBS UI order, top first
}
interface MockFilter {
  name: string;
  kind: string;
  enabled: boolean;
}
interface MockInput {
  name: string;
  uuid: string;
  kind: string;
  caps: number;
  muted: boolean;
  volumeMul: number;
  mediaState?: string;
  settings: Record<string, unknown>;
  /** How often a browser source's "refresh cache" button was pressed. */
  refreshes?: number;
}
interface MockOutput {
  active: boolean;
  paused: boolean;
  startedAt: number;
  pausedMs: number;
  pausedAt: number;
}

export interface MockState {
  scenes: MockScene[];
  inputs: MockInput[];
  filters: Record<string, MockFilter[]>;
  program: string;
  preview: string;
  studioMode: boolean;
  stream: MockOutput;
  record: MockOutput;
  replay: { active: boolean };
  virtualCam: { active: boolean };
  collections: string[];
  collection: string;
  profiles: string[];
  profile: string;
  transitions: string[];
  transition: string;
  transitionMs: number;
  hotkeys: string[];
  /** Every request received, newest last (handy in tests). */
  log: { requestType: string; requestData: Record<string, unknown> }[];
}

function output(): MockOutput {
  return { active: false, paused: false, startedAt: 0, pausedMs: 0, pausedAt: 0 };
}

export function createMockState(): MockState {
  let nextId = 1;
  const item = (source: string, enabled = true): MockItem => ({ id: nextId++, source, enabled });
  const input = (name: string, kind: string, caps: number, extra: Partial<MockInput> = {}): MockInput => ({
    name,
    uuid: randomUUID(),
    kind,
    caps,
    muted: false,
    volumeMul: 1,
    settings: kind.startsWith('text_') ? { text: name } : kind === 'browser_source' ? { url: 'https://example.com/' } : {},
    ...extra,
  });
  return {
    scenes: [
      { name: 'Starting Soon', uuid: randomUUID(), items: [item('Countdown'), item('Music')] },
      { name: 'Gameplay', uuid: randomUUID(), items: [item('Webcam'), item('Game Capture'), item('Alerts', false)] },
      { name: 'Just Chatting', uuid: randomUUID(), items: [item('Webcam'), item('Chat Overlay')] },
      { name: 'BRB', uuid: randomUUID(), items: [item('BRB Text'), item('Music')] },
    ],
    inputs: [
      input('Mic/Aux', 'pulse_input_capture', CAPS.audio, { volumeMul: 0.8 }),
      input('Desktop Audio', 'pulse_output_capture', CAPS.audio, { volumeMul: 0.5 }),
      input('Music', 'ffmpeg_source', CAPS.video | CAPS.audio | CAPS.async, { muted: true, volumeMul: 0.3, mediaState: 'OBS_MEDIA_STATE_PAUSED' }),
      input('Webcam', 'v4l2_input', CAPS.video | CAPS.async),
      input('Game Capture', 'pipewire-screen-capture-source', CAPS.video),
      input('Countdown', 'text_ft2_source_v2', CAPS.video),
      input('BRB Text', 'text_ft2_source_v2', CAPS.video),
      input('Chat Overlay', 'browser_source', CAPS.video | CAPS.audio),
      input('Alerts', 'browser_source', CAPS.video | CAPS.audio),
    ],
    filters: {
      'Mic/Aux': [
        { name: 'Noise Suppression', kind: 'noise_suppress_filter_v2', enabled: true },
        { name: 'Compressor', kind: 'compressor_filter', enabled: false },
      ],
      Webcam: [{ name: 'Color Correction', kind: 'color_filter_v2', enabled: true }],
      Gameplay: [{ name: 'Blur', kind: 'blur_filter', enabled: false }],
    },
    program: 'Gameplay',
    preview: 'Just Chatting',
    studioMode: false,
    stream: output(),
    record: output(),
    replay: { active: false },
    virtualCam: { active: false },
    collections: ['Main', 'Testing'],
    collection: 'Main',
    profiles: ['Default', 'Recording Only'],
    profile: 'Default',
    transitions: ['Fade', 'Cut', 'Stinger'],
    transition: 'Fade',
    transitionMs: 300,
    hotkeys: ['OBSBasic.StartStreaming', 'OBSBasic.StopStreaming', 'OBSBasic.StartRecording', 'OBSBasic.StopRecording', 'OBSBasic.Screenshot'],
    log: [],
  };
}

interface Session {
  ws: WebSocket;
  identified: boolean;
  subs: number;
  auth?: { challenge: string; salt: string };
}

export interface MockObsOptions {
  port?: number;
  host?: string;
  password?: string;
  /** Delay before outputs go from STARTING to STARTED (ms). */
  outputDelayMs?: number;
}

export interface MockObs {
  port: number;
  url: string;
  state: MockState;
  close(): Promise<void>;
  /** Send an event to every identified client, as OBS would. */
  emit(eventType: string, eventData: Record<string, unknown>, intent: number): void;
}

const sha256b64 = (s: string) => createHash('sha256').update(s).digest('base64');

export async function startMockObs(opts: MockObsOptions = {}): Promise<MockObs> {
  const state = createMockState();
  const sessions = new Set<Session>();
  const delay = opts.outputDelayMs ?? 250;

  const wss = new WebSocketServer({
    host: opts.host ?? '127.0.0.1',
    port: opts.port ?? 0,
    handleProtocols: (protocols) => (protocols.has('obswebsocket.json') ? 'obswebsocket.json' : false),
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const port = (wss.address() as AddressInfo).port;

  const send = (ws: WebSocket, op: number, d: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ op, d }));
  };

  const emit = (eventType: string, eventData: Record<string, unknown>, intent: number) => {
    for (const s of sessions) {
      if (s.identified && (s.subs & intent) !== 0) send(s.ws, Op.Event, { eventType, eventIntent: intent, eventData });
    }
  };

  // ---- state helpers ------------------------------------------------------------------------
  const findScene = (name: unknown) => {
    const scene = state.scenes.find((s) => s.name === name);
    if (!scene) throw new RequestError(Status.ResourceNotFound, `No source was found by the name of \`${String(name)}\`.`);
    return scene;
  };
  const findInput = (name: unknown) => {
    const input = state.inputs.find((i) => i.name === name);
    if (!input) throw new RequestError(Status.ResourceNotFound, `No source was found by the name of \`${String(name)}\`.`);
    return input;
  };
  const audioInput = (name: unknown) => {
    const input = findInput(name);
    if (!(input.caps & CAPS.audio)) throw new RequestError(Status.InvalidResourceState, 'The specified input does not support audio.');
    return input;
  };
  const sceneListData = () => ({
    currentProgramSceneName: state.program,
    currentProgramSceneUuid: findScene(state.program).uuid,
    currentPreviewSceneName: state.studioMode ? state.preview : null,
    currentPreviewSceneUuid: state.studioMode ? findScene(state.preview).uuid : null,
    // obs-websocket lists the bottom scene first with index 0.
    scenes: state.scenes.map((s, i) => ({ sceneIndex: state.scenes.length - 1 - i, sceneName: s.name, sceneUuid: s.uuid })).reverse(),
  });
  const duration = (o: MockOutput) => (o.active ? Date.now() - o.startedAt - o.pausedMs - (o.paused ? Date.now() - o.pausedAt : 0) : 0);
  const outputEvent = (name: 'StreamStateChanged' | 'RecordStateChanged', active: boolean, stateName: string) =>
    emit(name, { outputActive: active, outputState: `OBS_WEBSOCKET_OUTPUT_${stateName}`, ...(name === 'RecordStateChanged' ? { outputPath: null } : {}) }, Intent.Outputs);

  const setOutput = (which: 'stream' | 'record', on: boolean) => {
    const o = state[which];
    const event = which === 'stream' ? 'StreamStateChanged' : 'RecordStateChanged';
    if (on === o.active) throw new RequestError(on ? Status.OutputRunning : Status.OutputNotRunning, on ? 'The output is already running.' : 'The output is not running.');
    outputEvent(event, on, on ? 'STARTING' : 'STOPPING');
    setTimeout(() => {
      Object.assign(o, { active: on, paused: false, startedAt: Date.now(), pausedMs: 0 });
      outputEvent(event, on, on ? 'STARTED' : 'STOPPED');
    }, delay);
  };
  const setPaused = (paused: boolean) => {
    const r = state.record;
    if (!r.active) throw new RequestError(Status.OutputNotRunning, 'The output is not running.');
    if (r.paused === paused) return;
    if (paused) r.pausedAt = Date.now();
    else r.pausedMs += Date.now() - r.pausedAt;
    r.paused = paused;
    outputEvent('RecordStateChanged', true, paused ? 'PAUSED' : 'RESUMED');
  };
  const setProgram = (name: string) => {
    state.program = findScene(name).name;
    emit('CurrentProgramSceneChanged', { sceneName: state.program, sceneUuid: findScene(state.program).uuid }, Intent.Scenes);
  };
  const setMute = (input: MockInput, muted: boolean) => {
    input.muted = muted;
    emit('InputMuteStateChanged', { inputName: input.name, inputUuid: input.uuid, inputMuted: muted }, Intent.Inputs);
  };

  // ---- request handlers ---------------------------------------------------------------------
  type Handler = (d: Record<string, any>) => Record<string, unknown> | void;
  const handlers: Record<string, Handler> = {
    GetVersion: () => ({
      obsVersion: '32.0.0-mock',
      obsWebSocketVersion: '5.6.2',
      rpcVersion: 1,
      availableRequests: Object.keys(handlers),
      supportedImageFormats: ['png', 'jpg'],
      platform: 'linux',
      platformDescription: 'Mock OBS',
    }),
    GetStats: () => ({
      cpuUsage: 3 + Math.random() * 4,
      memoryUsage: 512,
      availableDiskSpace: 100_000,
      activeFps: 60,
      averageFrameRenderTime: 1.2,
      renderSkippedFrames: 0,
      renderTotalFrames: 10_000,
      outputSkippedFrames: 2,
      outputTotalFrames: 9_000,
      webSocketSessionIncomingMessages: 0,
      webSocketSessionOutgoingMessages: 0,
    }),
    GetSceneList: () => sceneListData(),
    GetCurrentProgramScene: () => ({ sceneName: state.program, sceneUuid: findScene(state.program).uuid, currentProgramSceneName: state.program }),
    GetCurrentPreviewScene: () => {
      if (!state.studioMode) throw new RequestError(Status.StudioModeNotActive, 'Studio mode is not active.');
      return { sceneName: state.preview, sceneUuid: findScene(state.preview).uuid, currentPreviewSceneName: state.preview };
    },
    SetCurrentProgramScene: (d) => setProgram(d.sceneName),
    SetCurrentPreviewScene: (d) => {
      if (!state.studioMode) throw new RequestError(Status.StudioModeNotActive, 'Studio mode is not active.');
      state.preview = findScene(d.sceneName).name;
      emit('CurrentPreviewSceneChanged', { sceneName: state.preview, sceneUuid: findScene(state.preview).uuid }, Intent.Scenes);
    },
    GetSceneItemList: (d) => {
      const scene = findScene(d.sceneName);
      return {
        sceneItems: scene.items.map((it, i) => {
          const input = state.inputs.find((x) => x.name === it.source);
          return {
            sceneItemId: it.id,
            sceneItemIndex: scene.items.length - 1 - i,
            sourceName: it.source,
            sourceUuid: input?.uuid ?? null,
            sourceType: 'OBS_SOURCE_TYPE_INPUT',
            inputKind: input?.kind ?? null,
            isGroup: null,
            sceneItemEnabled: it.enabled,
          };
        }),
      };
    },
    GetGroupSceneItemList: (d) => {
      throw new RequestError(Status.ResourceNotFound, `No group was found by the name of \`${d.sceneName}\`.`);
    },
    GetSceneItemId: (d) => {
      const item = findScene(d.sceneName).items.find((i) => i.source === d.sourceName);
      if (!item) throw new RequestError(Status.ResourceNotFound, 'No scene items were found.');
      return { sceneItemId: item.id };
    },
    SetSceneItemEnabled: (d) => {
      const scene = findScene(d.sceneName);
      const item = scene.items.find((i) => i.id === d.sceneItemId);
      if (!item) throw new RequestError(Status.ResourceNotFound, 'No scene items were found.');
      item.enabled = !!d.sceneItemEnabled;
      emit('SceneItemEnableStateChanged', { sceneName: scene.name, sceneUuid: scene.uuid, sceneItemId: item.id, sceneItemEnabled: item.enabled }, Intent.SceneItems);
    },
    GetInputList: () => ({
      inputs: state.inputs.map((i) => ({ inputName: i.name, inputUuid: i.uuid, inputKind: i.kind, unversionedInputKind: i.kind, inputKindCaps: i.caps })),
    }),
    GetInputSettings: (d) => {
      const input = findInput(d.inputName);
      return { inputSettings: input.settings, inputKind: input.kind };
    },
    SetInputSettings: (d) => {
      const input = findInput(d.inputName);
      if (!d.inputSettings || typeof d.inputSettings !== 'object') throw new RequestError(Status.MissingRequestField, 'Your request is missing the `inputSettings` field.');
      input.settings = d.overlay === false ? { ...d.inputSettings } : { ...input.settings, ...d.inputSettings };
      emit('InputSettingsChanged', { inputName: input.name, inputUuid: input.uuid, inputSettings: input.settings }, Intent.Inputs);
    },
    PressInputPropertiesButton: (d) => {
      const input = findInput(d.inputName);
      if (input.kind !== 'browser_source' || !['refreshnocache', 'refresh'].includes(d.propertyName)) {
        throw new RequestError(Status.ResourceNotFound, 'Unable to find a property by that name.');
      }
      input.refreshes = (input.refreshes ?? 0) + 1;
    },
    GetInputMute: (d) => ({ inputMuted: audioInput(d.inputName).muted }),
    SetInputMute: (d) => setMute(audioInput(d.inputName), !!d.inputMuted),
    ToggleInputMute: (d) => {
      const input = audioInput(d.inputName);
      setMute(input, !input.muted);
      return { inputMuted: input.muted };
    },
    GetInputVolume: (d) => {
      const input = audioInput(d.inputName);
      return { inputVolumeMul: input.volumeMul, inputVolumeDb: input.volumeMul > 0 ? 20 * Math.log10(input.volumeMul) : null };
    },
    SetInputVolume: (d) => {
      const input = audioInput(d.inputName);
      if (typeof d.inputVolumeMul === 'number') input.volumeMul = Math.min(20, Math.max(0, d.inputVolumeMul));
      else if (typeof d.inputVolumeDb === 'number') input.volumeMul = d.inputVolumeDb <= -100 ? 0 : 10 ** (d.inputVolumeDb / 20);
      else throw new RequestError(Status.MissingRequestField, 'You must specify inputVolumeMul or inputVolumeDb.');
      emit(
        'InputVolumeChanged',
        { inputName: input.name, inputUuid: input.uuid, inputVolumeMul: input.volumeMul, inputVolumeDb: input.volumeMul > 0 ? 20 * Math.log10(input.volumeMul) : null },
        Intent.Inputs,
      );
    },
    GetStreamStatus: () => ({
      outputActive: state.stream.active,
      outputReconnecting: false,
      outputTimecode: '00:00:00.000',
      outputDuration: duration(state.stream),
      outputCongestion: 0,
      outputBytes: 0,
      outputSkippedFrames: 0,
      outputTotalFrames: 0,
    }),
    StartStream: () => setOutput('stream', true),
    StopStream: () => setOutput('stream', false),
    ToggleStream: () => {
      setOutput('stream', !state.stream.active);
      return { outputActive: !state.stream.active };
    },
    GetRecordStatus: () => ({
      outputActive: state.record.active,
      outputPaused: state.record.paused,
      outputTimecode: '00:00:00.000',
      outputDuration: duration(state.record),
      outputBytes: 0,
    }),
    StartRecord: () => setOutput('record', true),
    StopRecord: () => {
      setOutput('record', false);
      return { outputPath: '/tmp/mock.mkv' };
    },
    ToggleRecord: () => {
      setOutput('record', !state.record.active);
      return { outputActive: !state.record.active };
    },
    PauseRecord: () => setPaused(true),
    ResumeRecord: () => setPaused(false),
    ToggleRecordPause: () => setPaused(!state.record.paused),
    SplitRecordFile: () => {
      if (!state.record.active) throw new RequestError(Status.OutputNotRunning, 'The output is not running.');
    },
    CreateRecordChapter: () => {
      if (!state.record.active) throw new RequestError(Status.OutputNotRunning, 'The output is not running.');
    },
    GetReplayBufferStatus: () => ({ outputActive: state.replay.active }),
    ToggleReplayBuffer: () => {
      state.replay.active = !state.replay.active;
      emit('ReplayBufferStateChanged', { outputActive: state.replay.active, outputState: `OBS_WEBSOCKET_OUTPUT_${state.replay.active ? 'STARTED' : 'STOPPED'}` }, Intent.Outputs);
      return { outputActive: state.replay.active };
    },
    StartReplayBuffer: () => void (state.replay.active || handlers.ToggleReplayBuffer({})),
    StopReplayBuffer: () => void (state.replay.active && handlers.ToggleReplayBuffer({})),
    SaveReplayBuffer: () => {
      if (!state.replay.active) throw new RequestError(Status.OutputNotRunning, 'The output is not running.');
      emit('ReplayBufferSaved', { savedReplayPath: '/tmp/replay.mkv' }, Intent.Outputs);
    },
    GetVirtualCamStatus: () => ({ outputActive: state.virtualCam.active }),
    ToggleVirtualCam: () => {
      state.virtualCam.active = !state.virtualCam.active;
      emit('VirtualcamStateChanged', { outputActive: state.virtualCam.active, outputState: `OBS_WEBSOCKET_OUTPUT_${state.virtualCam.active ? 'STARTED' : 'STOPPED'}` }, Intent.Outputs);
      return { outputActive: state.virtualCam.active };
    },
    StartVirtualCam: () => void (state.virtualCam.active || handlers.ToggleVirtualCam({})),
    StopVirtualCam: () => void (state.virtualCam.active && handlers.ToggleVirtualCam({})),
    GetStudioModeEnabled: () => ({ studioModeEnabled: state.studioMode }),
    SetStudioModeEnabled: (d) => {
      const enabled = !!d.studioModeEnabled;
      if (enabled === state.studioMode) return;
      state.studioMode = enabled;
      if (enabled) state.preview = state.program;
      emit('StudioModeStateChanged', { studioModeEnabled: enabled }, Intent.Ui);
    },
    TriggerStudioModeTransition: () => {
      if (!state.studioMode) throw new RequestError(Status.StudioModeNotActive, 'Studio mode is not active.');
      const oldProgram = state.program;
      setProgram(state.preview);
      state.preview = oldProgram;
      emit('CurrentPreviewSceneChanged', { sceneName: state.preview, sceneUuid: findScene(state.preview).uuid }, Intent.Scenes);
    },
    GetSourceFilterList: (d) => {
      const name = d.sourceName;
      if (!state.inputs.some((i) => i.name === name) && !state.scenes.some((s) => s.name === name)) {
        throw new RequestError(Status.ResourceNotFound, `No source was found by the name of \`${name}\`.`);
      }
      return {
        filters: (state.filters[name] ?? []).map((f, i) => ({ filterEnabled: f.enabled, filterIndex: i, filterKind: f.kind, filterName: f.name, filterSettings: {} })),
      };
    },
    SetSourceFilterEnabled: (d) => {
      const filter = state.filters[d.sourceName]?.find((f) => f.name === d.filterName);
      if (!filter) throw new RequestError(Status.ResourceNotFound, 'No filter was found in the source with that name.');
      filter.enabled = !!d.filterEnabled;
      emit('SourceFilterEnableStateChanged', { sourceName: d.sourceName, filterName: filter.name, filterEnabled: filter.enabled }, Intent.Filters);
    },
    GetSceneCollectionList: () => ({ currentSceneCollectionName: state.collection, sceneCollections: state.collections }),
    SetCurrentSceneCollection: (d) => {
      if (!state.collections.includes(d.sceneCollectionName)) throw new RequestError(Status.ResourceNotFound, 'Your specified scene collection was not found.');
      emit('CurrentSceneCollectionChanging', { sceneCollectionName: state.collection }, Intent.Config);
      state.collection = d.sceneCollectionName;
      emit('CurrentSceneCollectionChanged', { sceneCollectionName: state.collection }, Intent.Config);
    },
    GetProfileList: () => ({ currentProfileName: state.profile, profiles: state.profiles }),
    SetCurrentProfile: (d) => {
      if (!state.profiles.includes(d.profileName)) throw new RequestError(Status.ResourceNotFound, 'Your specified profile was not found.');
      state.profile = d.profileName;
      emit('CurrentProfileChanged', { profileName: state.profile }, Intent.Config);
    },
    GetSceneTransitionList: () => ({
      currentSceneTransitionName: state.transition,
      currentSceneTransitionUuid: null,
      currentSceneTransitionKind: 'fade_transition',
      transitions: state.transitions.map((t) => ({ transitionName: t, transitionUuid: null, transitionKind: t.toLowerCase(), transitionFixed: t === 'Cut', transitionConfigurable: true })),
    }),
    SetCurrentSceneTransition: (d) => {
      if (!state.transitions.includes(d.transitionName)) throw new RequestError(Status.ResourceNotFound, 'No transition was found by that name.');
      state.transition = d.transitionName;
      emit('CurrentSceneTransitionChanged', { transitionName: state.transition, transitionUuid: null }, Intent.Transitions);
    },
    SetCurrentSceneTransitionDuration: (d) => {
      state.transitionMs = d.transitionDuration;
    },
    GetHotkeyList: () => ({ hotkeys: state.hotkeys }),
    TriggerHotkeyByName: (d) => {
      if (!state.hotkeys.includes(d.hotkeyName)) throw new RequestError(Status.ResourceNotFound, 'No hotkeys were found by that name.');
    },
    SaveSourceScreenshot: (d) => {
      findScene(d.sourceName);
    },
    // Real OBS sends a JPEG or PNG of the source; the mock draws its name and the time instead.
    GetSourceScreenshot: (d) => {
      const name = String(d.sourceName);
      if (!state.scenes.some((s) => s.name === name) && !state.inputs.some((i) => i.name === name)) findScene(name);
      const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      const escape = (t: string) => t.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">` +
        `<rect width="320" height="180" fill="hsl(${hue} 45% 30%)"/><circle cx="${40 + ((Date.now() / 1000) % 10) * 24}" cy="140" r="14" fill="hsl(${hue} 70% 65%)"/>` +
        `<text x="160" y="80" fill="#fff" font-family="sans-serif" font-size="30" text-anchor="middle">${escape(name)}</text>` +
        `<text x="160" y="112" fill="#fff" opacity="0.7" font-family="sans-serif" font-size="18" text-anchor="middle">${new Date().toLocaleTimeString()}</text></svg>`;
      return { imageData: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
    },
    GetMediaInputStatus: (d) => ({ mediaState: findInput(d.inputName).mediaState ?? 'OBS_MEDIA_STATE_NONE', mediaDuration: 60_000, mediaCursor: 0 }),
    TriggerMediaInputAction: (d) => {
      const input = findInput(d.inputName);
      const map: Record<string, string> = {
        OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY: 'OBS_MEDIA_STATE_PLAYING',
        OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE: 'OBS_MEDIA_STATE_PAUSED',
        OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP: 'OBS_MEDIA_STATE_STOPPED',
        OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART: 'OBS_MEDIA_STATE_PLAYING',
      };
      input.mediaState = map[d.mediaAction] ?? input.mediaState;
    },
  };

  const handle = (requestType: string, requestData: Record<string, unknown>) => {
    state.log.push({ requestType, requestData });
    const handler = handlers[requestType];
    if (!handler) return { requestStatus: { result: false, code: Status.UnknownRequestType, comment: 'Your request type is not valid.' } };
    try {
      const responseData = handler(requestData) ?? undefined;
      return { requestStatus: { result: true, code: Status.Success }, ...(responseData ? { responseData } : {}) };
    } catch (err) {
      if (err instanceof RequestError) return { requestStatus: { result: false, code: err.code, comment: err.message } };
      throw err;
    }
  };

  // Fake audio levels for inputs that aren't muted.
  const meterTimer = setInterval(() => {
    const t = Date.now() / 1000;
    const inputs = state.inputs
      .filter((i) => i.caps & CAPS.audio)
      .map((i, n) => {
        const level = i.muted ? 0 : i.volumeMul * (0.35 + 0.3 * Math.abs(Math.sin(t * (2 + n))));
        return { inputName: i.name, inputUuid: i.uuid, inputLevelsMul: [[level * 0.7, level, level], [level * 0.6, level * 0.9, level]] };
      });
    emit('InputVolumeMeters', { inputs }, Intent.InputVolumeMeters);
  }, 50);

  wss.on('connection', (ws) => {
    const session: Session = { ws, identified: false, subs: 0 };
    sessions.add(session);
    if (opts.password) session.auth = { challenge: randomBytes(32).toString('base64'), salt: randomBytes(32).toString('base64') };
    send(ws, Op.Hello, { obsWebSocketVersion: '5.6.2', rpcVersion: 1, ...(session.auth ? { authentication: session.auth } : {}) });

    ws.on('close', () => sessions.delete(session));
    ws.on('message', (raw) => {
      let msg: { op: number; d: Record<string, any> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(4002, 'Unable to decode message.');
        return;
      }
      const d = msg.d ?? {};
      if (msg.op === Op.Identify) {
        if (session.auth && opts.password) {
          const expected = sha256b64(sha256b64(opts.password + session.auth.salt) + session.auth.challenge);
          if (d.authentication !== expected) {
            ws.close(4009, 'Authentication failed.');
            return;
          }
        }
        session.identified = true;
        session.subs = typeof d.eventSubscriptions === 'number' ? d.eventSubscriptions : Intent.All;
        send(ws, Op.Identified, { negotiatedRpcVersion: 1 });
        return;
      }
      if (!session.identified) {
        ws.close(4007, 'Not identified.');
        return;
      }
      switch (msg.op) {
        case Op.Reidentify:
          if (typeof d.eventSubscriptions === 'number') session.subs = d.eventSubscriptions;
          send(ws, Op.Identified, { negotiatedRpcVersion: 1 });
          return;
        case Op.Request:
          send(ws, Op.RequestResponse, { requestType: d.requestType, requestId: d.requestId, ...handle(d.requestType, d.requestData ?? {}) });
          return;
        case Op.RequestBatch: {
          const results = [];
          for (const req of d.requests ?? []) {
            const r = handle(req.requestType, req.requestData ?? {});
            results.push({ requestType: req.requestType, requestId: req.requestId, ...r });
            if (d.haltOnFailure && !r.requestStatus.result) break;
          }
          send(ws, Op.RequestBatchResponse, { requestId: d.requestId, results });
          return;
        }
      }
    });
  });

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    state,
    emit,
    close: async () => {
      clearInterval(meterTimer);
      for (const s of sessions) s.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_OBS_PORT ?? 4456);
  const controlPort = Number(process.env.MOCK_OBS_CONTROL_PORT ?? port + 1);
  const password = process.env.MOCK_OBS_PASSWORD || undefined;
  let mock: MockObs | null = await startMockObs({ port, password });
  console.log(`Mock OBS listening on ${mock.url} (${password ? 'password required' : 'no password'})`);
  const toggleUrl = `http://127.0.0.1:${controlPort}/toggle`;
  console.log(
    process.platform === 'win32'
      ? `Simulate OBS quitting/restarting with: curl ${toggleUrl}`
      : `Simulate OBS quitting/restarting with: kill -USR2 ${process.pid}  (or: curl ${toggleUrl})`,
  );
  setInterval(() => {}, 1 << 30); // stay alive while "OBS" is stopped
  let toggling = Promise.resolve('');
  const toggle = () =>
    (toggling = toggling.then(async () => {
      if (mock) {
        await mock.close();
        mock = null;
        return 'Mock OBS stopped (toggle again to start it)';
      }
      mock = await startMockObs({ port, password });
      return 'Mock OBS started again (fresh state)';
    }));
  const report = (message: string) => (console.log(message), message);
  // Windows has no SIGUSR2, so the toggle is also a URL (on this PC only).
  createServer((req, res) => {
    if (req.url !== '/toggle') return void res.writeHead(404).end('Try /toggle\n');
    void toggle().then((message) => res.end(`${report(message)}\n`));
  }).listen(controlPort, '127.0.0.1');
  if (process.platform !== 'win32') process.on('SIGUSR2', () => void toggle().then(report));
  const stop = () => void (mock?.close() ?? Promise.resolve()).then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
