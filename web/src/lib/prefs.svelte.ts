// Per-device preferences. Stored in this browser only; every access is guarded because
// localStorage can be missing or throw (private windows, blocked site data).
export interface Prefs {
  /** Page to open on launch; '' = the last page this device showed. */
  startPage: string;
  lastPage: string;
  compact: boolean;
  showLabels: boolean;
  haptics: boolean;
  keepAwake: boolean;
  /** Darken the screen after this many idle minutes (0: never); the next tap only wakes it. */
  dimAfterMin: number;
  /** A new version this device was told about and put off ("Not now"); its notice stays hidden. */
  skippedUpdate: string;
}

const STORAGE_KEY = 'vsd.prefs';
const DEFAULTS: Prefs = {
  startPage: '',
  lastPage: '',
  compact: false,
  showLabels: true,
  haptics: true,
  keepAwake: true,
  dimAfterMin: 0,
  skippedUpdate: '',
};

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const prefs = $state<Prefs>(load());

export function savePrefs(value: Prefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // not persisted; fine for this session
  }
}

export function haptic(ms = 12): void {
  if (prefs.haptics) navigator.vibrate?.(ms);
}
