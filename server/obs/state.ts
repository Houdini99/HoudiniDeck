// Mirror of OBS state. Full resync on connect (batched requests), then kept current from events.
import { EventEmitter } from 'node:events';
import type { OBSWebSocket, RequestBatchRequest } from 'obs-websocket-js/json';
import {
  emptyObsState,
  type ObsConnection,
  type ObsFilter,
  type ObsInput,
  type ObsOutput,
  type ObsSceneInfo,
  type ObsSceneItem,
  type ObsState,
  type ObsStats,
} from '../../shared/obs-types.ts';

export type ObsCaller = Pick<OBSWebSocket, 'call' | 'callBatch'>;

// OBS responses carry loosely typed arrays (JsonObject[]); read them through these shapes.
type Json = Record<string, any>;
type BatchResult = { ok: true; data: Json } | { ok: false; code: number; comment: string };

const OBS_SOURCE_AUDIO = 1 << 1;

export async function batch(obs: ObsCaller, requests: { requestType: string; requestData?: object }[]): Promise<BatchResult[]> {
  if (requests.length === 0) return [];
  const results = await obs.callBatch(requests as RequestBatchRequest[], { haltOnFailure: false });
  return results.map((r) =>
    r.requestStatus.result
      ? { ok: true, data: (r.responseData ?? {}) as Json }
      : { ok: false, code: r.requestStatus.code, comment: r.requestStatus.comment },
  );
}

const data = (r: BatchResult | undefined): Json | undefined => (r?.ok ? r.data : undefined);

export function sortScenes(scenes: Json[]): ObsSceneInfo[] {
  // obs-websocket lists the bottom scene first (index 0); the OBS UI shows the highest index on top.
  return [...scenes]
    .sort((a, b) => (b.sceneIndex ?? 0) - (a.sceneIndex ?? 0))
    .map((s) => ({ name: s.sceneName, uuid: s.sceneUuid ?? undefined }));
}

export function mapSceneItems(items: Json[]): ObsSceneItem[] {
  return [...items]
    .sort((a, b) => (b.sceneItemIndex ?? 0) - (a.sceneItemIndex ?? 0))
    .map((i) => ({
      id: i.sceneItemId,
      source: i.sourceName,
      sourceUuid: i.sourceUuid ?? undefined,
      enabled: !!i.sceneItemEnabled,
      isGroup: !!i.isGroup,
    }));
}

export function mapFilters(filters: Json[]): ObsFilter[] {
  return [...filters]
    .sort((a, b) => (a.filterIndex ?? 0) - (b.filterIndex ?? 0))
    .map((f) => ({ name: f.filterName, enabled: !!f.filterEnabled, kind: f.filterKind }));
}

function mapStats(d: Json): ObsStats {
  return {
    cpu: d.cpuUsage ?? 0,
    memoryMb: d.memoryUsage ?? 0,
    fps: d.activeFps ?? 0,
    renderSkipped: d.renderSkippedFrames ?? 0,
    renderTotal: d.renderTotalFrames ?? 0,
    outputSkipped: d.outputSkippedFrames ?? 0,
    outputTotal: d.outputTotalFrames ?? 0,
  };
}

/** true/false when OBS reports input capability flags (obs-websocket ≥ 5.5), undefined otherwise. */
function audioCaps(caps: unknown): boolean | undefined {
  return typeof caps === 'number' ? (caps & OBS_SOURCE_AUDIO) !== 0 : undefined;
}

function renameKey<V>(record: Record<string, V>, from: string, to: string): void {
  if (from in record) {
    record[to] = record[from];
    delete record[from];
  }
}

function renameSourceInItems(s: ObsState, from: string, to: string): void {
  for (const items of Object.values(s.sceneItems)) {
    for (const item of items) if (item.source === from) item.source = to;
  }
}

