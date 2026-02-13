/**
 * SQLite Checkpointer Factory
 *
 * Singleton checkpointer backed by .cebus/checkpoints.sqlite.
 * All sessions share a single SQLite file, keyed by thread_id.
 * Also exposes the raw database for Cebus session metadata storage.
 */

import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';

let checkpointerInstance: SqliteSaver | undefined;
let dbInstance: Database.Database | undefined;

function getDbPath(): string {
  const dir = join(process.cwd(), '.cebus');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'checkpoints.sqlite');
}

export function getCheckpointer(): SqliteSaver {
  if (!checkpointerInstance) {
    // Suppress noisy stdout/stderr from better-sqlite3 native module init
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      checkpointerInstance = SqliteSaver.fromConnString(getDbPath());
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
  }
  return checkpointerInstance;
}

/**
 * Get the raw better-sqlite3 database for Cebus metadata tables.
 * Uses the same .cebus/checkpoints.sqlite file as the LangGraph checkpointer.
 */
export function getDatabase(): Database.Database {
  if (!dbInstance) {
    // Suppress noisy stdout/stderr from better-sqlite3 native module init
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      dbInstance = new Database(getDbPath());
      dbInstance.pragma('journal_mode = WAL');
      initMetadataTables(dbInstance);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
  }
  return dbInstance;
}

/**
 * Create Cebus metadata tables if they don't exist.
 */
function initMetadataTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cebus_sessions (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cebus_participants (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cebus_messages (
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (session_id, idx)
    )
  `);
}
