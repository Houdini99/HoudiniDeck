// ydotool: key presses on Linux (X11 and Wayland) through the kernel's uinput, with readable errors.
import { ActionError } from '../actions/executor.ts';
import { outputTail } from './command.ts';
import type { RunResult, Runner } from './process.ts';

/** `ydotool key <args>`, e.g. ["29:1", "47:1", "47:0", "29:0"] for Ctrl+V. */
export async function ydotoolKey(args: string[], run: Runner): Promise<void> {
  let res: RunResult;
  try {
    res = await run('ydotool', ['key', ...args]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ActionError('ydotool is not installed on the PC (see the README)');
    throw err;
  }
  if (res.code === 0) return;
  const output = `${res.stdout}\n${res.stderr}`; // ydotool reports connection problems on stdout
  if (/failed to connect socket/.test(output)) {
    throw new ActionError('ydotool’s background service isn’t running. Start it with: systemctl --user enable --now ydotool');
  }
  throw new ActionError(`ydotool: ${outputTail(output, 2) || `exit code ${res.code}`}`);
}