export function applyOutputState(out: ObsOutput, raw: string, now: number): void {
  switch (raw) {
    case 'OBS_WEBSOCKET_OUTPUT_STARTING':
      out.state = 'starting';
      out.paused = false;
      break;
    case 'OBS_WEBSOCKET_OUTPUT_STARTED':
      Object.assign(out, { state: 'started', paused: false, durationMs: 0, sampledAt: now });
      break;
    case 'OBS_WEBSOCKET_OUTPUT_STOPPING':
      out.state = 'stopping';
      break;
    case 'OBS_WEBSOCKET_OUTPUT_STOPPED':
      Object.assign(out, { state: 'stopped', paused: false, durationMs: 0, sampledAt: now });
      break;
    case 'OBS_WEBSOCKET_OUTPUT_RECONNECTING':
      out.state = 'reconnecting';
      break;
    case 'OBS_WEBSOCKET_OUTPUT_RECONNECTED':
      out.state = 'started';
      break;
    case 'OBS_WEBSOCKET_OUTPUT_PAUSED':
      // Freeze the clock at the moment of pausing.
      if (!out.paused) out.durationMs += Math.max(0, now - out.sampledAt);
      out.sampledAt = now;
      out.paused = true;
      break;
    case 'OBS_WEBSOCKET_OUTPUT_RESUMED':
      out.sampledAt = now;
      out.paused = false;
      break;
  }
}

export type Refetch =
  | { kind: 'full' }
  | { kind: 'sceneItems'; scene: string }
  | { kind: 'filters'; source: string }
  | { kind: 'input'; name: string }
  | { kind: 'preview' }
  | { kind: 'record' };

/** Apply one OBS event to the mirror in place. Returns follow-up fetches for events that lack detail. */
export function applyEvent(s: ObsState, type: string, d: Json, now: number): { changed: boolean; refetch: Refetch[] } {
  const refetch: Refetch[] = [];
  let changed = true;

  switch (type) {
    case 'CurrentProgramSceneChanged':
      s.programScene = d.sceneName;
      break;
    case 'CurrentPreviewSceneChanged':
      s.previewScene = d.sceneName;
      break;
    case 'SceneListChanged':
      s.scenes = sortScenes(d.scenes ?? []);
      break;
    case 'SceneCreated':
      if (d.isGroup && !s.groups.includes(d.sceneName)) s.groups.push(d.sceneName);
      s.sceneItems[d.sceneName] ??= [];
      s.filters[d.sceneName] ??= [];
      break;
    case 'SceneRemoved':
      delete s.sceneItems[d.sceneName];
      delete s.filters[d.sceneName];
      s.groups = s.groups.filter((g) => g !== d.sceneName);
      break;
    case 'SceneNameChanged': {
      const from: string = d.oldSceneName;
      const to: string = d.sceneName;
      for (const scene of s.scenes) if (scene.name === from) scene.name = to;
      s.groups = s.groups.map((g) => (g === from ? to : g));
      renameKey(s.sceneItems, from, to);
      renameKey(s.filters, from, to);
      renameSourceInItems(s, from, to);
      if (s.programScene === from) s.programScene = to;
      if (s.previewScene === from) s.previewScene = to;
      break;
    }
    case 'SceneItemCreated':
    case 'SceneItemRemoved':
    case 'SceneItemListReindexed':
      refetch.push({ kind: 'sceneItems', scene: d.sceneName });
      changed = false;
      break;
    case 'SceneItemEnableStateChanged': {
      const item = s.sceneItems[d.sceneName]?.find((i) => i.id === d.sceneItemId);
      if (item) item.enabled = !!d.sceneItemEnabled;
      else {
        refetch.push({ kind: 'sceneItems', scene: d.sceneName });
        changed = false;
      }
      break;
    }
    case 'InputCreated':
      s.inputs[d.inputName] = {
        name: d.inputName,
        uuid: d.inputUuid ?? undefined,
        kind: d.inputKind,
        audio: audioCaps(d.inputKindCaps) ?? false,
      };
      s.filters[d.inputName] ??= [];
      refetch.push({ kind: 'input', name: d.inputName });
      break;
    case 'InputRemoved':
      delete s.inputs[d.inputName];
      delete s.filters[d.inputName];
      break;
    case 'InputNameChanged': {
      const from: string = d.oldInputName;
      const to: string = d.inputName;
      const input = s.inputs[from];
      if (input) {
        delete s.inputs[from];
        input.name = to;
        s.inputs[to] = input;
      }
      renameKey(s.filters, from, to);
      renameSourceInItems(s, from, to);
      break;
    }
    case 'InputMuteStateChanged': {
      const input = s.inputs[d.inputName];
      if (input) input.muted = !!d.inputMuted;
      else changed = false;
      break;
    }
    case 'InputVolumeChanged': {
      const input = s.inputs[d.inputName];
      if (input) {
        input.volumeMul = d.inputVolumeMul;
        input.volumeDb = d.inputVolumeDb;
      } else changed = false;
      break;
    }
    case 'StreamStateChanged':
      applyOutputState(s.stream, d.outputState, now);
      break;
    case 'RecordStateChanged':
      applyOutputState(s.record, d.outputState, now);
      if (d.outputState === 'OBS_WEBSOCKET_OUTPUT_PAUSED' || d.outputState === 'OBS_WEBSOCKET_OUTPUT_RESUMED') {
        refetch.push({ kind: 'record' });
      }
      break;
    case 'ReplayBufferStateChanged':
      s.replayBuffer = { available: true, active: !!d.outputActive };
      break;
    case 'VirtualcamStateChanged':
      s.virtualCam = { available: true, active: !!d.outputActive };
      break;
    case 'StudioModeStateChanged':
      s.studioMode = !!d.studioModeEnabled;
      if (s.studioMode) refetch.push({ kind: 'preview' });
      else s.previewScene = undefined;
      break;
    case 'SourceFilterCreated':
    case 'SourceFilterRemoved':
    case 'SourceFilterListReindexed':
      refetch.push({ kind: 'filters', source: d.sourceName });
      changed = false;
      break;
    case 'SourceFilterNameChanged': {
      const filter = s.filters[d.sourceName]?.find((f) => f.name === d.oldFilterName);
      if (filter) filter.name = d.filterName;
      else changed = false;
      break;
    }
    case 'SourceFilterEnableStateChanged': {
      const filter = s.filters[d.sourceName]?.find((f) => f.name === d.filterName);
      if (filter) filter.enabled = !!d.filterEnabled;
      else {
        refetch.push({ kind: 'filters', source: d.sourceName });
        changed = false;
      }
      break;
    }
    case 'CurrentSceneCollectionChanged':
      s.collections.current = d.sceneCollectionName;
      refetch.push({ kind: 'full' });
      break;
    case 'SceneCollectionListChanged':
      s.collections.list = d.sceneCollections ?? [];
      break;
    case 'CurrentProfileChanged':
      s.profiles.current = d.profileName;
      break;
    case 'ProfileListChanged':
      s.profiles.list = d.profiles ?? [];
      break;
    case 'CurrentSceneTransitionChanged':
      s.currentTransition = d.transitionName;
      break;
    default:
      changed = false;
  }
  return { changed, refetch };
}

