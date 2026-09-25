import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** On Windows a virus scanner or the search indexer may hold a file open for a moment, which blocks renames. */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_MS = [50, 100, 200, 400, 800];

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !RENAME_RETRY_CODES.has(code) || attempt >= RENAME_RETRY_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS[attempt]));
    }
  }
}

/** Parsed JSON, or undefined when the file doesn't exist. Throws on unreadable/invalid JSON. */
export async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(text);
}

/** Write via temp file + fsync + rename so a crash never leaves a half-written file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await open(tmp, 'w', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(path: string, value: unknown, mode?: number): Promise<void> {
  return writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Move a broken file aside (e.g. deck.json.corrupt-1727270000000) and return the new path. */
export async function quarantine(path: string): Promise<string> {
  const target = `${path}.corrupt-${Date.now()}`;
  await renameWithRetry(path, target);
  return target;
}

/**
 * Let only the current user read the file: mode 0600, and on Windows (where modes don't apply) an
 * access list with just this user, instead of whatever the folder passes on.
 */
export async function restrictToOwner(path: string): Promise<void> {
  await chmod(path, 0o600);
  if (process.platform !== 'win32') return;
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) throw new Error('USERNAME is not set');
  await new Promise<void>((resolve, reject) => {
    execFile('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(`icacls failed: ${(stderr || stdout || err.message).trim()}`)) : resolve(),
    );
  });
}
