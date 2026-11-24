import { expect, it } from 'vitest';
import { autonomousRoll, autonomousTickHit, autonomousTickStart } from '../companionAutonomousPolicy.js';
import { decideCompanionOutreach } from '../companionOutreachPolicy.js';

const at = (time: string) => Date.parse('2026-11-23T' + time + ':00+08:00');

it('buckets time into five-minute ticks and keeps the same result throughout that tick', () => {
  const startsAt = at('08:05');
  expect(autonomousTickStart(startsAt + 299_999)).toBe(startsAt);
  expect(autonomousTickStart(startsAt + 300_000)).toBe(startsAt + 300_000);
  const roll = autonomousTickHit('/owner', 'bot', startsAt);
  expect(autonomousTickHit('/owner', 'bot', autonomousTickStart(startsAt + 299_999))).toBe(roll);
});

it('uses the HerAndHim uniform base threshold range', () => {
  expect(autonomousRoll(2 / 288, 0)).toBe(true);
  expect(autonomousRoll(3 / 288, 0)).toBe(false);
  expect(autonomousRoll(3 / 288, 0.5)).toBe(true);
  expect(autonomousRoll(6 / 288, 1)).toBe(false);
});

it('respects only the autonomous daily cap and midnight to 08:00 quiet hours', () => {
  const decide = (now: number, publishedAt: number[] = [], autonomous = true) =>
    decideCompanionOutreach({
      enabled: true, isHome: true, busy: false, now, publishedAt, eventAlreadyClaimed: false,
      event: { key: 'tick', occurredAt: now, autonomous },
    });
  expect(decide(at('07:55'))).toBe('quiet-hours');
  expect(decide(at('08:00'))).toBe('allow');
  expect(decide(at('23:55'))).toBe('allow');
  expect(decide(at('23:55'), Array(5).fill(at('23:50')))).toBe('allow');
  expect(decide(at('23:55'), Array(6).fill(at('23:50')))).toBe('daily-limit');
  expect(decide(at('23:55'), [], false)).toBe('quiet-hours');
  expect(decide(at('21:55'), [at('21:50')], false)).toBe('minimum-spacing');
});
