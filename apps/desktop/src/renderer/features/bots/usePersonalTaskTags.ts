import { useCallback, useEffect, useRef, useState } from 'react';
import { TASK_TAG_COLORS, type TaskTag, type TaskTagColor } from '@cindy/maker-shared';

import {
  captureTaskTagScope,
  readTaskTagCatalog,
  subscribeTaskTagCatalog,
} from '@/features/task-tags/taskTagEvents';

/**
 * This device's task-tag catalog for the personal todo page. It reads and feeds the shared
 * renderer cache (local device = undefined), so pushes from any surface reach the page; the page
 * still renders, untagged, while the catalog is unread or when reading it fails.
 */
export function usePersonalTaskTags() {
  const [state, setState] = useState(() => {
    const cached = readTaskTagCatalog(undefined);
    return { tags: cached?.tags ?? [], supported: cached?.supportedColors, loaded: Boolean(cached) };
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeTaskTagCatalog((deviceId, tags) => {
      if (deviceId !== undefined) return;
      setState((previous) => ({
        tags,
        supported: readTaskTagCatalog(undefined)?.supportedColors ?? previous.supported,
        loaded: true,
      }));
    });
    if (!readTaskTagCatalog(undefined)) {
      const scope = captureTaskTagScope(undefined);
      void Promise.resolve()
        .then(() => window.electronAPI.localDb.taskTags.execute({ action: 'list' }))
        .then((result) => {
          scope.store(result.tags, result.supportedColors);
          if (!alive.current || !scope.current()) return;
          const cached = readTaskTagCatalog(undefined);
          setState({
            tags: cached?.tags ?? result.tags,
            supported: cached?.supportedColors ?? result.supportedColors,
            loaded: true,
          });
        })
        .catch(() => {
          if (alive.current && scope.current()) setState((previous) => ({ ...previous, loaded: true }));
        });
    }
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, []);

  /** Creates a tag in the catalog and returns it; throws the host error unchanged. */
  const create = useCallback(async (name: string, color: TaskTagColor): Promise<TaskTag> => {
    const before = new Set((readTaskTagCatalog(undefined)?.tags ?? []).map((tag) => tag.id));
    const scope = captureTaskTagScope(undefined);
    const result = await window.electronAPI.localDb.taskTags.execute({ action: 'create', name, color });
    scope.store(result.tags, result.supportedColors);
    const created =
      result.tags.find((tag) => !before.has(tag.id)) ??
      result.tags.find((tag) => tag.name === name.trim());
    if (!created) throw new Error('[FAILED] Created tag missing from catalog');
    if (alive.current && scope.current()) {
      const cached = readTaskTagCatalog(undefined);
      setState({
        tags: cached?.tags ?? result.tags,
        supported: cached?.supportedColors ?? result.supportedColors,
        loaded: true,
      });
    }
    return created;
  }, []);

  return {
    tags: state.tags,
    loaded: state.loaded,
    supportedColors: (state.supported ?? TASK_TAG_COLORS) as readonly TaskTagColor[],
    create,
  };
}
