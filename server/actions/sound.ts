// The sound.* family: a soundboard. Clips play on the PC (see ../system/sound.ts); what plays is
// tracked per button, so a press can stop its own sound.
import type { SoundPlayer } from '../system/sound.ts';
import { needButton, type Executor } from './executor.ts';

export function soundExecutor(player: Pick<SoundPlayer, 'play' | 'stopAll'>): Executor<'sound'> {
  return async (action, _phase, ctx) => {
    if (action.type === 'sound.stop') return player.stopAll();
    await player.play(needButton(ctx).buttonId, action);
  };
}
