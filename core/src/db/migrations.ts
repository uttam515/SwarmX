import Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      input_ref TEXT NOT NULL,
      computation_descriptor TEXT NOT NULL,
      required_resources_json TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      execution_constraints_json TEXT NOT NULL,
      result_destination TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      attempt_history_json TEXT NOT NULL DEFAULT '[]',
      assigned_worker_id TEXT,
      lease_expires_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_worker ON tasks(assigned_worker_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(lease_expires_at_ms);

    CREATE TABLE IF NOT EXISTS trusted_workers (
      device_id TEXT PRIMARY KEY,
      device_name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      shared_secret_hash TEXT NOT NULL,
      paired_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workloads (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      status TEXT NOT NULL,
      decision TEXT NOT NULL,
      selected_workers_json TEXT NOT NULL DEFAULT '[]',
      execution_time_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_workloads_status ON workloads(status);
  `);
}
