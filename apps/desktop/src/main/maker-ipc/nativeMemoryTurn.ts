import path from 'node:path';
import {
  MemoryTurnContext, FileMemoryTurnReceipts, FileMemoryTurnSnapshots,
  type MakerMemoryStore, type PreparedMemoryTurn, type Session, type AgentEvent,
} from '@cindy/maker-core';
import { extractPlainText } from './agentHandoff.js';

export interface NativeMemoryTurnInput {
  requestId: string;
  message: string | { type: 'user'; content: unknown };
  signal?: AbortSignal;
  userSource?: { messageId: string; text: string };
  recovery?: { sourceRequestId: string; sourceIsContinuation?: boolean; assertCurrent(): void };
}
export type NativeMemoryTurnPreparation = (input: NativeMemoryTurnInput) =>
  Promise<PreparedMemoryTurn | { kind: 'already-completed' }>;
const bindings = new Map<string, { sessionId: string; prepare: NativeMemoryTurnPreparation; terminal(event: AgentEvent): void }>();

/** Synchronous opt-in lookup. No binding means no IO, subscriptions, or prompt changes. */
export function getNativeMemoryTurnPreparation(session: { id: string; instanceId: string }): NativeMemoryTurnPreparation | undefined {
  const binding = bindings.get(session.instanceId);
  return binding?.sessionId === session.id ? binding.prepare : undefined;
}

let hasSelection: (sessionId: string) => boolean = () => false;
export function setNativeMemorySelectionResolver(resolve: (sessionId: string) => boolean): void { hasSelection = resolve; }
export function hasNativeMemoryBinding(sessionId: string): boolean {
  return hasSelection(sessionId) || [...bindings.values()].some(binding => binding.sessionId === sessionId);
}
export function settleNativeMemoryTurn(session: { id: string; instanceId: string }, event: AgentEvent): void {
  const binding = bindings.get(session.instanceId);
  if (binding?.sessionId === session.id) binding.terminal(event);
}

/** Main-only binding to the authenticated owner/bot runtime; never enabled by IPC payload. */
export function bindNativeMemoryTurn(params: {
  session: Session;
  ownerId: string;
  botId: string;
  directory: string;
  memory: Pick<MakerMemoryStore, 'search'> & { read(filename: string): Promise<{ body: string }> };
  contribute?: ConstructorParameters<typeof MemoryTurnContext>[0]['contribute'];
  assertCurrent(): void;
}): () => void {
  if (!params.ownerId || !params.botId || params.session.remoteHostId || !path.isAbsolute(params.directory)) {
    throw new Error('MEMORY_TURN_BINDING_INVALID');
  }
  params.assertCurrent();
  if (bindings.has(params.session.instanceId)) throw new Error('MEMORY_TURN_ALREADY_BOUND');
  let disposed = false;
  const lifetime = new AbortController();
  const assertCurrent = () => {
    if (disposed || params.session.getStatus() !== 'active') throw new Error('MEMORY_TURN_BINDING_STALE');
    params.assertCurrent();
  };
  // Include session: request IDs and completion generations belong to a conversation.
  const scope = JSON.stringify([params.ownerId, params.botId, params.session.id]);
  const controller = new MemoryTurnContext({ scope, hostTerminals: true, verifyPersistedRecall: true, memory: params.memory, assertCurrent, contribute: params.contribute,
    receipts: new FileMemoryTurnReceipts(path.join(params.directory, 'completed'), assertCurrent),
    snapshots: new FileMemoryTurnSnapshots(path.join(params.directory, 'prepared'), assertCurrent),
  });
  let active: PreparedMemoryTurn | undefined;
  const prepare: NativeMemoryTurnPreparation = async input => {
    assertCurrent();
    const prepared = await controller.prepare(params.session, input.requestId, {
      userSource: input.userSource,
      ...(input.recovery ? { inheritFrom: input.recovery.sourceRequestId, requireInheritedSource: input.recovery.sourceIsContinuation } : {}),
      identity: JSON.stringify(input.message), query: extractPlainText(typeof input.message === 'string' ? input.message : input.message.content),
    }, { signal: input.signal ? AbortSignal.any([lifetime.signal, input.signal]) : lifetime.signal,
      assertRecoveryCurrent: input.recovery?.assertCurrent });
    if (!('kind' in prepared)) active = prepared;
    return prepared;
  };
  bindings.set(params.session.instanceId, { sessionId: params.session.id, prepare, terminal: event => active?.terminal(event) });
  const dispose = () => { disposed = true; lifetime.abort(new Error('MEMORY_TURN_BINDING_STALE')); bindings.delete(params.session.instanceId); unsubscribe(); };
  const unsubscribe = params.session.onStatusChange(status => { if (status !== 'active') dispose(); });
  return dispose;
}
