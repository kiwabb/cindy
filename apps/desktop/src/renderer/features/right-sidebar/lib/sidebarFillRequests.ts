/**
 * A tab asks the main layout to let the right sidebar fill the window (narrow windows), or to
 * hand the space back. It rides the existing maximize state in MainLayout, so Esc, collapsing
 * the sidebar and leaving the chat route end it the same way as the manual maximize.
 */
type FillListener = (fill: boolean) => void;

const listeners = new Set<FillListener>();

export function requestRightSidebarFill(fill: boolean): void {
  for (const listener of [...listeners]) {
    try {
      listener(fill);
    } catch {
      // A broken subscriber must not keep the others from hearing it.
    }
  }
}

export function subscribeRightSidebarFill(listener: FillListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Below this window width a side panel beside the conversation is too cramped to read. */
export const NARROW_WINDOW_MAX_WIDTH = 960;
