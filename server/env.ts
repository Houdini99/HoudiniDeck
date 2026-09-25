import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

export interface Env {
  port: number;
  host: string;
  /** Port shown in printed/pairing URLs (the Vite dev server in development). */
  publicPort: number;
  dataDir: string;
  webDist: string;
  /** OBS overrides from the environment; undefined means "use settings.json". */
  obsUrl?: string;
  obsPassword?: string;
  /** Allow buttons that run shell commands. Only the environment can turn this on, never the UI. */
  commandsEnabled: boolean;
  production: boolean;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const port = int(e.PORT, 3325);
  return {
    port,
    host: e.HOST || '0.0.0.0',
    publicPort: int(e.STREAMDECK_PUBLIC_PORT, port),
    dataDir: resolve(e.STREAMDECK_DATA_DIR || join(ROOT_DIR, 'data')),
    webDist: join(ROOT_DIR, 'web', 'dist'),
    obsUrl: e.OBS_URL || undefined,
    obsPassword: e.OBS_PASSWORD,
    commandsEnabled: e.STREAMDECK_ENABLE_COMMANDS === '1',
    production: e.NODE_ENV === 'production',
  };
}

/** The user's pictures folder (respects XDG_PICTURES_DIR, e.g. a localized "Bilder"). */
export function picturesDir(): string {
  const home = homedir();
  try {
    const dirs = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8');
    const match = /^XDG_PICTURES_DIR="(.+)"$/m.exec(dirs);
    if (match) return match[1].replace('$HOME', home);
  } catch {
    // no user-dirs file: fall through to the default
  }
  return join(home, 'Pictures');
}

export function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
