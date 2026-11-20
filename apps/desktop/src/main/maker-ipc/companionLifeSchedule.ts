import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface CompanionLifeScheduleSlot {
  date: string;
  timezone: string;
  start: string;
  end: string;
  activity: string;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_PLAN_BYTES = 32 * 1024;

async function readBoundedJson(file: string, limit: number): Promise<unknown> {
  const dir = path.dirname(file);
  // Check the whole parent path, not just the final file. Native paths are
  // already canonicalized at the owner-root boundary.
  if (await realpath(dir) !== dir) return null;
  const before = await lstat(file);
  if (!before.isFile() || before.size > limit) return null;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const current = await handle.stat();
    const after = await lstat(file);
    if (!after.isFile() || !current.isFile() || current.size > limit ||
        before.dev !== current.dev || before.ino !== current.ino ||
        after.dev !== current.dev || after.ino !== current.ino ||
        await realpath(dir) !== dir) return null;
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset <= limit) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return offset <= limit ? JSON.parse(bytes.subarray(0, offset).toString('utf8')) : null;
  } finally {
    await handle.close();
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** No per-turn model/tool calls. The caller binds the owner and managed Bot Home. */
export function createCompanionLifeScheduleReader(input: {
  ownerRoot: string;
  botHome: string;
  isCurrent(): boolean;
  now?: () => Date;
}) {
  return async (soul: string): Promise<CompanionLifeScheduleSlot | undefined> => {
    if (!soul.trim() || !input.isCurrent()) return;
    const now = (input.now ?? (() => new Date()))();
    try {
      const root = await realpath(input.ownerRoot);
      const relative = path.relative(path.join(input.ownerRoot, 'bots'), input.botHome);
      if (!relative || relative === '..' || relative.includes(path.sep) || path.isAbsolute(relative)) return;
      const home = path.join(root, 'bots', relative);
      const workspace = path.join(home, 'workspace');
      if (await realpath(workspace) !== workspace || !input.isCurrent()) return;

      const manifest = record(await readBoundedJson(path.join(workspace, '.cindy', 'companion-life-schedule.json'), 2048));
      if (manifest?.version !== 1 || typeof manifest.timezone !== 'string' ||
          !/^[A-Za-z0-9_+/-]{1,80}$/.test(manifest.timezone)) return;
      const timezone = manifest.timezone;
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(now).map(({ type, value }) => [type, value]));
      const date = `${parts.year}-${parts.month}-${parts.day}`;
      const time = `${parts.hour}:${parts.minute}`;
      const plan = record(await readBoundedJson(path.join(workspace, 'life-schedule', date + '.json'), MAX_PLAN_BYTES));
      const provenance = record(plan?.provenance);
      const soulSha256 = createHash('sha256').update(soul.trim(), 'utf8').digest('hex');
      if (plan?.kind !== 'plan' || plan.date !== date || plan.timezone !== timezone ||
          provenance?.rule !== 'current-soul-v1' || provenance.soulSha256 !== soulSha256 ||
          !Array.isArray(plan.activities) || plan.activities.length < 2 || plan.activities.length > 24) return;
      let previousEnd = '00:00';
      let current: CompanionLifeScheduleSlot | undefined;
      for (const raw of plan.activities) {
        const slot = record(raw);
        if (typeof slot?.start !== 'string' || typeof slot.end !== 'string' ||
            !TIME.test(slot.start) || !(TIME.test(slot.end) || slot.end === '24:00') ||
            slot.start !== previousEnd || slot.end <= slot.start ||
            typeof slot.activity !== 'string' || /[\u0000-\u001f\u007f]/.test(slot.activity)) return;
        const activity = slot.activity.trim();
        if (!activity || activity.length > 200) return;
        if (slot.start <= time && time < slot.end) current = { date, timezone, start: slot.start, end: slot.end, activity };
        previousEnd = slot.end;
      }
      return previousEnd === '24:00' && input.isCurrent() ? current : undefined;
    } catch {
      // Optional data: stale, missing, unreadable or malformed plans never block a send.
      return;
    }
  };
}
