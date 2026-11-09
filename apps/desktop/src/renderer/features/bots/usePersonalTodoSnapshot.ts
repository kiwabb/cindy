import { useEffect, useSyncExternalStore } from 'react';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import {
  ensurePersonalTodos,
  getPersonalTodoSnapshot,
  subscribePersonalTodos,
} from './personalTodoCache';

/** All consumers share one local read/cache/timer; no remote polling for the badge. */
export function usePersonalTodoSnapshot() {
  const generation = useOptionalDataOwnerGeneration();
  const snapshot = useSyncExternalStore(
    subscribePersonalTodos,
    getPersonalTodoSnapshot,
    getPersonalTodoSnapshot,
  );
  useEffect(ensurePersonalTodos, [generation]);
  return snapshot;
}
