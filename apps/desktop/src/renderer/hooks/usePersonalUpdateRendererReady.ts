import { useEffect } from 'react';

/** A committed main shell must survive one paint before acknowledging an upgrade. */
export function usePersonalUpdateRendererReady(ownerId: string | null, ownerGeneration: number): void {
  useEffect(() => {
    if (!ownerId || !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0) return;
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const pending = window.electronAPI.appReadyForBot?.({ rendererCommitted: true, dataOwnerId: ownerId, ownerGeneration });
        void pending?.catch(() => undefined);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [ownerId, ownerGeneration]);
}
