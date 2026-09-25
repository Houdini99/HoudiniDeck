// Running the fixed helper programs (playerctl, …). Always with argument arrays, never a shell,
// and behind small interfaces so executors and watchers can be tested without the real programs.
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a program to completion. Rejects only if it can't be started (e.g. ENOENT: not installed). */
export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

export const runProcess: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 5000;
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      if (typeof err.code === 'string') return reject(err); // not started at all (ENOENT, EACCES)
      if (err.killed) return resolve({ code: 124, stdout, stderr: `${stderr}timed out after ${timeoutMs / 1000} s` });
      resolve({ code: typeof err.code === 'number' ? err.code : 1, stdout, stderr });
    });
  });

/** A long-running program whose output is read line by line. */
export interface LineProcess {
  kill(): void;
}

export interface LineHandlers {
  line: (line: string) => void;
  /**
   * Called once when the program ends by itself (not after kill()): with an error if it couldn't
   * start, else with its exit code and the last thing it wrote to stderr.
   */
  exit: (code: number | null, error?: NodeJS.ErrnoException, stderr?: string) => void;
}

export type Spawner = (cmd: string, args: string[], on: LineHandlers) => LineProcess;

export const spawnLines: Spawner = (cmd, args, on) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let done = false;
  let lastError = '';
  const finish = (code: number | null, error?: NodeJS.ErrnoException) => {
    if (done) return;
    done = true;
    on.exit(code, error, lastError);
  };
  createInterface({ input: child.stdout }).on('line', (line) => !done && on.line(line));
  createInterface({ input: child.stderr }).on('line', (line) => (lastError = line.trim() || lastError));
  child.on('error', (err) => finish(null, err));
  child.on('close', (code) => finish(code));
  return {
    kill() {
      done = true;
      child.kill();
    },
  };
};

/** How long a started program is watched for an immediate failure. */
const LAUNCH_CHECK_MS = 1000;

/**
 * Start a program without waiting for it (it may keep running, like a browser). Resolves with its exit
 * code if it ends within a second, else with null. Rejects if it can't start (ENOENT: not installed).
 */
export type Launcher = (cmd: string, args: string[]) => Promise<number | null>;

export const launchProgram: Launcher = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      child.unref();
      resolve(null);
    }, LAUNCH_CHECK_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
