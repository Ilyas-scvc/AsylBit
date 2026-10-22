export function formatTime(seconds: number, tenths = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return tenths ? `${base}.${Math.floor((seconds * 10) % 10)}` : base;
}

export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function formatKhz(rate: number): string {
  return rate > 0 ? `${(rate / 1000).toFixed(1)} KHZ` : '— KHZ';
}

export function formatDb(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1)} DB` : '−∞ DB';
}
