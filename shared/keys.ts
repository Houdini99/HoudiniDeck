// Keys for Keyboard Shortcut buttons: Linux evdev names and codes (from linux/input-event-codes.h,
// which ydotool sends), labels, and the browser's KeyboardEvent.code for recording shortcuts.
// Codes are physical key positions named after the US layout: on a German keyboard, KEY_Z is the key
// labeled Y. Recording a shortcut in the browser gets that right, since KeyboardEvent.code is also a position.

export interface KeyInfo {
  code: number;
  label: string;
  group: KeyGroup;
  /** KeyboardEvent.code values for this key. */
  dom?: string[];
}

export const KEY_GROUPS = ['Modifiers', 'Letters', 'Digits', 'Function keys', 'Navigation', 'Editing', 'Symbols', 'Numpad', 'Media'] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];

const letters = 'QWERTYUIOPASDFGHJKLZXCVBNM';
const LETTER_CODES = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30, 31, 32, 33, 34, 35, 36, 37, 38, 44, 45, 46, 47, 48, 49, 50];
const FKEY_CODES = [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194];
const NUMPAD_DIGIT_CODES = [82, 79, 80, 81, 75, 76, 77, 71, 72, 73];

export const KEYS = {
  KEY_LEFTCTRL: { code: 29, label: 'Ctrl', group: 'Modifiers', dom: ['ControlLeft'] },
  KEY_LEFTSHIFT: { code: 42, label: 'Shift', group: 'Modifiers', dom: ['ShiftLeft'] },
  KEY_LEFTALT: { code: 56, label: 'Alt', group: 'Modifiers', dom: ['AltLeft'] },
  KEY_LEFTMETA: { code: 125, label: 'Super', group: 'Modifiers', dom: ['MetaLeft', 'OSLeft'] },
  KEY_RIGHTCTRL: { code: 97, label: 'Right Ctrl', group: 'Modifiers', dom: ['ControlRight'] },
  KEY_RIGHTSHIFT: { code: 54, label: 'Right Shift', group: 'Modifiers', dom: ['ShiftRight'] },
  KEY_RIGHTALT: { code: 100, label: 'AltGr', group: 'Modifiers', dom: ['AltRight'] },
  KEY_RIGHTMETA: { code: 126, label: 'Right Super', group: 'Modifiers', dom: ['MetaRight', 'OSRight'] },
  ...Object.fromEntries(
    [...letters].map((l, i) => [`KEY_${l}`, { code: LETTER_CODES[i], label: l, group: 'Letters', dom: [`Key${l}`] }]),
  ),
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, d) => [`KEY_${d}`, { code: d === 0 ? 11 : d + 1, label: String(d), group: 'Digits', dom: [`Digit${d}`] }]),
  ),
  ...Object.fromEntries(FKEY_CODES.map((code, i) => [`KEY_F${i + 1}`, { code, label: `F${i + 1}`, group: 'Function keys', dom: [`F${i + 1}`] }])),
  KEY_ESC: { code: 1, label: 'Esc', group: 'Navigation', dom: ['Escape'] },
  KEY_TAB: { code: 15, label: 'Tab', group: 'Navigation', dom: ['Tab'] },
  KEY_ENTER: { code: 28, label: 'Enter', group: 'Navigation', dom: ['Enter'] },
  KEY_SPACE: { code: 57, label: 'Space', group: 'Navigation', dom: ['Space'] },
  KEY_UP: { code: 103, label: 'Up', group: 'Navigation', dom: ['ArrowUp'] },
  KEY_DOWN: { code: 108, label: 'Down', group: 'Navigation', dom: ['ArrowDown'] },
  KEY_LEFT: { code: 105, label: 'Left', group: 'Navigation', dom: ['ArrowLeft'] },
  KEY_RIGHT: { code: 106, label: 'Right', group: 'Navigation', dom: ['ArrowRight'] },
  KEY_HOME: { code: 102, label: 'Home', group: 'Navigation', dom: ['Home'] },
  KEY_END: { code: 107, label: 'End', group: 'Navigation', dom: ['End'] },
  KEY_PAGEUP: { code: 104, label: 'Page Up', group: 'Navigation', dom: ['PageUp'] },
  KEY_PAGEDOWN: { code: 109, label: 'Page Down', group: 'Navigation', dom: ['PageDown'] },
  KEY_BACKSPACE: { code: 14, label: 'Backspace', group: 'Editing', dom: ['Backspace'] },
  KEY_DELETE: { code: 111, label: 'Delete', group: 'Editing', dom: ['Delete'] },
  KEY_INSERT: { code: 110, label: 'Insert', group: 'Editing', dom: ['Insert'] },
  KEY_SYSRQ: { code: 99, label: 'Print', group: 'Editing', dom: ['PrintScreen'] },
  KEY_PAUSE: { code: 119, label: 'Pause', group: 'Editing', dom: ['Pause'] },
  KEY_SCROLLLOCK: { code: 70, label: 'Scroll Lock', group: 'Editing', dom: ['ScrollLock'] },
  KEY_CAPSLOCK: { code: 58, label: 'Caps Lock', group: 'Editing', dom: ['CapsLock'] },
  KEY_NUMLOCK: { code: 69, label: 'Num Lock', group: 'Editing', dom: ['NumLock'] },
  KEY_COMPOSE: { code: 127, label: 'Menu', group: 'Editing', dom: ['ContextMenu'] },
  KEY_MINUS: { code: 12, label: '-', group: 'Symbols', dom: ['Minus'] },
  KEY_EQUAL: { code: 13, label: '=', group: 'Symbols', dom: ['Equal'] },
  KEY_LEFTBRACE: { code: 26, label: '[', group: 'Symbols', dom: ['BracketLeft'] },
  KEY_RIGHTBRACE: { code: 27, label: ']', group: 'Symbols', dom: ['BracketRight'] },
  KEY_BACKSLASH: { code: 43, label: '\\', group: 'Symbols', dom: ['Backslash'] },
  KEY_SEMICOLON: { code: 39, label: ';', group: 'Symbols', dom: ['Semicolon'] },
  KEY_APOSTROPHE: { code: 40, label: "'", group: 'Symbols', dom: ['Quote'] },
  KEY_GRAVE: { code: 41, label: '`', group: 'Symbols', dom: ['Backquote'] },
  KEY_COMMA: { code: 51, label: ',', group: 'Symbols', dom: ['Comma'] },
  KEY_DOT: { code: 52, label: '.', group: 'Symbols', dom: ['Period'] },
  KEY_SLASH: { code: 53, label: '/', group: 'Symbols', dom: ['Slash'] },
  KEY_102ND: { code: 86, label: '< > (ISO)', group: 'Symbols', dom: ['IntlBackslash'] },
  ...Object.fromEntries(
    NUMPAD_DIGIT_CODES.map((code, d) => [`KEY_KP${d}`, { code, label: `Num ${d}`, group: 'Numpad', dom: [`Numpad${d}`] }]),
  ),
  KEY_KPPLUS: { code: 78, label: 'Num +', group: 'Numpad', dom: ['NumpadAdd'] },
  KEY_KPMINUS: { code: 74, label: 'Num -', group: 'Numpad', dom: ['NumpadSubtract'] },
  KEY_KPASTERISK: { code: 55, label: 'Num *', group: 'Numpad', dom: ['NumpadMultiply'] },
  KEY_KPSLASH: { code: 98, label: 'Num /', group: 'Numpad', dom: ['NumpadDivide'] },
  KEY_KPDOT: { code: 83, label: 'Num .', group: 'Numpad', dom: ['NumpadDecimal'] },
  KEY_KPENTER: { code: 96, label: 'Num Enter', group: 'Numpad', dom: ['NumpadEnter'] },
  KEY_MUTE: { code: 113, label: 'Mute', group: 'Media', dom: ['AudioVolumeMute'] },
  KEY_VOLUMEDOWN: { code: 114, label: 'Volume Down', group: 'Media', dom: ['AudioVolumeDown'] },
  KEY_VOLUMEUP: { code: 115, label: 'Volume Up', group: 'Media', dom: ['AudioVolumeUp'] },
  KEY_MICMUTE: { code: 248, label: 'Mic Mute', group: 'Media' },
  KEY_PLAYPAUSE: { code: 164, label: 'Play/Pause', group: 'Media', dom: ['MediaPlayPause'] },
  KEY_NEXTSONG: { code: 163, label: 'Next Track', group: 'Media', dom: ['MediaTrackNext'] },
  KEY_PREVIOUSSONG: { code: 165, label: 'Previous Track', group: 'Media', dom: ['MediaTrackPrevious'] },
  KEY_STOPCD: { code: 166, label: 'Stop', group: 'Media', dom: ['MediaStop'] },
} as Record<string, KeyInfo>;

