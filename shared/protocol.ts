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
}

export interface PairingInfo {
  url: string;
  qrSvg: string;
  /** Present when the request came from a device that must know the key (not loopback). */
  key?: string;
}

export interface SettingsView {
  obs: { url: string; hasPassword: boolean; fromEnv: boolean };
  pairing: PairingInfo;
}

export type ToastLevel = 'info' | 'error';

export type ServerMsg =
  | { t: 'hello'; protocol: number; needsAuth: boolean }
  | { t: 'authError'; reason: 'bad-key' | 'key-rotated' | 'timeout' }
  | { t: 'init'; buildId: string; serverTime: number; deck: Deck; obs: ObsState; ext: ExtState; info: ServerInfo }
  | { t: 'deck'; deck: Deck }
  | { t: 'obs'; obs: ObsState; serverTime: number }
  | { t: 'ext'; ext: ExtState }
  | { t: 'meters'; levels: Record<string, number> }
  | { t: 'result'; reqId: number; ok: true; data?: unknown }
  | { t: 'result'; reqId: number; ok: false; error: string }
  | { t: 'toast'; level: ToastLevel; text: string; buttonId?: string };

/** WebSocket close codes used by the server. */
export const CLOSE = {
  authFailed: 4001,
  badOrigin: 4003,
  serverRestart: 1012,
} as const;