/** Event names forwarded from obs-websocket-js into applyEvent. */
export const MIRRORED_EVENTS = [
  'CurrentProgramSceneChanged',
  'CurrentPreviewSceneChanged',
  'SceneListChanged',
  'SceneCreated',
  'SceneRemoved',
  'SceneNameChanged',
  'SceneItemCreated',
  'SceneItemRemoved',
  'SceneItemListReindexed',
  'SceneItemEnableStateChanged',
  'InputCreated',
  'InputRemoved',
  'InputNameChanged',
  'InputMuteStateChanged',
  'InputVolumeChanged',
  'StreamStateChanged',
  'RecordStateChanged',
  'ReplayBufferStateChanged',
  'VirtualcamStateChanged',
  'StudioModeStateChanged',
  'SourceFilterCreated',
  'SourceFilterRemoved',
  'SourceFilterListReindexed',
  'SourceFilterNameChanged',
  'SourceFilterEnableStateChanged',
  'CurrentSceneCollectionChanged',
  'SceneCollectionListChanged',
  'CurrentProfileChanged',
  'ProfileListChanged',
  'CurrentSceneTransitionChanged',
] as const;

/** The refetch key an event touches, so in-flight fetches for the same thing can be detected as stale. */
function eventKey(type: string, d: Json): string | undefined {
  switch (type) {
    case 'CurrentPreviewSceneChanged':
    case 'StudioModeStateChanged':
      return 'preview';
    case 'SceneItemCreated':
    case 'SceneItemRemoved':
    case 'SceneItemListReindexed':
    case 'SceneItemEnableStateChanged':
      return `sceneItems:${d.sceneName}`;
    case 'SourceFilterCreated':
    case 'SourceFilterRemoved':
    case 'SourceFilterListReindexed':
    case 'SourceFilterNameChanged':
    case 'SourceFilterEnableStateChanged':
      return `filters:${d.sourceName}`;
    case 'InputMuteStateChanged':
    case 'InputVolumeChanged':
      return `input:${d.inputName}`;
    case 'RecordStateChanged':
      return 'record';
    default:
      return undefined;
  }
}

