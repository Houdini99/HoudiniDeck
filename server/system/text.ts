// Type Text buttons on Linux: the text goes on the clipboard (wl-copy, or KDE's Klipper) and is pasted
// with Ctrl+V through ydotool. Typing it key by key would go through the keyboard layout (a German
// one swaps Y and Z and has no way to send "é"); pasting gets every character right.
import { ydotoolKeyArgs } from '../../shared/keys.ts';
import { ActionError } from '../actions/executor.ts';
import { launchProgram, type Launcher, type Runner } from './process.ts';
import { ydotoolKey } from './ydotool.ts';

/** Time for the clipboard to change hands before the paste. */
const SETTLE_MS = 150;

export interface TextDeps {
  run: Runner;
  /** wl-copy stays in the background to serve the clipboard, so it's started, not waited for. */
  launch?: Launcher;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function setClipboard(text: string, deps: TextDeps): Promise<void> {
  const launch = deps.launch ?? launchProgram;
  try {
    if ((await launch('wl-copy', ['--', text])) === 0) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    const res = await deps.run('busctl', ['--user', 'call', 'org.kde.klipper', '/klipper', 'org.kde.klipper.klipper', 'setClipboardContents', 's', text]);
    if (res.code === 0) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  throw new ActionError('Couldn’t put the text on the clipboard. Install wl-clipboard (sudo pacman -S wl-clipboard), or run Plasma’s clipboard (Klipper).');
}

export async function pasteText(text: string, enter: boolean, deps: TextDeps): Promise<void> {
  await setClipboard(text, deps);
  await (deps.sleep ?? wait)(SETTLE_MS);
  const keys = ydotoolKeyArgs(['KEY_LEFTCTRL', 'KEY_V']);
  await ydotoolKey(enter ? [...keys, ...ydotoolKeyArgs(['KEY_ENTER'])] : keys, deps.run);
}
