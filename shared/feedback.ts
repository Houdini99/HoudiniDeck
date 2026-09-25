// Derives how a button should look from its action and the live OBS state. Pure; runs in the browser.
import { ACTION_META, COLORS, actionActiveBg, actionActiveIcon, actionAutoLabel, actionIcon, actionSupported } from './actions-meta.ts';
import { counterDefinitions, timerDefinition, withNested } from './deck-utils.ts';
import { followedPlayer, soundKey, type ExtState, type StatMetric, type StatsState } from './ext-types.ts';
import { mulToPos } from './fader.ts';
import { formatClock, formatDb, formatDuration, formatTimeOfDay } from './format.ts';
import { resolveInput, resolveScene, resolveSceneItem, resolveSourceName } from './obs-resolve.ts';
import { timerReading } from './timers.ts';
import type { ObsOutput, ObsStatMetric, ObsState } from './obs-types.ts';
import type { Action, ActionOf, Button, Deck, IconRef } from './schema.ts';

export interface VisualCtx {
  obs: ObsState;
  deck: Deck;
  ext: ExtState;
  /** Current time on the server's clock (browser clock corrected by the measured offset). */
  now: number;
  /** Whether the server runs Run Command buttons (they're dimmed otherwise). */
  commands?: boolean;
  /** The server's operating system; buttons it can't run (e.g. KDE shortcuts on Windows) are dimmed. */
  platform?: string;
  /** Live pictures of scenes (data: URLs by scene name), for scene buttons that show one. */
  thumbs?: Record<string, string>;
}

export type Tone = 'live' | 'rec' | 'paused' | 'busy';

export interface ActionStatus {
  active: boolean;
  /** Scene buttons: red ring for Program, green ring for Preview (like OBS). */
  ring?: 'program' | 'preview';
  badge?: string;
  tone?: Tone;
  busy?: boolean;
  offline?: boolean;
  missing?: boolean;
  disabled?: boolean;
  /** Fader tiles: position 0..1, the value to show, and the OBS input whose level meter to show. */
  fader?: { pos: number; muted: boolean; text: string; input?: string; mic?: boolean };
  /** A picture that fills the button (a song's cover art), shown instead of the icon. */
  image?: string;
  /** Stats tiles: a big value instead of the icon, and a bar filled to `level` (0..1) when there is a reading. */
  gauge?: { text: string; detail?: string; level?: number; tone?: 'warm' | 'hot' };
  /** Wants attention (a countdown that ran out): the button flashes. */
  alert?: boolean;
}

export interface ButtonVisual extends ActionStatus {
  label: string;
  icon?: IconRef;
  bg: string;
  fg: string;
  labelPos?: Button['labelPos'];
  labelSize?: Button['labelSize'];
}

export function outputElapsed(out: ObsOutput, now: number): number {
  const running = (out.state === 'started' || out.state === 'reconnecting') && !out.paused;
  return out.durationMs + (running ? Math.max(0, now - out.sampledAt) : 0);
}

function outputStatus(out: ObsOutput, label: string, tone: Tone, now: number): ActionStatus {
  switch (out.state) {
    case 'starting':
      return { active: false, busy: true, badge: 'STARTING', tone: 'busy' };
    case 'stopping':
      return { active: true, busy: true, badge: 'STOPPING', tone: 'busy' };
    case 'reconnecting':
      return { active: true, busy: true, badge: 'RECONNECTING', tone: 'busy' };
    case 'started': {
      const time = formatDuration(outputElapsed(out, now));
      return out.paused
        ? { active: true, badge: `PAUSED ${time}`, tone: 'paused' }
        : { active: true, badge: `${label} ${time}`, tone };
    }
    default:
      return { active: false };
  }
}

const GB = 1024 ** 3;

function gauge(value: number, max: number, text: string, warm: number, hot: number, detail?: string): ActionStatus {
  const tone = value >= hot ? 'hot' : value >= warm ? 'warm' : undefined;
  return { active: false, gauge: { text, detail, level: Math.min(1, Math.max(0, value / max)), tone } };
}

