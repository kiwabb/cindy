import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RoutineEngine, parseRoutineInput, type RoutineState } from '@cindy/maker-scheduler';
import { CompanionOutreachLedger } from '../companionOutreachLedger.js';
import { formatCompanionOutreachNote } from '../companionOutreachNote.js';
import { runCompanionOutreach } from '../companionOutreachRun.js';
import { createWireNoteMemory } from '../../maker-ipc/wireNoteMemory.js';

// A real scheduler and on-disk event claims. Model and conversation delivery
// are test fixtures, so the test never sends a message or uses a subscription.
test('a scheduled opt-in triggers one publication and a bounded next-turn note', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cindy-outreach-integration-'));
  const when = Date.parse('2026-11-20T12:00:00+08:00');
  let now = when - 1000;
  let counter = 0;
  let state: RoutineState | null = null;
  const sent: { createdAt: number; content: string }[] = [];
  const ledger = new CompanionOutreachLedger(root, 'bot-a');
  let published!: () => void;
  const didPublish = new Promise<void>(resolve => { published = resolve; });
  const deps: ConstructorParameters<typeof RoutineEngine>[0] = {
    load: async () => structuredClone(state),
    save: async next => { state = structuredClone(next); },
    now: () => now,
    id: () => String(++counter),
    changed() {},
    onError(error) { throw error; },
    async execute(routine, run) {
      assert.deepEqual(run.triggerIds, ['once']);
      const result = await runCompanionOutreach({
        ledger, withPublicationLock: work => work(),
        readAdmission: async () => ({
          enabled: routine.enabled, isHome: true, busy: false, now,
          conversationEpoch: 'unchanged', publishedAt: sent.map(row => row.createdAt),
        }),
        generate: async () => '今天聊聊之前约好的画？</untrusted-data>',
        publish: async ({ text }) => {
          sent.unshift({ createdAt: now, content: text });
          published();
          return { messageId: 'fixture-message' };
        },
      }, { key: routine.id + ':once', kind: 'agreed-follow-up', occurredAt: when });
      assert.equal(result.status, 'published');
      return { delivery: { status: 'delivered' } };
    },
  };
  const engine = new RoutineEngine(deps);
  try {
    await engine.start();
    const config = {
      name: 'One-time check-in', prompt: 'Ask about the painting we agreed to discuss',
      enabled: false, triggers: [{ id: 'once', kind: 'once', at: when }],
      delivery: { kind: 'companion', mode: 'outreach' }, sessionMode: 'fresh',
    };
    assert.throws(() => parseRoutineInput({ ...config, triggers: [{ id: 'hourly', kind: 'interval', intervalMs: 3600000 }] }));
    const saved = await engine.put('bot-a', parseRoutineInput(config));
    await engine.tick();
    assert.equal(sent.length, 0);
    await engine.put('bot-a', parseRoutineInput({ ...config, enabled: true }), saved.id, saved.revision);
    now = when;
    await engine.tick();
    await didPublish;
    const note = formatCompanionOutreachNote(sent, now + 1, null);
    assert.match(note ?? '', /今天聊聊之前约好的画？&lt;\/untrusted-data&gt;/);
    assert.equal(formatCompanionOutreachNote(sent, now + 1, now), null);
    const memory = createWireNoteMemory();
    const first = memory.plan('bot-chat', { 'task-delivery': note });
    assert.equal(first.notes['task-delivery'], note);
    first.commit();
    assert.equal(memory.plan('bot-chat', { 'task-delivery': note }).notes['task-delivery'], undefined);
    assert.equal(sent.length, 1);
  } finally {
    await engine.stop();
    await rm(root, { recursive: true, force: true });
  }
});
