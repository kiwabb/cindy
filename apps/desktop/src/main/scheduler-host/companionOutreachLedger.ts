import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPANION_FOLLOW_UP_CLIENT_PREFIX } from '../../shared/companionFollowUpMessage.js';

// Run on the companion's primary host, under its per-companion execution
// guard. Claim files survive process restarts. Published messages, rather
// than claims, are the authority for delivered counts.
export class CompanionOutreachLedger {
  private readonly ownerRoot: string;
  private readonly botId: string;

  constructor(ownerRoot: string, botId: string) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(botId)) throw new Error('Invalid companion ID');
    this.ownerRoot = ownerRoot;
    this.botId = botId;
  }

  private get directory() {
    return join(this.ownerRoot, 'companion-follow-ups', this.botId);
  }

  clientId(eventKey: string): string {
    if (!eventKey.trim()) throw new Error('Missing companion event key');
    return `${COMPANION_FOLLOW_UP_CLIENT_PREFIX}${createHash('sha256').update(this.botId)
      .update('\0').update(eventKey).digest('hex')}`;
  }

  async readPublications(after: number): Promise<Array<readonly [string, number]>> {
    const entries = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return entries.flatMap(filename => {
      const match = /^([a-f0-9]{64})\.(\d+)\.sent$/.exec(filename);
      if (!match || Number(match[2]) < after) return [];
      return [[COMPANION_FOLLOW_UP_CLIENT_PREFIX + match[1], Number(match[2])] as const];
    });
  }

  async recordPublication(eventKey: string, createdAt: number): Promise<void> {
    const hash = this.clientId(eventKey).slice(COMPANION_FOLLOW_UP_CLIENT_PREFIX.length);
    await writeFile(join(this.directory, `${hash}.${createdAt}.sent`), '', { mode: 0o600 });
  }

  async claim(eventKey: string): Promise<boolean> {
    const filename = this.clientId(eventKey).slice(COMPANION_FOLLOW_UP_CLIENT_PREFIX.length) + '.claim';
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(this.directory, filename), '', { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }
}
