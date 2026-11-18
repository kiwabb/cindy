import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { MemoryRecord } from './types.js';
import { MemoryError } from './types.js';

/** Internal ledger in the existing owner/bot memory DB; never a second fact store. */
export class FactJournal {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_fact_derivations (
      filename TEXT NOT NULL, content_hash TEXT NOT NULL, sources TEXT NOT NULL, invalidated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(filename, content_hash))`);
  }
  static contentHash(record: Pick<MemoryRecord, 'body' | 'frontmatter'>): string {
    return createHash('sha256').update(JSON.stringify([record.frontmatter.title, record.frontmatter.description, record.body.trim()])).digest('hex');
  }
  rememberDerived(filename: string, contentHash: string, sources: Array<{ filename: string; updatedAt: string }>): void {
    this.db.prepare('INSERT OR REPLACE INTO memory_fact_derivations VALUES (?, ?, ?, 0)').run(filename, contentHash, JSON.stringify(sources));
  }
  derivations(): Array<{ filename: string; content_hash: string; sources: string; invalidated: number }> {
    return this.db.prepare('SELECT * FROM memory_fact_derivations').all() as Array<{ filename: string; content_hash: string; sources: string; invalidated: number }>;
  }
  invalidateSources(filenames: readonly string[]): void {
    const changed = new Set(filenames);
    const rows = this.derivations();
    let more = true;
    while (more) {
      more = false;
      for (const row of rows) {
        if (changed.has(row.filename)) continue;
        const sources = JSON.parse(row.sources) as Array<{ filename: string }>;
        if (sources.some(source => changed.has(source.filename))) {
          this.db.prepare('UPDATE memory_fact_derivations SET invalidated=1 WHERE filename=?').run(row.filename);
          changed.add(row.filename); more = true;
        }
      }
    }
  }


  static existing(db: Database.Database): FactJournal | undefined {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_fact_control'").get()
      ? new FactJournal(db) : undefined;
  }

  static open(db: Database.Database, scope: string): FactJournal {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_fact_control (
      id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_fact_sources (id TEXT PRIMARY KEY, source_hash TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_fact_jobs (
      id TEXT PRIMARY KEY, source_hash TEXT NOT NULL, status TEXT NOT NULL,
      payload TEXT, detail TEXT NOT NULL DEFAULT '');`);
    db.prepare('INSERT OR IGNORE INTO memory_fact_control VALUES (1, ?, 0)').run(scope);
    const journal = new FactJournal(db);
    if (journal.scope() !== scope) throw new MemoryError('not-ready', 'Fact memory scope mismatch');
    // Ambiguous dispatch/apply outcomes require review, never an automatic model retry.
    db.prepare("UPDATE memory_fact_jobs SET status='review', payload=NULL, detail='interrupted' WHERE status IN ('preparing','analyzing','applying')").run();
    return journal;
  }

  scope(): string { return (this.db.prepare('SELECT scope FROM memory_fact_control WHERE id=1').get() as { scope: string }).scope; }
  revision(): number { return (this.db.prepare('SELECT revision FROM memory_fact_control WHERE id=1').get() as { revision: number }).revision; }
  bump(): void { this.db.prepare('UPDATE memory_fact_control SET revision=revision+1 WHERE id=1').run(); }
  sourceRevision(id: string, sourceHash: string): number {
    this.db.prepare('INSERT OR IGNORE INTO memory_fact_sources VALUES (?, ?, ?)').run(id, sourceHash, this.revision());
    const row = this.db.prepare('SELECT source_hash,revision FROM memory_fact_sources WHERE id=?').get(id) as { source_hash: string; revision: number };
    if (row.source_hash !== sourceHash) throw new MemoryError('version-conflict', 'Logical source changed');
    return row.revision;
  }
  enqueue(id: string, sourceHash: string, payload: unknown): void {
    const old = this.db.prepare('SELECT source_hash FROM memory_fact_jobs WHERE id=?').get(id) as { source_hash: string } | undefined;
    if (old && old.source_hash !== sourceHash) throw new MemoryError('version-conflict', 'Completed source changed');
    this.db.prepare("INSERT OR IGNORE INTO memory_fact_jobs(id,source_hash,status,payload) VALUES (?,?,'pending',?)")
      .run(id, sourceHash, JSON.stringify(payload));
  }
  next(): { id: string; payload: string } | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT id,payload FROM memory_fact_jobs WHERE status='pending' ORDER BY rowid LIMIT 1").get() as { id: string; payload: string } | undefined;
      if (row) this.transition(row.id, 'pending', 'preparing');
      return row;
    })();
  }
  transition(id: string, expected: string, next: string): void {
    if (this.db.prepare('UPDATE memory_fact_jobs SET status=? WHERE id=? AND status=?').run(next, id, expected).changes !== 1) {
      throw new MemoryError('version-conflict', 'Fact job was superseded');
    }
  }
  state(id: string, status: string, detail = ''): void {
    this.db.prepare('UPDATE memory_fact_jobs SET status=?, detail=?, payload=CASE WHEN ? THEN NULL ELSE payload END WHERE id=?')
      .run(status, detail, ['done', 'conflict', 'review'].includes(status) ? 1 : 0, id);
  }
  cancelPending(): void {
    this.db.prepare("UPDATE memory_fact_jobs SET status='conflict', payload=NULL, detail='user-mutation' WHERE status='pending'").run();
  }
  inspect(): Array<{ id: string; status: string; detail: string }> {
    return this.db.prepare('SELECT id,status,detail FROM memory_fact_jobs ORDER BY rowid').all() as Array<{ id: string; status: string; detail: string }>;
  }
}
