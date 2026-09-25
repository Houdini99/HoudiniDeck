// Everything the editor and the button renderer need to know about each action type.
// Adding an action type = schema entry (schema.ts) + meta entry (here) + executor (server).
import { followedPlayer, type ExtState, type StatMetric } from './ext-types.ts';
import { prettyHotkey } from './format.ts';
import { resolveInput, resolveScene, resolveSceneItem } from './obs-resolve.ts';
import type { ObsState } from './obs-types.ts';
import type { Action, ActionOf, ActionType, Deck, IconRef } from './schema.ts';

export const COLORS = {
  bg: '#1c2030',
  fg: '#eef1f8',
  red: '#d33d3d',
  green: '#2e9d5c',
  blue: '#3868d6',
  amber: '#c98714',
  purple: '#7c52d8',
  teal: '#16968f',
  pink: '#c2477f',
  slate: '#3b4256',
} as const;

/** display: shows something (e.g. CPU load); tapping does nothing. */
export type Behavior = 'press' | 'hold' | 'fader' | 'nav' | 'display';

export const CATEGORIES = [
  'Scenes & Sources',
  'Audio',
  'Outputs',
  'Studio Mode',
  'More OBS',
  'Media',
  'System',
  'Integrations',
  'Macros',
  'Navigation',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type FieldKind =
  | 'scene'
  | 'sceneOrGroup'
  | 'sceneItem'
  | 'audioInput'
  | 'mediaInput'
  | 'filterSource'
  | 'anySource'
  | 'filter'
  | 'select'
  | 'number'
  | 'text'
  | 'url'
  | 'multiline'
  | 'headers'
  | 'checkbox'
  | 'mediaPlayer'
  | 'macroSteps'
  | 'page'
  | 'hotkey'
  | 'collection'
  | 'profile'
  | 'transition';

/** Field kinds whose value is an ObsRef ({ name, uuid? }) rather than a string or number. */
export const REF_KINDS: ReadonlySet<FieldKind> = new Set([
  'scene',
  'sceneOrGroup',
  'sceneItem',
  'audioInput',
  'mediaInput',
  'filterSource',
  'anySource',
]);

export interface FieldDef<T extends ActionType = ActionType> {
  key: string;
  label: string;
  kind: FieldKind;
  options?: { value: string; label: string }[];
  optional?: boolean;
  /** Key of the field this one's choices depend on (e.g. a source list depends on the scene). */
  dependsOn?: string;
  /** Hide the field (and don't require it) unless this returns true, e.g. no body for GET requests. */
  show?: (a: ActionOf<T>) => boolean;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** Label of the empty choice in an optional select (default "(none)"). */
  emptyLabel?: string;
  hint?: string;
}

export interface LabelCtx {
  obs?: ObsState;
  deck?: Deck;
  ext?: ExtState;
}

type Spec<T extends ActionType, V> = V | ((a: ActionOf<T>) => V);

export interface ActionMeta<T extends ActionType = ActionType> {
  type: T;
  label: string;
  description: string;
  category: Category;
  icon: Spec<T, IconRef>;
  activeIcon?: Spec<T, IconRef>;
  activeBg?: Spec<T, string | undefined>;
  /** Defaults to 'press'. */
  behavior?: Spec<T, Behavior>;
  fields: FieldDef<T>[];
  create: () => ActionOf<T>;
  autoLabel: (a: ActionOf<T>, ctx: LabelCtx) => string;
  confirmByDefault?: boolean;
  /** Only works when the server allows commands (STREAMDECK_ENABLE_COMMANDS=1). */
  needsCommands?: boolean;
}

const mdi = (name: string): IconRef => ({ set: 'mdi', name });
const noRef = () => ({ name: '' });

const TOGGLE_START_STOP = [
  { value: 'toggle', label: 'Toggle' },
  { value: 'start', label: 'Start' },
  { value: 'stop', label: 'Stop' },
];

const MEDIA_ICONS: Record<ActionOf<'obs.media'>['action'], string> = {
  playPause: 'play-pause',
  play: 'play',
  pause: 'pause',
  restart: 'restart',
  stop: 'stop',
  next: 'skip-next',
  previous: 'skip-previous',
};

const MEDIA_LABELS: Record<ActionOf<'obs.media'>['action'], string> = {
  playPause: 'Play/Pause',
  play: 'Play',
  pause: 'Pause',
  restart: 'Restart',
  stop: 'Stop',
  next: 'Next',
  previous: 'Previous',
};

const inputName = (ref: { name: string; uuid?: string }, obs?: ObsState) =>
  (obs && resolveInput(obs, ref)?.name) || ref.name;

const PLAYER_COMMANDS: Record<ActionOf<'media.player'>['command'], { label: string; icon: string }> = {
  playPause: { label: 'Play/Pause', icon: 'play' },
  next: { label: 'Next Track', icon: 'skip-next' },
  previous: { label: 'Previous Track', icon: 'skip-previous' },
  stop: { label: 'Stop', icon: 'stop' },
};

const VOLUME_TARGETS = { output: 'Speakers', input: 'Mic' } as const;

export const STATS: Record<StatMetric, { label: string; option: string; icon: string }> = {
  cpu: { label: 'CPU', option: 'CPU load', icon: 'cpu-64-bit' },
  memory: { label: 'RAM', option: 'Memory (RAM) in use', icon: 'memory' },
  cpuTemp: { label: 'CPU temp', option: 'CPU temperature', icon: 'thermometer' },
  gpu: { label: 'GPU', option: 'GPU load (NVIDIA)', icon: 'expansion-card' },
  gpuTemp: { label: 'GPU temp', option: 'GPU temperature (NVIDIA)', icon: 'thermometer' },
  gpuMemory: { label: 'VRAM', option: 'GPU memory in use (NVIDIA)', icon: 'expansion-card-variant' },
};

function volumeIcon(a: ActionOf<'system.volume'>, muted: boolean): IconRef {
  if (a.mode === 'step') return mdi((a.step ?? 5) >= 0 ? 'volume-plus' : 'volume-minus');
  if (a.target === 'input') return mdi(muted ? 'microphone-off' : 'microphone');
  return mdi(muted ? 'volume-off' : 'volume-high');
}

function urlHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

type MetaTable = { [T in ActionType]: ActionMeta<T> };

export const ACTION_META: MetaTable = {
  'obs.scene': {
    type: 'obs.scene',
    label: 'Switch Scene',
    description: 'Show a scene. In Studio Mode it goes to Preview first (Auto).',
    category: 'Scenes & Sources',
    icon: mdi('monitor'),
    fields: [
      { key: 'scene', label: 'Scene', kind: 'scene' },
      {
        key: 'target',
        label: 'Target',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Auto (Preview in Studio Mode)' },
          { value: 'program', label: 'Program (live)' },
          { value: 'preview', label: 'Preview' },
        ],
      },
    ],
    create: () => ({ type: 'obs.scene', scene: noRef(), target: 'auto' }),
    autoLabel: (a, { obs }) => (obs && resolveScene(obs, a.scene)?.name) || a.scene.name || 'Scene',
  },
  'obs.sceneItem': {
    type: 'obs.sceneItem',
    label: 'Source Visibility',
    description: 'Show or hide a source inside a scene.',
    category: 'Scenes & Sources',
    icon: mdi('eye-off'),
    activeIcon: mdi('eye'),
    activeBg: COLORS.blue,
    fields: [
      { key: 'scene', label: 'Scene or group', kind: 'sceneOrGroup' },
      { key: 'source', label: 'Source', kind: 'sceneItem', dependsOn: 'scene' },
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        options: [
          { value: 'toggle', label: 'Toggle' },
          { value: 'show', label: 'Show' },
          { value: 'hide', label: 'Hide' },
        ],
      },
    ],
    create: () => ({ type: 'obs.sceneItem', scene: noRef(), source: noRef(), mode: 'toggle' }),
    autoLabel: (a, { obs }) =>
      (obs && resolveSceneItem(obs, a.scene, a.source)?.item.source) || a.source.name || 'Source',
  },
  'obs.filter': {
    type: 'obs.filter',
    label: 'Filter Toggle',
    description: 'Enable or disable a filter on a source or scene.',
    category: 'Scenes & Sources',
    icon: mdi('auto-fix'),
    activeBg: COLORS.blue,
    fields: [
      { key: 'source', label: 'Source or scene', kind: 'filterSource' },
      { key: 'filter', label: 'Filter', kind: 'filter', dependsOn: 'source' },
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        options: [
          { value: 'toggle', label: 'Toggle' },
          { value: 'enable', label: 'Enable' },
          { value: 'disable', label: 'Disable' },
        ],
      },
    ],
    create: () => ({ type: 'obs.filter', source: noRef(), filter: '', mode: 'toggle' }),
    autoLabel: (a) => a.filter || 'Filter',
  },
  'obs.mute': {
    type: 'obs.mute',
    label: 'Mute / Push-to-talk',
    description: 'Mute or unmute an audio input, or hold to talk / hold to mute.',
    category: 'Audio',
    icon: (a) => mdi(a.mode === 'pushToTalk' ? 'microphone-off' : 'microphone'),
    activeIcon: (a) => mdi(a.mode === 'pushToTalk' ? 'microphone' : 'microphone-off'),
    activeBg: (a) => (a.mode === 'pushToTalk' ? COLORS.green : COLORS.red),
    behavior: (a) => (a.mode === 'pushToTalk' || a.mode === 'pushToMute' ? 'hold' : 'press'),
    fields: [
      { key: 'input', label: 'Audio input', kind: 'audioInput' },
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        options: [
          { value: 'toggle', label: 'Toggle mute' },
          { value: 'mute', label: 'Mute' },
          { value: 'unmute', label: 'Unmute' },
          { value: 'pushToTalk', label: 'Push to talk (hold)' },
          { value: 'pushToMute', label: 'Push to mute (hold)' },
        ],
      },
    ],
    create: () => ({ type: 'obs.mute', input: noRef(), mode: 'toggle' }),
    autoLabel: (a, { obs }) => inputName(a.input, obs) || 'Mic',
  },
  'obs.volume': {
    type: 'obs.volume',
    label: 'Volume Fader',
    description: 'Drag up or down to change the volume. Tap to mute. Shows a live level meter.',
    category: 'Audio',
    icon: mdi('volume-high'),
    behavior: 'fader',
    fields: [{ key: 'input', label: 'Audio input', kind: 'audioInput' }],
    create: () => ({ type: 'obs.volume', input: noRef() }),
    autoLabel: (a, { obs }) => inputName(a.input, obs) || 'Volume',
  },
  'obs.volumeStep': {
    type: 'obs.volumeStep',
    label: 'Volume Step',
    description: 'Raise or lower an input by a fixed number of dB.',
    category: 'Audio',
    icon: (a) => mdi(a.db >= 0 ? 'volume-plus' : 'volume-minus'),
    fields: [
      { key: 'input', label: 'Audio input', kind: 'audioInput' },
      { key: 'db', label: 'Step (dB)', kind: 'number', min: -30, max: 30, step: 1 },
    ],
    create: () => ({ type: 'obs.volumeStep', input: noRef(), db: 3 }),
    autoLabel: (a, { obs }) => `${inputName(a.input, obs)} ${a.db > 0 ? '+' : ''}${a.db} dB`,
  },
  'obs.stream': {
    type: 'obs.stream',
    label: 'Stream',
    description: 'Start or stop streaming. Shows LIVE and the stream time.',
    category: 'Outputs',
    icon: mdi('broadcast'),
    activeBg: COLORS.red,
    confirmByDefault: true,
    fields: [{ key: 'mode', label: 'Mode', kind: 'select', options: TOGGLE_START_STOP }],
    create: () => ({ type: 'obs.stream', mode: 'toggle' }),
    autoLabel: (a) => ({ toggle: 'Stream', start: 'Go Live', stop: 'End Stream' })[a.mode],
  },
  'obs.record': {
    type: 'obs.record',
    label: 'Record',
    description: 'Start, stop or pause recording, split the file or add a chapter marker.',
    category: 'Outputs',
    icon: (a) =>
      mdi({ toggle: 'record-rec', start: 'record-rec', stop: 'stop', pause: 'pause', split: 'content-cut', chapter: 'bookmark-plus' }[a.mode]),
    activeIcon: (a) => (a.mode === 'pause' ? mdi('play') : mdi({ toggle: 'record-rec', start: 'record-rec', stop: 'stop', split: 'content-cut', chapter: 'bookmark-plus' }[a.mode])),
    activeBg: (a) => (a.mode === 'pause' ? COLORS.amber : a.mode === 'split' || a.mode === 'chapter' ? undefined : COLORS.red),
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        options: [
          ...TOGGLE_START_STOP,
          { value: 'pause', label: 'Pause / resume' },
          { value: 'split', label: 'Split file' },
          { value: 'chapter', label: 'Add chapter marker' },
        ],
      },
    ],
    create: () => ({ type: 'obs.record', mode: 'toggle' }),
    autoLabel: (a) =>
      ({ toggle: 'Record', start: 'Start Rec', stop: 'Stop Rec', pause: 'Pause Rec', split: 'Split File', chapter: 'Chapter' })[a.mode],
  },
  'obs.replay': {
    type: 'obs.replay',
    label: 'Replay Buffer',
    description: 'Start or stop the replay buffer, or save a replay.',
    category: 'Outputs',
    icon: (a) => mdi(a.mode === 'save' ? 'content-save' : 'replay'),
    activeBg: (a) => (a.mode === 'save' ? undefined : COLORS.teal),
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        options: [...TOGGLE_START_STOP, { value: 'save', label: 'Save replay' }],
      },
    ],
    create: () => ({ type: 'obs.replay', mode: 'save' }),
    autoLabel: (a) => (a.mode === 'save' ? 'Save Replay' : 'Replay Buffer'),
  },
  'obs.virtualCam': {
    type: 'obs.virtualCam',
    label: 'Virtual Camera',
    description: 'Start or stop the OBS virtual camera.',
    category: 'Outputs',
    icon: mdi('webcam'),
    activeBg: COLORS.purple,
    fields: [{ key: 'mode', label: 'Mode', kind: 'select', options: TOGGLE_START_STOP }],
    create: () => ({ type: 'obs.virtualCam', mode: 'toggle' }),
    autoLabel: () => 'Virtual Cam',
  },
  'obs.studioMode': {
    type: 'obs.studioMode',
    label: 'Studio Mode',
    description: 'Turn Studio Mode (preview/program) on or off.',
    category: 'Studio Mode',
    icon: mdi('view-split-vertical'),
    activeBg: COLORS.amber,
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        options: [
          { value: 'toggle', label: 'Toggle' },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ],
      },
    ],
    create: () => ({ type: 'obs.studioMode', mode: 'toggle' }),
    autoLabel: () => 'Studio Mode',
  },
  'obs.transition': {
    type: 'obs.transition',
    label: 'Transition',
    description: 'Send Preview to Program. A chosen transition also becomes OBS’s selected one.',
    category: 'Studio Mode',
    icon: mdi('transition'),
    fields: [
      { key: 'transition', label: 'Transition', kind: 'transition', optional: true, hint: 'Leave empty to use the current one' },
      { key: 'durationMs', label: 'Duration (ms)', kind: 'number', optional: true, min: 0, max: 20000, step: 50 },
    ],
    create: () => ({ type: 'obs.transition' }),
    autoLabel: (a) => a.transition || 'Transition',
  },
  'obs.screenshot': {
    type: 'obs.screenshot',
    label: 'Screenshot',
    description: 'Save a PNG of the program scene (or a chosen source) to ~/Pictures/OBS.',
    category: 'More OBS',
    icon: mdi('camera'),
    fields: [{ key: 'source', label: 'Source', kind: 'anySource', optional: true, hint: 'Empty = current program scene' }],
    create: () => ({ type: 'obs.screenshot' }),
    autoLabel: () => 'Screenshot',
  },
  'obs.media': {
    type: 'obs.media',
    label: 'Media Control',
    description: 'Play, pause or restart a media source.',
    category: 'More OBS',
    icon: (a) => mdi(MEDIA_ICONS[a.action]),
    fields: [
      { key: 'input', label: 'Media source', kind: 'mediaInput' },
      {
        key: 'action',
        label: 'Action',
        kind: 'select',
        options: Object.entries(MEDIA_LABELS).map(([value, label]) => ({ value, label })),
      },
    ],
    create: () => ({ type: 'obs.media', input: noRef(), action: 'playPause' }),
    autoLabel: (a, { obs }) => `${MEDIA_LABELS[a.action]} ${inputName(a.input, obs)}`.trim(),
  },
  'obs.hotkey': {
    type: 'obs.hotkey',
    label: 'OBS Hotkey',
    description: 'Trigger any OBS hotkey action by name.',
    category: 'More OBS',
    icon: mdi('keyboard'),
    fields: [{ key: 'name', label: 'Hotkey', kind: 'hotkey' }],
    create: () => ({ type: 'obs.hotkey', name: '' }),
    autoLabel: (a) => (a.name ? prettyHotkey(a.name) : 'Hotkey'),
  },
  'obs.collection': {
    type: 'obs.collection',
    label: 'Scene Collection',
    description: 'Switch to another scene collection.',
    category: 'More OBS',
    icon: mdi('folder-multiple'),
    activeBg: COLORS.slate,
    fields: [{ key: 'name', label: 'Scene collection', kind: 'collection' }],
    create: () => ({ type: 'obs.collection', name: '' }),
    autoLabel: (a) => a.name || 'Collection',
  },
  'obs.profile': {
    type: 'obs.profile',
    label: 'Profile',
    description: 'Switch to another OBS profile.',
    category: 'More OBS',
    icon: mdi('account-cog'),
    activeBg: COLORS.slate,
    fields: [{ key: 'name', label: 'Profile', kind: 'profile' }],
    create: () => ({ type: 'obs.profile', name: '' }),
    autoLabel: (a) => a.name || 'Profile',
  },
  'media.player': {
    type: 'media.player',
    label: 'Media Keys',
    description: 'Play, pause or skip music and videos playing on the PC (Spotify, browsers, VLC, …).',
    category: 'Media',
    icon: (a) => mdi(PLAYER_COMMANDS[a.command].icon),
    activeIcon: (a) => mdi(a.command === 'playPause' ? 'pause' : PLAYER_COMMANDS[a.command].icon),
    fields: [
      {
        key: 'command',
        label: 'Command',
        kind: 'select',
        options: Object.entries(PLAYER_COMMANDS).map(([value, c]) => ({ value, label: c.label })),
      },
      {
        key: 'player',
        label: 'Player',
        kind: 'mediaPlayer',
        optional: true,
        emptyLabel: 'Whichever played last',
        placeholder: 'e.g. spotify (empty: whichever played last)',
      },
      { key: 'nowPlaying', label: 'Show the song and cover art', kind: 'checkbox' },
    ],
    create: () => ({ type: 'media.player', command: 'playPause', nowPlaying: true }),
    autoLabel: (a, { ext }) => (a.nowPlaying && ext && followedPlayer(ext, a.player)?.title) || PLAYER_COMMANDS[a.command].label,
  },
  'system.volume': {
    type: 'system.volume',
    label: 'System Volume',
    description: 'Mute or change the PC’s speakers or microphone (its default devices), or use a fader.',
    category: 'System',
    icon: (a) => volumeIcon(a, false),
    activeIcon: (a) => volumeIcon(a, true),
    activeBg: (a) => (a.mode === 'step' ? undefined : COLORS.red),
    behavior: (a) => (a.mode === 'fader' ? 'fader' : 'press'),
    fields: [
      {
        key: 'target',
        label: 'Device',
        kind: 'select',
        options: [
          { value: 'output', label: 'Speakers / headphones (default output)' },
          { value: 'input', label: 'Microphone (default input)' },
        ],
      },
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        options: [
          { value: 'toggleMute', label: 'Toggle mute' },
          { value: 'mute', label: 'Mute' },
          { value: 'unmute', label: 'Unmute' },
          { value: 'step', label: 'Volume up or down' },
          { value: 'fader', label: 'Fader (drag; tap to mute)' },
        ],
      },
      {
        key: 'step',
        label: 'Step (%)',
        kind: 'number',
        min: -50,
        max: 50,
        step: 1,
        show: (a) => a.mode === 'step',
        hint: 'Negative numbers turn it down.',
      },
    ],
    create: () => ({ type: 'system.volume', target: 'output', mode: 'toggleMute' }),
    autoLabel: (a) => {
      const name = VOLUME_TARGETS[a.target];
      if (a.mode !== 'step') return name;
      const step = a.step ?? 5;
      return `${name} ${step >= 0 ? '+' : ''}${step}%`;
    },
  },
  'system.stats': {
    type: 'system.stats',
    label: 'System Stats',
    description: 'Show the PC’s CPU or GPU load, temperature or memory use, updated every 2 seconds. Tapping it does nothing.',
    category: 'System',
    icon: (a) => mdi(STATS[a.metric].icon),
    behavior: 'display',
    fields: [
      {
        key: 'metric',
        label: 'Show',
        kind: 'select',
        options: Object.entries(STATS).map(([value, s]) => ({ value, label: s.option })),
      },
    ],
    create: () => ({ type: 'system.stats', metric: 'cpu' }),
    autoLabel: (a) => STATS[a.metric].label,
  },
  'system.command': {
    type: 'system.command',
    label: 'Run Command',
    description: 'Run a command on the PC, e.g. start an app or a script.',
    category: 'System',
    icon: mdi('console'),
    needsCommands: true,
    fields: [
      {
        key: 'command',
        label: 'Command',
        kind: 'multiline',
        placeholder: 'e.g. ~/bin/lights-on.sh',
        hint: 'Runs with sh -c in your home folder.',
      },
      {
        key: 'detached',
        label: 'Start an app (don’t wait for it)',
        kind: 'checkbox',
        hint: 'For programs that keep running, like a browser or a game.',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        kind: 'number',
        optional: true,
        min: 1000,
        max: 600000,
        step: 1000,
        placeholder: '30000',
        show: (a) => !a.detached,
        hint: 'The command is stopped if it takes longer.',
      },
    ],
    create: () => ({ type: 'system.command', command: '' }),
    autoLabel: (a) => a.command.trim().split(/\s+/)[0]?.split('/').pop() || 'Command',
  },
  'http.request': {
    type: 'http.request',
    label: 'Webhook',
    description: 'Send an HTTP request, e.g. to Home Assistant, Streamer.bot or a Philips Hue bridge.',
    category: 'Integrations',
    icon: mdi('webhook'),
    fields: [
      {
        key: 'method',
        label: 'Method',
        kind: 'select',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })),
      },
      { key: 'url', label: 'URL', kind: 'url', placeholder: 'http://homeassistant.local:8123/api/webhook/…' },
      {
        key: 'body',
        label: 'Body',
        kind: 'multiline',
        optional: true,
        show: (a) => a.method !== 'GET',
        placeholder: '{"entity_id": "light.desk"}',
        hint: 'Valid JSON is sent as application/json unless you set a Content-Type header.',
      },
      {
        key: 'headers',
        label: 'Headers',
        kind: 'headers',
        optional: true,
        hint: 'Saved in the deck, so every paired device can read them (and so can backups).',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        kind: 'number',
        optional: true,
        min: 500,
        max: 60000,
        step: 500,
        placeholder: '10000',
      },
    ],
    create: () => ({ type: 'http.request', method: 'POST', url: '' }),
    autoLabel: (a) => urlHost(a.url) || 'Webhook',
  },
  macro: {
    type: 'macro',
    label: 'Macro',
    description: 'Run several actions in a row, with pauses if you like (e.g. switch scene, unmute the mic, start recording).',
    category: 'Macros',
    icon: mdi('playlist-play'),
    fields: [
      { key: 'steps', label: 'Steps', kind: 'macroSteps' },
      {
        key: 'stopOnError',
        label: 'Stop when a step fails',
        kind: 'checkbox',
        hint: 'Otherwise the remaining steps still run.',
      },
    ],
    create: () => ({ type: 'macro', steps: [], stopOnError: true }),
    autoLabel: () => 'Macro',
  },
  'deck.page': {
    type: 'deck.page',
    label: 'Open Page / Folder',
    description: 'Go to another page of this deck.',
    category: 'Navigation',
    icon: mdi('folder'),
    behavior: 'nav',
    fields: [{ key: 'pageId', label: 'Page', kind: 'page' }],
    create: () => ({ type: 'deck.page', pageId: '' }),
    autoLabel: (a, { deck }) => deck?.pages.find((p) => p.id === a.pageId)?.name ?? 'Page',
  },
  'deck.back': {
    type: 'deck.back',
    label: 'Back',
    description: 'Return to the previous page.',
    category: 'Navigation',
    icon: mdi('arrow-left'),
    behavior: 'nav',
    fields: [],
    create: () => ({ type: 'deck.back' }),
    autoLabel: () => 'Back',
  },
};

