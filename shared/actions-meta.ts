// Everything the editor and the button renderer need to know about each action type.
// Adding an action type = schema entry (schema.ts) + meta entry (here) + executor (server).
import { followedPlayer, type ExtState, type StatMetric } from './ext-types.ts';
import { formatClock, prettyHotkey } from './format.ts';
import { shortcutLabel } from './keys.ts';
import { resolveInput, resolveScene, resolveSceneItem } from './obs-resolve.ts';
import type { ObsStatMetric, ObsState } from './obs-types.ts';
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
  'Timers & Counters',
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
  | 'textInput'
  | 'browserInput'
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
  | 'sound'
  | 'duration'
  | 'action'
  | 'targetButton'
  | 'macroSteps'
  | 'keys'
  | 'kdeComponent'
  | 'kdeShortcut'
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
  'textInput',
  'browserInput',
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
  /** Only works when Run Command buttons are turned on (Settings, on the PC itself). */
  needsCommands?: boolean;
  /** The operating systems (Node's process.platform) where the server can run it; unset means all. */
  platforms?: readonly string[];
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

export const OBS_STATS: Record<ObsStatMetric, { label: string; option: string; icon: string }> = {
  dropped: { label: 'Dropped', option: 'Dropped frames (network, while live)', icon: 'network-strength-2-alert' },
  bitrate: { label: 'Bitrate', option: 'Stream bitrate (while live)', icon: 'speedometer' },
  fps: { label: 'FPS', option: 'Frames per second', icon: 'filmstrip' },
  cpu: { label: 'OBS CPU', option: 'OBS’s CPU use', icon: 'cpu-64-bit' },
  render: { label: 'Render lag', option: 'Frames missed because of rendering lag', icon: 'monitor-dashboard' },
  encode: { label: 'Encode lag', option: 'Frames skipped because of encoding lag', icon: 'chip' },
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

/** The program a command starts, without its folder: "lights-on.sh" for ~/bin/lights-on.sh, "obs64.exe" for "C:\…\obs64.exe". */
function commandName(command: string): string {
  const first = /^\s*(?:"([^"]*)"|(\S+))/.exec(command);
  const program = first?.[1] ?? first?.[2] ?? '';
  return program.split(/[\\/]/).pop() ?? '';
}

