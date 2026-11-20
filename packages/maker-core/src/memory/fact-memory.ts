import { createHash } from 'node:crypto';
import type { FactJournal } from './fact-journal.js';
import { MemoryError, type MemoryRecord, type WriteOptions } from './types.js';

export interface FactScope { ownerId: string; botId: string }
export interface FactRoute {
  providerId: string;
  model: string;
  protocol: 'openai-responses' | 'cindy-subscription';
  /** HTTP routes only; subscription routes never carry credentials or URLs. */
  baseUrl?: string;
  agentDeviceId?: string | null;
}
export interface FactSource {
  sessionId: string;
  logicalTurnId: string;
  userMessageId: string;
  generation: number;
  /** Only the actual owner's visible utterance, never assistant/tool/persona text. */
  userText: string;
  origin: 'user';
}
export type FactChange =
  | { action: 'ADD'; name: string; title: string; description: string; body: string; quote: string; subject: 'user' }
  | { action: 'UPDATE'; filename: string; title: string; description: string; body: string; quote: string; subject: 'user' }
  | { action: 'DELETE'; filename: string; quote: string; subject: 'user' }
  | { action: 'NOOP' };
export type FactMutation = { write: WriteOptions } | { delete: string };
export interface FactAnalysisPort {
  /** Resolved user-selected route. The port must dispatch this route without fallback. */
  readonly route: FactRoute;
  analyze(input: { route: FactRoute; userText: string; assistantReply?: string; facts: MemoryRecord[]; signal: AbortSignal }): Promise<{ route: FactRoute; changes: unknown }>;
}
export interface FactMemoryDeps {
  scope: FactScope;
  selectedRoute: FactRoute;
  port: FactAnalysisPort;
  journal: FactJournal;
  assertCurrentScope(scope: FactScope): void;
  onCommitted?(): void;
  list(): Promise<MemoryRecord[]>;
  apply(revision: number, mutations: FactMutation[]): Promise<void>;
}
interface Payload { source: FactSource; revision: number; route: FactRoute; assistantReply?: string }
const sourceId = (scope: FactScope, s: FactSource) => hash([scope.ownerId, scope.botId, s.sessionId, s.logicalTurnId, s.userMessageId]);
const sourceHash = (s: FactSource) => hash([s.sessionId, s.logicalTurnId, s.userMessageId, s.userText]);
export interface FactTurnToken { readonly generation: number }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const routeKey = (r: FactRoute) => JSON.stringify([r.providerId, r.model, r.protocol, r.baseUrl, r.agentDeviceId ?? null]);
const managedName = /^user_fact_[a-f0-9]{24}_[a-z0-9_-]{1,24}\.md$/;

export function validateFactRoute(route: FactRoute): void {
  if (route.protocol === 'cindy-subscription') {
    if (route.providerId !== 'openai' || !route.model.trim() || route.baseUrl !== undefined
      || (route.agentDeviceId !== null && route.agentDeviceId !== undefined && !/^[a-f0-9]{64}$/.test(route.agentDeviceId)))
      throw new MemoryError('invalid-frontmatter', 'Explicit owned subscription required');
    return;
  }
  if (typeof route.baseUrl !== 'string' || route.agentDeviceId) throw new MemoryError('invalid-frontmatter', 'Explicit HTTP route required');
  const url = new URL(route.baseUrl);
  if (!route.providerId.trim() || !route.model.trim() || route.protocol !== 'openai-responses' || url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw new MemoryError('invalid-frontmatter', 'Explicit fact-analysis route required');
  }
}
export function validateFactSelection(selected: FactRoute, actual: FactRoute): void {
  validateFactRoute(selected);
  validateFactRoute(actual);
  if (routeKey(selected) !== routeKey(actual)) throw new MemoryError('not-ready', 'Fact analysis route changed');
}
function changesOf(raw: unknown, source: FactSource, records: MemoryRecord[]): FactChange[] {
  if (!Array.isArray(raw) || raw.length > 16) throw new Error('Invalid fact changes');
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error('Invalid fact change');
    if (item.action === 'NOOP' && Object.keys(item).length === 1) continue;
    const fields = item.action === 'ADD' ? ['action','name','title','description','body','quote','subject']
      : item.action === 'UPDATE' ? ['action','filename','title','description','body','quote','subject']
        : item.action === 'DELETE' ? ['action','filename','quote','subject'] : [];
    if (!fields.length || Object.keys(item).length !== fields.length || fields.some(k => typeof item[k] !== 'string') || item.subject !== 'user' || !item.quote.trim() || !source.userText.includes(item.quote)) throw new Error('Fact requires exact user evidence');
    const key = item.action === 'ADD' ? item.name : item.filename;
    if (seen.has(key)) throw new Error('Duplicate fact target');
    seen.add(key);
    if (item.action === 'ADD') {
      if (!/^[a-z0-9_-]{1,24}$/.test(item.name)) throw new Error('Invalid fact name');
    } else if (!managedName.test(item.filename) || !records.some(r => r.filename === item.filename && r.frontmatter.type === 'user')) {
      throw new Error('Analysis may only change existing managed user facts');
    }
    if (item.action !== 'DELETE' && (!item.title.trim() || item.title.length > 100 || !item.description.trim() || item.description.length > 200 || /[\r\n]/.test(item.description) || !item.body.trim() || Buffer.byteLength(item.body) > 6000)) throw new Error('Invalid fact content');
  }
  return raw as FactChange[];
}

