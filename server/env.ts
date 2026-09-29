import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Packaging } from '../shared/protocol.ts';

export const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Where the deck looks for new versions: the newest published release (GitHub leaves out drafts and pre-releases). */
export const RELEASES_URL = 'https://api.github.com/repos/Houdini99/HoudiniDeck/releases/latest';

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
  /** Open the deck in the browser once it runs (the Windows Start menu shortcut sets this). */
  openBrowser: boolean;
  production: boolean;
  /** How this copy was installed (the AppImage and the Windows installer's launchers say so); decides how it updates. */
  packaging: Packaging;
  /** The AppImage file this copy runs from (the AppImage runtime sets APPIMAGE). */
  appImagePath?: string;
  /** Where to look for new releases; undefined turns update checks off (STREAMDECK_UPDATE_CHECK=0). */
  updateFeed?: string;
}

function packaging(value: string | undefined): Packaging {
  return value === 'appimage' || value === 'windows-installer' ? value : 'source';
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
    openBrowser: e.STREAMDECK_OPEN_BROWSER === '1',
    production: e.NODE_ENV === 'production',
    packaging: packaging(e.STREAMDECK_PACKAGE),
    appImagePath: e.APPIMAGE || undefined,
    updateFeed: e.STREAMDECK_UPDATE_CHECK === '0' ? undefined : e.STREAMDECK_UPDATE_FEED || RELEASES_URL,
  };
}

/** The user's pictures folder (respects XDG_PICTURES_DIR, e.g. a localized "Bilder", and Windows' own setting). */
export async function picturesDir(): Promise<string> {
  const home = homedir();
  if (process.platform === 'win32') return (await windowsPicturesDir()) || join(home, 'Pictures');
  try {
    const dirs = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8');
    const match = /^XDG_PICTURES_DIR="(.+)"$/m.exec(dirs);
    if (match) return match[1].replace('$HOME', home);
  } catch {
    // no user-dirs file: fall through to the default
  }
  return join(home, 'Pictures');
}

/**
 * Windows knows where the folder really is (OneDrive often moves it, e.g. to C:\Users\me\OneDrive\Bilder).
 * PowerShell answers in base64, so the console's code page can't garble a name like "Imágenes".
 */
function windowsPicturesDir(): Promise<string | undefined> {
  const script = "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath('MyPictures')))";
  return new Promise((resolve) => {
    execFile(
      windowsPowerShell(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => resolve(err ? undefined : Buffer.from(stdout.trim(), 'base64').toString('utf8') || undefined),
    );
  });
}

/** Windows PowerShell 5.1, which every Windows 10/11 has (PowerShell 7 may not be installed). */
export function windowsPowerShell(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
