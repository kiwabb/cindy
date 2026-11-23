import { validateFactRoute } from '@cindy/maker-core';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertPrivateCompanionStore } from './privateCompanionStore.js';
import type { FactAnalysisPort, FactRoute, MakerMemoryStore, Session } from '@cindy/maker-core';
import { bindNativeMemoryTurn } from './nativeMemoryTurn.js';
import { bindNativeFactMemory } from './nativeFactMemory.js';
import type { CompanionStateAssemblyInput, bindDesktopCompanionState } from './companionStateAssembly.js';

export interface CompanionMemorySelection { ownerId: string; botId: string; sessionId: string; route: FactRoute; companionState?: boolean }
export interface CompanionMemoryRuntimeDeps {
  owner(): { id: string; epoch: string; root: string } | null;
  session(id: string): Session | undefined;
  readBot(id: string): Promise<{ canonicalSessionId: string | null; deleting: boolean; projectMode: boolean } | null>;
  store(botId: string): Promise<MakerMemoryStore>;
  provider(sessionId: string): string | null;
  analysis(sessionId: string, route: FactRoute, assertCurrent: () => void): FactAnalysisPort;
  state?(input: CompanionStateAssemblyInput): ReturnType<typeof bindDesktopCompanionState>;
  refresh(sessionId: string): Promise<unknown>;
  reportFailure(): void;
}
/** Only explicit Main activation populates selections. No startup configuration scan or model calls. */
export class CompanionMemoryRuntime {
  private readonly selections = new Map<string, { selection: CompanionMemorySelection; epoch: string }>();
  private readonly bindings = new Map<string, { instanceId: string; routeKey: string; dispose(): void }>();
  private readonly preparing = new Map<string, Promise<void>>();
  constructor(private readonly deps: CompanionMemoryRuntimeDeps) {}
  async activate(input: CompanionMemorySelection): Promise<void> {
    const owner = this.deps.owner();
    validateFactRoute(input.route);
    if (!owner || owner.id !== input.ownerId) throw new Error('COMPANION_MEMORY_SCOPE_OR_ROUTE_INVALID');
    if (input.route.protocol === 'openai-responses' && !['127.0.0.1','localhost','[::1]'].includes(new URL(input.route.baseUrl!).hostname))
      throw new Error('COMPANION_MEMORY_SCOPE_OR_ROUTE_INVALID');
    if (this.selections.has(input.sessionId)) throw new Error('COMPANION_MEMORY_ALREADY_ENABLED');
    const selected = { selection: structuredClone(input), epoch: owner.epoch };
    this.selections.set(input.sessionId, selected);
    try { await this.ensure(input.sessionId); }
    catch (error) { if (this.selections.get(input.sessionId) === selected) this.selections.delete(input.sessionId); throw error; }
  }
  hasSelection(sessionId: string): boolean { return this.selections.has(sessionId); }
  ensure(sessionId: string): Promise<void> {
    if (!this.selections.has(sessionId)) return Promise.resolve();
    const pending = this.preparing.get(sessionId);
    if (pending) return pending;
    const work = this.bind(sessionId).finally(() => { if (this.preparing.get(sessionId) === work) this.preparing.delete(sessionId); });
    this.preparing.set(sessionId, work); return work;
  }
  private async bind(sessionId: string): Promise<void> {
    const config = this.selections.get(sessionId)!;
    const { selection, epoch } = config;
    const session = this.deps.session(sessionId);
    const owner = this.deps.owner();
    const chat = session && {
      engine: session.agentKind, model: session.model, providerId: this.deps.provider(sessionId),
      device: session.agentDeviceId ?? null,
    };
    const independentAnalysis = selection.route.protocol === 'cindy-subscription' && !selection.route.agentDeviceId;
    let boundStore: MakerMemoryStore | undefined;
    let disposed = false;
    const current = () => {
      const live = this.deps.owner();
      if (disposed || !session || !owner || this.selections.get(sessionId) !== config || live?.id !== selection.ownerId
        || live.epoch !== epoch || this.deps.session(sessionId) !== session || session.getStatus() !== 'active'
        || !chat || session.remoteHostId || !['codex', 'pi'].includes(session.agentKind)
        || session.agentKind !== chat.engine || session.model !== chat.model
        || this.deps.provider(sessionId) !== chat.providerId || (session.agentDeviceId ?? null) !== chat.device
        || (!independentAnalysis && (chat.engine !== 'codex' || chat.model !== selection.route.model
          || chat.providerId !== selection.route.providerId || chat.device !== (selection.route.agentDeviceId ?? null)))
        || (chat.engine === 'pi' && chat.device)) throw new Error('COMPANION_MEMORY_BINDING_STALE');
      if (boundStore) assertPrivateCompanionStore(owner!.root, selection.botId, boundStore.getStorageIdentity());
    };
    current();
    // Older peers can still serve ordinary chat. Do not attach unsupported recall
    // or extraction, and retry capability negotiation on a later real send.
    if (session!.supportsHostTurnContext === false) {
      this.bindings.get(sessionId)?.dispose();
      return;
    }
    const verifyCanonicalSession = async () => {
      const bot = await this.deps.readBot(selection.botId);
      current();
      if (!bot || bot.deleting || !bot.projectMode || bot.canonicalSessionId !== sessionId
        || path.resolve(session!.workDir) !== path.join(owner!.root, 'bots', selection.botId, 'workspace'))
        throw new Error('COMPANION_PRIVATE_BOT_REQUIRED');
    };
    await verifyCanonicalSession();
    const binding = this.bindings.get(sessionId);
    const routeKey = JSON.stringify(chat);
    if (binding?.instanceId === session!.instanceId && binding.routeKey === routeKey) return;
    binding?.dispose();
    const store = await this.deps.store(selection.botId); current();
    boundStore = store; current();
    let refreshing = false;
    const analysis = this.deps.analysis(sessionId, selection.route, current);
    const queue = await store.createFactMemory({
      scope: { ownerId: selection.ownerId, botId: selection.botId },
      selectedRoute: selection.route,
      port: {
        route: analysis.route,
        analyze: async input => {
          await verifyCanonicalSession();
          const result = await analysis.analyze(input);
          await verifyCanonicalSession();
          return result;
        },
      },
      assertCurrentScope: current,
      onCommitted: () => { refreshing = chat?.engine === 'codex'; },
    });
    const key = (value: string) => createHash('sha256').update(value).digest('hex');
    let unbindHidden: (() => void) | undefined;
    let unbindFacts: (() => void) | undefined;
    let state: Awaited<ReturnType<typeof bindDesktopCompanionState>> | undefined;
    let unsubscribe = () => {};
    const dispose = () => {
      if (disposed) return; disposed = true;
      state?.dispose(); unbindFacts?.(); unbindHidden?.(); queue.dispose(); unsubscribe();
      if (this.bindings.get(sessionId)?.instanceId === session!.instanceId) this.bindings.delete(sessionId);
    };
    try {
      current();
      if (selection.companionState === true) {
        if (!this.deps.state) throw Error('COMPANION_STATE_ASSEMBLY_UNAVAILABLE');
        state = await this.deps.state({ ownerId: selection.ownerId, ownerEpoch: epoch, botId: selection.botId,
          session: session!, route: selection.route, assertCurrent: current, reportFailure: this.deps.reportFailure });
      }
      await verifyCanonicalSession();
      unbindHidden = bindNativeMemoryTurn({ session: session!, ownerId: selection.ownerId, botId: selection.botId,
        directory: path.join(owner!.root, 'companion-memory', key(selection.botId), key(sessionId)), memory: store, assertCurrent: current, contribute: state?.contribute });
      unbindFacts = bindNativeFactMemory(session!, queue, current, this.deps.reportFailure, async () => {
        if (!refreshing) return;
        refreshing = false;
        current();
        await this.deps.refresh(sessionId);
      });
      unsubscribe = session!.onStatusChange(status => { if (status !== 'active') dispose(); });
      current();
      this.bindings.set(sessionId, { instanceId: session!.instanceId, routeKey, dispose });
    } catch (error) { dispose(); throw error; }
  }
  deactivate(sessionId: string): void { this.selections.delete(sessionId); this.bindings.get(sessionId)?.dispose(); }
  deleteBot(botId: string): void {
    for (const [id, entry] of this.selections) if (entry.selection.botId === botId) this.deactivate(id);
  }
  dispose(): void { for (const id of [...this.selections.keys()]) this.deactivate(id); }
}
