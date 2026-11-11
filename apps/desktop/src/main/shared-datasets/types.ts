import type {
  SharedDatasetRole,
  SharedDatasetsChangedPush,
  SharedDatasetsRequest,
} from '@cindy/device-link';

/** Every shared item carries a global id and a per-item revision (optimistic concurrency). */
export interface SharedItem {
  id: string;
  revision: number;
}

/** `id` absent = creation. `expectedRevision` is rewritten by the replica when it flushes. */
export interface SharedUpdate {
  id?: string;
  expectedRevision?: number;
  [key: string]: unknown;
}

/** What `applySubmit` returns; the engine only needs the identity and revision of the touched item. */
export interface SharedResult {
  id: string;
  revision: number;
}

/** A deterministic dataset refusal (stale revision, validation…) as opposed to an I/O failure. */
export class SharedDatasetError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

/**
 * What a host dataset provides. Every method that touches the local store must capture the
 * account owner synchronously on entry (the engine calls `assertCurrent` right before each call
 * and never holds results across an owner change).
 */
export interface SharedDatasetDefinition<
  Item extends SharedItem = SharedItem,
  Extras = unknown,
> {
  id: string;
  /** Bump when the stored item shape changes; peers with another version are not joined. */
  schemaVersion: number;
  /** Raw stored items, including deletion tombstones. */
  readItems(): Promise<Item[]>;
  /** Data the replica needs but cannot derive (e.g. the home's tag catalog). */
  readExtras?(): Promise<Extras | undefined>;
  /** Stable change fingerprint of items + extras; equal cursors mean nothing to transfer. */
  cursorOf(items: Item[], extras: Extras | undefined): string;
  /**
   * Replica: makes the local store equal to the home's snapshot. Items replace same-id entries,
   * `removeIds` are deleted. On a replica this store is the mirror every reader already uses.
   */
  replaceMirror(items: Item[], removeIds: string[]): Promise<void>;
  /**
   * The dataset's own write. On the home it is the authoritative apply of a submitted update;
   * on a replica it is the optimistic apply onto the mirror. Throws on refusal.
   */
  applySubmit(update: SharedUpdate): Promise<SharedResult>;
  /** Called after any write that bypassed the engine (UI, Agent). The home then pushes `changed`. */
  onLocalChange(callback: () => void): () => void;
  /** The stable refusal code of a deterministic dataset error; null for anything else. */
  errorCode?(error: unknown): string | null;
  /**
   * An idempotent creation that reproduces `item` on another computer (join and demotion).
   * `requestId` is stable per (computer, item). Null = nothing to carry over (e.g. deleted).
   */
  creationUpdate(item: Item, requestId: string): SharedUpdate | null;
  /**
   * A creation the home refused is resubmitted by the owner ("use mine"): the same creation under a
   * fresh request id, so the home does not answer with the earlier refusal again.
   */
  renewCreation?(update: SharedUpdate): SharedUpdate;
  /** Demotion: the edit that carries a locally newer `local` onto `remote`; null = nothing. */
  reviseUpdate?(local: Item, remote: Item): SharedUpdate | null;
}

export type AnySharedDatasetDefinition = SharedDatasetDefinition<any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface SharedDatasetRegistry {
  get(id: string): AnySharedDatasetDefinition | undefined;
  list(): AnySharedDatasetDefinition[];
}

/** One computer of the same account as seen by the engine. */
export interface SharedPeerFact {
  deviceId: string;
  name: string;
  online: boolean;
}

export type PeerReply =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

/** Binds one operation to the account that started it. */
export interface SharedOwnerScope {
  owner: string;
  /** `<owner-scoped userData>/shared-datasets`. */
  baseDir: string;
  /** Throws once the account boundary moved. */
  assertCurrent(): void;
}

export interface SharedDatasetsPorts {
  selfDeviceId(): string | null;
  captureScope(): SharedOwnerScope;
  /** Same-account desktops other than this one (online or not). */
  listPeers(): Promise<SharedPeerFact[]>;
  /** Presence only; no server request. */
  isPeerOnline(deviceId: string): boolean;
  peerName(deviceId: string): string | undefined;
  invoke(deviceId: string, request: SharedDatasetsRequest): Promise<PeerReply>;
  /** Fire-and-forget push to an eligible (same account, online, not revoked) desktop. */
  sendChanged(deviceId: string, frame: SharedDatasetsChangedPush): void;
  /** Online, eligible desktops to push `changed` to. */
  pushTargets(): string[];
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}

export interface SharedDatasetSyncStatus {
  role: SharedDatasetRole;
  homeDeviceId?: string;
  homeName?: string;
  homeOnline: boolean;
  pending: number;
  conflicts: number;
  lastSyncedAt?: number;
  /** The last sync attempt failed with this code; cleared by the next success. */
  lastError?: string;
}

export interface SharedDatasetConflict {
  /** The refused op's stable id (survives sequence rebasing); resolve by it. */
  id: string;
  update: SharedUpdate;
  code: string;
  at: number;
  /** The home's version of the item, filled in once a snapshot after the conflict arrived. */
  homeItem?: unknown;
}

export type ConflictChoice = 'mine' | 'theirs';
