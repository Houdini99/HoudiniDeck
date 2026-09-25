import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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
    await rename(tmp, path);
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
  await rename(path, target);
  return target;
}