/** Opt-in product core. No timers, implicit model selection, transcript scan or import-time I/O. */
export class FactMemoryQueue {
  private readonly tokens = new WeakMap<FactTurnToken, Payload>();
  private running?: Promise<void>;
  private readonly abort = new AbortController();
  private readonly scope: FactScope;
  private readonly route: FactRoute;
  constructor(private readonly deps: FactMemoryDeps) {
    this.scope = Object.freeze({ ...deps.scope });
    this.route = Object.freeze({ ...deps.selectedRoute });
    validateFactSelection(this.route, deps.port.route);
    this.assertReady();
  }
  private assertReady(): void {
    if (this.abort.signal.aborted) throw new MemoryError('not-ready', 'Fact memory disposed');
    this.deps.assertCurrentScope(this.scope);
    if (this.deps.journal.scope() !== JSON.stringify([this.scope.ownerId, this.scope.botId])) throw new MemoryError('not-ready', 'Fact memory scope mismatch');
    if (routeKey(this.route) !== routeKey(this.deps.port.route)) throw new MemoryError('not-ready', 'Fact analysis route changed');
  }
  prepare(source: FactSource): FactTurnToken {
    this.assertReady();
    if (source.origin !== 'user' || !source.sessionId || !source.logicalTurnId || !source.userMessageId || !Number.isSafeInteger(source.generation) || source.generation < 1 || !source.userText.trim() || Buffer.byteLength(source.userText) > 32_768) throw new Error('Invalid fact source');
    const token = Object.freeze({ generation: source.generation });
    this.tokens.set(token, { source: { ...source }, route: this.route, revision: this.deps.journal.sourceRevision(sourceId(this.scope, source), sourceHash(source)) });
    return token;
  }
  /** Host must call only at the final product-turn outcome, not each SDK done. */
  finish(token: FactTurnToken, outcome: 'completed' | 'failed' | 'cancelled', generation: number, assistantReply?: string): void {
    this.assertReady();
    const payload = this.tokens.get(token);
    if (!payload || token.generation !== generation) throw new Error('Unknown or stale fact turn');
    this.tokens.delete(token);
    if (outcome !== 'completed' || payload.revision !== this.deps.journal.revision()) return;
    const s = payload.source;
    const id = sourceId(this.scope, s);
    // Generation is an attempt identifier, not the completed logical source identity.
    this.deps.journal.enqueue(id, sourceHash(s), { ...payload, assistantReply: assistantReply?.slice(0, 4096) });
  }
  /** Asynchronous single drain; a persisted pending job can be resumed without scanning history. */
  drain(): Promise<void> {
    if (!this.running) this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run(): Promise<void> {
    this.assertReady();
    for (let job = this.deps.journal.next(); job; job = this.deps.journal.next()) {
      this.assertReady();
      const payload = JSON.parse(job.payload) as Payload;
      if (payload.revision !== this.deps.journal.revision() || routeKey(payload.route) !== routeKey(this.route)) {
        this.deps.journal.state(job.id, 'conflict', 'memory-changed'); continue;
      }
      try {
        const records = await this.deps.list();
        this.assertReady();
        if (payload.revision !== this.deps.journal.revision()) throw new MemoryError('version-conflict', 'Memory changed');
        this.deps.journal.transition(job.id, 'preparing', 'analyzing');
        const result = await this.deps.port.analyze({ route: this.route, userText: payload.source.userText,
          assistantReply: payload.assistantReply, facts: records.filter(r => r.frontmatter.type === 'user'), signal: this.abort.signal });
        this.assertReady();
        if (routeKey(result.route) !== routeKey(this.route)) throw new Error('Unexpected fact analysis route');
        const changes = changesOf(result.changes, payload.source, records);
        const mutations: FactMutation[] = [];
        for (const change of changes) {
          if (change.action === 'NOOP') continue;
          if (change.action === 'DELETE') { mutations.push({ delete: change.filename }); continue; }
          const name = change.action === 'ADD' ? `fact_${job.id.slice(0,24)}_${change.name}` : change.filename.slice(5,-3);
          const provenance = JSON.stringify({ sessionId: payload.source.sessionId, turnId: payload.source.logicalTurnId,
            messageId: payload.source.userMessageId, quote: change.quote });
          mutations.push({ write: { type: 'user', name, title: change.title, description: change.description,
            body: `${change.body}\n\nSource: ${provenance}`, mode: change.action === 'ADD' ? 'create' : 'update' } });
        }
        this.deps.journal.transition(job.id, 'analyzing', 'applying');
        await this.deps.apply(payload.revision, mutations);
        this.assertReady();
        this.deps.journal.state(job.id, 'done');
        if (mutations.length) this.deps.onCommitted?.();
      } catch (error) {
        this.deps.assertCurrentScope(this.scope);
        // No response/error text is retained: it may contain user content or credentials.
        this.deps.journal.state(job.id, error instanceof MemoryError && error.code === 'version-conflict' ? 'conflict' : 'review', 'not-applied-or-partial');
      }
    }
  }
  /** Existing UI can use this boundary before user correction/deletion; in-flight results lose CAS. */
  invalidatePending(): void { this.assertReady(); this.deps.journal.bump(); this.deps.journal.cancelPending(); }
  inspect() { this.assertReady(); return this.deps.journal.inspect(); }
  get isDisposed(): boolean { return this.abort.signal.aborted; }
  dispose(): void { this.abort.abort(); }
}
