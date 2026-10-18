// Preserve the existing service's behavior until its owner explicitly changes it.
export const LEGACY_SETTINGS = { alerts: 'all', banked: true };
export const RECOMMENDED_SETTINGS = { alerts: 'both', banked: false };

export function normalizeSettings(value) {
  const s = value === undefined ? LEGACY_SETTINGS : value;
  if (!s || typeof s !== 'object' || !['both', 'completed', 'all'].includes(s.alerts) || typeof s.banked !== 'boolean') {
    throw new Error('invalid_settings');
  }
  return { alerts: s.alerts, banked: s.banked };
}

export function allowsNotification(item, settings) {
  const s = normalizeSettings(settings);
  if (item.stage === 'banked') return s.banked;
  if (['completed', 'observed'].includes(item.stage)) return true;
  if (s.alerts === 'completed') return false;
  if (item.stage === 'planned') return true;
  return s.alerts === 'all';
}
