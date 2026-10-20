export const formatDuration = (ms: number | null) => {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const formatSize = (bytes: number | null) => {
  if (!bytes) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
};

export const formatUsd = (usd: number | null | undefined) =>
  usd === null || usd === undefined ? 'невідома' : `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
