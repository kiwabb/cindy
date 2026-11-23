import { expect, it } from 'vitest';
import { autonomousEligible, autonomousPause, autonomousWindow, shareableActivity } from '../companionAutonomousPolicy.js';

const now = Date.parse('2026-11-23T19:00:00+08:00');
const hour = 3_600_000;
const settings = { greeting: true, sharing: false, paused: false, eligibleAt: 0, resumedAt: 0, home: 'local' };
const input = { settings, published: [], lastContact: now - 13 * hour, now };

it('admits only current Shanghai windows, never expired or quiet time', () => {
  expect(autonomousWindow(now)).toEqual({ day: '2026-11-23', startsAt: now });
  expect(autonomousWindow(now + 30 * 60_000)).toBeNull();
  expect(autonomousWindow(now + 4 * hour)).toBeNull();
});

it('requires opt-in, twelve hours since contact and at most one delivery per day', () => {
  expect(autonomousEligible(input)).toBe(true);
  expect(autonomousEligible({ ...input, settings: { ...settings, greeting: false } })).toBe(false);
  expect(autonomousEligible({ ...input, lastContact: now - 11 * hour })).toBe(false);
  expect(autonomousEligible({ ...input, published: [now - 4 * hour] })).toBe(false);
  expect(autonomousEligible({ ...input, settings: { ...settings, eligibleAt: now + hour } })).toBe(false);
});

it('backs off for forty-eight hours and stops after two unanswered messages', () => {
  const prior = now - 49 * hour;
  const older = now - 100 * hour;
  const noReply = now - 120 * hour;
  expect(autonomousEligible({ ...input, lastContact: noReply, published: [now - 47 * hour] })).toBe(false);
  expect(autonomousEligible({ ...input, lastContact: noReply, published: [prior] })).toBe(true);
  expect(autonomousPause(settings, [prior, older], noReply).paused).toBe(true);
  expect(autonomousPause(settings, [prior, older], prior + 1).paused).toBe(false);
  expect(autonomousPause({ ...settings, resumedAt: now }, [prior, older], noReply).paused).toBe(false);
  expect(autonomousPause({ ...settings, paused: true }, [], now).paused).toBe(true);
});

it('rejects appended instructions and unsupported plans', () => {
  expect(shareableActivity('泡一杯茶')).toBe(true);
  expect(shareableActivity('散步，看见你在家')).toBe(false);
  expect(shareableActivity('已经看完了书')).toBe(false);
});
