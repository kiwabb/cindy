import { createPersonalTodoStore } from '../personalTodoStore';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBotTodoStore } from '../botTodoStore';
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'todo-contract-'));
  roots.push(root);
  return { root, file: path.join(root, 'todos.v1.json') };
}
const p = {
  key: 'quote:1',
  title: '比较报价',
  outcome: '报价比较并获得用户确认',
  next: {
    label: '比较报价',
    instruction: '读取已授权报价，准备比较，不发送邮件',
    kind: 'advance' as const,
  },
  sources: [
    { kind: 'mail' as const, id: 'mail1', label: '报价邮件', ref: 'https://example.test/quote' },
  ],
};
describe('host Todo persistence', () => {
  // Unit regression: a new automatic observation must not become a user assignment.
  it('attributes automatic discoveries in the locked write and preserves existing assignments', async () => {
    const { file } = await fixture();
    const owner = createBotTodoStore(file);
    const automatic = createBotTodoStore(file, () => {}, () => false);
    const discovered = await automatic.patch({ ...p, origin: 'assigned' });
    expect(discovered.origin).toBe('discovered');
    const assigned = await owner.patch({ ...p, key: 'owner-task' });
    expect((await automatic.patch({ id: assigned.id, expectedRevision: assigned.revision, progress: 'Observed', origin: 'discovered' })).origin).toBe('assigned');
    const result = await automatic.ingest({ source: 'event', sequence: 1, patch: { ...p, key: 'event-task', origin: 'assigned' } });
    expect(result.todo?.origin).toBe('discovered');
    expect((await owner.read()).items.find(t => t.id === assigned.id)?.origin).toBe('assigned');
  });

  it('preserves fields after partial writes across independent store instances', async () => {
    const { file } = await fixture(),
      a = createBotTodoStore(file),
      b = createBotTodoStore(file);
    const t = await a.patch(p);
    await b.patch({ id: t.id, expectedRevision: t.revision, progress: '草稿已准备' });
    const result = (await a.read()).items[0];
    expect(result.sources[0].ref).toBe(p.sources[0].ref);
    expect(result.next).toEqual(p.next);
    const races = await Promise.allSettled([
      a.patch({ id: t.id, expectedRevision: 2, title: '新标题' }),
      b.patch({ id: t.id, expectedRevision: 2, title: '并发旧标题' }),
    ]);
    expect(races.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await a.read()).items[0].revision).toBe(3);
  });
  it('acknowledges only successful events, merges the same key, and suppresses cross-source repeats', async () => {
    const { file } = await fixture(),
      s = createBotTodoStore(file);
    await expect(
      s.ingest({ source: 'mail', sequence: 1, patch: { key: 'bad' } }),
    ).rejects.toThrow();
    expect((await s.read()).cursors.mail).toBeUndefined();
    const saved = await s.ingest({ source: 'mail', sequence: 1, patch: p });
    expect(saved.todo).toBeTruthy();
    expect((await s.ingest({ source: 'mail', sequence: 1, patch: p })).duplicate).toBe(true);
    const t = (await s.read()).items[0];
    await s.patch({ id: t.id, expectedRevision: t.revision, operation: 'delete' });
    expect(
      (
        await s.ingest({
          source: 'feishu',
          sequence: 1,
          patch: { ...p, sources: [{ kind: 'feishu', id: 'f1', label: '同事转述' }] },
        })
      ).suppressed,
    ).toBe(true);
    expect((await s.read()).items).toHaveLength(1);
    const deleted = (await s.read()).items[0];
    await s.patch({ id: deleted.id, expectedRevision: deleted.revision, operation: 'restore' });
    const active = (await s.read()).items[0];
    await s.ingest({
      source: 'feishu',
      sequence: 2,
      patch: {
        id: active.id,
        expectedRevision: active.revision,
        sources: [{ kind: 'feishu', id: 'f2', label: '另一条反馈' }],
      },
    });
    expect((await s.read()).items[0].sources).toHaveLength(2);
  });
  it('records receipts without dispatch replay, and ignores a stale receipt after the next step changes', async () => {
    const { file } = await fixture(),
      s = createBotTodoStore(file),
      t = await s.patch(p);
    expect((await s.prepareAction(t.id, t.revision, 'request-1')).dispatch).toBe(true);
    expect((await s.prepareAction(t.id, t.revision, 'request-2')).dispatch).toBe(false);
    await s.settleAction(t.id, 'request-1', { ok: false, uncertain: true });
    expect((await s.prepareAction(t.id, t.revision, 'request-3')).dispatch).toBe(false);
    await s.patch({
      id: t.id,
      expectedRevision: t.revision,
      next: { kind: 'decide', label: '确认报价', instruction: '让用户确认比较结果' },
    });
    expect(await s.settleAction(t.id, 'request-1', { ok: true })).toBeNull();
    expect((await s.read()).items[0].action).toBeNull();
  });
  it('fails closed on corruption and rejects owner changes without writing', async () => {
    const { file } = await fixture();
    await writeFile(file, '{invalid');
    const s = createBotTodoStore(file);
    await expect(s.patch(p)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{invalid');
    const f = await fixture();
    let current = true;
    const scoped = createBotTodoStore(
      f.file,
      () => {
        if (!current) throw new Error('OWNER_SCOPE_CHANGED');
      },
    );
    current = false;
    await expect(scoped.patch(p)).rejects.toThrow('OWNER_SCOPE_CHANGED');
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps two owners and two teammates isolated in separate homes', async () => {
    const one = await fixture(),
      two = await fixture();
    const a = createBotTodoStore(path.join(one.root, 'a.json')),
      b = createBotTodoStore(path.join(one.root, 'b.json')),
      other = createBotTodoStore(two.file);
    await a.patch(p);
    expect((await b.read()).items).toEqual([]);
    expect((await other.read()).items).toEqual([]);
  });
});

it('accepts only a matching attempt receipt and never turns it into affair completion', async () => {
  const { file } = await fixture(),
    s = createBotTodoStore(file),
    t = await s.patch(p);
  await s.prepareAction(t.id, 1, 'attempt-one');
  await s.settleAction(t.id, 'attempt-one', { ok: true });
  await expect(
    s.patch({
      id: t.id,
      expectedRevision: 1,
      progress: '旧回执',
      resolvedActionRequestId: 'older-attempt',
    }),
  ).rejects.toThrow('STALE_RECEIPT');
  await expect(
    s.patch({ id: t.id, expectedRevision: 1, resolvedActionRequestId: 'attempt-one' }),
  ).rejects.toThrow('RECEIPT_EVIDENCE_REQUIRED');
  const saved = await s.patch({
    id: t.id,
    expectedRevision: 1,
    progress: '尝试失败，服务未发送；可重试',
    resolvedActionRequestId: 'attempt-one',
  });
  expect(saved.action).toBeNull();
  expect(saved.status).toBe('open');
  expect((await s.prepareAction(t.id, saved.revision, 'attempt-two')).dispatch).toBe(true);
});

it('expired deferral allows advancing the same next step without altering its real deadline', async () => {
  const { file } = await fixture(),
    s = createBotTodoStore(file);
  const t = await s.patch({
    ...p,
    sourceDeadline: { kind: 'date', date: '2026-10-10', timeZone: 'UTC' },
  });
  const later = await s.patch({
    id: t.id,
    expectedRevision: 1,
    operation: 'later',
    until: new Date(Date.now() + 86400000).toISOString(),
  });
  await expect(s.prepareAction(t.id, later.revision, 'before')).rejects.toThrow('NO_NEXT_ACTION');
  const expired = await s.read();
  expired.items[0].decision = { kind: 'later', until: '2020-01-01T00:00:00Z' };
  await writeFile(file, JSON.stringify(expired));
  expect((await s.prepareAction(t.id, later.revision, 'after')).dispatch).toBe(true);
  expect((await s.read()).items[0].sourceDeadline?.date).toBe('2026-10-10');
});

it('rejects valid JSON with corrupt or overlong text without rewriting the file', async () => {
  const { file } = await fixture();
  const s = createBotTodoStore(file);
  const t = await s.patch(p);
  const clean = await s.read();
  for (const fields of [
    { deadlineCandidate: false },
    { deadlineOverride: false },
    { suggestedDate: {} },
    { suggestedDate: 0 },
    { suggestedDate: '2026-02-30' },
    { suggestedDate: 'x'.repeat(11) },
    { suggestedDate: 'not-a-date' },
    { history: [{ summary: '依据', at: '2026-10-10T00:00:00Z', ref: {} }] },
    { history: [{ summary: '依据', at: '2026-10-10T00:00:00Z', ref: 'x'.repeat(2001) }] },
    { sources: [{ ...p.sources[0], project: {} }] },
    { sources: [{ ...p.sources[0], observedAt: 0 }] },
    { associations: [{ kind: 'task', id: 't', label: {} }] },
    { decision: { kind: 'deleted', until: {} } },
    { next: { label: 'x'.repeat(101), instruction: '继续', kind: 'advance' } },
    { title: {} },
    { outcome: [] },
    { title: 'x'.repeat(301) },
    { progress: 'x'.repeat(4001) },
    { createdAt: 0 },
    { updatedAt: [] },
    { createdAt: {} },
    { updatedAt: '2026-10-10' },
    { createdAt: '2026-10-10T00:00:00.' + '0'.repeat(65) + 'Z' },
    {
      deadlineCandidate: {
        value: { kind: 'date', date: '2026-10-13', timeZone: 'Asia/Shanghai' },
        reason: {},
      },
    },
    {
      deadlineCandidate: {
        value: { kind: 'date', date: '2026-10-13', timeZone: 'Asia/Shanghai' },
        reason: 'x'.repeat(2001),
      },
    },
    {
      deadlineCandidate: {
        value: { kind: 'date', date: '2026-10-13', timeZone: 'Asia/Shanghai' },
        reason: ' ',
      },
    },
  ]) {
    const corrupt = structuredClone(clean);
    Object.assign(corrupt.items[0], fields);
    const content = JSON.stringify(corrupt);
    await writeFile(file, content);
    await expect(s.read()).rejects.toThrow('CORRUPT_STORE');
    await expect(
      s.patch({ id: t.id, expectedRevision: t.revision, progress: '不能写入' }),
    ).rejects.toThrow('CORRUPT_STORE');
    expect(await readFile(file, 'utf8')).toBe(content);
  }
});

it('preserves valid suggested dates and local evidence while rejecting invalid optional write fields', async () => {
  const { file } = await fixture();
  const store = createBotTodoStore(file);
  const t = await store.patch({ ...p, suggestedDate: '2026-10-13' });
  await store.patch({
    id: t.id,
    expectedRevision: t.revision,
    operation: 'complete',
    completion: { summary: '已核对文件', ref: '/cindy/notes.md' },
  });
  const saved = (await store.read()).items[0];
  expect(saved.suggestedDate).toBe('2026-10-13');
  expect(saved.history[0].ref).toBe('/cindy/notes.md');
  for (const patch of [
    { deadlineCandidate: false },
    { suggestedDate: {} },
    { completion: { summary: '依据', ref: {} }, operation: 'complete' },
    { sources: [{ ...p.sources[0], ref: false }] },
  ])
    await expect(
      store.patch({ ...patch, id: saved.id, expectedRevision: saved.revision } as any),
    ).rejects.toThrow();
  expect((await store.read()).items[0]).toEqual(saved);
});

describe('todos moving with the companion', () => {
  it('replaces items by id and removes tombstoned ones, keeping this computer\'s cursors', async () => {
    const { file } = await fixture();
    const store = createBotTodoStore(file);
    const keep = await store.patch({ ...p, key: 'keep' });
    const gone = await store.patch({ ...p, key: 'gone' });
    await store.ingest({ source: 'plugin:mail', sequence: 3, items: [] } as never).catch(() => undefined);
    const before = await store.read();
    const moved = { ...keep, title: '从另一台电脑来的标题', revision: 9 };
    const arrived = { ...keep, id: 'todo:arrived', key: 'arrived', title: '新的' };
    await store.importItems([moved, arrived], [gone.id]);
    const after = await store.read();
    expect(after.items.map((item) => item.id).sort()).toEqual(['todo:arrived', keep.id].sort());
    expect(after.items.find((item) => item.id === keep.id)?.title).toBe('从另一台电脑来的标题');
    expect(after.cursors).toEqual(before.cursors);
  });

  it('gives another companion\'s todo with a taken key a stable key of its own', async () => {
    const { file } = await fixture();
    const store = createBotTodoStore(file);
    const mine = await store.patch({ ...p, key: 'quote:1' });
    const theirs = { ...mine, id: 'todo:theirs', title: '另一个 Cindy 的' };
    await store.importItems([theirs], []);
    await store.importItems([theirs], []);
    const items = (await store.read()).items;
    expect(items).toHaveLength(2);
    const merged = items.find((item) => item.id === 'todo:theirs')!;
    expect(merged.key).toMatch(/^quote:1~[0-9a-f]{10}$/);
    expect(items.find((item) => item.id === mine.id)!.key).toBe('quote:1');
    // Still a valid store for the next write.
    await store.patch({ id: mine.id, expectedRevision: mine.revision, progress: '继续' });
  });
});

// Personal ownership contract: bot tests do not exercise the manual adapter.
// Minimal input: title only. Unit tier; isolated OS temp files, never real user todos.
// Protects persistence, revisions and independent due/defer dates through the production adapter.
describe('personal todo account store', () => {
  it('persists title-only creation, independent deferral, completion/reopen and deletion', async () => {
    const { file } = await fixture();
    const first = createPersonalTodoStore(file);
    const created = await first.update({ creationRequestId: crypto.randomUUID(), title: 'Personal unit input' });
    expect(created).toMatchObject({ ownership: 'self', source: 'manual', notes: '', deadline: null });
    expect(created).not.toHaveProperty('origin');
    const reopenedStore = createPersonalTodoStore(file);
    expect(await reopenedStore.list()).toEqual([created]);
    const deadline = { kind: 'date' as const, date: '2030-01-01', timeZone: 'UTC' };
    const deferred = await reopenedStore.update({ id: created.id, expectedRevision: created.revision, notes: 'Unit notes', deadline, operation: 'later', until: '2030-02-01T00:00:00Z' });
    expect(deferred).toMatchObject({ deadline, deferredUntil: '2030-02-01T00:00:00Z' });
    const done = await first.update({ id: deferred.id, expectedRevision: deferred.revision, operation: 'complete' });
    expect(done).toMatchObject({ status: 'done', deferredUntil: null, deadline });
    const open = await first.update({ id: done.id, expectedRevision: done.revision, operation: 'reopen' });
    expect(open.status).toBe('open');
    await first.update({ id: open.id, expectedRevision: open.revision, operation: 'delete' });
    expect(await reopenedStore.list()).toEqual([]);
  });
  it('rejects stale revisions, invalid manual input and an owner change without altering persisted data', async () => {
    const { file } = await fixture();
    const store = createPersonalTodoStore(file);
    const item = await store.update({ creationRequestId: crypto.randomUUID(), title: 'Versioned unit input' });
    await store.update({ id: item.id, expectedRevision: item.revision, notes: 'New version' });
    await expect(store.update({ id: item.id, expectedRevision: item.revision, title: 'Stale' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.update({ creationRequestId: crypto.randomUUID(), title: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.update({ creationRequestId: crypto.randomUUID(), title: 'x', origin: 'assigned' } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const switched = createPersonalTodoStore(file, () => { throw new Error('Owner changed'); });
    await expect(switched.update({ creationRequestId: crypto.randomUUID(), title: 'Wrong owner' })).rejects.toThrow('Owner changed');
    expect((await store.list()).map(t => t.title)).toEqual(['Versioned unit input']);
  });
  // Contract for priority / tags / reminder (2026-11-11): older files carry none of them and must
  // keep reading as defaults; invalid values are rejected before anything is written.
  it('round-trips priority, tag ids and reminder, and reads items written before they existed', async () => {
    const { file } = await fixture();
    const store = createPersonalTodoStore(file);
    const legacy = await store.update({ creationRequestId: 'before-organize', title: 'Older unit item' });
    const raw = JSON.parse(await readFile(file, 'utf8'));
    for (const item of raw.items) { delete item.priority; delete item.tagIds; delete item.reminder; }
    await writeFile(file, JSON.stringify(raw));
    expect(await store.list()).toEqual([expect.objectContaining({ id: legacy.id, priority: 0, tagIds: [], reminder: 'default' })]);
    const created = await store.update({ creationRequestId: 'organized', title: 'Organized unit item', priority: 3, tagIds: ['preset:work', 'preset:work'], reminder: 'before-15m' });
    expect(created).toMatchObject({ priority: 3, tagIds: ['preset:work'], reminder: 'before-15m' });
    const edited = await store.update({ id: created.id, expectedRevision: created.revision, priority: 0, tagIds: [], reminder: 'off' });
    expect(edited).toMatchObject({ priority: 0, tagIds: [], reminder: 'off' });
    await expect(store.update({ id: edited.id, expectedRevision: edited.revision, priority: 4 as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.update({ id: edited.id, expectedRevision: edited.revision, reminder: 'soon' as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.update({ id: edited.id, expectedRevision: edited.revision, tagIds: [''] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // A retried creation with different organize fields is an edited draft, not a duplicate.
    await expect(store.update({ creationRequestId: 'organized', title: 'Organized unit item', priority: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    const corrupt = JSON.parse(await readFile(file, 'utf8'));
    corrupt.items[0].priority = 9;
    await writeFile(file, JSON.stringify(corrupt));
    await expect(store.list()).rejects.toMatchObject({ code: 'CORRUPT_STORE' });
  });
  // Contract for subtasks (2026-11-11): the whole ordered checklist is replaced under the item's
  // revision; new steps get ids from the store, existing ids survive edits, bad lists write nothing.
  it('replaces the checklist under the revision, assigns ids to new steps and rejects malformed lists', async () => {
    const { file } = await fixture();
    const store = createPersonalTodoStore(file);
    const created = await store.update({ creationRequestId: 'with-steps', title: 'Checklist unit item', subtasks: [{ title: ' 拉数据 ' }, { title: '写结论', done: true }] });
    expect(created.subtasks).toEqual([
      { id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), title: '拉数据', done: false },
      { id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), title: '写结论', done: true },
    ]);
    // A lost-reply retry of the same creation is the same item, even though new ids would differ.
    expect((await store.update({ creationRequestId: 'with-steps', title: 'Checklist unit item', subtasks: [{ title: '拉数据' }, { title: '写结论', done: true }] })).id).toBe(created.id);
    const [first, second] = created.subtasks;
    const edited = await store.update({ id: created.id, expectedRevision: created.revision, subtasks: [{ ...second }, { ...first, done: true }, { title: '发给预审' }] });
    expect(edited.subtasks.map((s) => [s.id === first.id || s.id === second.id ? s.id : 'new', s.title, s.done])).toEqual([
      [second.id, '写结论', true], [first.id, '拉数据', true], ['new', '发给预审', false],
    ]);
    await expect(store.update({ id: edited.id, expectedRevision: created.revision, subtasks: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
    for (const subtasks of [[{ title: '' }], [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }], Array.from({ length: 51 }, (_, i) => ({ title: `s${i}` }))])
      await expect(store.update({ id: edited.id, expectedRevision: edited.revision, subtasks })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await store.list())[0].subtasks).toEqual(edited.subtasks);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    delete raw.items[0].subtasks;
    await writeFile(file, JSON.stringify(raw));
    expect((await store.list())[0].subtasks).toEqual([]);
    raw.items[0].subtasks = [{ id: 'x', title: 'ok', done: 'yes' }];
    await writeFile(file, JSON.stringify(raw));
    await expect(store.list()).rejects.toMatchObject({ code: 'CORRUPT_STORE' });
  });
});

// Unit: a real atomic store commit followed by a lost transport receipt must be replay-safe.
it('recovers a committed personal creation after a lost reply without creating another item', async () => {
  const { file } = await fixture();
  const input = { creationRequestId: 'lost-reply-unit', title: 'Committed unit todo', notes: '', deadline: { kind: 'date' as const, date: '2030-01-01', timeZone: 'UTC' } };
  const client = createPersonalTodoStore(file);
  let committed: Awaited<ReturnType<typeof client.update>> | undefined;
  await expect((async () => { committed = await client.update(input); throw new Error('Reply lost after commit'); })()).rejects.toThrow('Reply lost');
  const retry = await createPersonalTodoStore(file).update({ ...input, deadline: { timeZone: 'UTC', date: '2030-01-01', kind: 'date' } });
  expect(retry).toEqual(committed);
  expect(await client.list()).toEqual([retry]);
  await expect(client.update({ ...input, title: 'Edited uncertain draft' })).rejects.toMatchObject({ code: 'CONFLICT' });
  const done = await client.update({ id: retry.id, expectedRevision: retry.revision, operation: 'complete' });
  // Keep the real clock for the cross-process lock's OS process-identity checks.
  await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(done.updatedAt)));
  const edited = await client.update({ id: done.id, expectedRevision: done.revision, notes: 'Edited after completion' });
  expect(edited.createdAt).toBe(retry.createdAt);
  expect(done.completedAt).toBe(done.updatedAt);
  expect(edited.completedAt).toBe(done.completedAt);
  expect(Date.parse(edited.updatedAt)).toBeGreaterThan(Date.parse(done.updatedAt));
});

// Unit: the daily tombstone sweep of the personal file must only drop old personal deletions.
it('purges old deleted personal tombstones with their receipts and keeps teammate and recent ones', async () => {
  const { file } = await fixture();
  const store = createPersonalTodoStore(file);
  const bot = createBotTodoStore(file);
  const day = 86_400_000;
  const deleteTodo = async (request: string) => {
    const created = await store.update({ creationRequestId: request, title: request });
    await store.update({ id: created.id, expectedRevision: created.revision, operation: 'delete' });
  };
  await deleteTodo('old');
  await deleteTodo('recent');
  const live = await store.update({ creationRequestId: 'live', title: 'live' });
  const teammate = await bot.patch({ ...p, key: 'quote:old' });
  await bot.patch({ id: teammate.id, expectedRevision: teammate.revision, operation: 'delete' });
  // 'old' and the teammate item were deleted 31 days ago; 'recent' and 'live' 5 days ago.
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const base = Date.now();
  for (const item of raw.items) {
    const age = item.key === 'personal:recent' || item.key === 'personal:live' ? 5 : 31;
    item.updatedAt = new Date(base - age * day).toISOString();
  }
  await writeFile(file, JSON.stringify(raw));
  expect(await bot.purgeDeleted({ olderThanMs: 30 * day, now: base, keyPrefix: 'personal:' })).toBe(1);
  const after = await bot.read();
  expect(after.items.map((t) => t.key).sort()).toEqual(['personal:live', 'personal:recent', 'quote:old']);
  expect(Object.keys(after.receipts).some((k) => k.startsWith('personal:old:'))).toBe(false);
  expect(after.cursors['personal:old']).toBeUndefined();
  expect(after.cursors['personal:recent']).toBe(1);
  expect(await bot.purgeDeleted({ olderThanMs: 30 * day, now: base, keyPrefix: 'personal:' })).toBe(0);
  await expect(bot.purgeDeleted({ olderThanMs: 0, now: base, keyPrefix: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect((await store.list()).map((t) => t.id)).toEqual([live.id]);
});
