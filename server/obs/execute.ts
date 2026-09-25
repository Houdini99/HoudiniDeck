// Runs obs.* actions against obs-websocket. Every OBS reference is resolved against the live mirror.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { OBSWebSocket } from 'obs-websocket-js/json';
import { mulToDb, posToMul } from '../../shared/fader.ts';
import { resolveInput, resolveScene, resolveSceneItem, resolveSourceName } from '../../shared/obs-resolve.ts';
import { BROWSER_INPUT_KIND, isTextInputKind, type ObsInput, type ObsState } from '../../shared/obs-types.ts';
import type { ObsRef } from '../../shared/schema.ts';
import { ActionError, type ActionOfPrefix, type Phase } from '../actions/executor.ts';

export type ObsAction = ActionOfPrefix<'obs'>;

export interface ExecuteOptions {
  screenshotDir: string;
}

type Caller = Pick<OBSWebSocket, 'call'>;

const MEDIA_ACTIONS = {
  play: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
  pause: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
  stop: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
  restart: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
  next: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT',
  previous: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS',
} as const;

function fail(message: string): never {
  throw new ActionError(message);
}

function audioInput(state: ObsState, ref: ObsRef): ObsInput {
  const input = resolveInput(state, ref) ?? fail(`Audio input “${ref.name}” not found in OBS`);
  if (!input.audio) fail(`“${input.name}” has no audio`);
  return input;
}

/** Replace what a text source shows. */
export async function setTextSource(obs: Caller, state: ObsState, ref: ObsRef, text: string): Promise<void> {
  const input = resolveInput(state, ref) ?? fail(`Text source “${ref.name}” not found in OBS`);
  if (!isTextInputKind(input.kind)) fail(`“${input.name}” is not a text source`);
  await obs.call('SetInputSettings', { inputName: input.name, inputSettings: { text }, overlay: true });
}