function statsStatus(metric: StatMetric, stats: StatsState): ActionStatus {
  const reading = metric === 'gpuTemp' || metric === 'gpuMemory' ? stats.gpu : stats[metric];
  if (reading === undefined) return { active: false, gauge: { text: '–' } }; // not read yet
  if (reading === null) return { active: false, disabled: true, gauge: { text: 'n/a' } };
  const { cpu, memory, cpuTemp, gpu } = stats;
  switch (metric) {
    case 'cpu':
      return gauge(cpu!, 100, `${Math.round(cpu!)}%`, 75, 90);
    case 'memory': {
      const percent = (memory!.used / memory!.total) * 100;
      return gauge(percent, 100, `${Math.round(percent)}%`, 80, 92, `${(memory!.used / GB).toFixed(1)} GB`);
    }
    case 'cpuTemp':
      return gauge(cpuTemp!, 100, `${Math.round(cpuTemp!)}°C`, 70, 85);
    case 'gpu':
      return gauge(gpu!.util, 100, `${Math.round(gpu!.util)}%`, 75, 90);
    case 'gpuTemp':
      return gauge(gpu!.temp, 100, `${Math.round(gpu!.temp)}°C`, 70, 83);
    case 'gpuMemory': {
      const percent = (gpu!.memUsed / gpu!.memTotal) * 100;
      return gauge(percent, 100, `${Math.round(percent)}%`, 80, 92, `${(gpu!.memUsed / 1024).toFixed(1)} GB`);
    }
  }
}

/** Whether this server can't run the action, or something inside it (a macro step, a toggle side). */
function unavailable(action: Action, ctx: VisualCtx): boolean {
  return withNested(action).some((a) => !actionSupported(a.type, ctx.platform) || (ACTION_META[a.type].needsCommands && !ctx.commands));
}

function timerStatus(action: ActionOf<'timer'>, ctx: VisualCtx, buttonId: string | undefined): ActionStatus {
  const id = action.target ?? buttonId;
  const definition = id ? timerDefinition(ctx.deck, id) : undefined;
  if (action.target && !definition) return { active: false, missing: true, gauge: { text: '–' } };
  const reading = timerReading(definition ?? action, id ? ctx.ext.timers[id] : undefined, ctx.now);
  const text = formatClock(reading.seconds);
  if (reading.done) return { active: false, alert: true, gauge: { text, level: 0, tone: 'hot' } };
  const warm = reading.running && reading.left !== undefined && reading.seconds <= 10;
  return { active: reading.running, gauge: { text, level: reading.left, tone: warm ? 'warm' : undefined } };
}

function counterStatus(action: ActionOf<'counter'>, ctx: VisualCtx, buttonId: string | undefined): ActionStatus {
  const id = action.target ?? buttonId;
  if (action.target && counterDefinitions(ctx.deck, action.target).length === 0) return { active: false, missing: true, gauge: { text: '–' } };
  return { active: false, gauge: { text: String(id ? (ctx.ext.counters[id] ?? 0) : 0) } };
}

/** `buttonId`: the button the action belongs to (counters, timers, toggles and sounds keep their state per button). */
const percent = (part = 0, total = 0) => (total > 0 ? (part / total) * 100 : 0);

function obsStatsStatus(metric: ObsStatMetric, obs: ObsState): ActionStatus {
  const stats = obs.stats;
  const live = obs.stream.state === 'started' || obs.stream.state === 'reconnecting';
  switch (metric) {
    case 'bitrate': {
      if (!live) return { active: false, disabled: true, gauge: { text: '–' } };
      const kbps = obs.stream.bitrateKbps;
      if (kbps === undefined) return { active: false, gauge: { text: '…' } };
      const congestion = obs.stream.congestion ?? 0;
      const tone = congestion >= 0.5 ? 'hot' : congestion >= 0.2 ? 'warm' : undefined;
      const [text, detail] = kbps >= 1000 ? [(kbps / 1000).toFixed(1), 'Mbit/s'] : [String(Math.round(kbps)), 'kbit/s'];
      return { active: false, gauge: { text, detail, tone } };
    }
    case 'dropped': {
      if (!live) return { active: false, disabled: true, gauge: { text: '–' } };
      const dropped = percent(obs.stream.skippedFrames, obs.stream.totalFrames);
      return gauge(dropped, 5, `${dropped.toFixed(1)}%`, 1, 5, `${obs.stream.skippedFrames ?? 0} frames`);
    }
  }
  if (!stats) return { active: false, gauge: { text: '–' } };
  switch (metric) {
    case 'fps':
      return { active: false, gauge: { text: String(Math.round(stats.fps)) } };
    case 'cpu':
      return gauge(stats.cpu, 100, `${stats.cpu.toFixed(1)}%`, 50, 80);
    case 'render': {
      const lag = percent(stats.renderSkipped, stats.renderTotal);
      return gauge(lag, 5, `${lag.toFixed(1)}%`, 0.5, 2, `${stats.renderSkipped} frames`);
    }
    case 'encode': {
      const lag = percent(stats.outputSkipped, stats.outputTotal);
      return gauge(lag, 5, `${lag.toFixed(1)}%`, 0.5, 2, `${stats.outputSkipped} frames`);
    }
  }
}

