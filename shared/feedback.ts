// Derives how a button should look from its action and the live OBS state. Pure; runs in the browser.
import { COLORS, actionActiveBg, actionActiveIcon, actionAutoLabel, actionIcon } from './actions-meta.ts';
import { followedPlayer, type ExtState, type StatMetric, type StatsState } from './ext-types.ts';
import { mulToPos } from './fader.ts';
import { formatDb, formatDuration } from './format.ts';
import { resolveInput, resolveScene, resolveSceneItem, resolveSourceName } from './obs-resolve.ts';
import type { ObsOutput, ObsState } from './obs-types.ts';
import type { Action, Button, Deck, IconRef } from './schema.ts';

export interface VisualCtx {
  obs: ObsState;
  deck: Deck;
  ext: ExtState;
  /** Current time on the server's clock (browser clock corrected by the measured offset). */
  now: number;
  /** Whether the server runs Run Command buttons (they're dimmed otherwise). */
  commands?: boolean;
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
}

export interface ButtonVisual extends ActionStatus {
  label: string;
  icon?: IconRef;
  bg: string;
  fg: string;
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

export function actionStatus(action: Action, ctx: VisualCtx): ActionStatus {
  const { obs, deck, ext, now } = ctx;
  if (action.type.startsWith('obs.') && obs.connection !== 'connected') return { active: false, offline: true };

  switch (action.type) {
    case 'obs.scene': {
      const scene = resolveScene(obs, action.scene);
      if (!scene) return { active: false, missing: true };
      if (scene.name === obs.programScene) return { active: true, ring: 'program' };
      if (obs.studioMode && scene.name === obs.previewScene) return { active: false, ring: 'preview' };
      return { active: false };
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
      return resolveInput(obs, action.input) ? { active: false } : { active: false, missing: true };
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
      return { active: false };
    case 'system.command':
      return { active: false, disabled: !ctx.commands };
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
      return { active: false };
  }
}

/** `forceActive` lets the editor preview either look regardless of the live state. */
export function buttonVisual(button: Button, ctx: VisualCtx, opts: { forceActive?: boolean } = {}): ButtonVisual {
  const action = button.tap ?? button.longPress;
  const status: ActionStatus = action ? actionStatus(action, ctx) : { active: false };
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
