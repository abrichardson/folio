mod vault;

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// The open Folio file, if unlocked. Commands run one at a time behind this lock.
struct AppState {
    path: PathBuf,
    conn: Mutex<Option<Connection>>,
}

type CommandResult<T> = Result<T, String>;

fn with_conn<T>(
    state: &tauri::State<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, vault::VaultError>,
) -> CommandResult<T> {
    let guard = state
        .conn
        .lock()
        .map_err(|_| "Folio is busy. Try again.".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| vault::VaultError::Locked.to_string())?;
    f(conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_status(state: tauri::State<AppState>) -> CommandResult<&'static str> {
    let guard = state
        .conn
        .lock()
        .map_err(|_| "Folio is busy. Try again.".to_string())?;
    Ok(if guard.is_some() {
        "unlocked"
    } else if state.path.exists() {
        "locked"
    } else {
        "missing"
    })
}

#[tauri::command]
fn vault_create(state: tauri::State<AppState>, password: String) -> CommandResult<()> {
    let conn = vault::create(&state.path, &password).map_err(|e| e.to_string())?;
    *state
        .conn
        .lock()
        .map_err(|_| "Folio is busy. Try again.".to_string())? = Some(conn);
    Ok(())
}

#[tauri::command]
fn vault_unlock(state: tauri::State<AppState>, password: String) -> CommandResult<()> {
    let conn = vault::open(&state.path, &password).map_err(|e| e.to_string())?;
    *state
        .conn
        .lock()
        .map_err(|_| "Folio is busy. Try again.".to_string())? = Some(conn);
    Ok(())
}

#[tauri::command]
fn vault_lock(state: tauri::State<AppState>) -> CommandResult<()> {
    // Dropping the connection closes the file and clears the key from memory.
    *state
        .conn
        .lock()
        .map_err(|_| "Folio is busy. Try again.".to_string())? = None;
    Ok(())
}

#[tauri::command]
fn state_load(state: tauri::State<AppState>) -> CommandResult<vault::Stored> {
    with_conn(&state, vault::load)
}

#[tauri::command]
fn state_save(
    state: tauri::State<AppState>,
    payload: String,
    upsert: Vec<String>,
    remove: Vec<String>,
    version: i64,
) -> CommandResult<i64> {
    let changes = vault::Changes {
        payload: &payload,
        upsert: &upsert,
        remove: &remove,
    };
    with_conn(&state, |conn| vault::save(conn, changes, version))
}

#[tauri::command]
fn vault_change_password(
    state: tauri::State<AppState>,
    current: String,
    next: String,
) -> CommandResult<()> {
    with_conn(&state, |conn| {
        vault::change_password(conn, &state.path, &current, &next)
    })
}

#[tauri::command]
fn backup_list(state: tauri::State<AppState>) -> CommandResult<Vec<vault::Backup>> {
    with_conn(&state, |_| vault::list_backups(&state.path))
}

/// Makes today's backup if there is none yet. `date` is the local calendar date.
#[tauri::command]
fn backup_daily(
    state: tauri::State<AppState>,
    date: String,
) -> CommandResult<Option<vault::Backup>> {
    with_conn(&state, |_| vault::daily_backup(&state.path, &date))
}

#[tauri::command]
fn backup_now(state: tauri::State<AppState>, date: String) -> CommandResult<vault::Backup> {
    with_conn(&state, |_| {
        vault::create_backup(&state.path, &date, vault::BackupKind::Manual)
    })
}

/// Replaces the open file with a backup. The backup's password is checked before the
/// current file is closed; afterwards the file opens with that password.
#[tauri::command]
fn backup_restore(
    state: tauri::State<AppState>,
    name: String,
    password: String,
    date: String,
) -> CommandResult<()> {
    let mut guard = state
        .conn
        .lock()
        .map_err(|_| "Folio is busy. Try again.".to_string())?;
    if guard.is_none() {
        return Err(vault::VaultError::Locked.to_string());
    }
    vault::check_backup(&state.path, &name, &password).map_err(|e| e.to_string())?;
    // Close the current file before replacing it.
    *guard = None;
    let conn =
        vault::restore_backup(&state.path, &name, &password, &date).map_err(|e| e.to_string())?;
    *guard = Some(conn);
    Ok(())
}

/// Saves a copy of an encrypted backup wherever the user chooses (another drive, say).
#[tauri::command]
async fn backup_save_copy(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
) -> CommandResult<bool> {
    use tauri_plugin_dialog::DialogExt;
    let source = with_conn(&state, |_| vault::backup_path(&state.path, &name))?;
    let Some(chosen) = app
        .dialog()
        .file()
        .set_file_name(&name)
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let target = chosen
        .into_path()
        .map_err(|_| "That location cannot be used.".to_string())?;
    std::fs::copy(source, target).map_err(|e| format!("The copy could not be saved. {e}"))?;
    Ok(true)
}

/// Stores a receipt. The bytes are the request body; the ID is in the `x-id` header.
#[tauri::command]
fn attachment_add(
    state: tauri::State<AppState>,
    request: tauri::ipc::Request,
) -> CommandResult<()> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("The attachment was not sent as a file.".into());
    };
    let id = request
        .headers()
        .get("x-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "The attachment ID is missing.".to_string())?
        .to_string();
    with_conn(&state, |conn| vault::add_attachment(conn, &id, data))
}