export function actionStatus(action: Action, ctx: VisualCtx, buttonId?: string): ActionStatus {
  const { obs, deck, ext, now } = ctx;
  if (unavailable(action, ctx)) return { active: false, disabled: true };
  if (action.type.startsWith('obs.') && obs.connection !== 'connected') return { active: false, offline: true };

  switch (action.type) {
    case 'obs.scene': {
      const scene = resolveScene(obs, action.scene);
      if (!scene) return { active: false, missing: true };
      const image = action.preview ? ctx.thumbs?.[scene.name] : undefined;
      if (scene.name === obs.programScene) return { active: true, ring: 'program', image };
      if (obs.studioMode && scene.name === obs.previewScene) return { active: false, ring: 'preview', image };
      return { active: false, image };
    }
    case 'obs.sceneItem': {
      const hit = resolveSceneItem(obs, action.scene, action.source);
      return hit ? { active: hit.item.enabled } : { active: false, missing: true };
    }
    case 'obs.filter': {
      const source = resolveSourceName(obs, action.source);
      const filter = source ? obs.filters[source]?.find((f) => f.name === action.filter) : undefined;
      return filter ? { active: filter.enabled } : { active: false, missing: true };
    }
    case 'obs.mute': {
      const input = resolveInput(obs, action.input);
      if (!input?.audio) return { active: false, missing: true };
      const muted = !!input.muted;
      return { active: action.mode === 'pushToTalk' ? !muted : muted };
    }
    case 'obs.volume': {
      const input = resolveInput(obs, action.input);
      if (!input?.audio) return { active: false, missing: true };
      const muted = !!input.muted;
      return {
        active: muted,
        fader: { pos: mulToPos(input.volumeMul ?? 0), muted, text: formatDb(input.volumeDb), input: input.name },
      };
    }
    case 'obs.volumeStep':
    case 'obs.media':
    case 'obs.text':
    case 'obs.browserRefresh':
      return resolveInput(obs, action.input) ? { active: false } : { active: false, missing: true };
    case 'obs.stats':
      return obsStatsStatus(action.metric, obs);
    case 'obs.stream':
      return outputStatus(obs.stream, 'LIVE', 'live', now);
    case 'obs.record': {
      const recording = obs.record.state === 'started';
      if (action.mode === 'split' || action.mode === 'chapter') return { active: false, disabled: !recording };
      if (action.mode === 'pause') {
        return { ...outputStatus(obs.record, 'REC', 'rec', now), active: !!obs.record.paused, disabled: !recording };
      }
      return outputStatus(obs.record, 'REC', 'rec', now);
    }
    case 'obs.replay':
      if (!obs.replayBuffer.available) return { active: false, disabled: true };
      return action.mode === 'save'
        ? { active: false, disabled: !obs.replayBuffer.active }
        : { active: obs.replayBuffer.active };
    case 'obs.virtualCam':
      return obs.virtualCam.available ? { active: obs.virtualCam.active } : { active: false, disabled: true };
    case 'obs.studioMode':
      return { active: obs.studioMode };
    case 'obs.transition':
      return { active: false, disabled: !obs.studioMode };
    case 'obs.screenshot':
      return action.source && !resolveSourceName(obs, action.source) ? { active: false, missing: true } : { active: false };
    case 'obs.collection':
      return {
        active: obs.collections.current === action.name,
        missing: obs.collections.list.length > 0 && !obs.collections.list.includes(action.name),
      };
    case 'obs.profile':
      return {
        active: obs.profiles.current === action.name,
        missing: obs.profiles.list.length > 0 && !obs.profiles.list.includes(action.name),
      };
    case 'obs.hotkey':
    case 'http.request':
    case 'macro':
    case 'system.hotkey':
    case 'kde.shortcut':
    case 'system.command':
    case 'system.openUrl':
    case 'system.text':
      return { active: false };
    case 'toggle':
      return { active: !!buttonId && !!ext.toggles[buttonId] };
    case 'counter':
      return counterStatus(action, ctx, buttonId);
    case 'timer':
      return timerStatus(action, ctx, buttonId);
    case 'clock': {
      const date = new Date(now);
      const detail = action.date ? date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : undefined;
      return { active: false, gauge: { text: formatTimeOfDay(date, action), detail } };
    }
    case 'sound.play':
      return { active: !!buttonId && ext.sounds.includes(soundKey(buttonId, action.sound)) };
    case 'sound.stop':
      return { active: ext.sounds.length > 0 };
    case 'system.stats':
      return statsStatus(action.metric, ext.stats);
    case 'system.volume': {
      const device = ext.audio.available ? ext.audio[action.target] : null;
      if (device === null) return { active: false, disabled: true };
      if (action.mode === 'step') return { active: false };
      if (!device) return { active: false }; // not read yet
      const status: ActionStatus = { active: device.muted };
      if (action.mode === 'fader') {
        const text = `${Math.round(device.volume * 100)}%`;
        status.fader = { pos: Math.min(1, device.volume), muted: device.muted, text, mic: action.target === 'input' };
      }
      return status;
    }
    case 'media.player': {
      const player = ext.media.available ? followedPlayer(ext, action.player) : undefined;
      if (!player) return { active: false, disabled: true };
      const playing = player.status === 'Playing';
      const status: ActionStatus = { active: action.command === 'playPause' && playing };
      if (action.nowPlaying) {
        status.image = player.art;
        if (player.status === 'Paused' && player.title) Object.assign(status, { badge: 'PAUSED', tone: 'paused' });
      }
      return status;
    }
    case 'deck.page':
      return { active: false, missing: !deck.pages.some((p) => p.id === action.pageId) };
    case 'deck.back':
    case 'deck.pageStep':
      return { active: false };
  }
}

