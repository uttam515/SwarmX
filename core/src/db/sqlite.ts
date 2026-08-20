import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

export function createDatabase(dbPath?: string): Database.Database {
  const finalPath = dbPath || path.join(process.env.HOME || '.', '.swarmx', 'swarmx.db');
  const dir = path.dirname(finalPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(finalPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  
  return db;
}
