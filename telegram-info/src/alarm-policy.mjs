// Bounded alarm planning for the Telegram outbox. No external dependencies.
export const MIN_ALARM_DELAY_MS = 60_000;
export const MAINTENANCE_INTERVAL_MS = 3_600_000;
const validTime = value => Number.isSafeInteger(value) && value >= 0;

export function planAlarm(now, due, deliveryEnabled, current = null) {
  if (!validTime(now) || now > Number.MAX_SAFE_INTEGER - MAINTENANCE_INTERVAL_MS) throw new Error('Invalid alarm clock');
  const earliest = now + MIN_ALARM_DELAY_MS;
  const maintenance = now + MAINTENANCE_INTERVAL_MS;
  // Disabled delivery never consults queued deadlines. Hourly maintenance
  // still expires old records and reconciles interrupted claims.
  const target = deliveryEnabled && validTime(due)
    ? Math.max(earliest, Math.min(due, maintenance))
    : maintenance;
  // Replace stale or near-immediate alarms left by an older deployment.
  // Preserve an already scheduled safe alarm when it is no later than target.
  if (validTime(current) && current >= earliest && current <= target) return null;
  return target;
}
