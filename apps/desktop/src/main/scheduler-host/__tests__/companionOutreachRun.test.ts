import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { CompanionOutreachLedger } from '../companionOutreachLedger.js';
import { runCompanionOutreach } from '../companionOutreachRun.js';

test('a user message during generation suppresses publication and consumed event does not rerun', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cindy-outreach-run-'));
  try {
    const now = Date.parse('2026-11-20T12:00:00+08:00');
    const event = { key: 'follow-1', occurredAt: now };
    let epoch = 'before';
    let generated = 0;
    let locked = false;
    const deps = {
      ledger: new CompanionOutreachLedger(root, 'bot-a'),
      async withPublicationLock<T>(action: () => Promise<T>) {
        assert.equal(locked, false);
        locked = true;
        try { return await action(); } finally { locked = false; }
      },
      async readAdmission() {
        assert.equal(locked, true);
        return { enabled: true, isHome: true, busy: false, now, conversationEpoch: epoch, publishedAt: [] };
      },
      async generate() {
        assert.equal(locked, false);
        generated++;
        epoch = 'user-sent';
        return '想和你聊聊。';
      },
      async publish() {
        assert.fail('User input should win publication');
      },
    };
    assert.deepEqual(await runCompanionOutreach(deps, event), {
      status: 'suppressed', reason: 'conversation-changed',
    });
    assert.deepEqual(await runCompanionOutreach(deps, event), { status: 'skipped', reason: 'duplicate' });
    assert.equal(generated, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reopening the receipt directory preserves claims and counts only confirmed publications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cindy-outreach-receipts-'));
  try {
    const first = new CompanionOutreachLedger(root, 'bot-a');
    assert.equal(await first.claim('failed'), true);
    assert.equal(await first.claim('delivered'), true);
    await first.recordPublication('delivered', 123_000);
    const reopened = new CompanionOutreachLedger(root, 'bot-a');
    assert.equal(await reopened.claim('failed'), false);
    assert.deepEqual(await reopened.readPublications(0), [[reopened.clientId('delivered'), 123_000]]);
    assert.deepEqual(await reopened.readPublications(123_001), []);
    assert.deepEqual(await new CompanionOutreachLedger(root, 'bot-b').readPublications(0), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