export const KEY_NAMES = Object.keys(KEYS) as [string, ...string[]];

/** The modifiers the editor offers as toggles, in the order they're pressed. */
export const MODIFIER_KEYS = ['KEY_LEFTCTRL', 'KEY_LEFTSHIFT', 'KEY_LEFTALT', 'KEY_LEFTMETA'] as const;

const BY_DOM = new Map(Object.entries(KEYS).flatMap(([name, key]) => (key.dom ?? []).map((dom) => [dom, name] as const)));

/** The key name for a KeyboardEvent.code (e.g. "KeyM" → "KEY_M"). */
export function keyFromDom(code: string): string | undefined {
  return BY_DOM.get(code);
}

export function isModifier(name: string): boolean {
  return KEYS[name]?.group === 'Modifiers';
}

/** "Ctrl+Shift+M" */
export function shortcutLabel(keys: readonly string[]): string {
  return keys.map((k) => KEYS[k]?.label ?? k).join('+');
}

/** ydotool's arguments: press every key in order, then release them in reverse. */
export function ydotoolKeyArgs(keys: readonly string[], phase: 'tap' | 'down' | 'up' = 'tap'): string[] {
  const down = keys.map((k) => `${KEYS[k].code}:1`);
  const up = [...keys].reverse().map((k) => `${KEYS[k].code}:0`);
  return phase === 'down' ? down : phase === 'up' ? up : [...down, ...up];
}
