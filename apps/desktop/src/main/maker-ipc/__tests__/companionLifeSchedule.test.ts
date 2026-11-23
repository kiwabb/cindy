import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCompanionLifeScheduleReader } from '../companionLifeSchedule';

const soul = 'The companion likes illustration.';
const hash = createHash('sha256').update(soul).digest('hex');
const timezone = 'Asia/Shanghai';
const activities = [
  { start: '00:00', end: '09:00', activity: 'rest' },
  { start: '09:00', end: '24:00', activity: 'sketch' },
];
let root: string;
let home: string;
let workspace: string;
let now: Date;

async function save(date: string, overrides: Record<string, unknown> = {}) {
  await writeFile(path.join(workspace, 'life-schedule', date + '.json'), JSON.stringify({
    date, timezone, kind: 'plan', activities,
    provenance: { rule: 'current-soul-v1', soulSha256: hash },
    ...overrides,
  }));
}

function reader(isCurrent = () => true, botHome = home) {
  return createCompanionLifeScheduleReader({ ownerRoot: root, botHome, now: () => now, isCurrent });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'companion-life-schedule-'));
  home = path.join(root, 'bots', 'target');
  workspace = path.join(home, 'workspace');
  await mkdir(path.join(workspace, '.cindy'), { recursive: true });
  await mkdir(path.join(workspace, 'life-schedule'));
  await writeFile(path.join(workspace, '.cindy', 'companion-life-schedule.json'), JSON.stringify({ version: 1, timezone }));
  now = new Date('2026-11-20T00:59:00Z');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('companion life schedule input', () => {
  it('uses the half-open local slot and selects the new local date before UTC midnight', async () => {
    await save('2026-11-20');
    const read = reader();
    expect(await read(soul)).toMatchObject({ date: '2026-11-20', activity: 'rest' });
    now = new Date('2026-11-20T01:00:00Z');
    expect(await read(soul)).toMatchObject({ date: '2026-11-20', activity: 'sketch' });
    now = new Date('2026-11-20T16:00:00Z');
    expect(await read(soul)).toBeUndefined();
    await save('2026-11-21');
    expect(await read(soul)).toMatchObject({ date: '2026-11-21', activity: 'rest' });
  });

  it('honors the declared time zone and rejects unsupported zones', async () => {
    const file = path.join(workspace, '.cindy', 'companion-life-schedule.json');
    const otherTimezone = 'America/Los_Angeles';
    await writeFile(file, JSON.stringify({ version: 1, timezone: otherTimezone }));
    await save('2026-11-19', { timezone: otherTimezone });
    expect(await reader()(soul)).toMatchObject({
      date: '2026-11-19', timezone: otherTimezone, activity: 'sketch',
    });
    await writeFile(file, JSON.stringify({ version: 1, timezone: 'Invalid/Timezone' }));
    expect(await reader()(soul)).toBeUndefined();
  });

  it('skips absent, malformed, oversized, unstamped, stale-SOUL and invalid slot data', async () => {
    const read = reader();
    expect(await read(soul)).toBeUndefined();
    const file = path.join(workspace, 'life-schedule', '2026-11-20.json');
    for (const bad of ['{', ' '.repeat(33 * 1024)]) {
      await writeFile(file, bad);
      expect(await read(soul)).toBeUndefined();
    }
    await save('2026-11-20', { provenance: null });
    expect(await read(soul)).toBeUndefined();
    await save('2026-11-20', { date: '2026-11-19' });
    expect(await read(soul)).toBeUndefined();
    await save('2026-11-20', { activities: [{ ...activities[0], end: '08:59' }, activities[1]] });
    expect(await read(soul)).toBeUndefined();
    await save('2026-11-20');
    expect(await read('Changed persona')).toBeUndefined();
  });

  it('withholds data when owner is revoked and refuses another Bot Home and redirected paths', async () => {
    await save('2026-11-20');
    const another = path.join(root, 'bots', 'other');
    await mkdir(another);
    expect(await reader(() => true, another)(soul)).toBeUndefined();
    expect(await reader(() => true, path.join(root, 'other-owner', 'bots', 'target'))(soul)).toBeUndefined();
    let checks = 0;
    expect(await reader(() => ++checks < 3)(soul)).toBeUndefined();

    // Use a directory junction on Windows, where symlinks can require elevation.
    await symlink(workspace, path.join(another, 'workspace'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await reader(() => true, another)(soul)).toBeUndefined();
  });
});
