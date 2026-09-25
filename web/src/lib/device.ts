// Browser capabilities: keeping the screen on, fullscreen.
import NoSleep from 'nosleep.js';

let noSleep: NoSleep | null = null;
let wanted = false;
let armed = false;

// Browsers only allow this from a user gesture, so arm it for the next tap.
function enableOnGesture(): void {
  armed = false;
  if (!wanted) return;
  noSleep ??= new NoSleep();
  noSleep.enable().catch(() => {
    // Refused (e.g. wake lock denied); try again the next time the page becomes visible.
  });
}

function arm(): void {
  if (armed || !wanted) return;
  armed = true;
  document.addEventListener('pointerup', enableOnGesture, { once: true, capture: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wanted && !noSleep?.isEnabled) arm();
});

/** Uses the Wake Lock API where available (localhost/https) and a looping silent video otherwise. */
export function setKeepAwake(on: boolean): void {
  wanted = on;
  if (on) {
    if (!noSleep?.isEnabled) arm();
  } else {
    noSleep?.disable();
  }
}

type FullscreenDoc = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => void };

export function canFullscreen(): boolean {
  const doc = document as FullscreenDoc;
  return !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

export function toggleFullscreen(): void {
  const doc = document as FullscreenDoc;
  const el = document.documentElement as FullscreenEl;
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    (doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc))?.();
  } else if (el.requestFullscreen) {
    el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  } else {
    el.webkitRequestFullscreen?.();
  }
}

/** Shrink raster images to 512px WebP before upload; GIFs (animation) and SVGs pass through. */
export async function prepareImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 400_000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Safari can't encode WebP and falls back to PNG, which is fine.
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/webp', 0.9));
  } catch {
    return file;
  }
}
