// The access key lives in localStorage (per origin), never in a cookie. If storage is unavailable
// (private mode, blocked site data) it's kept in memory for this tab only.
const STORAGE_KEY = 'vsd.key';
let memoryKey: string | null = null;

export function getKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? memoryKey;
  } catch {
    return memoryKey;
  }
}

export function setKey(key: string): void {
  memoryKey = key;
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // memory only
  }
}

export function clearKey(): void {
  memoryKey = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored
  }
}

/** Accepts a bare key or a full pairing link (…/#k=KEY). */
export function parseKey(input: string): string | null {
  const text = input.trim();
  const fromLink = /[#&]k=([A-Za-z0-9_-]+)/.exec(text);
  if (fromLink) return fromLink[1];
  return /^[A-Za-z0-9_-]{16,200}$/.test(text) ? text : null;
}

/** Pairing links carry the key in the URL fragment; store it and strip it from the address bar. */
export function takeKeyFromUrl(): string | null {
  const key = parseKey(location.hash);
  if (!key) return null;
  setKey(key);
  history.replaceState(null, '', location.pathname + location.search);
  return key;
}
