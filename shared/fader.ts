// Volume fader taper. A cubic curve gives finer control near the top, where it matters.

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function posToMul(pos: number): number {
  return clamp01(pos) ** 3;
}

export function mulToPos(mul: number): number {
  return clamp01(Math.cbrt(Math.max(0, mul)));
}

export function mulToDb(mul: number): number {
  return mul <= 0 ? -Infinity : 20 * Math.log10(mul);
}

export function dbToMul(db: number): number {
  return db === -Infinity ? 0 : 10 ** (db / 20);
}

/** Meter position for a peak level: linear in dB over −60…0 dB, like OBS's mixer. */
export function meterPos(peakMul: number): number {
  const db = mulToDb(peakMul);
  return db === -Infinity ? 0 : clamp01((db + 60) / 60);
}
