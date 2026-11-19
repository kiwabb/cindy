import { describe, it, expect } from 'vitest';
import { injectWebSocketTurnContext } from '../codex-turn-context.js';
describe('subscription WebSocket hidden recall', () => {
  it('preserves native instructions, plan, user and tool input without mutation', () => {
    const input = [{role:'user',content:'original'}, {type:'function_call_output',call_id:'a',output:'original output'}];
    const body = {type:'response.create',model:'gpt-6.1-terra',instructions:'native plan instructions',input};
    const next = injectWebSocketTurnContext(body,'frozen recall') as typeof body;
    expect(next.instructions).toBe('native plan instructions\n\nfrozen recall');
    expect(next.input).toBe(input); expect(next.model).toBe(body.model);
    expect(body.instructions).toBe('native plan instructions');
  });
  it('does nothing for disabled/cleared context or non-generation frames', () => {
    const body={type:'response.create',instructions:'native'};
    expect(injectWebSocketTurnContext(body)).toBe(body);
    expect(injectWebSocketTurnContext(body,'')).toBe(body);
    const cancel={type:'response.cancel'}; expect(injectWebSocketTurnContext(cancel,'recall')).toBe(cancel);
  });
  it('rejects invalid instruction payload instead of dropping recall', () => {
    expect(()=>injectWebSocketTurnContext({type:'response.create',instructions:[]},'recall')).toThrow('HOST_CONTEXT_WS_INSTRUCTIONS_INVALID');
  });
});
