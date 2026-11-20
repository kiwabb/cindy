import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideCompanionOutreach } from '../companionOutreachPolicy.ts';

const now = Date.parse('2026-11-20T12:00:00+08:00');
const hour = 3_600_000;
const state = {
  enabled: true,
  isHome: true,
  busy: false,
  now,
  event: { key: 'agreement-1', kind: 'agreed-follow-up' as const, occurredAt: now },
  eventAlreadyClaimed: false,
  publishedAt: [],
};

test('requires an opt-in, primary computer, idle conversation and a fresh event', () => {
  assert.equal(decideCompanionOutreach(state), 'allow');
  assert.equal(decideCompanionOutreach({ ...state, enabled: false }), 'disabled');
  assert.equal(decideCompanionOutreach({ ...state, isHome: false }), 'not-home');
  assert.equal(decideCompanionOutreach({ ...state, busy: true }), 'busy');
  assert.equal(decideCompanionOutreach({ ...state, event: null }), 'no-fresh-event');
  assert.equal(decideCompanionOutreach({ ...state, event: { ...state.event, occurredAt: now - hour } }), 'no-fresh-event');
  assert.equal(decideCompanionOutreach({ ...state, eventAlreadyClaimed: true }), 'duplicate');
});

test('enforces Shanghai quiet hours, daily quota, and spacing', () => {
  function at(time: string) {
    const stamp = Date.parse(`2026-11-20T${time}:00+08:00`);
    return decideCompanionOutreach({ ...state, now: stamp, event: { ...state.event, occurredAt: stamp } });
  }
  assert.equal(at('07:59'), 'quiet-hours');
  assert.equal(at('08:00'), 'allow');
  assert.equal(at('21:59'), 'allow');
  assert.equal(at('22:00'), 'quiet-hours');
  assert.equal(decideCompanionOutreach({ ...state, publishedAt: [now - 4 * hour, now - 3 * hour] }), 'daily-limit');
  assert.equal(decideCompanionOutreach({ ...state, publishedAt: [now - 3 * hour + 1] }), 'minimum-spacing');
  assert.equal(decideCompanionOutreach({ ...state, publishedAt: [now - 3 * hour] }), 'allow');
  assert.equal(decideCompanionOutreach({ ...state, publishedAt: [now - 16 * hour, now - 20 * hour] }), 'allow');
});
