import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AutonomousSettings } from './companionAutonomousPolicy.js';

const validId = (id: string) => /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id);
const directory = (root: string) => join(root, 'companion-autonomous');

function location(root: string, id: string) {
  if (!validId(id)) throw new Error('Invalid companion ID');
  return join(directory(root), id + '.json');
}

export async function listAutonomousSettings(root: string) {
  const entries = await readdir(directory(root)).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(validId);
}

export async function readAutonomousSettings(root: string, id: string): Promise<AutonomousSettings | null> {
  const file = location(root, id);
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<AutonomousSettings> | null;
    if (value && typeof value.greeting === 'boolean' && typeof value.sharing === 'boolean' &&
        typeof value.paused === 'boolean' && typeof value.home === 'string' &&
        typeof value.resumedAt === 'number' && Number.isSafeInteger(value.resumedAt) &&
        typeof value.eligibleAt === 'number' && Number.isSafeInteger(value.eligibleAt)) {
      return { ...value, greeting: value.greeting, sharing: value.sharing, paused: value.paused,
        home: value.home, resumedAt: value.resumedAt, eligibleAt: value.eligibleAt };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return null;
}

export async function writeAutonomousSettings(root: string, id: string, value: AutonomousSettings) {
  const file = location(root, id);
  const temporary = file + '.' + randomUUID();
  await mkdir(directory(root), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