const signed = (n: number) => (n >= 0 ? `+${n}` : `−${-n}`);

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
      {
        key: 'preview',
        label: 'Show a live picture of the scene',
        kind: 'checkbox',
        hint: 'Updated every 2 seconds while the button is on a screen. OBS renders each picture, which costs it a little GPU and CPU.',
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
  'obs.text': {
    type: 'obs.text',
    label: 'Set Text',
    description: 'Replace what a text source shows, e.g. a “Back in 5 minutes” message or today’s topic.',
    category: 'Scenes & Sources',
    icon: mdi('format-text'),
    fields: [
      { key: 'input', label: 'Text source', kind: 'textInput' },
      { key: 'text', label: 'Text', kind: 'multiline', optional: true, placeholder: 'e.g. Back in 5 minutes', hint: 'Empty clears the text.' },
    ],
    create: () => ({ type: 'obs.text', input: noRef(), text: '' }),
    autoLabel: (a, { obs }) => (a.text ?? '').split('\n')[0].trim().slice(0, 40) || inputName(a.input, obs) || 'Set Text',
  },
  'obs.browserRefresh': {
    type: 'obs.browserRefresh',
    label: 'Refresh Browser Source',
    description: 'Reload a browser source without its cache, e.g. when alerts or chat get stuck.',
    category: 'Scenes & Sources',
    icon: mdi('web-refresh'),
    fields: [{ key: 'input', label: 'Browser source', kind: 'browserInput' }],
    create: () => ({ type: 'obs.browserRefresh', input: noRef() }),
    autoLabel: (a, { obs }) => inputName(a.input, obs) || 'Refresh',
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
  'obs.stats': {
    type: 'obs.stats',
    label: 'OBS Stats',
    description: 'Show how the stream is doing: dropped frames, bitrate, frame rate, OBS’s CPU use or lag. Tapping it does nothing.',
    category: 'More OBS',
    icon: (a) => mdi(OBS_STATS[a.metric].icon),
    behavior: 'display',
    fields: [
      {
        key: 'metric',
        label: 'Show',
        kind: 'select',
        options: Object.entries(OBS_STATS).map(([value, s]) => ({ value, label: s.option })),
      },
    ],
    create: () => ({ type: 'obs.stats', metric: 'dropped' }),
    autoLabel: (a) => OBS_STATS[a.metric].label,
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
    platforms: ['linux', 'win32'],
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
  'sound.play': {
    type: 'sound.play',
    label: 'Play Sound',
    description: 'Play a sound clip (MP3 or WAV) on the PC’s speakers, like a soundboard. OBS hears it through Desktop Audio.',
    category: 'Media',
    platforms: ['linux', 'win32'],
    icon: mdi('music-note'),
    activeIcon: (a) => mdi(a.mode === 'toggle' ? 'stop' : 'music-note'),
    activeBg: COLORS.teal,
    fields: [
      { key: 'sound', label: 'Sound', kind: 'sound' },
      { key: 'volume', label: 'Volume (%)', kind: 'number', optional: true, min: 1, max: 100, step: 1, placeholder: '100' },
      {
        key: 'mode',
        label: 'Pressed again while it plays',
        kind: 'select',
        options: [
          { value: 'toggle', label: 'Stop it' },
          { value: 'restart', label: 'Start it over' },
          { value: 'overlap', label: 'Play it once more on top' },
        ],
      },
    ],
    create: () => ({ type: 'sound.play', sound: '', mode: 'toggle' }),
    autoLabel: (a) => a.name?.replace(/\.[^.]*$/, '') || 'Sound',
  },
  'sound.stop': {
    type: 'sound.stop',
    label: 'Stop All Sounds',
    description: 'Stop every sound the deck is playing. Lights up while any plays.',
    category: 'Media',
    platforms: ['linux', 'win32'],
    icon: mdi('volume-off'),
    activeBg: COLORS.teal,
    fields: [],
    create: () => ({ type: 'sound.stop' }),
    autoLabel: () => 'Stop Sounds',
  },
  'system.volume': {
    type: 'system.volume',
    label: 'System Volume',
    description: 'Mute or change the PC’s speakers or microphone (its default devices), or use a fader.',
    category: 'System',
    platforms: ['linux', 'win32'],
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
  'system.hotkey': {
    type: 'system.hotkey',
    label: 'Keyboard Shortcut',
    description: 'Press keys on the PC, e.g. an app’s shortcut. Can hold them while you hold the button.',
    category: 'System',
    platforms: ['linux', 'win32'],
    icon: mdi('keyboard-outline'),
    behavior: (a) => (a.hold ? 'hold' : 'press'),
    fields: [
      {
        key: 'keys',
        label: 'Keys',
        kind: 'keys',
        hint: 'Keys go by their position on a US keyboard (on a German one, Y and Z swap). Recording on your keyboard gets it right.',
      },
      { key: 'hold', label: 'Hold the keys while the button is held', kind: 'checkbox', hint: 'For push-to-talk and the like.' },
    ],
    create: () => ({ type: 'system.hotkey', keys: [] }),
    autoLabel: (a) => shortcutLabel(a.keys) || 'Shortcut',
  },
  'kde.shortcut': {
    type: 'kde.shortcut',
    label: 'KDE Shortcut',
    description: 'Trigger a KDE Plasma global shortcut, e.g. Overview, a Spectacle screenshot or Mute Microphone. Needs no setup.',
    category: 'System',
    platforms: ['linux'],
    icon: { set: 'simple-icons', name: 'kde' },
    fields: [
      { key: 'component', label: 'App', kind: 'kdeComponent', placeholder: 'e.g. kwin' },
      { key: 'shortcut', label: 'Shortcut', kind: 'kdeShortcut', dependsOn: 'component', placeholder: 'e.g. Overview' },
    ],
    create: () => ({ type: 'kde.shortcut', component: '', shortcut: '' }),
    autoLabel: (a) => a.title || a.shortcut || 'KDE Shortcut',
  },
  'system.text': {
    type: 'system.text',
    label: 'Type Text',
    description: 'Type a text into the window that has focus, e.g. a chat message or your e-mail address.',
    category: 'System',
    platforms: ['linux', 'win32'],
    icon: mdi('form-textbox'),
    fields: [
      { key: 'text', label: 'Text', kind: 'multiline', placeholder: 'e.g. Thanks for the follow! ❤️' },
      { key: 'enter', label: 'Press Enter afterwards', kind: 'checkbox', hint: 'To send it, e.g. in a chat.' },
    ],
    create: () => ({ type: 'system.text', text: '' }),
    autoLabel: (a) => {
      const line = a.text.trim().split('\n')[0];
      return line.length > 24 ? `${line.slice(0, 23)}…` : line || 'Type Text';
    },
  },
  'system.openUrl': {
    type: 'system.openUrl',
    label: 'Open Website',
    description: 'Open a web page in the PC’s default browser, e.g. your stream dashboard.',
    category: 'System',
    platforms: ['linux', 'win32'],
    icon: mdi('web'),
    fields: [{ key: 'url', label: 'Address', kind: 'url', placeholder: 'https://dashboard.twitch.tv/' }],
    create: () => ({ type: 'system.openUrl', url: '' }),
    autoLabel: (a) => urlHost(a.url).replace(/^www\./, '') || 'Website',
  },
  counter: {
    type: 'counter',
    label: 'Counter',
    description: 'Count something (deaths, wins, …) on the button, the same on every device. Tap adds one, a long press resets it. Can show the count in an OBS text source.',
    category: 'Timers & Counters',
    icon: mdi('counter'),
    fields: [
      {
        key: 'mode',
        label: 'When pressed',
        kind: 'select',
        options: [
          { value: 'add', label: 'Add (or subtract)' },
          { value: 'set', label: 'Set to a number (e.g. 0 to reset)' },
        ],
      },
      { key: 'step', label: 'Add', kind: 'number', optional: true, min: -1_000_000, max: 1_000_000, step: 1, placeholder: '1', show: (a) => a.mode === 'add', hint: 'Negative numbers subtract.' },
      { key: 'value', label: 'Set to', kind: 'number', optional: true, step: 1, placeholder: '0', show: (a) => a.mode === 'set' },
      {
        key: 'target',
        label: 'Which counter',
        kind: 'targetButton',
        optional: true,
        emptyLabel: 'This button’s own',
        hint: 'Another Counter button changes that button’s count (handy in macros).',
      },
      { key: 'textSource', label: 'Also show it in an OBS text source', kind: 'textInput', optional: true, show: (a) => !a.target && a.mode === 'add' },
      {
        key: 'textFormat',
        label: 'Text',
        kind: 'text',
        optional: true,
        placeholder: '{n}',
        show: (a) => !a.target && a.mode === 'add' && !!a.textSource?.name,
        hint: '{n} becomes the count, e.g. “Deaths: {n}”.',
      },
    ],
    create: () => ({ type: 'counter', mode: 'add' }),
    autoLabel: (a) => {
      if (a.mode === 'set') return a.value ? `Set ${a.value}` : 'Reset';
      return a.target || (a.step ?? 1) !== 1 ? signed(a.step ?? 1) : 'Counter';
    },
  },
  timer: {
    type: 'timer',
    label: 'Timer',
    description: 'A countdown or stopwatch on the button, the same on every device. Tap starts and pauses, a long press resets it. Can show the time in an OBS text source.',
    category: 'Timers & Counters',
    icon: (a) => mdi(a.mode === 'reset' ? 'timer-refresh-outline' : a.durationSec ? 'timer-sand' : 'timer-outline'),
    activeBg: COLORS.green,
    fields: [
      {
        key: 'mode',
        label: 'When pressed',
        kind: 'select',
        options: [
          { value: 'toggle', label: 'Start / pause' },
          { value: 'restart', label: 'Start from the beginning' },
          { value: 'reset', label: 'Reset' },
        ],
      },
      {
        key: 'target',
        label: 'Which timer',
        kind: 'targetButton',
        optional: true,
        emptyLabel: 'This button’s own',
        hint: 'Another Timer button controls that button’s timer (handy in macros).',
      },
      {
        key: 'durationSec',
        label: 'Count down from',
        kind: 'duration',
        optional: true,
        placeholder: 'e.g. 5:00 (empty: count up)',
        show: (a) => !a.target && a.mode !== 'reset',
        hint: 'Minutes:seconds, or hours:minutes:seconds. Empty makes it a stopwatch that counts up.',
      },
      { key: 'textSource', label: 'Also show it in an OBS text source', kind: 'textInput', optional: true, show: (a) => !a.target && a.mode !== 'reset' },
      {
        key: 'textFormat',
        label: 'Text',
        kind: 'text',
        optional: true,
        placeholder: '{time}',
        show: (a) => !a.target && a.mode !== 'reset' && !!a.textSource?.name,
        hint: '{time} becomes the time, e.g. “Starting in {time}”.',
      },
      {
        key: 'doneText',
        label: 'Text when the countdown is done',
        kind: 'text',
        optional: true,
        placeholder: 'e.g. Starting now!',
        show: (a) => !a.target && a.mode !== 'reset' && !!a.textSource?.name && !!a.durationSec,
      },
    ],
    create: () => ({ type: 'timer', mode: 'toggle', durationSec: 300 }),
    autoLabel: (a) => {
      if (a.mode === 'reset') return 'Reset';
      if (a.mode === 'restart') return a.durationSec && !a.target ? `${formatClock(a.durationSec)} again` : 'Restart';
      return a.target ? 'Start/Pause' : a.durationSec ? 'Countdown' : 'Stopwatch';
    },
  },
  clock: {
    type: 'clock',
    label: 'Clock',
    description: 'Show the time of day, and the date if you like. Tapping it does nothing.',
    category: 'Timers & Counters',
    icon: mdi('clock-outline'),
    behavior: 'display',
    fields: [
      { key: 'seconds', label: 'Show seconds', kind: 'checkbox' },
      { key: 'hour12', label: '12-hour clock (AM/PM)', kind: 'checkbox' },
      { key: 'date', label: 'Show the date', kind: 'checkbox' },
    ],
    create: () => ({ type: 'clock', date: true }),
    autoLabel: () => '',
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
        placeholder: 'e.g. ~/bin/lights-on.sh, or on Windows: start "" notepad',
        hint: 'Runs in your home folder, with sh -c (Linux) or cmd.exe /c (Windows).',
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
    autoLabel: (a) => commandName(a.command) || 'Command',
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
  toggle: {
    type: 'toggle',
    label: 'Toggle',
    description: 'Switch between two actions: the first press runs one, the next press the other. The button stays lit in between (e.g. lights on and off through webhooks).',
    category: 'Macros',
    icon: mdi('toggle-switch-off-outline'),
    activeIcon: mdi('toggle-switch'),
    activeBg: COLORS.green,
    fields: [
      { key: 'on', label: 'First press (turns it on)', kind: 'action' },
      { key: 'off', label: 'Next press (turns it off)', kind: 'action' },
    ],
    create: () => ({ type: 'toggle', on: ACTION_META['http.request'].create(), off: ACTION_META['http.request'].create() }),
    autoLabel: (a, ctx) => actionAutoLabel(a.on, ctx),
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
  'deck.pageStep': {
    type: 'deck.pageStep',
    label: 'Next / Previous Page',
    description: 'Go to the next or previous page, in the order of the tabs (after the last comes the first).',
    category: 'Navigation',
    icon: (a) => mdi(a.direction === 'next' ? 'page-next-outline' : 'page-previous-outline'),
    behavior: 'nav',
    fields: [
      {
        key: 'direction',
        label: 'Go to',
        kind: 'select',
        options: [
          { value: 'next', label: 'The next page' },
          { value: 'previous', label: 'The previous page' },
        ],
      },
    ],
    create: () => ({ type: 'deck.pageStep', direction: 'next' }),
    autoLabel: (a) => (a.direction === 'next' ? 'Next Page' : 'Previous Page'),
  },
};

// The table is keyed per type; these helpers erase that to work on any Action.
const metaFor = (action: Action) => ACTION_META[action.type] as unknown as ActionMeta<ActionType>;
const pick = <V>(spec: Spec<ActionType, V> | undefined, action: Action): V | undefined =>
  typeof spec === 'function' ? (spec as (a: Action) => V)(action) : spec;

export const ACTION_TYPES = Object.keys(ACTION_META) as ActionType[];

/** Whether the server's operating system can run this action (unknown platform: assume yes). */
export function actionSupported(type: ActionType, platform: string | undefined): boolean {
  const platforms = ACTION_META[type].platforms;
  return !platform || !platforms || platforms.includes(platform);
}

/** The action types this server can run (Run Command only when commands are allowed). */
export function availableActionTypes(commands: boolean, platform?: string): ActionType[] {
  return ACTION_TYPES.filter((t) => (commands || !ACTION_META[t].needsCommands) && actionSupported(t, platform));
}

/**
 * Whether an action type can be a macro step (and so one side of a toggle): it just runs, without
 * holding, dragging or only showing something, and it isn't navigation, a macro or a toggle.
 */
export function isStepType(type: ActionType): boolean {
  if (type === 'macro' || type === 'toggle' || type.startsWith('deck.')) return false;
  return actionBehavior(ACTION_META[type].create() as Action) === 'press';
}

export function actionMeta(type: ActionType): ActionMeta<ActionType> {
  return ACTION_META[type] as unknown as ActionMeta<ActionType>;
}

export function actionBehavior(action: Action): Behavior {
  return pick(metaFor(action).behavior, action) ?? 'press';
}

/** actionBehavior for the schema's checks, whose types can't refer to Action while it is being defined. */
export function behaviorOf(action: { type: string }): Behavior {
  return actionBehavior(action as Action);
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
      if (f.kind === 'checkbox' || f.kind === 'action') return false;
      if (f.kind === 'macroSteps' || f.kind === 'keys') return !Array.isArray(v) || v.length === 0;
      return typeof v !== 'string' || v === '';
    })
    .map((f) => f.label);
  if (action.type === 'macro') {
    action.steps.forEach((step, i) => {
      if ('action' in step) missing.push(...missingFields(step.action).map((name) => `step ${i + 1} ${name.toLowerCase()}`));
    });
  }
  if (action.type === 'toggle') {
    missing.push(...missingFields(action.on).map((name) => `first press: ${name.toLowerCase()}`));
    missing.push(...missingFields(action.off).map((name) => `next press: ${name.toLowerCase()}`));
  }
  return missing;
}

