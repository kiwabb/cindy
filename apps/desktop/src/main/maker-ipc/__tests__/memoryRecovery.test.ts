import { it, expect } from 'vitest';
import { issueMemoryRecovery, bindMemoryRecoveryMessage, readMemoryRecovery } from '../memoryRecovery.js';
it('requires Main proof, exact input/target and live generation', () => {
  let live = true; const guard = () => { if (!live) throw Error('stale'); };
  const token = issueMemoryRecovery({ sessionId: 's', attemptId: 'b', sourceRequestId: 'a', assertCurrent: guard });
  expect(() => readMemoryRecovery(token, 's', 'b', 'continue')).toThrow('UNTRUSTED');
  bindMemoryRecoveryMessage(token, 'continue', guard);
  expect(readMemoryRecovery(token, 's', 'b', 'continue').sourceRequestId).toBe('a');
  expect(() => readMemoryRecovery({}, 's', 'b', 'continue')).toThrow('UNTRUSTED');
  expect(() => readMemoryRecovery(JSON.parse(JSON.stringify(token)), 's', 'b', 'continue')).toThrow('UNTRUSTED');
  expect(() => readMemoryRecovery(token, 'other', 'b', 'continue')).toThrow('TARGET_CHANGED');
  expect(() => readMemoryRecovery(token, 's', 'other', 'continue')).toThrow('TARGET_CHANGED');
  expect(() => readMemoryRecovery(token, 's', 'b', 'tampered')).toThrow('INPUT_CHANGED');
  expect(() => bindMemoryRecoveryMessage(token, 'tampered', guard)).toThrow('INPUT_CHANGED');
  const proof = readMemoryRecovery(token, 's', 'b', 'continue'); live = false;
  expect(() => proof.assertCurrent()).toThrow('stale');
  expect(() => readMemoryRecovery(token, 's', 'b', 'continue')).toThrow('stale');
});
it('rejects self recovery', () => {
  expect(() => issueMemoryRecovery({ sessionId: 's', attemptId: 'a', sourceRequestId: 'a', assertCurrent() {} })).toThrow('INVALID_SOURCE');
});
