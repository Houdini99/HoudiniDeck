// The system.* family: the PC itself. For now the default speakers and microphone, via wpctl.
import type { ActionOf } from '../../shared/schema.ts';
import { AUDIO_DEVICE_IDS, type AudioWatcher } from '../system/audio.ts';
import type { RunResult, Runner } from '../system/process.ts';
import { ActionError, type Executor, type Phase } from './executor.ts';

export interface SystemDeps {
  run: Runner;
  /** Re-read the volumes right after changing one, so buttons update at once. */
  audio: Pick<AudioWatcher, 'refresh'>;
}

export function systemExecutor(deps: SystemDeps): Executor<'system'> {
  return async (action, phase) => {
    switch (action.type) {
      case 'system.volume':
        return setVolume(action, phase, deps);
    }
  };
}

export function volumeArgs(action: ActionOf<'system.volume'>, phase: Phase): string[] {
  const id = AUDIO_DEVICE_IDS[action.target];
  if (phase.kind === 'fader') return ['set-volume', id, Math.min(1, Math.max(0, phase.pos)).toFixed(3)];
  switch (action.mode) {
    case 'mute':
      return ['set-mute', id, '1'];
    case 'unmute':
      return ['set-mute', id, '0'];
    case 'step': {
      const step = action.step ?? 5;
      // Turning up stops at 100%, like the desktop's volume keys.
      return step >= 0 ? ['set-volume', '--limit=1.0', id, `${step}%+`] : ['set-volume', id, `${-step}%-`];
    }
    default:
      return ['set-mute', id, 'toggle']; // toggleMute, and a tap on a fader
  }
}

async function setVolume(action: ActionOf<'system.volume'>, phase: Phase, deps: SystemDeps): Promise<void> {
  let res: RunResult;
  try {
    res = await deps.run('wpctl', volumeArgs(action, phase));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ActionError('wpctl is not installed on the PC');
    throw err;
  }
  if (res.code !== 0) throw new ActionError(`wpctl: ${res.stderr.trim() || `exit code ${res.code}`}`);
  await deps.audio.refresh();
}