/** `forceActive` lets the editor preview either look regardless of the live state. */
export function buttonVisual(button: Button, ctx: VisualCtx, opts: { forceActive?: boolean } = {}): ButtonVisual {
  const action = button.tap ?? button.longPress;
  const status: ActionStatus = action ? actionStatus(action, ctx, button.id) : { active: false };
  if (button.icon) status.image = undefined; // a chosen icon wins over cover art
  if (opts.forceActive !== undefined) {
    status.active = opts.forceActive;
    // For scene buttons "active" means on Program, which is drawn as a ring.
    if (action?.type === 'obs.scene') status.ring = opts.forceActive ? 'program' : undefined;
  }
  const baseLabel = button.label || (action ? actionAutoLabel(action, ctx) : '');
  const baseIcon = button.icon ?? (action ? actionIcon(action) : undefined);
  const bg = button.bg ?? COLORS.bg;
  const fg = button.fg ?? COLORS.fg;
  Object.assign(status, { labelPos: button.labelPos, labelSize: button.labelSize });
  if (!status.active) return { ...status, label: baseLabel, icon: baseIcon, bg, fg };

  // A custom base icon wins over the action's default active icon; state then shows through color.
  const activeIcon = button.active?.icon ?? (button.icon ?? (action && actionActiveIcon(action)) ?? baseIcon);
  return {
    ...status,
    label: button.active?.label || baseLabel,
    icon: activeIcon,
    bg: button.active?.bg ?? (action && actionActiveBg(action)) ?? bg,
    fg: button.active?.fg ?? fg,
  };
}