function refetchKey(r: Exclude<Refetch, { kind: 'full' }>): string {
  switch (r.kind) {
    case 'sceneItems':
      return `sceneItems:${r.scene}`;
    case 'filters':
      return `filters:${r.source}`;
    case 'input':
      return `input:${r.name}`;
    default:
      return r.kind;
  }
}

/** Fetch one part of the state; returns a function that applies it (and lists newly found groups). */
async function fetchPart(obs: ObsCaller, r: Exclude<Refetch, { kind: 'full' }>, current: ObsState): Promise<(s: ObsState) => string[]> {
  switch (r.kind) {
    case 'sceneItems': {
      const isGroup = current.groups.includes(r.scene);
      const res = await obs.call(isGroup ? 'GetGroupSceneItemList' : 'GetSceneItemList', { sceneName: r.scene });
      const items = mapSceneItems(res.sceneItems as Json[]);
      return (s) => {
        s.sceneItems[r.scene] = items;
        const found = items.filter((i) => i.isGroup && !s.groups.includes(i.source)).map((i) => i.source);
        s.groups.push(...found);
        return found;
      };
    }
    case 'filters': {
      const res = await obs.call('GetSourceFilterList', { sourceName: r.source });
      const filters = mapFilters(res.filters as Json[]);
      return (s) => {
        s.filters[r.source] = filters;
        return [];
      };
    }
    case 'input': {
      const [mute, volume] = await batch(obs, [
        { requestType: 'GetInputMute', requestData: { inputName: r.name } },
        { requestType: 'GetInputVolume', requestData: { inputName: r.name } },
      ]);
      return (s) => {
        const input = s.inputs[r.name];
        if (input) applyAudio(input, data(mute), data(volume));
        return [];
      };
    }
    case 'preview': {
      const res = (await obs.call('GetCurrentPreviewScene')) as Json;
      return (s) => {
        if (s.studioMode) s.previewScene = res.sceneName ?? res.currentPreviewSceneName ?? undefined;
        return [];
      };
    }
    case 'record': {
      const res = (await obs.call('GetRecordStatus')) as Json;
      const sampledAt = Date.now();
      return (s) => {
        Object.assign(s.record, { durationMs: res.outputDuration ?? 0, sampledAt, paused: !!res.outputPaused });
        return [];
      };
    }
  }
}

export class ObsStateStore extends EventEmitter<{ change: [] }> {
  state: ObsState = emptyObsState();
  /** Bumped on reset/resync so results from an older connection are discarded. */
  private epoch = 0;
  private resyncing = false;
  private queued: { type: string; data: Json }[] = [];
  /** Per refetch key: how many events touched it (see eventKey). */
  private touched = new Map<string, number>();

  reset(connection: ObsConnection, extra: Partial<Pick<ObsState, 'error' | 'url'>> = {}): void {
    this.epoch++;
    this.queued = [];
    this.state = { ...emptyObsState(connection), ...extra };
    this.emit('change');
  }

  setConnection(connection: ObsConnection, error?: string): void {
    this.state.connection = connection;
    this.state.error = error;
    this.emit('change');
  }

  async resync(obs: ObsCaller): Promise<void> {
    const epoch = ++this.epoch;
    this.resyncing = true;
    try {
      const next = await fetchFullState(obs);
      if (epoch !== this.epoch) return;
      this.state = { ...next, connection: this.state.connection, url: this.state.url, error: this.state.error };
      // Events that arrived while we were fetching are newer than the snapshot; apply them now.
      const queued = this.queued;
      this.queued = [];
      this.resyncing = false;
      for (const event of queued) await this.handleEvent(obs, event.type, event.data);
      this.emit('change');
    } finally {
      if (epoch === this.epoch) this.resyncing = false;
    }
  }

