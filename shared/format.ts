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
