/** Subscription WS requests retain native developer/plan instructions and user input.
 * Only the current parent thread's trusted, already bounded recall is appended.
 */
export function injectWebSocketTurnContext(body: unknown, context?: string): unknown {
  if (!context) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('HOST_CONTEXT_WS_BODY_INVALID');
  const request = body as Record<string, unknown>;
  if (request.type !== 'response.create') return body;
  if (request.instructions !== undefined && typeof request.instructions !== 'string') throw Error('HOST_CONTEXT_WS_INSTRUCTIONS_INVALID');
  if (context.length > 16384) throw Error('HOST_CONTEXT_WS_TOO_LARGE');
  return { ...request, instructions: `${request.instructions ?? ''}\n\n${context}` };
}
