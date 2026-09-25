// Derives how a button should look from its action and the live OBS state. Pure; runs in the browser.
import { COLORS, actionActiveBg, actionActiveIcon, actionAutoLabel, actionIcon } from './actions-meta.ts';
import { followedPlayer, type ExtState } from './ext-types.ts';
import { mulToPos } from './fader.ts';
import { formatDuration } from './format.ts';
import { resolveInput, resolveScene, resolveSceneItem, resolveSourceName } from './obs-resolve.ts';
import type { ObsOutput, ObsState } from './obs-types.ts';
import type { Action, Button, Deck, IconRef } from './schema.ts';

export interface VisualCtx {
  obs: ObsState;
  deck: Deck;
  ext: ExtState;
  /** Current time on the server's clock (browser clock corrected by the measured offset). */
  now: number;
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
  fader?: { pos: number; muted: boolean; db?: number; input: string };
  /** A picture that fills the button (a song's cover art), shown instead of the icon. */
  image?: string;
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
        fader: { pos: mulToPos(input.volumeMul ?? 0), muted, db: input.volumeDb, input: input.name },
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
      return { active: false };
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
