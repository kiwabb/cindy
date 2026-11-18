import type { FactMemoryQueue, FactSource, FactTurnToken, SessionSendResult } from '@cindy/maker-core';

interface NativeFactSession { id: string; instanceId: string; remoteHostId: string | null }
interface Binding {
  queue: FactMemoryQueue;
  assertCurrent(): void;
  reportFailure(): void;
  afterDrain?(): Promise<unknown>;
  turns: Map<number, FactTurnToken>;
}
const bindings = new WeakMap<NativeFactSession, Binding>();

/** Host-only, exact live Session binding. No persisted global switch or renderer-supplied scope. */
export function bindNativeFactMemory(session: NativeFactSession, queue: FactMemoryQueue,
  assertCurrent: () => void, reportFailure: () => void, afterDrain?: () => Promise<unknown>): () => void {
  assertCurrent();
  if (session.remoteHostId || bindings.has(session)) throw new Error('Unsupported fact memory binding');
  const binding: Binding = { queue, assertCurrent, reportFailure, afterDrain, turns: new Map() };
  bindings.set(session, binding);
  return () => {
    if (bindings.get(session) === binding) bindings.delete(session);
    binding.turns.clear();
    queue.dispose();
  };
}

/** Compose with the real send transaction; preserve its UserMessage and all send callbacks. */
export async function withNativeFactMemoryTurn(
  session: NativeFactSession,
  source: Omit<FactSource, 'generation' | 'sessionId'> | undefined,
  dispatch: (reserved?: (generation: number) => void) => Promise<SessionSendResult>,
): Promise<SessionSendResult> {
  const binding = source && bindings.get(session);
  if (!binding) return dispatch();
  let generation: number | undefined;
  let accepted = false;
  try {
    const result = await dispatch(value => {
      try {
        binding.assertCurrent();
        generation = value;
        binding.turns.set(value, binding.queue.prepare({ ...source!, sessionId: session.id, generation: value }));
      } catch { binding.reportFailure(); }
    });
    accepted = result.accepted;
    return result;
  } finally {
    if (!accepted && generation !== undefined) finishNativeFactMemoryTurn(session, generation, 'failed');
  }
}

/** Called by the existing product-terminal classifier, never directly by a vendor done event. */
export function finishNativeFactMemoryTurn(session: NativeFactSession, generation: number,
  outcome: 'completed' | 'failed'): void {
  const binding = bindings.get(session);
  const token = binding?.turns.get(generation);
  if (!binding || !token) return;
  binding.turns.delete(generation);
  try {
    binding.assertCurrent();
    binding.queue.finish(token, outcome, generation);
    if (outcome === 'completed') void binding.queue.drain().then(() => binding.afterDrain?.()).catch(() => binding.reportFailure());
  } catch {
    // Facts must never turn an already-completed visible reply into a send failure.
    binding.reportFailure();
  }
}

/** Accept only the host's verified desktop context (direct send or trusted queue receipt).
 * Never derive user facts from the final wire prompt, assistant text or channel metadata. */
export function readNativeFactUserSource(
  context: { origin: { kind: string }; rawChannelText: string } | undefined,
  persisted: { clientId: string; autoResume?: boolean; sourcePlugin?: unknown; botTaskCoordination?: unknown; sharedTaskAuthor?: unknown } | null | undefined,
  retryUserClientId: string | undefined,
  queue?: { ordinary: boolean; authoredText: unknown; remote: boolean },
): { messageId: string; text: string } | undefined {
  if (!persisted?.clientId || persisted.autoResume || retryUserClientId || persisted.sourcePlugin
    || persisted.botTaskCoordination || persisted.sharedTaskAuthor || (context && context.origin.kind !== 'desktop')) return undefined;
  // Ordinary queue text is stamped by trusted input admission and carried in the Main-only
  // AUTO_REVIEW_SOURCE_CONTENT symbol. The Pi-command receipt is not a general chat identity.
  const text = context?.rawChannelText ?? (queue?.ordinary && !queue.remote ? queue.authoredText : undefined);
  if (typeof text !== 'string' || !text.trim()) return undefined;
  return { messageId: persisted.clientId, text };
}
