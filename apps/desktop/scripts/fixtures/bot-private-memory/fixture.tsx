import { useRef } from 'react';
import { mountPage } from '../../ui-page/harness';
import { BotMemorySettings } from '../../../src/renderer/features/bots/BotMemorySettings';

// Empty/error fixtures only. No real memory, model, filesystem or Electron IPC.
function Page() {
  const backRef = useRef<(() => Promise<boolean>) | null>(null);
  const leaveRef = useRef<(() => Promise<boolean>) | null>(null);
  return <main className="p-5"><BotMemorySettings botId="fixture" botName="Fixture"
    memoryEnabled={false} onMemoryEnabledChange={() => {}}
    aboutMe={{ value: '', onChange: () => {}, onBlur: () => {} }}
    backRef={backRef} leaveRef={leaveRef} /></main>;
}
void mountPage({
  host: ctx => ({ localDb: { bots: {
    memory: { list: async () => [] },
    memoryPreview: { get: async () => ({ botId: 'fixture', enabled: false, revision: 'none', model: 'Fixture', available: true, reason: null }) },
    privateFacts: { list: async () => {
      if (ctx.case !== 'default') throw new Error(ctx.case === 'shared'
        ? 'COMPANION_SHARED_WORKSPACE' : 'COMPANION_PRIVATE_STORE_REQUIRED');
      return { source: 'bot-private', botId: 'fixture', items: [] };
    } },
  } } }),
  render: () => <Page />,
});
