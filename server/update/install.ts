// Downloading and installing a new version: the AppImage replaces itself, the Windows installer runs
// silently. Everything that touches the network or starts programs can be swapped for tests.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { fetchFailure } from '../actions/http.ts';
import { windowsPowerShell } from '../env.ts';

/** More than any release should ever be (the AppImage is about 50 MB), so a bad answer can't fill the disk. */
export const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export interface ExpectedFile {
  /** Hex SHA-256, as GitHub reports it for the release asset. */
  sha256: string;
  size: number;
}

/**
 * Download `url` to `dest` and check its size and SHA-256. On any failure `dest` is removed, so what's
 * left behind is always the complete, verified file.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expected: ExpectedFile,
  onProgress: (share: number) => void = () => {},
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (expected.size > MAX_DOWNLOAD_BYTES) throw new Error(`The download is too big (${Math.round(expected.size / 1024 / 1024)} MB)`);
  let res: Response;
  try {
    res = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`The download failed: ${fetchFailure(err, new URL(url), DOWNLOAD_TIMEOUT_MS)}`);
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`The download failed: ${res.status} ${res.statusText}`.trimEnd());
  }
  const hash = createHash('sha256');
  let received = 0;
  try {
    const file = await open(dest, 'w', 0o644);
    try {
      for await (const chunk of res.body) {
        received += chunk.byteLength;
        if (received > expected.size) throw new Error('The download is bigger than GitHub said; nothing was changed');
        hash.update(chunk);
        await file.write(chunk);
        onProgress(received / expected.size);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    if (received !== expected.size) throw new Error('The download stopped early; nothing was changed');
    if (hash.digest('hex') !== expected.sha256.toLowerCase()) throw new Error("The download doesn't match its checksum; nothing was changed");
  } catch (err) {
    await rm(dest, { force: true });
    if ((err as Error).name === 'TimeoutError') throw new Error(`The download took longer than ${DOWNLOAD_TIMEOUT_MS / 60_000} minutes`);
    throw err;
  }
}

/** What to start once this deck has closed (the new AppImage). */
export interface Relaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * The environment for the new AppImage: its runtime sets APPDIR and friends itself, and the browser is
 * open already (a deck started by double-click had STREAMDECK_OPEN_BROWSER=1).
 */
export function relaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const name of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'STREAMDECK_OPEN_BROWSER']) delete next[name];
  return next;
}

/** Starts the Windows installer; resolves with its exit code when it ends (if this deck is still running then). */
export type InstallerRunner = (setup: string, args: string[]) => Promise<number>;

/**
 * The installer shows the UAC prompt itself (Inno Setup's loader elevates). Should Windows still refuse
 * to start it without elevation, it goes through Start-Process instead, which asks for it.
 */
export const runInstaller: InstallerRunner = (setup, args) =>
  new Promise((resolve, reject) => {
    const watch = (cmd: string, cmdArgs: string[], env: NodeJS.ProcessEnv, fallback?: () => void) => {
      const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', env });
      child.on('error', (err: NodeJS.ErrnoException) => (fallback && err.code === 'EACCES' ? fallback() : reject(err)));
      child.on('exit', (code) => resolve(code ?? 1));
    };
    // The file names travel as environment variables, so no quoting rules apply to them.
    const viaStartProcess = () =>
      watch(
        windowsPowerShell(),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$p = Start-Process -FilePath $env:HOUDINIDECK_SETUP -ArgumentList $env:HOUDINIDECK_SETUP_ARGS -PassThru -Wait; exit $p.ExitCode',
        ],
        { ...process.env, HOUDINIDECK_SETUP: setup, HOUDINIDECK_SETUP_ARGS: args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ') },
      );
    watch(setup, args, process.env, viaStartProcess);
  });

/** Silent, but with Inno Setup's progress window, keeping the options chosen last time; /STARTDECK starts the deck again afterwards. */
export function installerArgs(logFile: string): string[] {
  return ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/STARTDECK', `/LOG=${logFile}`];
}
