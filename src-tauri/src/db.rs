use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use crate::error::{AppError, AppResult};

pub struct Db {
    pub conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        ensure_column(&conn, "installed_pack", "actual_slot_code", "TEXT")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get_setting(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().expect("db mutex");
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        let conn = self.conn.lock().expect("db mutex");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn clear_setting(&self, key: &str) -> AppResult<()> {
        let conn = self.conn.lock().expect("db mutex");
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    pub fn with_conn<F, T>(&self, f: F) -> AppResult<T>
    where
        F: FnOnce(&mut Connection) -> AppResult<T>,
    {
        let mut conn = self.conn.lock().map_err(|_| AppError::Db("poisoned".into()))?;
        f(&mut conn)
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS skin_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  character_code TEXT NOT NULL,
  slot_code TEXT NOT NULL,
  pack_name TEXT,
  source_path TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  imported_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skin_files_pack ON skin_files (character_code, pack_name);

CREATE TABLE IF NOT EXISTS installed_pack (
  character_code TEXT NOT NULL,
  slot_code TEXT NOT NULL,
  pack_name TEXT,
  source_skin_file_id INTEGER,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (character_code, slot_code)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> AppResult<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for row in rows {
        if row? == column {
            return Ok(());
        }
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
        [],
    )?;
    Ok(())
}
