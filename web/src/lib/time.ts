// Ports of worker/src/dashboard.ts's own timeUntil/timeAgo - identical
// behavior, just typed. Kept as pure functions here rather than
// duplicated per-page.

export function timeUntil(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "any moment now";
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return `~${hours}h ${mins}m`;
}

// Accepts either an epoch-ms number (Santa's own devices table, from D1)
// or an ISO 8601 string (Fleet's seen_time) - same dual-format reasoning
// as the original.
export function timeAgo(input: number | string): string {
  const ts = typeof input === "number" ? input : new Date(input).getTime();
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
