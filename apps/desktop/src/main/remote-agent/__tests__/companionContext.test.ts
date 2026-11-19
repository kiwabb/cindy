// Wire fixtures only; no relay, model or real account.
import { expect, it } from 'vitest';
import { HOST_TURN_CONTEXT } from '@cindy/maker-core';
import { encodeSendOptions, decodeSendOptions } from '../wire';
import { parseStartedInfo } from '../controller/proxyHandle';
const callbacks = {
  onTranscriptUserEntry: async () => {},
  onInteractionStateChange: () => {},
  writeAttachment: async () => '',
};
it('carries the frozen hidden snapshot independently of user content and permission fields', async () => {
  const context = { requestId: 'root-fixture', text: '{"memories":[]}' };
  const encoded = await encodeSendOptions({ [HOST_TURN_CONTEXT]: context }, async () =>
    Buffer.alloc(0),
  );
  const decoded = await decodeSendOptions(JSON.parse(JSON.stringify(encoded.wire)), callbacks);
  expect(decoded[HOST_TURN_CONTEXT]).toEqual(context);
  expect(Object.isFrozen(decoded[HOST_TURN_CONTEXT])).toBe(true);
  expect(encoded.wire.cindy).toEqual({ hostTurnContext: context });
  expect(
    parseStartedInfo({ id: 'fixture', supportsHostTurnContext: true }, 'codex')
      .supportsHostTurnContext,
  ).toBe(true);
  expect(parseStartedInfo({ id: 'old-peer' }, 'codex').supportsHostTurnContext).toBe(false);
});
it.each([
  { requestId: 'r', text: 'x'.repeat(8001) },
  { requestId: 5, text: 'x' },
  { requestId: 'r', text: 'x', ownerId: 'external' },
])('rejects malformed hidden data %j', async (value) => {
  await expect(
    decodeSendOptions({ cindy: { hostTurnContext: value } }, callbacks),
  ).rejects.toThrow();
});
