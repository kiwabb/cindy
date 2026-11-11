import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TodoError, type TodoPatch } from '@cindy/maker-shared/teammate-todo';
import {
  PERSONAL_TODO_UPDATE_KEYS,
  projectPersonalTodo,
  type PersonalTodoUpdate,
} from '../../shared/personalTodo.js';
import { createBotTodoStore } from './botTodoStore.js';

/**
 * New checklist steps may arrive without an id (an Agent naming steps in prose); give each one here
 * so the shared validator only ever sees complete steps. Malformed input is left for it to reject.
 */
function withSubtaskIds(subtasks: PersonalTodoUpdate['subtasks']): TodoPatch['subtasks'] {
  if (!Array.isArray(subtasks)) return subtasks as TodoPatch['subtasks'];
  return subtasks.map((step) =>
    step && typeof step === 'object' && !Array.isArray(step)
      ? {
          ...step,
          id: step.id ?? randomUUID().replaceAll('-', '').slice(0, 16),
          done: step.done ?? false,
        }
      : step,
  ) as TodoPatch['subtasks'];
}

/** Dedicated account file; no bot lookup, legacy import, model dispatch or remote projection. */
export function createPersonalTodoStore(file: string, assertCurrent = () => {}) {
  const store = createBotTodoStore(file, assertCurrent);
  return {
    async list() {
      const state = await store.read();
      return state.items.filter((t) => t.decision?.kind !== 'deleted').map(projectPersonalTodo);
    },
    async update(input: PersonalTodoUpdate) {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new TodoError('INVALID_INPUT');
      const allowed: readonly string[] = PERSONAL_TODO_UPDATE_KEYS;
      if (Object.keys(input).some((k) => !allowed.includes(k)))
        throw new TodoError('INVALID_INPUT');
      if (
        input.operation &&
        !['complete', 'reopen', 'delete', 'later', 'restore'].includes(input.operation)
      )
        throw new TodoError('INVALID_INPUT');
      if (!input.id && input.operation) throw new TodoError('INVALID_INPUT');
      if (
        !input.id &&
        (typeof input.creationRequestId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,80}$/.test(input.creationRequestId))
      )
        throw new TodoError('INVALID_INPUT');
      const key = `personal:${input.creationRequestId}`;
      const patch: TodoPatch = {
        id: input.id,
        expectedRevision: input.expectedRevision,
        title: input.title,
        progress: input.notes,
        operation: input.operation,
        until: input.until,
        priority: input.priority,
        tagIds: input.tagIds,
        reminder: input.reminder,
        subtasks: withSubtaskIds(input.subtasks),
        ...(input.deadline !== undefined ? { deadlineOverride: { value: input.deadline } } : {}),
        ...(!input.id ? { key, outcome: input.title } : {}),
        ...(input.operation === 'complete'
          ? { completion: { summary: 'Marked complete by owner' } }
          : {}),
      };
      if (input.id) return projectPersonalTodo(await store.patch(patch));
      // The receipt and item commit under the existing cross-process lock in one atomic file write.
      const receipt = await store.ingest({ source: key, sequence: 1, patch });
      if (receipt.todo) return projectPersonalTodo(receipt.todo);
      const existing = (await store.read()).items.find((todo) => todo.key === key);
      if (!existing || existing.decision?.kind === 'deleted') throw new TodoError('NOT_FOUND');
      // Reusing a request after editing the draft must not silently discard those edits.
      if (
        existing.title !== input.title?.trim() ||
        existing.progress !== (input.notes ?? '') ||
        !isDeepStrictEqual(existing.deadlineOverride?.value ?? null, input.deadline ?? null) ||
        (existing.priority ?? 0) !== (input.priority ?? 0) ||
        !isDeepStrictEqual(existing.tagIds ?? [], input.tagIds ?? []) ||
        (existing.reminder ?? 'default') !== (input.reminder ?? 'default') ||
        // Retried new steps get fresh ids, so compare what the owner typed.
        !isDeepStrictEqual(
          (existing.subtasks ?? []).map(({ title, done }) => ({ title, done })),
          (withSubtaskIds(input.subtasks) ?? []).map(({ title, done }) => ({
            title: title.trim(),
            done,
          })),
        )
      )
        throw new TodoError('CONFLICT');
      return projectPersonalTodo(existing);
    },
  };
}
