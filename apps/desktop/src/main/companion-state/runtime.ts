import type { Affect, Binding, CompletedTurn, ExplicitModel } from './types.js';
import { assertModel } from './types.js';
import type { StateStore } from './store.js';
import { applyAffect, assertTurn, turnKey } from './affect.js';

export interface AnalysisPort {
  analyze(text: string, route: ExplicitModel, signal: AbortSignal): Promise<Affect>;
}
/** Default-off host lifecycle. No global scan, background timer, prompt injection or model fallback. */
export class CompanionStateRuntime {
  private readonly abort = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly options: {
    enabled?: boolean; binding: Binding; route: ExplicitModel; store: StateStore;
    assertCurrent(): void;
    verify(turn: CompletedTurn, terminalProof: CompletedTurn): Promise<boolean>;
    analysis: AnalysisPort;
  }) {}
  dispose(): void { this.abort.abort(); }
  private current(): void {
    if (this.abort.signal.aborted) throw new Error('COMPANION_DISPOSED');
    this.options.assertCurrent();
  }
  complete(turn: CompletedTurn, text: string): Promise<void> {
    if (this.options.enabled !== true) return Promise.resolve();
    // Freeze before queuing: a caller cannot replace identity while verification awaits.
    const event = structuredClone(turn);
    const operation = this.tail.then(async () => {
      this.current(); assertTurn(event, this.options.binding); assertModel(this.options.route);
      if (!(await this.options.verify(event, turn))) throw new Error('COMPANION_COMPLETION_NOT_DURABLE');
      this.current();
      const snapshot = await this.options.store.read(); this.current();
      const previous = snapshot.turns[turnKey(event)];
      if (previous) {
        if (previous.userMessageId !== event.userMessageId) throw new Error('COMPANION_LOGICAL_TURN_CONFLICT');
        return;
      }
      const affect = await this.options.analysis.analyze(text, this.options.route, this.abort.signal);
      this.current();
      // Do not rerun the model after a concurrent mutation. Conflict is explicit and reviewable.
      await applyAffect(this.options.store, this.options.binding, event, affect, snapshot.revision, () => this.current());
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
