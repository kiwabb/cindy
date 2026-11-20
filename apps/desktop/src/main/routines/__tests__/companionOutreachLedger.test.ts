import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CompanionOutreachLedger } from '../companionOutreachLedger.ts';

test('one worker claims the event and a restart reads the same draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cindy-outreach-ledger-'));
  try {
    const first = new CompanionOutreachLedger(root, 'bot-a');
    const second = new CompanionOutreachLedger(root, 'bot-a');
    const other = new CompanionOutreachLedger(root, 'bot-b');
    assert.deepEqual((await Promise.all([first.claim('event-1'), second.claim('event-1')])).sort(), [false, true]);
    assert.notEqual(first.clientId('event-1'), other.clientId('event-1'));
    assert.equal(await other.claim('event-1'), true);
    assert.equal(await first.readDraft('event-1'), null);
    await first.saveDraft('event-1', '忙完了？想和你聊两句。');
    const reopened = new CompanionOutreachLedger(root, 'bot-a');
    assert.equal(await reopened.claim('event-1'), false);
    assert.equal(await reopened.readDraft('event-1'), '忙完了？想和你聊两句。');
    await assert.rejects(reopened.saveDraft('event-1', '替换'), { code: 'EEXIST' });
  } finally {
    await rm(root, { recursive: true });
  }
});
