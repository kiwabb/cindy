import type { ProcessableMessage } from '@cindy/a2ui-renderer/core';
export { splitA2uiMessage, A2UI_SDK_VERSION, A2UI_PROTOCOL_VERSION, A2UI_BASIC_CATALOG } from '@cindy/maker-shared/a2ui-message';
import { readA2uiEnvelopes } from '@cindy/maker-shared/a2ui-message';

export function readA2uiMessages(source: string): ProcessableMessage[] {
  return readA2uiEnvelopes(source) as ProcessableMessage[];
}

/** Exact visible submission text; context is data, never a tool invocation. */
export function a2uiSubmissionText(action: { name: string; userMessage?: string; context: Record<string, unknown> }): string | undefined {
  if (action.name !== 'cindy.sendMessage' || !action.userMessage?.trim()) return undefined;
  const context = Object.keys(action.context).length ? `\n\n${JSON.stringify(action.context, null, 2)}` : '';
  const text = action.userMessage.trim() + context;
  return text.length <= 16000 ? text : undefined;
}
