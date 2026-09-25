// The system.* family: the PC itself. The default speakers and microphone (via wpctl), and
// shell commands (only when the server was started with STREAMDECK_ENABLE_COMMANDS=1).
import type { ActionOf } from '../../shared/schema.ts';
import { AUDIO_DEVICE_IDS, type AudioWatcher } from '../system/audio.ts';
import { DEFAULT_COMMAND_TIMEOUT_MS, launchCommand, outputTail, runCommand } from '../system/command.ts';
import type { RunResult, Runner } from '../system/process.ts';
import { ActionError, type Executor, type Phase } from './executor.ts';

export interface SystemDeps {
  run: Runner;
  /** Re-read the volumes right after changing one, so buttons update at once. */
  audio: Pick<AudioWatcher, 'refresh'>;
  /** STREAMDECK_ENABLE_COMMANDS=1; only the environment can turn this on. */
  commandsEnabled: boolean;
}

export function systemExecutor(deps: SystemDeps): Executor<'system'> {
  return async (action, phase) => {
    switch (action.type) {
      case 'system.volume':
        return setVolume(action, phase, deps);
      case 'system.command':
        return runCommandAction(action, deps.commandsEnabled);
      default:
        throw new Error(`No executor for ${(action satisfies never as { type: string }).type}`);
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

async function runCommandAction(action: ActionOf<'system.command'>, enabled: boolean): Promise<void> {
  if (!enabled) throw new ActionError('Running commands is turned off. Start the deck with STREAMDECK_ENABLE_COMMANDS=1 to allow it.');
  if (action.detached) {
    const code = await launchCommand(action.command);
    if (code === 127) throw new ActionError(`Command not found: ${action.command.trim().split(/\s+/)[0]}`);
    if (code) throw new ActionError(`The command stopped right away (exit code ${code})`);
    return;
  }
  const timeoutMs = action.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const res = await runCommand(action.command, timeoutMs);
  if (res.timedOut) throw new ActionError(`The command was stopped after ${timeoutMs / 1000} s`);
  if (res.code === 0) return;
  const detail = outputTail(res.stderr) || outputTail(res.stdout);
  const status = res.code === null ? `stopped by ${res.signal}` : `exit code ${res.code}`;
  throw new ActionError(`The command failed (${status})${detail ? `:\n${detail}` : ''}`);
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
