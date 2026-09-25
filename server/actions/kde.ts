// The kde.* family: KDE Plasma global shortcuts, which need no setup (see ../system/kde.ts).
import { invokeKdeShortcut } from '../system/kde.ts';
import type { Runner } from '../system/process.ts';
import type { Executor } from './executor.ts';

export function kdeExecutor(run: Runner): Executor<'kde'> {
  return (action) => invokeKdeShortcut(run, action.component, action.shortcut);
}
