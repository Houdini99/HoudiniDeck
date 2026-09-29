// WebSocket protocol between the browser and the server.
// Client → server messages are defined (and validated) by ClientMsgSchema in schema.ts.
import type { ExtState } from './ext-types.ts';
import type { ObsState } from './obs-types.ts';
import type { ClientMsg, Deck, DeckOp } from './schema.ts';

export type { ClientMsg, DeckOp };

export const PROTOCOL_VERSION = 1;

export interface ServerInfo {
  version: string;
  hostname: string;
  /** URLs other devices can use to reach the deck. */
  urls: string[];
  /** Whether Run Command buttons work (turned on in Settings on the PC itself). */
  commands: boolean;
  /** The server's operating system (Node's process.platform: 'linux', 'win32', …); some actions only work on some. */
  platform: string;
  update: UpdateInfo;
}

/** How this copy was installed: the AppImage and the Windows installer update themselves, a source checkout doesn't. */
export type Packaging = 'appimage' | 'windows-installer' | 'source';

/** A release on GitHub that is newer than the running version. */
export interface AvailableUpdate {
  version: string;
  /** The release's page on GitHub. */
  pageUrl: string;
  /** Its release notes, as plain text (shortened). */
  notes: string;
  publishedAt?: string;
  /** Its download for this copy is attached (CI adds them a few minutes after the release is published). */
  installable: boolean;
}

export interface UpdateInfo {
  packaging: Packaging;
  available?: AvailableUpdate;
  state: 'idle' | 'checking' | 'downloading' | 'installing' | 'restarting';
  /** How much of the download is done (0–1), while downloading. */
  progress?: number;
  /** Why the last check or update failed. */
  error?: string;
  /** When GitHub was last asked (ms since 1970). */
  checkedAt?: number;
  /** Automatic checks: turned on or off in Settings, or off on the server (STREAMDECK_UPDATE_CHECK=0). */
  checks: 'on' | 'off' | 'env-off';
}

export interface PairingInfo {
  url: string;
  qrSvg: string;
  /** Present when the request came from a device that must know the key (not loopback). */
  key?: string;
}

export interface SettingsView {
  obs: { url: string; hasPassword: boolean; fromEnv: boolean };
  /** Run Command buttons; only the PC's own browser may change this (`canChange`). */
  commands: { enabled: boolean; canChange: boolean };
  pairing: PairingInfo;
}

export type ToastLevel = 'info' | 'error';

/** What Undo and Redo would do next (e.g. "deleted button"); unset when there is nothing to undo or redo. */
export interface HistoryInfo {
  undo?: string;
  redo?: string;
}

/** KDE global shortcuts by app, for the KDE Shortcut editor (query 'kdeShortcuts'). */
export interface KdeShortcut {
  id: string;
  name: string;
}

export interface KdeComponent {
  id: string;
  name: string;
  shortcuts: KdeShortcut[];
}

export type ServerMsg =
  | { t: 'hello'; protocol: number; needsAuth: boolean }
  | { t: 'authError'; reason: 'bad-key' | 'key-rotated' | 'timeout' }
  /** `local`: this browser runs on the PC itself (it may install updates and turn Run Command buttons on or off). */
  | { t: 'init'; buildId: string; serverTime: number; deck: Deck; history: HistoryInfo; obs: ObsState; ext: ExtState; info: ServerInfo; local: boolean }
  | { t: 'deck'; deck: Deck; history: HistoryInfo }
  /** The server info changed (e.g. Run Command buttons were turned on or off, or an update was found). */
  | { t: 'info'; info: ServerInfo }
  | { t: 'obs'; obs: ObsState; serverTime: number }
  | { t: 'ext'; ext: ExtState }
  | { t: 'meters'; levels: Record<string, number> }
  /** New live pictures of scenes (data: URLs by scene name), only for scenes this browser asked for. */
  | { t: 'thumbs'; images: Record<string, string> }
  | { t: 'result'; reqId: number; ok: true; data?: unknown }
  | { t: 'result'; reqId: number; ok: false; error: string }
  | { t: 'toast'; level: ToastLevel; text: string; buttonId?: string };

/** WebSocket close codes used by the server. */
export const CLOSE = {
  authFailed: 4001,
  badOrigin: 4003,
  serverRestart: 1012,
} as const;