/** A source name as part of a file name: without the characters Windows (or Linux) forbids there. */
export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export async function executeObsAction(
  obs: Caller,
  state: ObsState,
  action: ObsAction,
  phase: Phase,
  opts: ExecuteOptions,
): Promise<void> {
  switch (action.type) {
    case 'obs.scene': {
      const scene = resolveScene(state, action.scene) ?? fail(`Scene “${action.scene.name}” not found in OBS`);
      const toPreview = action.target === 'preview' || (action.target === 'auto' && state.studioMode);
      if (toPreview && !state.studioMode) fail('Studio Mode is off, so there is no Preview');
      await obs.call(toPreview ? 'SetCurrentPreviewScene' : 'SetCurrentProgramScene', { sceneName: scene.name });
      return;
    }
    case 'obs.sceneItem': {
      const hit =
        resolveSceneItem(state, action.scene, action.source) ??
        fail(`Source “${action.source.name}” not found in “${action.scene.name}”`);
      const enabled = action.mode === 'toggle' ? !hit.item.enabled : action.mode === 'show';
      await obs.call('SetSceneItemEnabled', { sceneName: hit.sceneName, sceneItemId: hit.item.id, sceneItemEnabled: enabled });
      return;
    }
    case 'obs.filter': {
      const source = resolveSourceName(state, action.source) ?? fail(`Source “${action.source.name}” not found in OBS`);
      const filter =
        state.filters[source]?.find((f) => f.name === action.filter) ?? fail(`Filter “${action.filter}” not found on “${source}”`);
      const enabled = action.mode === 'toggle' ? !filter.enabled : action.mode === 'enable';
      await obs.call('SetSourceFilterEnabled', { sourceName: source, filterName: filter.name, filterEnabled: enabled });
      return;
    }
    case 'obs.mute': {
      const input = audioInput(state, action.input);
      if (phase.kind === 'hold') {
        if (action.mode === 'pushToTalk') await obs.call('SetInputMute', { inputName: input.name, inputMuted: !phase.down });
        if (action.mode === 'pushToMute') await obs.call('SetInputMute', { inputName: input.name, inputMuted: phase.down });
        return;
      }
      if (action.mode === 'toggle') await obs.call('ToggleInputMute', { inputName: input.name });
      if (action.mode === 'mute' || action.mode === 'unmute') {
        await obs.call('SetInputMute', { inputName: input.name, inputMuted: action.mode === 'mute' });
      }
      return;
    }
    case 'obs.volume': {
      const input = audioInput(state, action.input);
      if (phase.kind === 'fader') await obs.call('SetInputVolume', { inputName: input.name, inputVolumeMul: posToMul(phase.pos) });
      else await obs.call('ToggleInputMute', { inputName: input.name });
      return;
    }
    case 'obs.volumeStep': {
      const input = audioInput(state, action.input);
      const current = mulToDb(input.volumeMul ?? 1);
      const from = current > -100 ? current : -60; // from silence, start stepping at -60 dB
      const db = Math.min(0, Math.max(-100, from + action.db));
      await obs.call('SetInputVolume', { inputName: input.name, inputVolumeDb: db });
      return;
    }
    case 'obs.stream': {
      const request = ({ toggle: 'ToggleStream', start: 'StartStream', stop: 'StopStream' } as const)[action.mode];
      await obs.call(request);
      return;
    }
    case 'obs.record': {
      if ((action.mode === 'pause' || action.mode === 'split' || action.mode === 'chapter') && state.record.state !== 'started') {
        fail('Not recording');
      }
      const request = (
        {
          toggle: 'ToggleRecord',
          start: 'StartRecord',
          stop: 'StopRecord',
          pause: 'ToggleRecordPause',
          split: 'SplitRecordFile',
          chapter: 'CreateRecordChapter',
        } as const
      )[action.mode];
      await obs.call(request);
      return;
    }
    case 'obs.replay': {
      if (!state.replayBuffer.available) fail('The replay buffer is off in OBS (Settings → Output → Replay Buffer)');
      if (action.mode === 'save' && !state.replayBuffer.active) fail('Start the replay buffer first');
      const request = (
        { toggle: 'ToggleReplayBuffer', start: 'StartReplayBuffer', stop: 'StopReplayBuffer', save: 'SaveReplayBuffer' } as const
      )[action.mode];
      await obs.call(request);
      return;
    }
    case 'obs.virtualCam': {
      if (!state.virtualCam.available) fail('The virtual camera is not available in this OBS');
      const request = ({ toggle: 'ToggleVirtualCam', start: 'StartVirtualCam', stop: 'StopVirtualCam' } as const)[action.mode];
      await obs.call(request);
      return;
    }
    case 'obs.studioMode': {
      const enabled = action.mode === 'toggle' ? !state.studioMode : action.mode === 'on';
      await obs.call('SetStudioModeEnabled', { studioModeEnabled: enabled });
      return;
    }
    case 'obs.transition': {
      if (!state.studioMode) fail('Studio Mode is off');
      if (action.transition && action.transition !== state.currentTransition) {
        await obs.call('SetCurrentSceneTransition', { transitionName: action.transition });
      }
      if (action.durationMs !== undefined) {
        await obs.call('SetCurrentSceneTransitionDuration', { transitionDuration: Math.max(50, action.durationMs) });
      }
      await obs.call('TriggerStudioModeTransition');
      return;
    }
    case 'obs.screenshot': {
      const source = action.source
        ? (resolveSourceName(state, action.source) ?? fail(`Source “${action.source.name}” not found in OBS`))
        : (state.programScene ?? fail('No program scene'));
      await mkdir(opts.screenshotDir, { recursive: true });
      const file = join(opts.screenshotDir, `${safeFileName(source)} ${timestamp()}.png`);
      await obs.call('SaveSourceScreenshot', { sourceName: source, imageFormat: 'png', imageFilePath: file });
      return;
    }
    case 'obs.text':
      await setTextSource(obs, state, action.input, action.text ?? '');
      return;
    case 'obs.browserRefresh': {
      const input = resolveInput(state, action.input) ?? fail(`Browser source “${action.input.name}” not found in OBS`);
      if (input.kind !== BROWSER_INPUT_KIND) fail(`“${input.name}” is not a browser source`);
      // The "Refresh cache of current page" button in the source's properties.
      await obs.call('PressInputPropertiesButton', { inputName: input.name, propertyName: 'refreshnocache' });
      return;
    }
    case 'obs.collection':
      await obs.call('SetCurrentSceneCollection', { sceneCollectionName: action.name });
      return;
    case 'obs.profile':
      await obs.call('SetCurrentProfile', { profileName: action.name });
      return;
    case 'obs.hotkey':
      await obs.call('TriggerHotkeyByName', { hotkeyName: action.name });
      return;
    case 'obs.media': {
      const input = resolveInput(state, action.input) ?? fail(`Media source “${action.input.name}” not found in OBS`);
      let media: keyof typeof MEDIA_ACTIONS;
      if (action.action === 'playPause') {
        const status = await obs.call('GetMediaInputStatus', { inputName: input.name });
        media =
          status.mediaState === 'OBS_MEDIA_STATE_PLAYING'
            ? 'pause'
            : status.mediaState === 'OBS_MEDIA_STATE_ENDED'
              ? 'restart'
              : 'play';
      } else {
        media = action.action;
      }
      await obs.call('TriggerMediaInputAction', { inputName: input.name, mediaAction: MEDIA_ACTIONS[media] });
      return;
    }
  }
}
