// Keep completion records independently from the short activity list. A quiet
// source or a new preview must not erase the time of the last completed reset.
export function mergeResetHistory(previous = [], items = [], withdrawnIds = [], now = Date.now()) {
  const withdrawn = new Set(withdrawnIds);
  const records = new Map();
  for (const item of [...previous, ...items]) {
    if (!['completed', 'observed'].includes(item.stage) || item.withdrawn || !item.key) continue;
    if (withdrawn.has(item.key.split(':')[0])) continue;
    const at = Date.parse(item.at);
    if (!Number.isFinite(at) || at > now) continue;
    const prior = records.get(item.key);
    if (prior?.stage === 'completed' && item.stage === 'observed') continue;
    records.set(item.key, { key: item.key, stage: item.stage, at: new Date(at).toISOString(), url: item.url || null });
  }
  return [...records.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 400);
}
