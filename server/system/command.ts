// Runs the shell commands of Run Command buttons (only when they're turned on in Settings):
// with `sh -c` on Linux, and with `cmd.exe /d /s /c` on Windows (as Node's own `shell: true` does).
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** How long a started app is watched for an immediate failure (e.g. "command not found"). */
const LAUNCH_CHECK_MS = 1000;
const OUTPUT_KEPT = 8192;

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The deck's own secrets stay out of the commands' environment. */
function commandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OBS_PASSWORD;
  return env;
}

const isWindows = process.platform === 'win32';

/** Exit codes of a shell whose command doesn't exist: sh says 127, cmd.exe 9009. */
const NOT_FOUND_CODES: readonly number[] = [127, 9009];

/** cmd.exe's own commands, which `where` can't find. */
const CMD_BUILTINS = new Set(
  'assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype goto if md mkdir mklink move path pause popd prompt pushd rd rem ren rename rmdir set setlocal shift start time title type ver verify vol'.split(
    ' ',
  ),
);

/** The program a command line starts: its first word, or the quoted path it starts with. */
export function commandProgram(command: string): string {
  const first = /^\s*(?:"([^"]*)"|([^\s&|<>()]+))/.exec(command);
  return first?.[1] ?? first?.[2] ?? '';
}

/** Whether Windows finds the program a command starts, as cmd.exe would (its own commands count as found). */
async function windowsProgramExists(command: string): Promise<boolean> {
  const program = commandProgram(command);
  if (!program || CMD_BUILTINS.has(program.toLowerCase())) return true;
  if (/[\\/:]/.test(program)) {
    const path = resolve(homedir(), program);
    const extensions = ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')];
    return extensions.some((ext) => existsSync(path + ext));
  }
  return new Promise((done) => execFile('where', [program], { windowsHide: true }, (err) => done(!err)));
}

/**
 * Whether a command that failed right away did so because its program doesn't exist. cmd.exe says
 * 9009, but just 1 when it was started without a console (for apps), so Windows looks it up then.
 */
export async function commandNotFound(command: string, code: number, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (NOT_FOUND_CODES.includes(code)) return true;
  return platform === 'win32' && !(await windowsProgramExists(command));
}

/** The shell and its arguments for a command line. */
export function shellCommand(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') {
    // /d: no AutoRun macros; /s /c "…": run the line between the outer quotes exactly as typed.
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`] };
  }
  return { file: 'sh', args: ['-c', command] };
}

function spawnShell(command: string, opts: SpawnOptions) {
  const { file, args } = shellCommand(command);
  return spawn(file, args, { cwd: homedir(), env: commandEnv(), windowsVerbatimArguments: isWindows, ...opts });
}

/** Stop the command and everything it started: its process group on Linux, its process tree on Windows. */
function killGroup(pid: number | undefined): void {
  if (!pid) return;
  if (isWindows) {
    execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

/**
 * Run the command in the shell and wait for it. Programs it starts in the background may keep running;
 * the result comes when the shell itself exits.
 */
export function runCommand(command: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    // Linux: its own process group, so a timeout can stop everything it started. Windows: no console
    // window popping up (detached would open one there); taskkill /t finds the whole tree instead.
    const child = spawnShell(command, { detached: !isWindows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout!.on('data', (chunk: Buffer) => (stdout = (stdout + chunk).slice(-OUTPUT_KEPT)));
    child.stderr!.on('data', (chunk: Buffer) => (stderr = (stderr + chunk).slice(-OUTPUT_KEPT)));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      // Let the last output arrive; background programs may hold the pipes open, so don't wait long.
      const done = () => resolve({ code, signal, stdout, stderr, timedOut });
      const grace = setTimeout(done, 200);
      child.on('close', () => {
        clearTimeout(grace);
        done();
      });
    });
  });
}

/**
 * Start the command without waiting for it (for apps). Rejects if it can't start, and resolves
 * with the exit code if it stops within a second (e.g. 127 or 9009: command not found).
 */
export function launchCommand(command: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // detached: on Windows this also keeps the app running when the deck stops (Node would end it otherwise).
    const child = spawnShell(command, { detached: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.unref();
      resolve(null); // still running: started fine
    }, LAUNCH_CHECK_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** The last few lines of a command's output, for a toast. */
export function outputTail(text: string, lines = 3, maxChars = 300): string {
  const tail = text.trim().split(/\r?\n/).slice(-lines).join('\n');
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/** Apps started by Run Command buttons need the desktop session's variables (missing e.g. under systemd). */
export function desktopSessionWarning(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const missing = [];
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) missing.push('WAYLAND_DISPLAY');
  if (!env.DBUS_SESSION_BUS_ADDRESS) missing.push('DBUS_SESSION_BUS_ADDRESS');
  if (missing.length === 0) return undefined;
  return (
    `${missing.join(' and ')} not set, so apps started by Run Command buttons may not open. ` +
    `Under systemd, run: systemctl --user import-environment ${missing.join(' ')}`
  );
}
