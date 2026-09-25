// System Volume buttons on Windows: the default speakers and microphone through the helper (Core Audio).
import type { AudioDevice, AudioTarget } from '../../../shared/ext-types.ts';
import type { ActionOf } from '../../../shared/schema.ts';
import type { Phase } from '../../actions/executor.ts';
import type { WinRequester } from './helper.ts';

/** The device's volume, or null when there is no such device. */
export function readWindowsVolume(helper: WinRequester, target: AudioTarget): Promise<AudioDevice | null> {
  return helper.request<AudioDevice | null>('volume.get', { target });
}

/** What the helper should do for a button: the same modes as wpctl, with the volume from 0 to 1 (Windows can't go above 100%). */
export function windowsVolumeRequest(action: ActionOf<'system.volume'>, phase: Phase): { mode: string; value?: number } {
  if (phase.kind === 'fader') return { mode: 'set', value: Math.min(1, Math.max(0, phase.pos)) };
  switch (action.mode) {
    case 'mute':
    case 'unmute':
      return { mode: action.mode };
    case 'step':
      return { mode: 'step', value: action.step ?? 5 };
    default:
      return { mode: 'toggleMute' }; // toggleMute, and a tap on a fader
  }
}

export async function setWindowsVolume(helper: WinRequester, action: ActionOf<'system.volume'>, phase: Phase): Promise<void> {
  await helper.request('volume.set', { target: action.target, ...windowsVolumeRequest(action, phase) });
}
