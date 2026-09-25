// Keyboard Shortcut buttons on Windows, sent by the helper with SendInput. shared/keys.ts names keys by
// their Linux codes, which are key positions on a US keyboard; Windows gets the same positions as scan
// codes and maps them through the active layout like a real keyboard's (Y and Z swap on a German one).
import { KEYS } from '../../../shared/keys.ts';
import type { ActionOf } from '../../../shared/schema.ts';
import { ActionError, type Phase } from '../../actions/executor.ts';
import type { WinRequester } from './helper.ts';

export interface WinKey {
  scan: number;
  /** The scan code has the E0 prefix (arrows, right Ctrl, the Windows key, …). */
  extended?: boolean;
  /** Sent as this virtual-key code instead: keys that SendInput can't reliably send by scan code. */
  vk?: number;
}

/** Linux codes whose scan code has the E0 prefix. */
const EXTENDED: Record<number, number> = {
  96: 0x1c, // Num Enter
  97: 0x1d, // Right Ctrl
  98: 0x35, // Num /
  99: 0x37, // Print Screen
  100: 0x38, // AltGr
  102: 0x47, // Home
  103: 0x48, // Up
  104: 0x49, // Page Up
  105: 0x4b, // Left
  106: 0x4d, // Right
  107: 0x4f, // End
  108: 0x50, // Down
  109: 0x51, // Page Down
  110: 0x52, // Insert
  111: 0x53, // Delete
  125: 0x5b, // Left Windows key (Super)
  126: 0x5c, // Right Windows key
  127: 0x5d, // Menu
};

/** Keys sent as virtual-key codes: media keys, Pause, Num Lock, and F13–F24 (which programs often only know by that code). */
const BY_VK: Record<number, WinKey> = {
  69: { scan: 0x45, extended: true, vk: 0x90 }, // Num Lock
  113: { scan: 0x20, extended: true, vk: 0xad }, // Mute
  114: { scan: 0x2e, extended: true, vk: 0xae }, // Volume Down
  115: { scan: 0x30, extended: true, vk: 0xaf }, // Volume Up
  119: { scan: 0x45, vk: 0x13 }, // Pause
  163: { scan: 0x19, extended: true, vk: 0xb0 }, // Next Track
  164: { scan: 0x22, extended: true, vk: 0xb3 }, // Play/Pause
  165: { scan: 0x10, extended: true, vk: 0xb1 }, // Previous Track
  166: { scan: 0x24, extended: true, vk: 0xb2 }, // Stop
};

/** F13–F24 (Linux 183–194): scan codes 0x64–0x6E and 0x76; virtual keys VK_F13 (0x7C) to VK_F24 (0x87). */
const F13_SCANS = [0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x76];

/** The Windows key for a Linux key code, or undefined if Windows has no such key (e.g. Mic Mute). */
export function windowsKey(code: number): WinKey | undefined {
  if (BY_VK[code]) return BY_VK[code];
  if (EXTENDED[code]) return { scan: EXTENDED[code], extended: true };
  if (code >= 183 && code <= 194) return { scan: F13_SCANS[code - 183], vk: 0x7c + (code - 183) };
  // Up to F12 (88), Linux codes are the keyboard's own scan codes.
  if (code >= 1 && code <= 88) return { scan: code };
  return undefined;
}

/** The helper's key events, [scan, extended, vk, up] each: press in order, release in reverse. */
export function windowsKeyEvents(keys: readonly string[], phase: 'tap' | 'down' | 'up' = 'tap'): number[] {
  const resolved = keys.map((name) => {
    const key = KEYS[name] && windowsKey(KEYS[name].code);
    if (!key) throw new ActionError(`Windows has no ${KEYS[name]?.label ?? name} key`);
    return key;
  });
  const event = (k: WinKey, up: boolean) => [k.scan, k.extended ? 1 : 0, k.vk ?? 0, up ? 1 : 0];
  const down = resolved.flatMap((k) => event(k, false));
  const up = [...resolved].reverse().flatMap((k) => event(k, true));
  return phase === 'down' ? down : phase === 'up' ? up : [...down, ...up];
}

/** Keys via the helper; hold buttons press on down and release on up. */
export async function pressWindowsKeys(helper: WinRequester, action: ActionOf<'system.hotkey'>, phase: Phase): Promise<void> {
  const events = phase.kind === 'hold' ? windowsKeyEvents(action.keys, phase.down ? 'down' : 'up') : windowsKeyEvents(action.keys);
  try {
    await helper.request('keys', { events });
  } catch (err) {
    if (err instanceof ActionError) throw new ActionError(`Couldn’t press the keys: ${err.message}`);
    throw err;
  }
}
