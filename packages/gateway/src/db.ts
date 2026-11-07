/** SQLite 底座：网关状态唯一持久化位置（PRD §7.1）。WAL 模式。 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(stateDir: string): DatabaseSync {
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(path.join(stateDir, 'gateway.sqlite'));
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'control',
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS commands (
      client_command_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      task_id TEXT,
      native_task_id TEXT,
      native_run_id TEXT,
      native_message_id TEXT,
      error_code TEXT,
      error_detail TEXT,
      pending_verify INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      native_workspace_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_dir TEXT NOT NULL,
      accessible INTEGER NOT NULL,
      inaccessible_reason TEXT,
      last_synced_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      native_task_id TEXT PRIMARY KEY,
      native_session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      status_native_raw TEXT,
      status_source TEXT NOT NULL DEFAULT 'native',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE TABLE IF NOT EXISTS events (
      stream_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      run_id TEXT,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, stream_seq);
    CREATE TABLE IF NOT EXISTS approvals (
      native_request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      run_id TEXT,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      decision TEXT,
      resolved_by_device TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      device_id TEXT,
      action TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      run_id TEXT,
      path TEXT NOT NULL,
      root_dir TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'text/plain',
      size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
}