  async handleEvent(obs: ObsCaller, type: string, eventData: Json | undefined): Promise<void> {
    if (this.resyncing) {
      this.queued.push({ type, data: eventData ?? {} });
      return;
    }
    const d = eventData ?? {};
    const key = eventKey(type, d);
    if (key) this.touched.set(key, (this.touched.get(key) ?? 0) + 1);
    const { changed, refetch } = applyEvent(this.state, type, d, Date.now());
    if (changed) this.emit('change');
    for (const r of refetch) await this.refetch(obs, r);
  }

  private async refetch(obs: ObsCaller, r: Refetch, attempt = 0): Promise<void> {
    if (r.kind === 'full') return this.resync(obs);
    const epoch = this.epoch;
    const key = refetchKey(r);
    const touchedBefore = this.touched.get(key) ?? 0;
    const apply = await fetchPart(obs, r, this.state);
    if (epoch !== this.epoch) return;
    // A response can be processed after an event that OBS sent later (same TCP chunk). If an event
    // touched the same thing meanwhile, this answer may be stale: ask again instead of applying it.
    if ((this.touched.get(key) ?? 0) !== touchedBefore) {
      if (attempt < 3) await this.refetch(obs, r, attempt + 1);
      return;
    }
    const newGroups = apply(this.state);
    this.emit('change');
    for (const group of newGroups) await this.refetch(obs, { kind: 'sceneItems', scene: group });
  }

  /** Periodic refresh of stats and output timers (only while someone is looking). */
  async poll(obs: ObsCaller): Promise<void> {
    const epoch = this.epoch;
    const s = this.state;
    const wantStream = s.stream.state !== 'stopped';
    const wantRecord = s.record.state !== 'stopped';
    const requests = [{ requestType: 'GetStats' }];
    if (wantStream) requests.push({ requestType: 'GetStreamStatus' });
    if (wantRecord) requests.push({ requestType: 'GetRecordStatus' });
    const [stats, ...rest] = await batch(obs, requests);
    if (epoch !== this.epoch) return;
    const now = Date.now();
    const statsData = data(stats);
    if (statsData) s.stats = mapStats(statsData);
    const stream = wantStream ? data(rest.shift()) : undefined;
    const record = wantRecord ? data(rest.shift()) : undefined;
    if (stream) syncOutput(s.stream, stream, now);
    if (record) syncOutput(s.record, record, now);
    this.emit('change');
  }
}

function syncOutput(out: ObsOutput, d: Json, now: number): void {
  if (!d.outputActive) {
    // Missed a STOPPED event; don't fight in-flight transitions.
    if (out.state === 'started' || out.state === 'reconnecting') Object.assign(out, { state: 'stopped', durationMs: 0, sampledAt: now, paused: false });
    return;
  }
  if (out.state === 'started' || out.state === 'reconnecting') out.state = d.outputReconnecting ? 'reconnecting' : 'started';
  out.durationMs = d.outputDuration ?? out.durationMs;
  out.sampledAt = now;
  if (d.outputPaused !== undefined) out.paused = !!d.outputPaused;
  if (d.outputCongestion !== undefined) out.congestion = d.outputCongestion;
}

function applyAudio(input: ObsInput, mute: Json | undefined, volume: Json | undefined): void {
  if (!mute) {
    input.audio = false;
    return;
  }
  input.audio = true;
  input.muted = !!mute.inputMuted;
  if (volume) {
    input.volumeMul = volume.inputVolumeMul;
    input.volumeDb = volume.inputVolumeDb;
  }
}

function outputFrom(d: Json | undefined, now: number): ObsOutput {
  if (!d?.outputActive) return { state: 'stopped', durationMs: 0, sampledAt: now };
  return {
    state: d.outputReconnecting ? 'reconnecting' : 'started',
    durationMs: d.outputDuration ?? 0,
    sampledAt: now,
    paused: !!d.outputPaused,
    congestion: d.outputCongestion,
  };
}

