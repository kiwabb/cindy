import type { IpcMainInvokeEvent } from 'electron';
import type { createBotMemoryService } from './botMemoryService.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Only the local settings renderer can reach this explicit private-store surface.
 * No caller supplied owner, scope, path, provider, source or arbitrary operation. */
export function registerBotPrivateFactIpc(deps: {
  ipc: { handle(channel: string, listener: (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>): unknown;
    removeHandler(channel: string): unknown };
  assertTrusted(event: IpcMainInvokeEvent): void;
  captureOwner(): { assertCurrent(): void };
  getService(): ReturnType<typeof createBotMemoryService>;
}) {
  let disposed = false;
  const channels: string[] = [];
  for (const operation of ['list','read','update','delete'] as const) {
    const channel = `local-db:bots:private-facts:${operation}`;channels.push(channel);
    deps.ipc.handle(channel, async (event, raw) => {
      if (disposed) throwIpcError('PRECONDITION_FAILED','Private memory access disposed');
      deps.assertTrusted(event);
      const owner = deps.captureOwner();
      const current = () => { owner.assertCurrent(); if (disposed) throwIpcError('PRECONDITION_FAILED','Private memory access disposed'); };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS','Invalid private memory request');
      const body = raw as Record<string,unknown>;
      const allowed = operation === 'list' ? ['botId','query'] : operation === 'read' ? ['botId','filename']
        : operation === 'update' ? ['botId','filename','title','body','expectedUpdatedAt'] : ['botId','filename','expectedUpdatedAt'];
      if (Object.keys(body).some(key=>!allowed.includes(key))) throwIpcError('INVALID_PARAMS','Unexpected private memory parameter');
      if (typeof body.botId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.botId)) throwIpcError('INVALID_PARAMS','Invalid botId');
      if (operation === 'list' && body.query !== undefined && (typeof body.query !== 'string' || body.query.length > 200)) throwIpcError('INVALID_PARAMS','Invalid query');
      current();const service=deps.getService();const botId=body.botId;
      const source = 'bot-private' as const;
      if (operation === 'list') { const items=await service.list(botId,body.query);current();return {source,botId,items}; }
      if (operation === 'read') { const item=await service.read(botId,body.filename);current();return {source,botId,item}; }
      if (operation === 'update') {
        const item=await service.update({botId,filename:body.filename as string,title:body.title as string,body:body.body as string,expectedUpdatedAt:body.expectedUpdatedAt as string});
        current();return {source,botId,item};
      }
      await service.delete({botId,filename:body.filename as string,expectedUpdatedAt:body.expectedUpdatedAt as string});current();
      return {source,botId,deleted:true};
    });
  }
  return () => { disposed=true;for(const channel of channels)deps.ipc.removeHandler(channel); };
}
