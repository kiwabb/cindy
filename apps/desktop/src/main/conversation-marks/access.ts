import path from 'node:path';
import { BrowserWindow } from 'electron';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import type {
  ConversationMark,
  ConversationMarkScope,
  ConversationMarkSyncStatus,
  ConversationMarkUpdate,
} from '../../shared/conversationMarks.js';
import {
  disableSharedDataset,
  enableSharedDataset,
  getSharedDatasetRole,
  getSyncStatus,
  listConflicts,
  onSharedDatasetChanged,
  onSharedDatasetStatusChanged,
  registerSharedDataset,
  resolveConflict,
  setAsHome,
  writeSharedDataset,
} from '../shared-datasets/api.js';
import { createConversationMarkStore, projectConversationMark } from './store.js';
import { createConversationMarksDataset, CONVERSATION_MARKS_DATASET_ID } from './dataset.js';

export const CONVERSATION_MARK_FILE = 'conversation-marks.v1.json';
export const CONVERSATION_MARKS_CHANGED_CHANNEL = 'conversation-marks:changed';
/** Followed for the on/off switch and the main computer: marks have no switch of their own. */
const PERSONAL_TODOS_DATASET_ID = 'personal-todos';
const REPLICA_WRITE_WAIT_MS = 3000;

export class ConversationMarkOwnerChangedError extends Error {
  constructor() {
    super('Owner changed');
  }
}

/** The single way to open the signed-in account's mark file, pinned to the account it started with. */
export function openConversationMarkStore() {
  const owner = activeOwnerScopeKey();
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey()) throw new ConversationMarkOwnerChangedError();
  };
  assertCurrent();
  const store = createConversationMarkStore(path.join(ownerScopedUserDataPath(), CONVERSATION_MARK_FILE), assertCurrent);
  return { store, assertCurrent };
}

const localListeners = new Set<() => void>();
/**
 * Mark ids with an edit made on this computer (a replica) that the main computer has not accepted
 * yet. Kept in memory: the engine's queue survives a restart, this per-row hint does not (the
 * count in the status line still does).
 */
const pendingIds = new Set<string>();

function broadcast(channel: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send(channel);
    } catch {
      // A closing renderer must not affect the persisted write.
    }
  }
}

export function notifyConversationMarksChanged(): void {
  broadcast(CONVERSATION_MARKS_CHANGED_CHANNEL);
  for (const listener of localListeners) {
    try {
      listener();
    } catch {
      // One subscriber must not block the others.
    }
  }
}

let selfDeviceIdSource: () => readonly (string | null | undefined)[] = () => [];

/**
 * Startup wires this computer's ids, preferred first: the device-link id (known once connected)
 * and the sign-in device id (always known; the self-hosted relay uses it as the device-link id and
 * the renderer already compares it with other computers' ids). Injected rather than imported so
 * this module stays loadable without the device-link runtime.
 */
export function setConversationMarksSelfDeviceIdSource(source: () => readonly (string | null | undefined)[]): void {
  selfDeviceIdSource = source;
}

const selfDeviceIds = (): string[] => [...new Set(selfDeviceIdSource().filter((id): id is string => !!id))];

/** The id a mark made here is stamped with (null only when no id is known at all). */
export const selfDeviceId = (): string | null => selfDeviceIds()[0] ?? null;

export async function listConversationMarks(scope: ConversationMarkScope): Promise<ConversationMark[]> {
  const { store, assertCurrent } = openConversationMarkStore();
  const marks = await store.list(scope, selfDeviceIds());
  assertCurrent();
  return marks;
}

/**
 * The single write entry. Off / home write the account file; a replica applies the edit to its
 * mirror and queues it for the main computer. A creation for a conversation on this computer is
 * stamped with this computer's id here, so the mark still names its conversation elsewhere.
 */
