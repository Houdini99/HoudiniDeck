// Open Website buttons: a web page in the PC's default browser, through xdg-open on Linux and the
// shell's URL handler on Windows. Only http(s) addresses, passed as one argument (never through a shell).
import { join } from 'node:path';
import { ActionError } from '../actions/executor.ts';
import { launchProgram, type Launcher } from './process.ts';

/** xdg-open's exit codes (see its man page). */
const XDG_OPEN_ERRORS: Record<number, string> = {
  2: 'the address couldn’t be opened',
  3: 'no browser was found',
  4: 'it couldn’t open a browser. Does the deck run inside your desktop session?',
};

export function openUrlCommand(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    // What Explorer does for a link. rundll32 takes the rest of its command line as the address.
    return { cmd: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] };
  }
  return { cmd: 'xdg-open', args: [url] };
}

export async function openUrl(url: string, launch: Launcher = launchProgram, platform: NodeJS.Platform = process.platform): Promise<void> {
  let href: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http');
    href = parsed.href; // spaces and quotes come out percent-encoded
  } catch {
    throw new ActionError('Only http:// and https:// addresses can be opened');
  }
  const { cmd, args } = openUrlCommand(href, platform);
  let code: number | null;
  try {
    code = await launch(cmd, args);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ActionError(`${cmd} is not installed on the PC (it comes with xdg-utils)`);
    throw err;
  }
  if (code) throw new ActionError(`The browser didn’t open: ${XDG_OPEN_ERRORS[code] ?? `exit code ${code}`}`);
}