async function fetchFullState(obs: ObsCaller): Promise<ObsState> {
  const [version, sceneList, studio, inputList, stream, record, replay, vcam, collections, profiles, transitions, stats] =
    await batch(obs, [
      { requestType: 'GetVersion' },
      { requestType: 'GetSceneList' },
      { requestType: 'GetStudioModeEnabled' },
      { requestType: 'GetInputList' },
      { requestType: 'GetStreamStatus' },
      { requestType: 'GetRecordStatus' },
      { requestType: 'GetReplayBufferStatus' },
      { requestType: 'GetVirtualCamStatus' },
      { requestType: 'GetSceneCollectionList' },
      { requestType: 'GetProfileList' },
      { requestType: 'GetSceneTransitionList' },
      { requestType: 'GetStats' },
    ]);
  const now = Date.now();
  const s = emptyObsState('connecting');

  const v = data(version);
  if (v) s.version = { obs: v.obsVersion, websocket: v.obsWebSocketVersion };
  const sl = data(sceneList);
  if (sl) {
    s.scenes = sortScenes(sl.scenes ?? []);
    s.programScene = sl.currentProgramSceneName ?? undefined;
    s.previewScene = sl.currentPreviewSceneName ?? undefined;
  }
  s.studioMode = !!data(studio)?.studioModeEnabled;
  if (!s.studioMode) s.previewScene = undefined;
  for (const i of (data(inputList)?.inputs ?? []) as Json[]) {
    s.inputs[i.inputName] = { name: i.inputName, uuid: i.inputUuid ?? undefined, kind: i.inputKind, audio: audioCaps(i.inputKindCaps) ?? true };
  }
  s.stream = outputFrom(data(stream), now);
  s.record = outputFrom(data(record), now);
  // These requests fail when the feature isn't set up in OBS (no replay buffer configured, etc.).
  s.replayBuffer = replay?.ok ? { available: true, active: !!replay.data.outputActive } : { available: false, active: false };
  s.virtualCam = vcam?.ok ? { available: true, active: !!vcam.data.outputActive } : { available: false, active: false };
  const c = data(collections);
  if (c) s.collections = { current: c.currentSceneCollectionName, list: c.sceneCollections ?? [] };
  const p = data(profiles);
  if (p) s.profiles = { current: p.currentProfileName, list: p.profiles ?? [] };
  const t = data(transitions);
  if (t) {
    s.transitions = ((t.transitions ?? []) as Json[]).map((x) => x.transitionName);
    s.currentTransition = t.currentSceneTransitionName ?? undefined;
  }
  const st = data(stats);
  if (st) s.stats = mapStats(st);

  // Second round: per-scene items, per-input audio state, and filters for every source.
  const inputs = Object.values(s.inputs).filter((i) => i.audio); // audio===true also means "unknown, probe it"
  const sources = [...s.scenes.map((x) => x.name), ...Object.keys(s.inputs)];
  const details = await batch(obs, [
    ...s.scenes.map((x) => ({ requestType: 'GetSceneItemList', requestData: { sceneName: x.name } })),
    ...inputs.flatMap((i) => [
      { requestType: 'GetInputMute', requestData: { inputName: i.name } },
      { requestType: 'GetInputVolume', requestData: { inputName: i.name } },
    ]),
    ...sources.map((name) => ({ requestType: 'GetSourceFilterList', requestData: { sourceName: name } })),
  ]);
  let k = 0;
  for (const scene of s.scenes) {
    const d = data(details[k++]);
    s.sceneItems[scene.name] = d ? mapSceneItems(d.sceneItems ?? []) : [];
  }
  for (const input of inputs) {
    applyAudio(input, data(details[k++]), data(details[k++]));
  }
  for (const name of sources) {
    const d = data(details[k++]);
    s.filters[name] = d ? mapFilters(d.filters ?? []) : [];
  }

  // Third round: items inside groups (a group is listed as an item with isGroup).
  const groups = [...new Set(Object.values(s.sceneItems).flat().filter((i) => i.isGroup).map((i) => i.source))];
  s.groups = groups;
  const groupItems = await batch(
    obs,
    groups.map((g) => ({ requestType: 'GetGroupSceneItemList', requestData: { sceneName: g } })),
  );
  groups.forEach((g, i) => {
    const d = data(groupItems[i]);
    s.sceneItems[g] = d ? mapSceneItems(d.sceneItems ?? []) : [];
  });

  return s;
}
