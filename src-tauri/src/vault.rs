//! The Folio data file: an SQLCipher-encrypted SQLite database on the user's computer.
//!
//! The finance workspace is a validated JSON document with a version number, matching the
//! front end's optimistic-concurrency contract: a save names the version it was based on and
//! fails if the stored version has moved on. Transactions live in their own table (one JSON
//! row each) so a save writes only the rows that changed; `load` reassembles the document.

use rusqlite::{params, Connection, ErrorCode, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const MIN_PASSWORD_LEN: usize = 8;
const SCHEMA_VERSION: i64 = 3;
/// Largest receipt or attachment Folio stores.
pub const MAX_ATTACHMENT_BYTES: usize = 15_000_000;
/// Longest record ID the front end accepts.
const MAX_ID_LEN: usize = 100;

#[derive(Debug, PartialEq, Eq)]
pub enum VaultError {
    AlreadyExists,
    Missing,
    WrongPassword,
    WrongBackupPassword,
    WeakPassword,
    Conflict,
    Locked,
    Storage(String),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::AlreadyExists => "A Folio file already exists on this computer.",
            Self::Missing => "No Folio file was found. Create one to get started.",
            Self::WrongPassword => "That password is incorrect.",
            Self::WrongBackupPassword => {
                "That password does not open this backup. Use the password you had when it was made."
            }
            Self::WeakPassword => "Use a password with at least 8 characters.",
            Self::Conflict => {
                "Your finances changed in another window. Reload before saving again."
            }
            Self::Locked => "Folio is locked. Unlock it to continue.",
            Self::Storage(detail) => {
                return write!(f, "Folio could not read or save its file. {detail}")
            }
        };
        f.write_str(message)
    }
}

impl From<rusqlite::Error> for VaultError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Stored {
    pub payload: Option<String>,
    pub version: i64,
}

fn apply_key(conn: &Connection, password: &str) -> Result<(), VaultError> {
    // pragma_update quotes the value as an SQL string literal, so any password is safe.
    conn.pragma_update(None, "key", password)?;
    // SQLCipher only checks the key when the file is first read.
    match conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    }) {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == ErrorCode::NotADatabase => {
            Err(VaultError::WrongPassword)
        }
        Err(e) => Err(e.into()),
    }
}

/// Upgrades the file in place, one numbered step at a time, each in its own transaction.
fn migrate(conn: &Connection) -> Result<(), VaultError> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current > SCHEMA_VERSION {
        return Err(VaultError::Storage(
            "This file was saved by a newer version of Folio. Update Folio to open it.".into(),
        ));
    }
    if current < 1 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS finance_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT NOT NULL,
                version INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )?;
        tx.pragma_update(None, "user_version", 1)?;
        tx.commit()?;
    }
    if current < 2 {
        // 2: move transactions out of the workspace document into their own table.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );",
        )?;
        let payload: Option<String> = tx
            .query_row("SELECT payload FROM finance_state WHERE id = 1", [], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(payload) = payload {
            let mut doc: serde_json::Value = serde_json::from_str(&payload)
                .map_err(|e| VaultError::Storage(format!("The saved workspace is damaged. {e}")))?;
            if let Some(serde_json::Value::Array(rows)) =
                doc.as_object_mut().and_then(|o| o.remove("transactions"))
            {
                insert_transactions(&tx, &rows)?;
                tx.execute(
                    "UPDATE finance_state SET payload = ?1 WHERE id = 1",
                    params![doc.to_string()],
                )?;
            }
        }
        tx.pragma_update(None, "user_version", 2)?;
        tx.commit()?;
    }
    if current < 3 {
        // 3: receipts and other attachments, stored encrypted in the same file. Their names
        // and which transaction they belong to live in the workspace document.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS attachments (
                id TEXT PRIMARY KEY,
                data BLOB NOT NULL,
                created TEXT NOT NULL
            );",
        )?;
        tx.pragma_update(None, "user_version", 3)?;
        tx.commit()?;
    }
    Ok(())
}

fn attachment_id(id: &str) -> Result<&str, VaultError> {
    if !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        Ok(id)
    } else {
        Err(VaultError::Storage(
            "The attachment ID was not valid.".into(),
        ))
    }
}

/// Stores an attachment's bytes under a new ID.
pub fn add_attachment(conn: &Connection, id: &str, data: &[u8]) -> Result<(), VaultError> {
    if data.is_empty() || data.len() > MAX_ATTACHMENT_BYTES {
        return Err(VaultError::Storage("Attach a file up to 15 MB.".into()));
    }
    conn.execute(
        "INSERT INTO attachments (id, data, created) VALUES (?1, ?2, ?3)",
        params![attachment_id(id)?, data, unix_seconds()],
    )?;
    Ok(())
}

