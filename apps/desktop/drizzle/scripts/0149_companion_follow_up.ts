import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schedules'").get();
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'companion_follow_up_at')) {
    db.exec('ALTER TABLE schedules ADD companion_follow_up_at INTEGER');
  }
}

module.exports = { run };
