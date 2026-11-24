import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { CreateScheduleInput, Schedule } from '@cindy/maker-scheduler';

import { EMPTY_COMPANION_CLOUD_SNAPSHOT } from '../../../shared/companionCloud.js';
import { companionHomes } from '../../companion-cloud/homes.js';
import { runMigrationReplay } from '../../localDb/migrationRunner.js';
import { botProfiles, botProfileVersions, botSessionLinks, messages, sessions } from '../../localDb/schema.js';
import {
  companionAutonomousSettings, startCompanionAutonomous, createCompanionFollowUp, readCompanionOutreachNote, withCompanionFollowUps,
} from '../companionOutreachHost.js';

const h = vi.hoisted(() => ({
  db: {} as unknown, ownerDir: '', generate: vi.fn(), publish: vi.fn(), plan: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'local' }), ownerScopedUserDataPath: () => h.ownerDir,
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => true,
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: h.db }) }));
vi.mock('../../localDb/ipc/bots.js', () => ({
  readBotSettingsProfile: async () => ({ enabled: true, currentVersion: 1, identitySource: 'Fixture companion' }),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: h.publish }));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => ({}) }));
vi.mock('../../maker-host/model-disable-store.js', () => ({ readModelDisableOverrides: () => ({}) }));
vi.mock('../../utility-model/textOneshotPinOptions.js', () => ({
  buildTextOneshotPinOptions: () => [{ agentKind: 'codex', providerId: 'fixture-provider', modelId: 'fixture-model' }],
}));
vi.mock('../../utility-model/oneshotProviderUsability.js', () => ({ hasOneshotProviderCredential: () => true }));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({ requestExplicitUtilityText: h.generate }));
vi.mock('../../maker-ipc/botProjectMemory.js', () => ({
  teammateWorkspaceDir: (root: string, id: string) => join(root, 'bots', id, 'workspace'),
}));
vi.mock('../../maker-ipc/botProfileFolder.js', () => ({
  botProfileDir: (root: string, id: string) => join(root, 'bots', id),
}));
vi.mock('../../maker-ipc/companionLifeSchedule.js', () => ({
  createCompanionLifeScheduleReader: () => h.plan,
}));
vi.mock('../../maker-ipc/register.js', () => ({
  ensureSchedulerQueueRestored: async () => true,
  getSessionLastUserActionAt: () => null,
  isSchedulerTargetSessionBusy: () => false,
  withSendToSessionLock: async (_sessionId: string, run: () => Promise<unknown>) => run(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  h.plan.mockReset();
  companionHomes.reset();
});

it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')('uses the current canonical route and stores only one assistant row across repeated host dispatch', async () => {
  const sqlite = new Database(':memory:');
  const root = await mkdtemp(join(tmpdir(), 'cindy-follow-up-host-'));
  h.ownerDir = join(root, 'owners', 'fixture');
  try {
    sqlite.loadExtension(join(process.cwd(), 'native', 'sqlite-vec',
      `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib'));
    runMigrationReplay(sqlite, { drizzleDir: join(process.cwd(), 'drizzle') });
    const db = drizzle(sqlite);
    h.db = db;
    const botId = 'bot_fixture';
    const sessionId = 'session-fixture';
    const start = Date.parse('2026-11-20T12:00:00+08:00');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    const createdAt = start;
    db.insert(sessions).values({
      id: sessionId, source: 'bot', agentKind: 'codex', model: 'fixture-model',
      providerId: 'fixture-provider', createdAt, updatedAt: createdAt,
    }).run();
    db.insert(botProfiles).values({
      id: botId, displayName: 'Fixture', canonicalSessionId: sessionId, createdAt, updatedAt: createdAt,
    }).run();
    db.insert(botProfileVersions).values({
      id: 'profile-fixture', botId, version: 1, identitySource: 'Active companion snapshot', createdAt,
    }).run();
    db.insert(botSessionLinks).values({
      id: 'link-fixture', botId, sessionId, role: 'canonical', createdAt,
    }).run();

    const dueAt = start + 60_000;
    const create = async (input: CreateScheduleInput, at: number): Promise<Schedule> => ({
      ...input,
      expireAt: input.expireAt ?? undefined,
      preRunHook: undefined,
      preRunPlugin: undefined,
      webhookTrigger: undefined,
      scriptConfig: undefined,
      manual: false, workspaceKind: 'project', status: 'active',
      id: 'follow-up-fixture', companionFollowUpAt: at, createdAt, updatedAt: createdAt,
    });
    const schedule = await createCompanionFollowUp(create, botId, 'Check in about reading', dueAt);
    const fallbackRunner = { fire: vi.fn() };
    const runner = withCompanionFollowUps(fallbackRunner, async () => schedule);
    const ctx = { runId: 'run-fixture', firedAt: dueAt, signal: new AbortController().signal };
    vi.setSystemTime(dueAt);

    companionHomes.update({ ...EMPTY_COMPANION_CLOUD_SNAPSHOT, demotedBotIds: [botId] });
    expect(await runner.fire(schedule, ctx)).toMatchObject({ skipped: true });
    expect(h.generate).not.toHaveBeenCalled();
    companionHomes.reset();

    h.generate.mockImplementation(async (prompt, request) => {
      const route = { agentKind: 'codex', providerId: 'fixture-provider', model: 'fixture-model' };
      expect(request).toMatchObject(route);
      expect(await request.beforeDispatch(route)).toBe(true);
      expect(await request.beforeDispatch({ ...route, providerId: 'unselected-provider' })).toBe(false);
      return { ...route, ok: true, text: prompt.includes('greeting') ? '晚上好呀，想跟你打个招呼。' : 'How did your reading go?' };
    });
    h.publish.mockImplementation(async (id, body, options) => {
      await options.beforePublish();
      db.insert(messages).values({
        id: body.clientId, sessionId: id, role: body.role, clientId: body.clientId,
        content: body.content, agentMeta: JSON.stringify(body.agentMeta), createdAt: body.createdAt,
      }).run();
      await options.beforePublish();
      return { id: body.clientId, createdAt: new Date(body.createdAt).toISOString() };
    });
    expect(await runner.fire(schedule, ctx)).toMatchObject({ sessionId });
    expect(await runner.fire(schedule, { ...ctx, runId: 'retry-fixture' })).toMatchObject({ skipped: true });
    expect(db.select().from(messages).all()).toMatchObject([{
      sessionId, role: 'assistant', content: 'How did your reading go?',
      agentMeta: JSON.stringify({ origin: { kind: 'scheduler', scheduleId: schedule.id,
        scheduleName: schedule.name, runId: ctx.runId } }),
    }]);
    expect(await readCompanionOutreachNote(sessionId)).toContain('How did your reading go?');
    expect(h.generate).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    expect(fallbackRunner.fire).not.toHaveBeenCalled();

    const evening = Date.parse('2026-11-23T19:00:00+08:00');
    vi.setSystemTime(evening);
    const fiveMinutes = 300_000;
    let engine = startCompanionAutonomous(() => true);
    try {
      await engine.tick();
      await companionAutonomousSettings(botId, { sharing: true });
      vi.setSystemTime(evening + fiveMinutes);
      await engine.tick();
      expect(h.publish).toHaveBeenCalledOnce();
      await companionAutonomousSettings(botId, { greeting: true });
      vi.setSystemTime(evening + 2 * fiveMinutes);
      await engine.tick();
      await engine.tick();
      expect(h.publish).toHaveBeenCalledTimes(2);
      engine.stop();
      engine = startCompanionAutonomous(() => true);
      await engine.tick();
      expect(h.publish).toHaveBeenCalledTimes(2);
      vi.setSystemTime(evening + 3 * fiveMinutes);
      await engine.tick();
      expect(h.publish).toHaveBeenCalledTimes(3);
      expect(await companionAutonomousSettings(botId)).toMatchObject({ paused: false });

      vi.setSystemTime(evening + 4 * fiveMinutes);
      h.generate.mockImplementationOnce(async (_prompt, request) => {
        await companionAutonomousSettings(botId, { greeting: false });
        expect(request.signal.aborted).toBe(true);
        return { ok: true, providerId: 'fixture-provider', model: 'fixture-model', text: '晚上好呀。' };
      });
      await engine.tick();
      expect(h.publish).toHaveBeenCalledTimes(3);

      await companionAutonomousSettings(botId, { greeting: true });
      vi.setSystemTime(evening + 5 * fiveMinutes);
      companionHomes.update({ ...EMPTY_COMPANION_CLOUD_SNAPSHOT, enabled: true });
      await engine.tick();
      expect(await companionAutonomousSettings(botId)).toMatchObject({ canEdit: false });
      expect(h.publish).toHaveBeenCalledTimes(3);
      companionHomes.reset();

      h.plan.mockResolvedValue({
        date: '2026-11-23', timezone: 'Asia/Shanghai', start: '19:00', end: '20:00', activity: '整理还没画完的插画草图',
      });
      h.plan.mockClear();
      db.update(botProfiles).set({ currentVersion: 2 }).run();
      await engine.tick();
      expect(h.plan).not.toHaveBeenCalled();
      expect(h.publish).toHaveBeenCalledTimes(3);
      db.update(botProfiles).set({ currentVersion: 1 }).run();
      vi.setSystemTime(evening + 6 * fiveMinutes);
      h.generate.mockImplementationOnce(async (prompt, request) => {
        expect(h.plan).toHaveBeenLastCalledWith('Active companion snapshot');
        expect(request.systemPrompt).toContain('Active companion snapshot');
        expect(request.systemPrompt).toContain('Do not claim a plan happened');
        expect(prompt).toContain('整理还没画完的插画草图');
        return { ok: true, providerId: 'fixture-provider', model: 'fixture-model', text: '我待会儿打算整理一下插画草图。' };
      });
      await engine.tick();
      expect(h.publish).toHaveBeenCalledTimes(4);
      expect(await readCompanionOutreachNote(sessionId)).toContain('我待会儿打算整理一下插画草图。');
    } finally {
      engine.stop();
    }
  } finally {
    sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});
