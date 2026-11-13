/**
 * One shared reading of the learning goals for every surface that shows them (Learning page,
 * Today tab, todo rows). Main pushes `learning:changed` when the tutor's files change; the
 * reading also refreshes when the window regains focus and every few minutes, so "today" rolls
 * over without a file change.
 */
import { useSyncExternalStore } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { LearningSnapshot } from '../../../shared/learning';

const REFRESH_MS = 5 * 60_000;

export interface LearningState {
  snapshot: LearningSnapshot | null;
  /** The first reading failed (nothing to show yet). Later failures keep the last reading. */
  failed: boolean;
}

const EMPTY: LearningState = { snapshot: null, failed: false };
let state: LearningState = EMPTY;
let stateOwner: DataOwnerGeneration | null = null;
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;
let inflight: Promise<void> | null = null;

function emit(next: LearningState, owner: DataOwnerGeneration) {
  state = next;
  stateOwner = owner;
  for (const listener of listeners) listener();
}

export function refreshLearningSnapshot(): Promise<void> {
  const api = window.electronAPI?.localDb?.learning;
  if (!api) return Promise.resolve();
  if (inflight) return inflight;
  const owner = getDataOwnerGeneration();
  const request = api
    .snapshot()
    .then((snapshot) => {
      if (isDataOwnerGenerationCurrent(owner)) emit({ snapshot, failed: false }, owner);
    })
    .catch(() => {
      if (isDataOwnerGenerationCurrent(owner) && !state.snapshot) emit({ snapshot: null, failed: true }, owner);
    })
    .finally(() => {
      inflight = null;
    });
  inflight = request;
  return request;
}

function attach() {
  const api = window.electronAPI?.localDb?.learning;
  if (!api) return () => {};
  const offChanged = api.onChanged(() => void refreshLearningSnapshot());
  const onFocus = () => void refreshLearningSnapshot();
  window.addEventListener('focus', onFocus);
  const timer = window.setInterval(onFocus, REFRESH_MS);
  void refreshLearningSnapshot();
  return () => {
    offChanged();
    window.removeEventListener('focus', onFocus);
    window.clearInterval(timer);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) detach = attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detach?.();
      detach = null;
      // Another account may sign in before the next subscriber; never show its predecessor's goals.
      state = EMPTY;
      stateOwner = null;
    }
  };
}

/** A reading taken for another account reads as empty while the new account's is fetched. */
function current(): LearningState {
  if (state === EMPTY || (stateOwner && isDataOwnerGenerationCurrent(stateOwner))) return state;
  queueMicrotask(() => void refreshLearningSnapshot());
  return EMPTY;
}

export function useLearningSnapshot(): LearningState {
  return useSyncExternalStore(subscribe, current, () => EMPTY);
}
