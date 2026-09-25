/** Keep receiving a pointer's events after it leaves the element. Never let a failure block the press. */
export function capturePointer(el: Element, e: PointerEvent): void {
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // e.g. the pointer is already gone; the press still counts
  }
}
