// The kde.* family: KDE Plasma global shortcuts, which need no setup (see ../system/kde.ts).
import { invokeKdeShortcut } from '../system/kde.ts';
import type { Runner } from '../system/process.ts';
import { ActionError, type Executor } from './executor.ts';

export function kdeExecutor(run: Runner, platform: NodeJS.Platform = process.platform): Executor<'kde'> {
  return async (action) => {
    if (platform !== 'linux') throw new ActionError('KDE shortcuts only work on Linux (in a KDE Plasma session)');
    await invokeKdeShortcut(run, action.component, action.shortcut);
  };
}
