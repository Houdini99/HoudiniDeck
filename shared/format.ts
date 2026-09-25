export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDb(db: number | undefined): string {
  if (db === undefined) return '';
  if (db === -Infinity || db <= -100) return '-∞ dB';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

/** "OBSBasic.StartRecording" → "Start Recording" */
export function prettyHotkey(name: string): string {
  const bare = name.replace(/^(OBSBasic|libobs)\./, '');
  return bare.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._]/g, ' ');
}

/** A timer's reading: "4:59", "0:07", "1:02:03" (seconds, rounded down). */
export function formatClock(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "5:00" → 300, "1:30:00" → 5400, "90" → 90; undefined for anything else. */
export function parseClock(text: string): number | undefined {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d{1,5}$/.test(p))) return undefined;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/** The time of day for a Clock button: "14:05", "14:05:09", or with hour12 "2:05 PM". */
export function formatTimeOfDay(date: Date, opts: { seconds?: boolean; hour12?: boolean } = {}): string {
  const h = date.getHours();
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = opts.seconds ? `:${String(date.getSeconds()).padStart(2, '0')}` : '';
  if (!opts.hour12) return `${String(h).padStart(2, '0')}:${mm}${ss}`;
  return `${h % 12 || 12}:${mm}${ss} ${h < 12 ? 'AM' : 'PM'}`;
}