// The table is keyed per type; these helpers erase that to work on any Action.
const metaFor = (action: Action) => ACTION_META[action.type] as unknown as ActionMeta<ActionType>;
const pick = <V>(spec: Spec<ActionType, V> | undefined, action: Action): V | undefined =>
  typeof spec === 'function' ? (spec as (a: Action) => V)(action) : spec;

export const ACTION_TYPES = Object.keys(ACTION_META) as ActionType[];

/** The action types this server can run (Run Command only when commands are allowed). */
export function availableActionTypes(commands: boolean): ActionType[] {
  return ACTION_TYPES.filter((t) => commands || !ACTION_META[t].needsCommands);
}

export function actionMeta(type: ActionType): ActionMeta<ActionType> {
  return ACTION_META[type] as unknown as ActionMeta<ActionType>;
}

export function actionBehavior(action: Action): Behavior {
  return pick(metaFor(action).behavior, action) ?? 'press';
}

export function actionAutoLabel(action: Action, ctx: LabelCtx): string {
  return metaFor(action).autoLabel(action, ctx);
}

export function actionIcon(action: Action): IconRef {
  return pick(metaFor(action).icon, action)!;
}

export function actionActiveIcon(action: Action): IconRef | undefined {
  return pick(metaFor(action).activeIcon, action);
}

export function actionActiveBg(action: Action): string | undefined {
  return pick(metaFor(action).activeBg, action);
}

/** Fields the editor shows for this action right now (some depend on other fields). */
export function visibleFields(action: Action): FieldDef[] {
  return metaFor(action).fields.filter((f) => !f.show || f.show(action));
}

/** Names of required fields that are still empty (the editor blocks saving until they're set). */
export function missingFields(action: Action): string[] {
  const values = action as unknown as Record<string, unknown>;
  const missing = visibleFields(action)
    .filter((f) => !f.optional)
    .filter((f) => {
      const v = values[f.key];
      if (REF_KINDS.has(f.kind)) return !(v as { name?: string } | undefined)?.name;
      if (f.kind === 'number') return typeof v !== 'number' || Number.isNaN(v);
      if (f.kind === 'checkbox') return false;
      if (f.kind === 'macroSteps') return !Array.isArray(v) || v.length === 0;
      return typeof v !== 'string' || v === '';
    })
    .map((f) => f.label);
  if (action.type === 'macro') {
    action.steps.forEach((step, i) => {
      if ('action' in step) missing.push(...missingFields(step.action).map((name) => `step ${i + 1} ${name.toLowerCase()}`));
    });
  }
  return missing;
}