pub fn get_attachment(conn: &Connection, id: &str) -> Result<Vec<u8>, VaultError> {
    conn.query_row(
        "SELECT data FROM attachments WHERE id = ?1",
        params![attachment_id(id)?],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| VaultError::Storage("That attachment was not found.".into()))
}

/// Deletes attachments no longer referenced by the workspace.
pub fn delete_attachments(conn: &Connection, ids: &[String]) -> Result<(), VaultError> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut delete = tx.prepare_cached("DELETE FROM attachments WHERE id = ?1")?;
        for id in ids {
            delete.execute(params![attachment_id(id)?])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn transaction_id(row: &serde_json::Value) -> Result<&str, VaultError> {
    match row.get("id").and_then(|v| v.as_str()) {
        Some(id) if !id.is_empty() && id.len() <= MAX_ID_LEN => Ok(id),
        _ => Err(VaultError::Storage(
            "A transaction was missing a valid ID.".into(),
        )),
    }
}

fn insert_transactions(conn: &Connection, rows: &[serde_json::Value]) -> Result<(), VaultError> {
    let mut insert = conn.prepare_cached(
        "INSERT INTO transactions (id, data) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    )?;
    for row in rows {
        insert.execute(params![transaction_id(row)?, row.to_string()])?;
    }
    Ok(())
}

/// Creates a new encrypted file. Fails if one already exists.
pub fn create(path: &Path, password: &str) -> Result<Connection, VaultError> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(VaultError::WeakPassword);
    }
    if path.exists() {
        return Err(VaultError::AlreadyExists);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| VaultError::Storage(e.to_string()))?;
    }
    let conn = Connection::open(path)?;
    apply_key(&conn, password)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Opens an existing encrypted file with its password.
pub fn open(path: &Path, password: &str) -> Result<Connection, VaultError> {
    if !path.exists() {
        return Err(VaultError::Missing);
    }
    // SQLCipher rejects an empty key outright; report it like any other wrong password.
    if password.is_empty() {
        return Err(VaultError::WrongPassword);
    }
    let conn = Connection::open(path)?;
    apply_key(&conn, password)?;
    // Keep a copy of a file from an earlier version before upgrading it.
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if (1..SCHEMA_VERSION).contains(&version) {
        create_backup(path, &utc_date(), BackupKind::Upgrade)?;
    }
    migrate(&conn)?;
    Ok(conn)
}

/// Changes the file's password. The current password must be given again.
pub fn change_password(
    conn: &Connection,
    path: &Path,
    current: &str,
    next: &str,
) -> Result<(), VaultError> {
    if next.chars().count() < MIN_PASSWORD_LEN {
        return Err(VaultError::WeakPassword);
    }
    check_password(path, current)?;
    // Re-encrypts every page with the new key.
    conn.pragma_update(None, "rekey", next)?;
    Ok(())
}

