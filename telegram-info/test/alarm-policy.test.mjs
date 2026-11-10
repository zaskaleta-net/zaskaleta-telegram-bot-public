import test from 'node:test';
import assert from 'node:assert/strict';
import { planAlarm, MIN_ALARM_DELAY_MS as MIN, MAINTENANCE_INTERVAL_MS as HOUR } from '../src/alarm-policy.mjs';
const NOW = 1_700_000_000_000;

test('disabled delivery ignores overdue queued work and schedules hourly maintenance', () => {
  assert.equal(planAlarm(NOW, NOW - 1, false), NOW + HOUR);
  assert.equal(planAlarm(NOW, NOW - HOUR, false, NOW + HOUR), null);
});

test('due and stale alarms are clamped to a future minimum', () => {
  assert.equal(planAlarm(NOW, NOW - 1, true), NOW + MIN);
  assert.equal(planAlarm(NOW, NOW, true, NOW - 1), NOW + MIN);
  assert.equal(planAlarm(NOW, NOW + MIN, true, NOW + 1), NOW + MIN);
});

test('future deadlines, maintenance cap and existing safe alarm are preserved', () => {
  assert.equal(planAlarm(NOW, NOW + 120_000, true), NOW + 120_000);
  assert.equal(planAlarm(NOW, NOW + 8 * HOUR, true), NOW + HOUR);
  assert.equal(planAlarm(NOW, null, true), NOW + HOUR);
  assert.equal(planAlarm(NOW, NOW + 120_000, true, NOW + 90_000), null);
  assert.equal(planAlarm(NOW, NOW + 120_000, true, NOW + HOUR), NOW + 120_000);
});

test('repeated disabled alarm firings cannot form a tight loop', () => {
  let clock = NOW, alarm = null;
  for (let i = 0; i < 48; i++) {
    const next = planAlarm(clock, NOW - HOUR, false, alarm);
    if (next !== null) alarm = next;
    assert.ok(alarm >= clock + MIN);
    clock = alarm;
  }
  assert.equal(clock, NOW + 48 * HOUR);
});

test('invalid clocks fail closed and invalid due dates fall back to maintenance', () => {
  assert.throws(() => planAlarm(NaN, 0, true), /Invalid alarm clock/);
  assert.throws(() => planAlarm(-1, 0, true), /Invalid alarm clock/);
  assert.equal(planAlarm(NOW, Infinity, true), NOW + HOUR);
});
