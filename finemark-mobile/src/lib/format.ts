export function fmtDate(s?: string | null, withTime = false): string {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  if (!withTime) return date;
  return `${date} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function fmtRelative(s?: string | null): string {
  if (!s) return '';
  const d = new Date(s).getTime();
  if (isNaN(d)) return '';
  const diff = Date.now() - d;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function fmtKES(n?: number | string | null): string {
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (num === null || num === undefined || isNaN(num)) return 'KES 0';
  return `KES ${num.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
}

export function initials(name?: string | null): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');
}
