// The media.* family: media keys for MPRIS players (Spotify, browsers, VLC, …) through playerctl.
import type { MediaWatcher } from '../system/media.ts';
import type { RunResult, Runner } from '../system/process.ts';
import { ActionError, type Executor } from './executor.ts';

const COMMANDS = { playPause: 'play-pause', next: 'next', previous: 'previous', stop: 'stop' } as const;

export function mediaExecutor(run: Runner, media: Pick<MediaWatcher, 'currentInstance'>): Executor<'media'> {
  return async (action) => {
    // Without a named player, control the one the buttons show; on its own, playerctl would
    // pick whichever player it happens to list first.
    const player = action.player || media.currentInstance();
    let res: RunResult;
    try {
      // --player=name as one argument, so a name can never be read as another option.
      res = await run('playerctl', [...(player ? [`--player=${player}`] : []), COMMANDS[action.command]]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ActionError('playerctl is not installed on the PC');
      throw err;
    }
    if (res.code === 0) return;
    const message = res.stderr.trim();
    if (/no players found/i.test(message)) throw new ActionError(action.player ? `“${action.player}” is not running` : 'No media player is running');
    throw new ActionError(`playerctl: ${message || `exit code ${res.code}`}`);
  };
}