export async function writeConversationMark(request: ConversationMarkUpdate): Promise<ConversationMark> {
  const { store, assertCurrent } = openConversationMarkStore();
  const input: ConversationMarkUpdate =
    !('id' in request) && !request.hostDeviceId && selfDeviceId()
      ? { ...request, hostDeviceId: selfDeviceId()! }
      : request;
  const outcome = await writeSharedDataset(
    CONVERSATION_MARKS_DATASET_ID,
    { ...input },
    { waitMs: REPLICA_WRITE_WAIT_MS, localWrite: () => store.update(input) },
  );
  assertCurrent();
  if (outcome.local) {
    notifyConversationMarksChanged();
    return projectConversationMark(outcome.value);
  }
  const queued = outcome.result as unknown as ConversationMark & { synced?: { id: string; revision: number } };
  const { synced, ...mark } = queued;
  if (synced) return { ...projectConversationMark(mark as never), id: synced.id, revision: synced.revision };
  pendingIds.add(mark.id);
  broadcast(CONVERSATION_MARKS_CHANGED_CHANNEL);
  return projectConversationMark(mark as never);
}

/** Null while sync is off: the list then shows no status line. */
export async function readConversationMarkSyncStatus(): Promise<ConversationMarkSyncStatus | null> {
  const role = await getSharedDatasetRole(CONVERSATION_MARKS_DATASET_ID);
  if (role === 'off') return null;
  const status = await getSyncStatus(CONVERSATION_MARKS_DATASET_ID);
  if (status.role === 'off') return null;
  if (status.pending === 0) pendingIds.clear();
  const reachable = status.homeOnline && !status.lastError;
  return {
    phase: !reachable ? 'offline' : status.pending > 0 ? 'syncing' : 'synced',
    pending: status.pending,
    pendingIds: [...pendingIds],
  };
}

let following: Promise<void> = Promise.resolve();

/**
 * Marks follow the personal-todo sync switch and its main computer: on when todo sync is on,
 * off when it is off, and this computer takes over as main for marks when it does for todos.
 * A mark edit the main computer refused (both computers changed the same mark) is settled in the
 * main computer's favour: there is no conflict list for marks.
 */
async function followTodoSync(): Promise<void> {
  const todos = await getSharedDatasetRole(PERSONAL_TODOS_DATASET_ID);
  const marks = await getSharedDatasetRole(CONVERSATION_MARKS_DATASET_ID);
  if (todos === 'off' && marks !== 'off') await disableSharedDataset(CONVERSATION_MARKS_DATASET_ID);
  else if (todos !== 'off' && marks === 'off') await enableSharedDataset(CONVERSATION_MARKS_DATASET_ID);
  else if (todos === 'home' && marks === 'replica') await setAsHome(CONVERSATION_MARKS_DATASET_ID);
  if ((await getSharedDatasetRole(CONVERSATION_MARKS_DATASET_ID)) === 'off') return;
  for (const conflict of await listConflicts(CONVERSATION_MARKS_DATASET_ID)) {
    await resolveConflict(CONVERSATION_MARKS_DATASET_ID, conflict.id, 'theirs');
  }
}

function scheduleFollow(): void {
  following = following
    .then(followTodoSync)
    .catch(() => {
      // Main computer unreachable or no account yet: the next status change tries again.
    });
}

let registered = false;

/** Registers the dataset; sync changes re-announce through the one change notification. */
export function registerConversationMarksSharedDataset(): void {
  if (registered) return;
  registered = true;
  registerSharedDataset(
    createConversationMarksDataset({
      open: () => openConversationMarkStore(),
      selfDeviceId,
      onLocalChange: (callback) => {
        localListeners.add(callback);
        return () => localListeners.delete(callback);
      },
    }),
  );
  onSharedDatasetChanged((id) => {
    if (id === CONVERSATION_MARKS_DATASET_ID) broadcast(CONVERSATION_MARKS_CHANGED_CHANNEL);
  });
  onSharedDatasetStatusChanged((id) => {
    if (id === PERSONAL_TODOS_DATASET_ID) scheduleFollow();
    if (id === CONVERSATION_MARKS_DATASET_ID) {
      broadcast(CONVERSATION_MARKS_CHANGED_CHANNEL);
      scheduleFollow();
    }
  });
  scheduleFollow();
}

/**
 * Called once the sync engine runs. A computer whose todo sync was already on before this version
 * gets no status event at start (a quiet main computer emits none), so the follower also re-checks
 * on a slow timer; it only reads local state files.
 */
export function startConversationMarksFollow(): () => void {
  scheduleFollow();
  const timer = setInterval(scheduleFollow, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