#[tauri::command]
fn attachment_get(
    state: tauri::State<AppState>,
    id: String,
) -> CommandResult<tauri::ipc::Response> {
    with_conn(&state, |conn| vault::get_attachment(conn, &id)).map(tauri::ipc::Response::new)
}

#[tauri::command]
fn attachment_delete(state: tauri::State<AppState>, ids: Vec<String>) -> CommandResult<()> {
    with_conn(&state, |conn| vault::delete_attachments(conn, &ids))
}

/// Saves a copy of a receipt wherever the user chooses.
#[tauri::command]
async fn attachment_save_copy(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
) -> CommandResult<bool> {
    use tauri_plugin_dialog::DialogExt;
    let data = with_conn(&state, |conn| vault::get_attachment(conn, &id))?;
    let name: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
        .collect();
    let Some(chosen) = app.dialog().file().set_file_name(name).blocking_save_file() else {
        return Ok(false);
    };
    let path = chosen
        .into_path()
        .map_err(|_| "That location cannot be used.".to_string())?;
    std::fs::write(path, data).map_err(|e| format!("The file could not be saved. {e}"))?;
    Ok(true)
}

/// Shows the system Save dialog and writes `contents` to the chosen file.
/// Returns false if the user cancels.
#[tauri::command]
async fn save_text_file(
    app: tauri::AppHandle,
    default_name: String,
    contents: String,
) -> CommandResult<bool> {
    use tauri_plugin_dialog::DialogExt;
    // Only a bare file name is offered as the default; the user chooses the folder.
    let name: String = default_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    let Some(chosen) = app.dialog().file().set_file_name(name).blocking_save_file() else {
        return Ok(false);
    };
    let path = chosen
        .into_path()
        .map_err(|_| "That location cannot be used.".to_string())?;
    std::fs::write(path, contents).map_err(|e| format!("The file could not be saved. {e}"))?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = vault::resolve_data_dir(&app.path().app_data_dir()?);
            app.manage(AppState {
                path: dir.join("folio.db"),
                conn: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_create,
            vault_unlock,
            vault_lock,
            state_load,
            state_save,
            save_text_file,
            vault_change_password,
            backup_list,
            backup_daily,
            backup_now,
            backup_restore,
            backup_save_copy,
            attachment_add,
            attachment_get,
            attachment_delete,
            attachment_save_copy
        ])
        .run(tauri::generate_context!())
        .expect("error while running Folio");
}
