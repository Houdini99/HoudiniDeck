// Runs the shell commands of Run Command buttons (only when STREAMDECK_ENABLE_COMMANDS=1).
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

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

/** Stop the command and everything it started (it leads its own process group). */
function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

/**
 * Run `sh -c command` and wait for it. Programs it starts in the background may keep running;
 * the result comes when the shell itself exits.
 */
export function runCommand(command: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { cwd: homedir(), env: commandEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => (stdout = (stdout + chunk).slice(-OUTPUT_KEPT)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk).slice(-OUTPUT_KEPT)));
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
 * Start `sh -c command` without waiting for it (for apps). Rejects if it can't start, and
 * resolves with the exit code if it stops within a second (e.g. 127: command not found).
 */
export function launchCommand(command: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { cwd: homedir(), env: commandEnv(), detached: true, stdio: 'ignore' });
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
  const tail = text.trim().split('\n').slice(-lines).join('\n');
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}
