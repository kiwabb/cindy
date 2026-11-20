import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
    return join(this.ownerRoot, 'routines', 'companion-outreach', this.botId);
  }

  clientId(eventKey: string): string {
    if (!eventKey.trim()) throw new Error('Missing companion event key');
    return `companion-outreach:${createHash('sha256').update(this.botId)
      .update('\0').update(eventKey).digest('hex')}`;
  }

  async claim(eventKey: string): Promise<boolean> {
    const filename = this.clientId(eventKey).split(':')[1] + '.claim';
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(this.directory, filename), '', { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  async saveDraft(eventKey: string, text: string): Promise<void> {
    if (!text.trim() || text.length > 1_000) throw new Error('Invalid outreach draft');
    const stem = this.clientId(eventKey).split(':')[1];
    // A crash during a draft write can make the event unusable, but cannot
    // authorize regenerating it. Validate the complete record on read.
    await readFile(join(this.directory, stem + '.claim'));
    await writeFile(join(this.directory, stem + '.draft'), JSON.stringify({ text }), {
      flag: 'wx', mode: 0o600,
    });
  }

  async readDraft(eventKey: string): Promise<string | null> {
    const stem = this.clientId(eventKey).split(':')[1];
    try {
      const { text } = JSON.parse(await readFile(join(this.directory, stem + '.draft'), 'utf8'));
      return typeof text === 'string' && text.trim() && text.length <= 1_000 ? text : null;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}
