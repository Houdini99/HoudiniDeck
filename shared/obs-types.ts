// Mirror of the OBS state the server keeps and pushes to every browser.

export type ObsConnection = 'disconnected' | 'connecting' | 'connected' | 'auth-failed';
export type OutputState = 'stopped' | 'starting' | 'started' | 'stopping' | 'reconnecting';

export interface ObsSceneInfo {
  name: string;
  uuid?: string;
}

export interface ObsSceneItem {
  id: number;
  source: string;
  sourceUuid?: string;
  enabled: boolean;
  isGroup: boolean;
}

export interface ObsInput {
  name: string;
  uuid?: string;
  kind: string;
  audio: boolean;
  muted?: boolean;
  volumeMul?: number;
  volumeDb?: number;
}

export interface ObsFilter {
  name: string;
  enabled: boolean;
  kind?: string;
}

export interface ObsOutput {
  state: OutputState;
  /** Output duration in ms as of `sampledAt` (server clock). */
  durationMs: number;
  sampledAt: number;
  paused?: boolean;
  reconnecting?: boolean;
  congestion?: number;
  /** Streaming only: bytes sent so far, the bitrate between the last two readings, and network-dropped frames. */
  bytes?: number;
  bitrateKbps?: number;
  skippedFrames?: number;
  totalFrames?: number;
}

export interface ObsStats {
  cpu: number;
  memoryMb: number;
  fps: number;
  renderSkipped: number;
  renderTotal: number;
  outputSkipped: number;
  outputTotal: number;
}

export interface ObsState {
  connection: ObsConnection;
  error?: string;
  url?: string;
  version?: { obs: string; websocket: string };
  scenes: ObsSceneInfo[];
  groups: string[];
  programScene?: string;
  previewScene?: string;
  studioMode: boolean;
  /** Scene items keyed by scene (or group) name, in OBS UI order (top first). */
  sceneItems: Record<string, ObsSceneItem[]>;
  /** Inputs keyed by input name. */
  inputs: Record<string, ObsInput>;
  /** Filters keyed by source (input or scene) name. */
  filters: Record<string, ObsFilter[]>;
  stream: ObsOutput;
  record: ObsOutput;
  replayBuffer: { available: boolean; active: boolean };
  virtualCam: { available: boolean; active: boolean };
  transitions: string[];
  currentTransition?: string;
  collections: { current?: string; list: string[] };
  profiles: { current?: string; list: string[] };
  stats?: ObsStats;
}

export function emptyOutput(now = 0): ObsOutput {
  return { state: 'stopped', durationMs: 0, sampledAt: now };
}

export function emptyObsState(connection: ObsConnection = 'disconnected'): ObsState {
  return {
    connection,
    scenes: [],
    groups: [],
    studioMode: false,
    sceneItems: {},
    inputs: {},
    filters: {},
    stream: emptyOutput(),
    record: emptyOutput(),
    replayBuffer: { available: false, active: false },
    virtualCam: { available: false, active: false },
    transitions: [],
    collections: { list: [] },
    profiles: { list: [] },
  };
}

/** Media inputs that respond to TriggerMediaInputAction. */
export const MEDIA_INPUT_KINDS = ['ffmpeg_source', 'vlc_source'];

/** OBS's text sources: Text (GDI+) on Windows, Text (FreeType 2) on Linux, in all their versions. */
export function isTextInputKind(kind: string): boolean {
  return /^text_(gdiplus|ft2_source)/.test(kind);
}

export const BROWSER_INPUT_KIND = 'browser_source';

/** What an OBS Stats tile can show. */
export const OBS_STAT_METRICS = ['fps', 'cpu', 'bitrate', 'dropped', 'render', 'encode'] as const;
export type ObsStatMetric = (typeof OBS_STAT_METRICS)[number];
