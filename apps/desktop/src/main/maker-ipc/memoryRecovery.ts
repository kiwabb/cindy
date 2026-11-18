/** Main-only, non-serializable recovery provenance. Not an IPC payload or a user hash. */
export const MEMORY_RECOVERY = Symbol('memoryRecovery');
type Source = { sessionId: string; attemptId: string; sourceRequestId: string; sourceIsContinuation?: boolean; assertCurrent(): void };
type Proof = Source & { message?: string; assertDispatchCurrent?: () => void };
const proofs = new WeakMap<object, Proof>();
export type MemoryRecoveryToken = Readonly<object>;
export function issueMemoryRecovery(source: Source): MemoryRecoveryToken {
  source.assertCurrent();
  if (!source.sessionId || !source.attemptId || !source.sourceRequestId
    || source.attemptId === source.sourceRequestId) throw new Error('MEMORY_RECOVERY_INVALID_SOURCE');
  const token = Object.freeze({}); proofs.set(token, { ...source }); return token;
}
export function bindMemoryRecoveryMessage(token: MemoryRecoveryToken, message: unknown,
  assertDispatchCurrent: () => void): void {
  const proof = proofs.get(token);
  if (!proof) throw new Error('MEMORY_RECOVERY_UNTRUSTED');
  proof.assertCurrent(); assertDispatchCurrent();
  const identity = JSON.stringify(message);
  if (proof.message !== undefined && proof.message !== identity) throw new Error('MEMORY_RECOVERY_INPUT_CHANGED');
  proof.message = identity; proof.assertDispatchCurrent = assertDispatchCurrent;
}
export function readMemoryRecovery(token: MemoryRecoveryToken, sessionId: string,
  attemptId: string, message: unknown): { sourceRequestId: string; sourceIsContinuation?: boolean; assertCurrent(): void } {
  const proof = proofs.get(token);
  if (!proof || !proof.assertDispatchCurrent) throw new Error('MEMORY_RECOVERY_UNTRUSTED');
  const assertCurrent = () => { proof.assertCurrent(); proof.assertDispatchCurrent!(); };
  assertCurrent();
  if (proof.sessionId !== sessionId || proof.attemptId !== attemptId) throw new Error('MEMORY_RECOVERY_TARGET_CHANGED');
  if (proof.message !== JSON.stringify(message)) throw new Error('MEMORY_RECOVERY_INPUT_CHANGED');
  return { sourceRequestId: proof.sourceRequestId, sourceIsContinuation: proof.sourceIsContinuation, assertCurrent };
}
