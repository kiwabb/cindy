/** The legacy no-argument entry keeps its existing IM side effects. */
export function handlePersonalRendererReadiness(
  options: unknown,
  isMainTopFrame: boolean,
  session: { dataOwnerId: string | null; mode: string; generation: number },
  acknowledge: (ownerId: string, mode: string, generation: number) => void,
): boolean {
  if (options === undefined) return false;
  if (!options || typeof options !== 'object' || Object.keys(options).length !== 3
    || (options as { rendererCommitted?: unknown }).rendererCommitted !== true
    || typeof (options as { dataOwnerId?: unknown }).dataOwnerId !== 'string'
    || !Number.isSafeInteger((options as { ownerGeneration?: unknown }).ownerGeneration)) throw new Error('Invalid renderer readiness');
  if (!isMainTopFrame) throw new Error('Renderer readiness requires the main top frame');
  const stamp = options as { dataOwnerId: string; ownerGeneration: number };
  if (stamp.dataOwnerId !== session.dataOwnerId || stamp.ownerGeneration !== session.generation) throw new Error('Stale renderer readiness');
  if (session.dataOwnerId && session.mode !== 'signed-out') acknowledge(session.dataOwnerId, session.mode, session.generation);
  return true;
}