/// Confirms `password` opens the file at `path`, without changing it.
fn check_password(path: &Path, password: &str) -> Result<(), VaultError> {
    if password.is_empty() {
        return Err(VaultError::WrongPassword);
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    apply_key(&conn, password)
}

// Backups are copies of the encrypted file in a `backups` folder beside it, so they need the
// password that was in use when they were made. Copies are taken only while the app holds the
// connection lock between commands, when no write is in progress.

/// Daily backups kept; older ones are deleted.
pub const DAILY_BACKUPS: usize = 30;
/// Backups of each other kind kept.
pub const OTHER_BACKUPS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupKind {
    /// Made once a day when Folio is unlocked.
    Daily,
    /// Made with "Back up now".
    Manual,
    /// Made before a file from an earlier version is upgraded.
    Upgrade,
    /// Made before a backup is restored over the current file.
    Restore,
}

impl BackupKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Manual => "manual",
            Self::Upgrade => "upgrade",
            Self::Restore => "restore",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        [Self::Daily, Self::Manual, Self::Upgrade, Self::Restore]
            .into_iter()
            .find(|k| k.as_str() == s)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Backup {
    pub name: String,
    /// Calendar date the backup was made (YYYY-MM-DD).
    pub date: String,
    pub kind: BackupKind,
    /// Seconds since 1970 when it was made, for ordering.
    pub created: u64,
    pub bytes: u64,
}

pub fn backup_dir(path: &Path) -> PathBuf {
    path.parent()
        .map(|p| p.join("backups"))
        .unwrap_or_else(|| PathBuf::from("backups"))
}

fn valid_date(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// Backup files are named `folio-<date>-<kind>-<seconds>.db`.
fn parse_backup_name(name: &str) -> Option<(String, BackupKind, u64)> {
    let rest = name.strip_prefix("folio-")?.strip_suffix(".db")?;
    let date = rest.get(..10)?;
    let (kind, created) = rest.get(11..)?.split_once('-')?;
    if !valid_date(date) || rest.as_bytes().get(10) != Some(&b'-') {
        return None;
    }
    Some((
        date.to_string(),
        BackupKind::parse(kind)?,
        created.parse().ok()?,
    ))
}

/// Backups of the file at `path`, newest first.
pub fn list_backups(path: &Path) -> Result<Vec<Backup>, VaultError> {
    let dir = backup_dir(path);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let io = |e: std::io::Error| VaultError::Storage(e.to_string());
    let mut backups = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(io)? {
        let entry = entry.map_err(io)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some((date, kind, created)) = parse_backup_name(&name) {
            let bytes = entry.metadata().map_err(io)?.len();
            backups.push(Backup {
                name,
                date,
                kind,
                created,
                bytes,
            });
        }
    }
    backups.sort_by(|a, b| b.created.cmp(&a.created).then(b.name.cmp(&a.name)));
    Ok(backups)
}

/// Copies the encrypted file into the backups folder, then deletes the oldest backups of the
/// same kind beyond the number kept.
pub fn create_backup(path: &Path, date: &str, kind: BackupKind) -> Result<Backup, VaultError> {
    if !valid_date(date) {
        return Err(VaultError::Storage("The backup date was not valid.".into()));
    }
    if !path.exists() {
        return Err(VaultError::Missing);
    }
    let io = |e: std::io::Error| VaultError::Storage(format!("The backup could not be saved. {e}"));
    let dir = backup_dir(path);
    std::fs::create_dir_all(&dir).map_err(io)?;
    let mut created: u64 = unix_seconds().parse().unwrap_or(0);
    let name = loop {
        let name = format!("folio-{date}-{}-{created}.db", kind.as_str());
        if !dir.join(&name).exists() {
            break name;
        }
        created += 1;
    };
    let bytes = std::fs::copy(path, dir.join(&name)).map_err(io)?;
    let keep = if kind == BackupKind::Daily {
        DAILY_BACKUPS
    } else {
        OTHER_BACKUPS
    };
    for old in list_backups(path)?
        .into_iter()
        .filter(|b| b.kind == kind)
        .skip(keep)
    {
        std::fs::remove_file(dir.join(&old.name)).map_err(io)?;
    }
    Ok(Backup {
        name,
        date: date.to_string(),
        kind,
        created,
        bytes,
    })
}

/// Makes the day's backup unless one exists for `date`.
pub fn daily_backup(path: &Path, date: &str) -> Result<Option<Backup>, VaultError> {
    let done = list_backups(path)?
        .iter()
        .any(|b| b.kind == BackupKind::Daily && b.date == date);
    if done {
        return Ok(None);
    }
    create_backup(path, date, BackupKind::Daily).map(Some)
}

/// The path of a listed backup. Only names in the backups folder are accepted.
pub fn backup_path(path: &Path, name: &str) -> Result<PathBuf, VaultError> {
    if parse_backup_name(name).is_none() || !list_backups(path)?.iter().any(|b| b.name == name) {
        return Err(VaultError::Storage("That backup was not found.".into()));
    }
    Ok(backup_dir(path).join(name))
}

/// Checks a backup's password without changing anything. Call before closing the current file.
pub fn check_backup(path: &Path, name: &str, password: &str) -> Result<(), VaultError> {
    check_password(&backup_path(path, name)?, password).map_err(|e| match e {
        VaultError::WrongPassword => VaultError::WrongBackupPassword,
        other => other,
    })
}

/// Replaces the file with a backup and opens it. The current file is first kept as a
/// "restore" backup, and put back if the restored copy cannot be opened. The caller must have
/// closed its connection to `path`, and should call `check_backup` first.
pub fn restore_backup(
    path: &Path,
    name: &str,
    password: &str,
    date: &str,
) -> Result<Connection, VaultError> {
    let source = backup_path(path, name)?;
    let io =
        |e: std::io::Error| VaultError::Storage(format!("The backup could not be restored. {e}"));
    let safety = if path.exists() {
        Some(create_backup(path, date, BackupKind::Restore)?)
    } else {
        None
    };
    std::fs::copy(&source, path).map_err(io)?;
    match open(path, password) {
        Ok(conn) => Ok(conn),
        Err(e) => {
            if let Some(safety) = safety {
                std::fs::copy(backup_dir(path).join(safety.name), path).map_err(io)?;
            }
            Err(e)
        }
    }
}

/// Today's date in UTC, used for backups made without a date from the app.
fn utc_date() -> String {
    let days = unix_seconds().parse::<i64>().unwrap_or(0) / 86_400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Loads the whole workspace, with its transactions, as one JSON document.
pub fn load(conn: &Connection) -> Result<Stored, VaultError> {
    let row = conn
        .query_row(
            "SELECT payload, version FROM finance_state WHERE id = 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((payload, version)) = row else {
        return Ok(Stored {
            payload: None,
            version: 0,
        });
    };
    let mut doc: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|e| VaultError::Storage(format!("The saved workspace is damaged. {e}")))?;
    let mut stmt = conn.prepare("SELECT data FROM transactions ORDER BY rowid")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .map(|data| {
            serde_json::from_str::<serde_json::Value>(&data?)
                .map_err(|e| VaultError::Storage(format!("A saved transaction is damaged. {e}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(object) = doc.as_object_mut() {
        object.insert("transactions".into(), serde_json::Value::Array(rows));
    }
    Ok(Stored {
        payload: Some(doc.to_string()),
        version,
    })
}

/// What a save changes. `payload` is the workspace document; if it contains a `transactions`
/// array, that array replaces every stored transaction (first save, restore, clear).
/// Otherwise `upsert` (JSON transaction objects) and `remove` (IDs) are applied.
#[derive(Debug, Default)]
pub struct Changes<'a> {
    pub payload: &'a str,
    pub upsert: &'a [String],
    pub remove: &'a [String],
}

/// Saves the changes if the stored version still equals `expected`; returns the new version.
/// Everything is written in one transaction, so a failed save changes nothing.
pub fn save(conn: &Connection, changes: Changes, expected: i64) -> Result<i64, VaultError> {
    let invalid = || VaultError::Storage("The workspace was not valid JSON.".into());
    let mut doc: serde_json::Value =
        serde_json::from_str(changes.payload).map_err(|_| invalid())?;
    let object = doc.as_object_mut().ok_or_else(invalid)?;
    let replacement = match object.remove("transactions") {
        Some(serde_json::Value::Array(rows)) => Some(rows),
        Some(_) => return Err(invalid()),
        None => None,
    };
    let upsert = changes
        .upsert
        .iter()
        .map(|row| serde_json::from_str::<serde_json::Value>(row).map_err(|_| invalid()))
        .collect::<Result<Vec<_>, _>>()?;

    let tx = conn.unchecked_transaction()?;
    let now = unix_seconds();
    let changed = if expected == 0 {
        tx.execute(
            "INSERT INTO finance_state (id, payload, version, updated_at) VALUES (1, ?1, 1, ?2)
             ON CONFLICT(id) DO NOTHING",
            params![doc.to_string(), now],
        )?
    } else {
        tx.execute(
            "UPDATE finance_state SET payload = ?1, version = version + 1, updated_at = ?2
             WHERE id = 1 AND version = ?3",
            params![doc.to_string(), now, expected],
        )?
    };
    if changed == 0 {
        return Err(VaultError::Conflict);
    }
    if let Some(rows) = replacement {
        tx.execute("DELETE FROM transactions", [])?;
        insert_transactions(&tx, &rows)?;
    } else {
        insert_transactions(&tx, &upsert)?;
        let mut delete = tx.prepare_cached("DELETE FROM transactions WHERE id = ?1")?;
        for id in changes.remove {
            delete.execute(params![id])?;
        }
    }
    tx.commit()?;
    Ok(expected + 1)
}

fn unix_seconds() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// Where the data file lives, given the app's own data folder (named after its identifier).
///
/// If the app's identifier has changed, the data is still in the folder named after the old
/// one, beside the new one. When the app's own folder has no data file, Folio looks for a
/// sibling folder whose name ends in `.folio` and holds one, and moves that folder into place
/// (a rename, so the data never exists twice). With more than one candidate it moves nothing.
/// If the move fails, the data file is used where it is, so it is never hidden behind a
/// "create a new file" screen.
pub fn resolve_data_dir(app_dir: &Path) -> PathBuf {
    if app_dir.join("folio.db").exists() {
        return app_dir.to_path_buf();
    }
    let (Some(parent), Some(own)) = (app_dir.parent(), app_dir.file_name()) else {
        return app_dir.to_path_buf();
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return app_dir.to_path_buf();
    };
    let candidates: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_name() != own)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".folio"))
        .map(|e| e.path())
        .filter(|p| p.join("folio.db").is_file())
        .collect();
    let [previous] = candidates.as_slice() else {
        return app_dir.to_path_buf();
    };
    // The app's folder may already exist with only web view caches in it; move those aside
    // rather than mixing them with the previous folder's.
    if app_dir.exists() {
        let aside = app_dir.with_file_name(format!("{}.replaced", own.to_string_lossy()));
        if std::fs::rename(app_dir, &aside).is_err() {
            return previous.clone();
        }
    }
    match std::fs::rename(previous, app_dir) {
        Ok(()) => app_dir.to_path_buf(),
        Err(_) => previous.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full(payload: &str) -> Changes<'_> {
        Changes {
            payload,
            ..Changes::default()
        }
    }

    fn transactions_of(conn: &Connection) -> Vec<String> {
        let stored = load(conn).unwrap().payload.unwrap();
        let doc: serde_json::Value = serde_json::from_str(&stored).unwrap();
        doc["transactions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| format!("{}={}", t["id"].as_str().unwrap(), t["amount"]))
            .collect()
    }

    fn temp_path() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("folio.db");
        (dir, path)
    }

    #[test]
    fn create_load_save_and_reopen() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        assert_eq!(
            load(&conn).unwrap(),
            Stored {
                payload: None,
                version: 0
            }
        );
        assert_eq!(save(&conn, full(r#"{"demo":false}"#), 0).unwrap(), 1);
        assert_eq!(save(&conn, full(r#"{"demo":false,"n":2}"#), 1).unwrap(), 2);
        drop(conn);

        let reopened = open(&path, "correct horse").unwrap();
        assert_eq!(
            load(&reopened).unwrap(),
            Stored {
                payload: Some(r#"{"demo":false,"n":2,"transactions":[]}"#.into()),
                version: 2
            }
        );
    }

    #[test]
    fn wrong_password_is_rejected() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        save(&conn, full(r#"{"secret":"fictional"}"#), 0).unwrap();
        drop(conn);
        assert_eq!(
            open(&path, "wrong horse").err(),
            Some(VaultError::WrongPassword)
        );
        assert_eq!(open(&path, "").err(), Some(VaultError::WrongPassword));
        assert!(open(&path, "correct horse").is_ok());
    }

    #[test]
    fn file_contents_are_encrypted() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        save(
            &conn,
            full(r#"{"transactions":[{"id":"t1","merchant":"Corner Grocery Fictional"}]}"#),
            0,
        )
        .unwrap();
        drop(conn);
        let bytes = std::fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("Corner Grocery Fictional"));
        assert!(!text.contains("SQLite format 3"));
        // A plain SQLite reader without the key cannot open it either.
        let plain = Connection::open(&path).unwrap();
        assert!(plain
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| r
                .get::<_, i64>(0))
            .is_err());
    }

    #[test]
    fn stale_versions_conflict() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        save(&conn, full("{}"), 0).unwrap();
        assert_eq!(save(&conn, full("{}"), 0).err(), Some(VaultError::Conflict));
        assert_eq!(save(&conn, full("{}"), 5).err(), Some(VaultError::Conflict));
        assert_eq!(save(&conn, full("{}"), 1).unwrap(), 2);
    }

    #[test]
    fn create_refuses_weak_passwords_and_existing_files() {
        let (_dir, path) = temp_path();
        assert_eq!(create(&path, "short").err(), Some(VaultError::WeakPassword));
        assert!(!path.exists());
        create(&path, "correct horse").unwrap();
        assert_eq!(
            create(&path, "another password").err(),
            Some(VaultError::AlreadyExists)
        );
    }

    #[test]
    fn open_reports_missing_file_and_invalid_json_is_refused() {
        let (_dir, path) = temp_path();
        assert_eq!(
            open(&path, "correct horse").err(),
            Some(VaultError::Missing)
        );
        let conn = create(&path, "correct horse").unwrap();
        assert!(matches!(
            save(&conn, full("not json"), 0),
            Err(VaultError::Storage(_))
        ));
        assert_eq!(load(&conn).unwrap().version, 0);
    }

    #[test]
    fn passwords_with_quotes_work() {
        let (_dir, path) = temp_path();
        let password = "it's \"quoted\"; DROP TABLE x; --";
        let conn = create(&path, password).unwrap();
        save(&conn, full("{}"), 0).unwrap();
        drop(conn);
        assert!(open(&path, password).is_ok());
    }

    #[test]
    fn version_1_files_move_transactions_into_their_own_table() {
        let (_dir, path) = temp_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // A file as the first release wrote it: one document holding every transaction.
        let old = Connection::open(&path).unwrap();
        apply_key(&old, "correct horse").unwrap();
        old.execute_batch(
            r#"CREATE TABLE finance_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT NOT NULL,
                version INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO finance_state VALUES (1,
                '{"demo":false,"accounts":[{"id":"a"}],"transactions":[{"id":"t1","amount":-500},{"id":"t2","amount":1200}]}',
                7, '0');
            PRAGMA user_version = 1;"#,
        )
        .unwrap();
        drop(old);

        let conn = open(&path, "correct horse").unwrap();
        let backups = list_backups(&path).unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].kind, BackupKind::Upgrade);
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let core: String = conn
            .query_row("SELECT payload FROM finance_state", [], |r| r.get(0))
            .unwrap();
        assert!(!core.contains("transactions"));
        assert_eq!(transactions_of(&conn), ["t1=-500", "t2=1200"]);
        let stored = load(&conn).unwrap();
        assert_eq!(stored.version, 7);
        assert!(stored
            .payload
            .unwrap()
            .contains(r#""accounts":[{"id":"a"}]"#));
        drop(conn);
        // Opening again does not repeat the migration or the backup.
        let conn = open(&path, "correct horse").unwrap();
        assert_eq!(transactions_of(&conn), ["t1=-500", "t2=1200"]);
        assert_eq!(list_backups(&path).unwrap().len(), 1);
    }

    #[test]
    fn saves_apply_only_the_changed_transactions() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        let first = r#"{"demo":false,"transactions":[{"id":"t1","amount":1},{"id":"t2","amount":2},{"id":"t3","amount":3}]}"#;
        save(&conn, full(first), 0).unwrap();
        let upsert = [
            r#"{"id":"t2","amount":20}"#.to_string(),
            r#"{"id":"t4","amount":4}"#.to_string(),
        ];
        let remove = ["t1".to_string()];
        let changes = Changes {
            payload: r#"{"demo":false}"#,
            upsert: &upsert,
            remove: &remove,
        };
        assert_eq!(save(&conn, changes, 1).unwrap(), 2);
        assert_eq!(transactions_of(&conn), ["t2=20", "t3=3", "t4=4"]);

        // A stale save changes nothing, including transactions.
        let stale = Changes {
            payload: r#"{"demo":false}"#,
            upsert: &upsert[1..],
            remove: &["t3".to_string()],
        };
        assert_eq!(save(&conn, stale, 1).err(), Some(VaultError::Conflict));
        assert_eq!(transactions_of(&conn), ["t2=20", "t3=3", "t4=4"]);

        // A document with a transactions array replaces them all.
        save(
            &conn,
            full(r#"{"demo":true,"transactions":[{"id":"x","amount":9}]}"#),
            2,
        )
        .unwrap();
        assert_eq!(transactions_of(&conn), ["x=9"]);
        assert!(load(&conn)
            .unwrap()
            .payload
            .unwrap()
            .contains(r#""demo":true"#));
    }

    #[test]
    fn invalid_transactions_are_refused_without_partial_writes() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        save(
            &conn,
            full(r#"{"transactions":[{"id":"t1","amount":1}]}"#),
            0,
        )
        .unwrap();
        for bad in [r#"{"amount":5}"#, r#"{"id":"","amount":5}"#, "not json"] {
            let upsert = [r#"{"id":"ok","amount":1}"#.to_string(), bad.to_string()];
            let changes = Changes {
                payload: "{}",
                upsert: &upsert,
                remove: &[],
            };
            assert!(matches!(
                save(&conn, changes, 1),
                Err(VaultError::Storage(_))
            ));
        }
        let long_id = format!(r#"{{"transactions":[{{"id":"{}"}}]}}"#, "x".repeat(101));
        assert!(matches!(
            save(&conn, full(&long_id), 1),
            Err(VaultError::Storage(_))
        ));
        assert!(matches!(
            save(&conn, full(r#"{"transactions":5}"#), 1),
            Err(VaultError::Storage(_))
        ));
        assert!(matches!(
            save(&conn, full("[]"), 1),
            Err(VaultError::Storage(_))
        ));
        assert_eq!(load(&conn).unwrap().version, 1);
        assert_eq!(transactions_of(&conn), ["t1=1"]);
    }

    #[test]
    fn files_from_newer_versions_are_not_opened() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);
        assert!(matches!(
            open(&path, "correct horse"),
            Err(VaultError::Storage(_))
        ));
    }

    fn workspace(conn: &Connection, version: i64, amount: i64) -> i64 {
        let doc = format!(r#"{{"demo":false,"transactions":[{{"id":"t1","amount":{amount}}}]}}"#);
        save(conn, full(&doc), version).unwrap()
    }

    #[test]
    fn passwords_can_be_changed() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        workspace(&conn, 0, 42);
        assert_eq!(
            change_password(&conn, &path, "wrong horse", "battery staple").err(),
            Some(VaultError::WrongPassword)
        );
        assert_eq!(
            change_password(&conn, &path, "correct horse", "short").err(),
            Some(VaultError::WeakPassword)
        );
        change_password(&conn, &path, "correct horse", "battery staple").unwrap();
        // The open connection keeps working.
        assert_eq!(transactions_of(&conn), ["t1=42"]);
        drop(conn);
        assert_eq!(
            open(&path, "correct horse").err(),
            Some(VaultError::WrongPassword)
        );
        let conn = open(&path, "battery staple").unwrap();
        assert_eq!(transactions_of(&conn), ["t1=42"]);
    }

    #[test]
    fn daily_backups_are_made_once_a_day_and_pruned() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        workspace(&conn, 0, 1);
        let first = daily_backup(&path, "2026-10-01").unwrap().unwrap();
        assert_eq!(first.kind, BackupKind::Daily);
        assert!(first.name.starts_with("folio-2026-10-01-daily-"));
        assert_eq!(daily_backup(&path, "2026-10-01").unwrap(), None);
        create_backup(&path, "2026-10-01", BackupKind::Manual).unwrap();
        for day in 2..=31 {
            daily_backup(&path, &format!("2026-10-{day:02}"))
                .unwrap()
                .unwrap();
        }
        let backups = list_backups(&path).unwrap();
        let daily: Vec<_> = backups
            .iter()
            .filter(|b| b.kind == BackupKind::Daily)
            .collect();
        assert_eq!(daily.len(), DAILY_BACKUPS);
        assert!(
            daily.iter().all(|b| b.date != "2026-10-01"),
            "oldest removed"
        );
        assert_eq!(
            backups
                .iter()
                .filter(|b| b.kind == BackupKind::Manual)
                .count(),
            1,
            "other kinds are kept separately"
        );
        assert!(create_backup(&path, "10/01/2026", BackupKind::Manual).is_err());
        // Unrelated files in the folder are ignored.
        std::fs::write(backup_dir(&path).join("notes.txt"), "x").unwrap();
        assert_eq!(list_backups(&path).unwrap().len(), backups.len());
    }

    #[test]
    fn backups_stay_encrypted_and_restore() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        let v = save(
            &conn,
            full(r#"{"transactions":[{"id":"t1","merchant":"Fictional Bakery","amount":1}]}"#),
            0,
        )
        .unwrap();
        let backup = create_backup(&path, "2026-10-01", BackupKind::Manual).unwrap();
        let bytes = std::fs::read(backup_dir(&path).join(&backup.name)).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("Fictional Bakery"));

        workspace(&conn, v, 2);
        // Wrong passwords and unknown names change nothing.
        assert_eq!(
            check_backup(&path, &backup.name, "wrong horse").err(),
            Some(VaultError::WrongBackupPassword)
        );
        for name in ["../folio.db", "folio-2026-10-01-manual-1.db", "folio.db"] {
            assert!(check_backup(&path, name, "correct horse").is_err());
        }
        check_backup(&path, &backup.name, "correct horse").unwrap();
        drop(conn);

        let conn = restore_backup(&path, &backup.name, "correct horse", "2026-10-02").unwrap();
        assert_eq!(transactions_of(&conn), ["t1=1"]);
        // The replaced file was kept and still holds the later data.
        let safety = list_backups(&path)
            .unwrap()
            .into_iter()
            .find(|b| b.kind == BackupKind::Restore)
            .unwrap();
        drop(conn);
        let conn = restore_backup(&path, &safety.name, "correct horse", "2026-10-02").unwrap();
        assert_eq!(transactions_of(&conn), ["t1=2"]);
    }

    #[test]
    fn backups_keep_the_password_they_were_made_with() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        workspace(&conn, 0, 7);
        let old = create_backup(&path, "2026-10-01", BackupKind::Manual).unwrap();
        change_password(&conn, &path, "correct horse", "battery staple").unwrap();
        assert!(check_backup(&path, &old.name, "battery staple").is_err());
        check_backup(&path, &old.name, "correct horse").unwrap();
        drop(conn);
        // Restoring it means the file now opens with the backup's password.
        drop(restore_backup(&path, &old.name, "correct horse", "2026-10-02").unwrap());
        assert!(open(&path, "correct horse").is_ok());
    }

    #[test]
    fn a_failed_restore_puts_the_current_file_back() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        workspace(&conn, 0, 3);
        let backup = create_backup(&path, "2026-10-01", BackupKind::Manual).unwrap();
        workspace(&conn, 1, 4);
        drop(conn);
        // Skipping the password check: the restored copy will not open with this password.
        assert!(restore_backup(&path, &backup.name, "wrong horse", "2026-10-02").is_err());
        let conn = open(&path, "correct horse").unwrap();
        assert_eq!(transactions_of(&conn), ["t1=4"]);
    }

    #[test]
    fn utc_dates_are_calendar_dates() {
        assert!(valid_date(&utc_date()));
        assert!(!valid_date("2026-1-01"));
        assert_eq!(
            parse_backup_name("folio-2026-10-03-daily-1790000000.db"),
            Some(("2026-10-03".into(), BackupKind::Daily, 1_790_000_000))
        );
        assert_eq!(parse_backup_name("folio-2026-10-03-other-1.db"), None);
        assert_eq!(parse_backup_name("folio-2026-10-03.db"), None);
    }

    #[test]
    fn attachments_are_stored_encrypted_and_deleted() {
        let (_dir, path) = temp_path();
        let conn = create(&path, "correct horse").unwrap();
        let receipt = b"FICTIONAL RECEIPT 12.34".to_vec();
        add_attachment(&conn, "r-1", &receipt).unwrap();
        assert_eq!(get_attachment(&conn, "r-1").unwrap(), receipt);
        assert!(
            add_attachment(&conn, "r-1", &receipt).is_err(),
            "IDs are unique"
        );
        assert!(add_attachment(&conn, "../x", &receipt).is_err());
        assert!(add_attachment(&conn, "r-2", &[]).is_err());
        assert!(add_attachment(&conn, "r-3", &vec![0u8; MAX_ATTACHMENT_BYTES + 1]).is_err());
        drop(conn);
        let bytes = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("FICTIONAL RECEIPT"));
        let conn = open(&path, "correct horse").unwrap();
        delete_attachments(&conn, &["r-1".into(), "missing".into()]).unwrap();
        assert!(get_attachment(&conn, "r-1").is_err());
    }

    #[test]
    fn data_folder_moves_from_a_previous_identifier() {
        let root = tempfile::tempdir().unwrap();
        let new_dir = root.path().join("io.example.folio");
        let old_dir = root.path().join("com.example.folio");
        std::fs::create_dir_all(old_dir.join("backups")).unwrap();
        std::fs::write(old_dir.join("folio.db"), b"data").unwrap();
        std::fs::write(old_dir.join("backups").join("b.db"), b"backup").unwrap();
        // The new folder already exists with only web view caches.
        std::fs::create_dir_all(new_dir.join("WebKitCache")).unwrap();
        assert_eq!(resolve_data_dir(&new_dir), new_dir);
        assert_eq!(std::fs::read(new_dir.join("folio.db")).unwrap(), b"data");
        assert!(new_dir.join("backups").join("b.db").exists());
        assert!(!old_dir.exists());
        assert!(root
            .path()
            .join("io.example.folio.replaced")
            .join("WebKitCache")
            .exists());
        // Second launch: already in place, nothing moves.
        assert_eq!(resolve_data_dir(&new_dir), new_dir);
    }

    #[test]
    fn data_folder_left_alone_when_present_ambiguous_or_absent() {
        let root = tempfile::tempdir().unwrap();
        let new_dir = root.path().join("io.example.folio");
        // Nothing anywhere: the app's own folder.
        assert_eq!(resolve_data_dir(&new_dir), new_dir);
        // Unrelated folders and folders without a data file are ignored.
        std::fs::create_dir_all(root.path().join("com.other.app")).unwrap();
        std::fs::write(root.path().join("com.other.app").join("folio.db"), b"x").unwrap();
        std::fs::create_dir_all(root.path().join("empty.folio")).unwrap();
        assert_eq!(resolve_data_dir(&new_dir), new_dir);
        assert!(root.path().join("com.other.app").join("folio.db").exists());
        // Two candidates: ambiguous, nothing moves.
        for name in ["a.folio", "b.folio"] {
            std::fs::create_dir_all(root.path().join(name)).unwrap();
            std::fs::write(root.path().join(name).join("folio.db"), b"x").unwrap();
        }
        assert_eq!(resolve_data_dir(&new_dir), new_dir);
        assert!(root.path().join("a.folio").join("folio.db").exists());
        // The app's own data file always wins.
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(new_dir.join("folio.db"), b"mine").unwrap();
        assert_eq!(resolve_data_dir(&new_dir), new_dir);
        assert!(root.path().join("b.folio").join("folio.db").exists());
    }
}
