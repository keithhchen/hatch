use std::collections::HashMap;
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

use hatch_local_runner::{LocalRunner, ToolCallRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use objc2::{rc::Retained, runtime::Bool};
#[cfg(target_os = "macos")]
use objc2_foundation::{
    NSData, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
};
#[cfg(target_os = "macos")]
use security_framework::passwords::{
    delete_generic_password_options, generic_password, set_generic_password_options,
    PasswordOptions,
};

const LOCAL_TOOL_RESULT_TTL: Duration = Duration::from_secs(60);
const KEYCHAIN_SERVICE: &str = "dev.hatch.local.desktop-session.v2";
const LEGACY_KEYCHAIN_SERVICE: &str = "dev.hatch.local";
const KEYCHAIN_ACCOUNT: &str = "active-session";
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;
const SETTINGS_FILE: &str = "settings.json";
const WORKSPACE_GRANTS_FILE: &str = "workspace-grants.json";
const WORKSPACE_GRANTS_SCHEMA_VERSION: u32 = 1;

struct StoredToolResult {
    created_at: Instant,
    payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct WorkspaceGrantInfo {
    grant_id: String,
    display_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WorkspaceGrantRecord {
    display_path: String,
    bookmark: Vec<u8>,
    #[serde(default)]
    security_scoped: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct WorkspaceGrantStore {
    schema_version: u32,
    grants: HashMap<String, WorkspaceGrantRecord>,
}

impl Default for WorkspaceGrantStore {
    fn default() -> Self {
        Self {
            schema_version: WORKSPACE_GRANTS_SCHEMA_VERSION,
            grants: HashMap::new(),
        }
    }
}

struct ScopedWorkspaceGrant {
    grant_id: String,
    path: PathBuf,
    #[cfg(target_os = "macos")]
    url: Retained<NSURL>,
    #[cfg(target_os = "macos")]
    access_started: bool,
}

#[cfg(target_os = "macos")]
impl Drop for ScopedWorkspaceGrant {
    fn drop(&mut self) {
        if self.access_started {
            // SAFETY: This balances the successful start call in
            // `resolve_scoped_workspace_grant`, on the same owning thread.
            unsafe { self.url.stopAccessingSecurityScopedResource() };
        }
    }
}

fn local_tool_results() -> &'static Mutex<HashMap<String, StoredToolResult>> {
    static RESULTS: OnceLock<Mutex<HashMap<String, StoredToolResult>>> = OnceLock::new();
    RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn local_tool_jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn local_tool_cancel_requests() -> &'static Mutex<HashMap<String, Instant>> {
    static CANCELLATIONS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn local_tool_registry_lock() -> &'static Mutex<()> {
    static REGISTRY: OnceLock<Mutex<()>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(()))
}

fn register_local_tool_job(tool_call_id: &str, cancel: Arc<AtomicBool>) -> Result<(), String> {
    // Serialize start/cancel/result transitions so a transport failure that
    // races the Tauri invoke can leave a pre-cancel tombstone instead of
    // allowing a not-yet-registered shell to start in the background.
    let _registry = local_tool_registry_lock()
        .lock()
        .map_err(|_| "Local tool registry is unavailable")?;
    let mut results = local_tool_results()
        .lock()
        .map_err(|_| "Local tool result registry is unavailable")?;
    results.retain(|_, result| result.created_at.elapsed() < LOCAL_TOOL_RESULT_TTL);
    results.remove(tool_call_id);
    let was_pre_cancelled = {
        let mut cancellations = local_tool_cancel_requests()
            .lock()
            .map_err(|_| "Local tool cancellation registry is unavailable")?;
        cancellations.retain(|_, created_at| created_at.elapsed() < LOCAL_TOOL_RESULT_TTL);
        cancellations.remove(tool_call_id).is_some()
    };
    let mut jobs = local_tool_jobs()
        .lock()
        .map_err(|_| "Local tool job registry is unavailable")?;
    if jobs.contains_key(tool_call_id) {
        return Err(format!(
            "Local tool call is already running: {tool_call_id}"
        ));
    }
    if was_pre_cancelled {
        cancel.store(true, Ordering::Release);
    }
    jobs.insert(tool_call_id.to_string(), cancel);
    Ok(())
}

fn workspace_grants_lock() -> &'static Mutex<()> {
    static GRANTS: OnceLock<Mutex<()>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(()))
}

#[tauri::command]
fn default_workspace() -> String {
    // A workspace is a user grant. Never infer Documents, $HOME, or cwd as consent.
    String::new()
}

#[tauri::command]
fn ensure_workspace(
    app: AppHandle,
    workspace_grant_id: String,
) -> Result<WorkspaceGrantInfo, String> {
    let scoped = resolve_scoped_workspace_grant(&app, &workspace_grant_id)?;
    Ok(WorkspaceGrantInfo {
        grant_id: scoped.grant_id.clone(),
        display_path: scoped.path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn pick_workspace_folder(app: AppHandle) -> Result<Option<WorkspaceGrantInfo>, String> {
    let selected = rfd::AsyncFileDialog::new()
        .set_title("Choose a workspace")
        .pick_folder()
        .await;
    let Some(handle) = selected else {
        return Ok(None);
    };
    // rfd 0.15 exposes only a PathBuf, not NSOpenPanel's original NSURL. Create
    // the bookmark immediately while the picker-issued process grant is live;
    // the signed picker → first-tool smoke gate verifies this reconstruction.
    let grant = create_workspace_grant(&app, handle.path().to_path_buf())?;
    Ok(Some(grant))
}

#[tauri::command]
fn revoke_workspace_grant(app: AppHandle, workspace_grant_id: String) -> Result<(), String> {
    remove_workspace_grant(&app, &workspace_grant_id)
}

#[tauri::command]
fn execute_tool_call(
    app: AppHandle,
    workspace_grant_id: String,
    request: Value,
) -> Result<(), String> {
    // Local tools belong to the Desktop, but they must not block its WebView.
    // The result is stored as a short-lived job and polled by the renderer so
    // the UI remains responsive while the bounded runner performs file work.
    let run_id = request
        .get("run_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_call_id = request
        .get("tool_call_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let result_key = tool_call_id.clone();
    if tool_call_id.is_empty() {
        return Err("A local tool call requires tool_call_id".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    register_local_tool_job(&result_key, cancel.clone())?;

    std::thread::spawn(move || {
        let payload = match execute_tool_call_blocking(&app, workspace_grant_id, request, cancel) {
            Ok(result) => result,
            Err(error) => serde_json::json!({
                "type": "tool_call.result",
                "run_id": run_id,
                "tool_call_id": tool_call_id,
                "status": "error",
                "error": {
                    "code": "local_runner_error",
                    "message": error
                }
            }),
        };

        if let Ok(_registry) = local_tool_registry_lock().lock() {
            if let Ok(mut results) = local_tool_results().lock() {
                results.retain(|_, result| result.created_at.elapsed() < LOCAL_TOOL_RESULT_TTL);
                results.insert(
                    result_key.clone(),
                    StoredToolResult {
                        created_at: Instant::now(),
                        payload,
                    },
                );
            }
            if let Ok(mut jobs) = local_tool_jobs().lock() {
                jobs.remove(&result_key);
            }
            if let Ok(mut cancellations) = local_tool_cancel_requests().lock() {
                cancellations.remove(&result_key);
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn cancel_tool_call(tool_call_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cancel = {
            let _registry = local_tool_registry_lock()
                .lock()
                .map_err(|_| "Local tool registry is unavailable")?;
            let result_is_ready = local_tool_results()
                .lock()
                .map_err(|_| "Local tool result registry is unavailable")?
                .contains_key(&tool_call_id);
            if result_is_ready {
                return Ok(false);
            }
            let cancel = local_tool_jobs()
                .lock()
                .map_err(|_| "Local tool job registry is unavailable")?
                .get(&tool_call_id)
                .cloned();
            if cancel.is_none() {
                let mut cancellations = local_tool_cancel_requests()
                    .lock()
                    .map_err(|_| "Local tool cancellation registry is unavailable")?;
                cancellations.retain(|_, created_at| created_at.elapsed() < LOCAL_TOOL_RESULT_TTL);
                cancellations.insert(tool_call_id.clone(), Instant::now());
                return Ok(true);
            }
            cancel
        };
        let Some(cancel) = cancel else {
            unreachable!("missing local tool jobs return from the pre-cancel branch")
        };
        cancel.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let still_running = {
                let _registry = local_tool_registry_lock()
                    .lock()
                    .map_err(|_| "Local tool registry is unavailable")?;
                local_tool_jobs()
                    .lock()
                    .map_err(|_| "Local tool job registry is unavailable")?
                    .contains_key(&tool_call_id)
            };
            if !still_running {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Hatch could not confirm local tool cancellation: {tool_call_id}"
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    })
    .await
    .map_err(to_string)?
}

#[tauri::command]
fn poll_tool_call(tool_call_id: String) -> Option<Value> {
    let _registry = local_tool_registry_lock().lock().ok()?;
    let mut results = local_tool_results().lock().ok()?;
    results.retain(|_, result| result.created_at.elapsed() < LOCAL_TOOL_RESULT_TTL);
    results.remove(&tool_call_id).map(|result| result.payload)
}

#[tauri::command]
fn read_auth_token() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(token) = read_keychain_secret(KEYCHAIN_SERVICE, true)? {
            finish_legacy_keychain_cleanup()?;
            return decode_keychain_token(token).map(Some);
        }

        // One-time upgrade from the CLI-created item. Re-adding through
        // Security.framework makes Hatch itself the creating trusted
        // application, so the Login Keychain ACL follows the app's code-signing
        // requirement instead of trusting a reusable system password CLI.
        let Some(legacy_token) = read_keychain_secret(LEGACY_KEYCHAIN_SERVICE, false)? else {
            return Ok(None);
        };
        write_keychain_secret(KEYCHAIN_SERVICE, &legacy_token)?;
        // Partial commit is intentional and fail-visible: if the v2 write
        // succeeds but legacy cleanup fails, keep v2 and return an error. The
        // next read sees v2 first and retries cleanup; it never reports Signed
        // out or silently falls back to the CLI-created item.
        finish_legacy_keychain_cleanup()?;
        decode_keychain_token(legacy_token).map(Some)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn finish_legacy_keychain_cleanup() -> Result<(), String> {
    delete_keychain_secret_if_present(LEGACY_KEYCHAIN_SERVICE, false).map_err(|error| {
        format!(
            "The secure session was saved in Hatch Keychain storage, but legacy Keychain cleanup failed and will be retried: {error}"
        )
    })
}

#[tauri::command]
fn write_auth_token(token: String) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("A non-empty session token is required".into());
    }
    #[cfg(target_os = "macos")]
    {
        write_keychain_secret(KEYCHAIN_SERVICE, token.trim().as_bytes())?;
        finish_legacy_keychain_cleanup()?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = token;
        Err("Secure session storage is only available on macOS".into())
    }
}

#[tauri::command]
fn clear_auth_token() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        delete_keychain_secret_if_present(KEYCHAIN_SERVICE, true)?;
        delete_keychain_secret_if_present(LEGACY_KEYCHAIN_SERVICE, false)?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn keychain_options(service: &str, explicitly_local: bool) -> PasswordOptions {
    let mut options = PasswordOptions::new_generic_password(service, KEYCHAIN_ACCOUNT);
    if explicitly_local {
        options.set_access_synchronized(Some(false));
    }
    options
}

#[cfg(target_os = "macos")]
fn read_keychain_secret(service: &str, explicitly_local: bool) -> Result<Option<Vec<u8>>, String> {
    match generic_password(keychain_options(service, explicitly_local)) {
        Ok(secret) => Ok(Some(secret)),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(error) => Err(keychain_error("read", error.code())),
    }
}

#[cfg(target_os = "macos")]
fn write_keychain_secret(service: &str, secret: &[u8]) -> Result<(), String> {
    set_generic_password_options(secret, keychain_options(service, true))
        .map_err(|error| keychain_error("save", error.code()))
}

#[cfg(target_os = "macos")]
fn delete_keychain_secret_if_present(service: &str, explicitly_local: bool) -> Result<(), String> {
    match delete_generic_password_options(keychain_options(service, explicitly_local)) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(error) => Err(keychain_error("remove", error.code())),
    }
}

#[cfg(target_os = "macos")]
fn decode_keychain_token(secret: Vec<u8>) -> Result<String, String> {
    let token = String::from_utf8(secret)
        .map_err(|_| "Hatch found an invalid secure session in macOS Keychain".to_string())?;
    let token = token.trim().to_string();
    (!token.is_empty())
        .then_some(token)
        .ok_or_else(|| "Hatch found an empty secure session in macOS Keychain".to_string())
}

#[cfg(target_os = "macos")]
fn keychain_error(action: &str, status: i32) -> String {
    format!("Hatch could not {action} the secure session (macOS Keychain status {status})")
}

#[tauri::command]
fn read_app_settings(app: AppHandle) -> Result<String, String> {
    let path = settings_path(&app)?;
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("{}".into()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn write_app_settings(app: AppHandle, settings: String) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(&settings).map_err(to_string)?;
    if !parsed.is_object() {
        return Err("Desktop settings must be a JSON object".into());
    }
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(to_string)?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, settings.as_bytes()).map_err(to_string)?;
    std::fs::rename(&temporary, &path).map_err(to_string)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !is_allowed_browse_url(&url) {
        return Err("Only the Hatch Creator Agent catalog can be opened from this action".into());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("/usr/bin/open").arg(&url).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd").args(["/C", "start", "", &url]).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(&url).status();
    status
        .map_err(to_string)?
        .success()
        .then_some(())
        .ok_or_else(|| "The system browser could not be opened".into())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(to_string)?
        .join(SETTINGS_FILE))
}

fn is_allowed_browse_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.host_str() == Some("hatch.tokenquadrant.cn")
        && (parsed.path() == "/agents" || parsed.path().starts_with("/agents/"))
}

fn workspace_grants_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(to_string)?
        .join(WORKSPACE_GRANTS_FILE))
}

fn read_workspace_grants(path: &std::path::Path) -> Result<WorkspaceGrantStore, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let store: WorkspaceGrantStore = serde_json::from_slice(&bytes).map_err(|error| {
                format!("workspace_grant_store_invalid: Hatch could not read its native workspace grants: {error}")
            })?;
            if store.schema_version != WORKSPACE_GRANTS_SCHEMA_VERSION {
                return Err("workspace_grant_store_invalid: Unsupported native workspace grant version".into());
            }
            Ok(store)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(WorkspaceGrantStore::default())
        }
        Err(error) => Err(format!(
            "workspace_grant_store_unavailable: Hatch could not read its native workspace grants: {error}"
        )),
    }
}

fn write_workspace_grants(
    path: &std::path::Path,
    store: &WorkspaceGrantStore,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(to_string)?;
    }
    let serialized = serde_json::to_vec(store).map_err(to_string)?;
    let temporary = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(&temporary).map_err(to_string)?;
    file.write_all(&serialized).map_err(to_string)?;
    file.sync_all().map_err(to_string)?;
    std::fs::rename(&temporary, path).map_err(to_string)
}

fn workspace_grant_record(app: &AppHandle, grant_id: &str) -> Result<WorkspaceGrantRecord, String> {
    if grant_id.trim().is_empty() {
        return Err(
            "workspace_grant_missing: Choose a workspace folder before granting access".into(),
        );
    }
    let _guard = workspace_grants_lock()
        .lock()
        .map_err(|_| "workspace_grant_store_unavailable: Native workspace grant lock failed")?;
    let path = workspace_grants_path(app)?;
    read_workspace_grants(&path)?
        .grants
        .get(grant_id)
        .cloned()
        .ok_or_else(|| {
            "workspace_grant_stale: The saved workspace permission is missing or was revoked"
                .to_string()
        })
}

fn save_workspace_grant(
    app: &AppHandle,
    grant_id: String,
    record: WorkspaceGrantRecord,
) -> Result<(), String> {
    let _guard = workspace_grants_lock()
        .lock()
        .map_err(|_| "workspace_grant_store_unavailable: Native workspace grant lock failed")?;
    let path = workspace_grants_path(app)?;
    let mut store = read_workspace_grants(&path)?;
    store.grants.insert(grant_id, record);
    write_workspace_grants(&path, &store)
}

fn remove_workspace_grant(app: &AppHandle, grant_id: &str) -> Result<(), String> {
    let _guard = workspace_grants_lock()
        .lock()
        .map_err(|_| "workspace_grant_store_unavailable: Native workspace grant lock failed")?;
    let path = workspace_grants_path(app)?;
    let mut store = read_workspace_grants(&path)?;
    if store.grants.remove(grant_id).is_some() {
        write_workspace_grants(&path, &store)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn create_workspace_grant(
    app: &AppHandle,
    selected_path: PathBuf,
) -> Result<WorkspaceGrantInfo, String> {
    let canonical = selected_path.canonicalize().map_err(|error| {
        format!("workspace_grant_invalid: Hatch could not open the selected folder: {error}")
    })?;
    validate_workspace_path(&canonical)?;
    let url = NSURL::from_directory_path(&canonical).ok_or_else(|| {
        "workspace_grant_invalid: The selected workspace path cannot be represented by macOS"
            .to_string()
    })?;
    let bookmark = url
        .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            // The main app is intentionally not App Sandboxed until shell
            // execution moves into a signed helper that resolves the bookmark
            // in the executing process. NSOpenPanel is the explicit macOS
            // consent event; this ordinary bookmark preserves its identity.
            NSURLBookmarkCreationOptions::empty(),
            None,
            None,
        )
        .map_err(|error| {
            format!(
                "workspace_grant_unavailable: macOS could not create an app-scoped folder permission: {error}"
            )
        })?;
    let grant_id = format!("workspace_{}", uuid::Uuid::new_v4().simple());
    let display_path = canonical.to_string_lossy().to_string();
    save_workspace_grant(
        app,
        grant_id.clone(),
        WorkspaceGrantRecord {
            display_path: display_path.clone(),
            bookmark: bookmark.to_vec(),
            security_scoped: false,
        },
    )?;
    Ok(WorkspaceGrantInfo {
        grant_id,
        display_path,
    })
}

#[cfg(not(target_os = "macos"))]
fn create_workspace_grant(
    _app: &AppHandle,
    _selected_path: PathBuf,
) -> Result<WorkspaceGrantInfo, String> {
    Err("workspace_grant_unavailable: Persisted workspace grants require macOS".into())
}

#[cfg(target_os = "macos")]
fn resolve_scoped_workspace_grant(
    app: &AppHandle,
    grant_id: &str,
) -> Result<ScopedWorkspaceGrant, String> {
    let record = workspace_grant_record(app, grant_id)?;
    let bookmark = NSData::with_bytes(&record.bookmark);
    let mut stale = Bool::NO;
    // SAFETY: `stale` is a valid out pointer for the duration of the call.
    let resolution_options = if record.security_scoped {
        NSURLBookmarkResolutionOptions::WithSecurityScope
            | NSURLBookmarkResolutionOptions::WithoutUI
    } else {
        NSURLBookmarkResolutionOptions::WithoutUI
    };
    let url = unsafe {
        NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
            &bookmark,
            resolution_options,
            None,
            &mut stale,
        )
    }
    .map_err(|error| {
        format!(
            "workspace_grant_stale: macOS could not resolve the saved workspace permission: {error}"
        )
    })?;
    if stale.as_bool() {
        return Err(
            "workspace_grant_stale: The saved workspace permission is stale; choose the folder again"
                .into(),
        );
    }
    // Security-scoped records are reserved for a future signed helper. Do not
    // claim a scope for ordinary NSOpenPanel bookmarks in the unsandboxed app.
    let access_started =
        record.security_scoped && unsafe { url.startAccessingSecurityScopedResource() };
    if record.security_scoped && !access_started {
        return Err(
            "workspace_grant_revoked: macOS denied the saved workspace permission; choose the folder again"
                .into(),
        );
    }
    let path = match url.to_file_path() {
        Some(path) => path,
        None => {
            if access_started {
                // SAFETY: Balance the successful start before returning early.
                unsafe { url.stopAccessingSecurityScopedResource() };
            }
            return Err(
                "workspace_grant_stale: The selected workspace no longer exists or is inaccessible"
                    .into(),
            );
        }
    };
    if let Err(error) = validate_workspace_path(&path) {
        if access_started {
            // SAFETY: Balance the successful start before returning early.
            unsafe { url.stopAccessingSecurityScopedResource() };
        }
        return Err(error);
    }
    Ok(ScopedWorkspaceGrant {
        grant_id: grant_id.to_string(),
        path,
        url,
        access_started,
    })
}

fn validate_workspace_path(path: &std::path::Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(
            "workspace_grant_invalid: The selected workspace must be an existing folder".into(),
        );
    }
    if path.parent().is_none() {
        return Err("workspace_grant_invalid: Choose a folder below the filesystem root".into());
    }
    // Do one real directory enumeration while onboarding/restoring. A metadata
    // stat can succeed before macOS TCC asks for protected-folder access; the
    // composer must remain gated until the same read used by file_list succeeds.
    let mut entries = std::fs::read_dir(path).map_err(|error| {
        format!(
            "workspace_grant_denied: macOS did not grant read access to the selected folder: {error}"
        )
    })?;
    entries.next().transpose().map_err(|error| {
        format!("workspace_grant_denied: Hatch could not enumerate the selected folder: {error}")
    })?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn resolve_scoped_workspace_grant(
    _app: &AppHandle,
    _grant_id: &str,
) -> Result<ScopedWorkspaceGrant, String> {
    Err("workspace_grant_unavailable: Persisted workspace grants require macOS".into())
}

fn execute_tool_call_blocking(
    app: &AppHandle,
    workspace_grant_id: String,
    request: Value,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    let workspace = resolve_scoped_workspace_grant(app, &workspace_grant_id)?;
    execute_tool_call_in_workspace(&workspace.path, request, cancel)
}

fn execute_tool_call_in_workspace(
    workspace: &std::path::Path,
    request: Value,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    let runner = LocalRunner::new(workspace).map_err(to_string)?;
    let request: ToolCallRequest = serde_json::from_value(request).map_err(to_string)?;
    if matches!(
        request.name.as_str(),
        "file_write" | "file_patch" | "shell_exec"
    ) && request.approval.as_deref() != Some("approved_by_user")
    {
        return Err(format!(
            "{} requires explicit approval in the Hatch window",
            request.name
        ));
    }
    serde_json::to_value(runner.execute_tool_call_request_with_cancel(request, cancel))
        .map_err(to_string)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            default_workspace,
            ensure_workspace,
            pick_workspace_folder,
            execute_tool_call,
            cancel_tool_call,
            poll_tool_call,
            read_auth_token,
            write_auth_token,
            clear_auth_token,
            read_app_settings,
            write_app_settings,
            open_external_url,
            revoke_workspace_grant
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Hatch desktop app");
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::{default_workspace, is_allowed_browse_url, validate_workspace_path};
    use serde_json::json;
    use std::sync::{atomic::AtomicBool, Arc};
    use tempfile::tempdir;

    fn execute_tool_call_in_workspace(
        workspace: &std::path::Path,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        super::execute_tool_call_in_workspace(workspace, request, Arc::new(AtomicBool::new(false)))
    }

    #[test]
    fn canonical_tool_request_executes_inside_workspace() {
        let temp = tempdir().unwrap();
        std::fs::write(temp.path().join("note.txt"), "Hatch desktop local harness").unwrap();

        let output = execute_tool_call_in_workspace(
            temp.path(),
            json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": "call_read",
                "name": "file_read",
                "arguments": {
                    "path": "note.txt"
                },
                "approval": "auto"
            }),
        )
        .unwrap();

        assert_eq!(output["type"], "tool_call.result");
        assert_eq!(output["status"], "ok");
        assert_eq!(output["result"]["content"], "Hatch desktop local harness");
    }

    #[test]
    fn startup_never_silently_grants_a_default_folder() {
        assert!(default_workspace().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_grants_reject_the_filesystem_root_before_any_tool_runs() {
        let error = validate_workspace_path(std::path::Path::new("/")).unwrap_err();
        assert!(error.contains("below the filesystem root"));
    }

    #[test]
    fn workspace_probe_enumerates_a_readable_folder_during_onboarding() {
        let temp = tempdir().unwrap();
        std::fs::write(temp.path().join("visible.txt"), "visible").unwrap();
        validate_workspace_path(temp.path()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn workspace_probe_rejects_an_unreadable_folder_before_composer() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempdir().unwrap();
        let locked = temp.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let result = validate_workspace_path(&locked);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.unwrap_err().contains("did not grant read access"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn ordinary_workspace_bookmark_round_trips_without_main_app_sandbox() {
        use objc2::runtime::Bool;
        use objc2_foundation::{
            NSData, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
        };

        let temp = tempdir().unwrap();
        let url = NSURL::from_directory_path(temp.path()).unwrap();
        let bookmark = url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::empty(),
                None,
                None,
            )
            .unwrap();
        let persisted = bookmark.to_vec();
        let restored_data = NSData::with_bytes(&persisted);
        let mut stale = Bool::NO;
        let restored = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &restored_data,
                NSURLBookmarkResolutionOptions::WithoutUI,
                None,
                &mut stale,
            )
        }
        .unwrap();

        assert!(!stale.as_bool());
        assert_eq!(
            restored.to_file_path().unwrap(),
            temp.path().canonicalize().unwrap()
        );
        validate_workspace_path(&restored.to_file_path().unwrap()).unwrap();
    }

    #[test]
    fn browse_opener_allows_only_the_hatch_catalog_origin() {
        assert!(is_allowed_browse_url(
            "https://hatch.tokenquadrant.cn/agents"
        ));
        assert!(is_allowed_browse_url(
            "https://hatch.tokenquadrant.cn/agents/signal"
        ));
        assert!(!is_allowed_browse_url(
            "https://hatch.tokenquadrant.cn/agents-redirect"
        ));
        assert!(!is_allowed_browse_url("https://evil.example/agents"));
        assert!(!is_allowed_browse_url(
            "https://hatch.tokenquadrant.cn.evil/agents"
        ));
    }

    #[test]
    fn keychain_backend_never_delegates_session_secrets_to_the_security_cli() {
        let source = include_str!("lib.rs");
        assert!(!source.contains(concat!("/usr/bin/", "security")));
        assert!(!source.contains(concat!("add-generic-", "password")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "isolated Login Keychain smoke; run explicitly on an unlocked macOS account"]
    fn security_framework_keychain_round_trip_smoke() {
        use super::{
            delete_keychain_secret_if_present, read_keychain_secret, write_keychain_secret,
        };
        let service = format!("dev.hatch.test.desktop-session.{}", std::process::id());
        delete_keychain_secret_if_present(&service, true).unwrap();
        write_keychain_secret(&service, b"isolated-smoke-token").unwrap();
        assert_eq!(
            read_keychain_secret(&service, true).unwrap(),
            Some(b"isolated-smoke-token".to_vec())
        );
        delete_keychain_secret_if_present(&service, true).unwrap();
        assert_eq!(read_keychain_secret(&service, true).unwrap(), None);
    }

    #[test]
    fn rejects_file_changes_without_desktop_user_approval() {
        let temp = tempdir().unwrap();
        let error = execute_tool_call_in_workspace(
            temp.path(),
            json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": "call_write",
                "name": "file_write",
                "arguments": { "path": "output.txt", "content": "no" },
                "approval": "auto"
            }),
        )
        .unwrap_err();
        assert!(error.contains("requires explicit approval"));
        assert!(!temp.path().join("output.txt").exists());
    }

    #[test]
    fn executes_file_changes_after_desktop_user_approval() {
        let temp = tempdir().unwrap();
        let output = execute_tool_call_in_workspace(
            temp.path(),
            json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": "call_write",
                "name": "file_write",
                "arguments": { "path": "output.txt", "content": "approved by the desktop user" },
                "approval": "approved_by_user"
            }),
        )
        .unwrap();

        assert_eq!(output["type"], "tool_call.result");
        assert_eq!(output["status"], "ok");
        assert_eq!(
            std::fs::read_to_string(temp.path().join("output.txt")).unwrap(),
            "approved by the desktop user"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_shell_commands_without_desktop_policy_approval() {
        let temp = tempdir().unwrap();
        let error = execute_tool_call_in_workspace(
            temp.path(),
            json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": "call_shell_denied",
                "name": "shell_exec",
                "arguments": { "command": "printf denied", "timeout_ms": 30000 },
                "approval": "auto"
            }),
        )
        .unwrap_err();

        assert!(error.contains("requires explicit approval"));
    }

    #[cfg(unix)]
    #[test]
    fn executes_shell_commands_after_desktop_policy_approval() {
        let temp = tempdir().unwrap();
        let output = execute_tool_call_in_workspace(
            temp.path(),
            json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": "call_shell_approved",
                "name": "shell_exec",
                "arguments": { "command": "printf shell-ok", "timeout_ms": 30000 },
                "approval": "approved_by_user"
            }),
        )
        .unwrap();

        assert_eq!(output["type"], "tool_call.result");
        assert_eq!(output["status"], "ok");
        assert_eq!(output["result"]["stdout"], "shell-ok");
    }

    #[cfg(unix)]
    #[test]
    fn desktop_cancel_token_reaches_the_running_shell_process_group() {
        use std::sync::atomic::Ordering;
        use std::time::Duration;

        let temp = tempdir().unwrap();
        let marker = temp.path().join("must-not-exist.txt");
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let workspace = temp.path().to_path_buf();
        let worker = std::thread::spawn(move || {
            super::execute_tool_call_in_workspace(
                &workspace,
                json!({
                    "type": "tool_call.request",
                    "run_id": "run_cancel",
                    "tool_call_id": "call_cancel",
                    "name": "shell_exec",
                    "arguments": {
                        "command": "/bin/sleep 2; printf late > must-not-exist.txt",
                        "timeout_ms": 5000
                    },
                    "approval": "approved_by_user"
                }),
                worker_cancel,
            )
            .unwrap()
        });
        std::thread::sleep(Duration::from_millis(100));
        cancel.store(true, Ordering::Release);
        let output = worker.join().unwrap();

        assert_eq!(output["status"], "error");
        assert_eq!(output["error"]["code"], "cancelled");
        std::thread::sleep(Duration::from_millis(100));
        assert!(!marker.exists());
    }

    #[test]
    fn cancellation_tombstone_wins_when_native_registration_arrives_late() {
        let tool_call_id = format!("call_pre_cancel_{}", uuid::Uuid::new_v4().simple());
        {
            let _registry = super::local_tool_registry_lock().lock().unwrap();
            super::local_tool_cancel_requests()
                .lock()
                .unwrap()
                .insert(tool_call_id.clone(), std::time::Instant::now());
        }

        let cancel = Arc::new(AtomicBool::new(false));
        super::register_local_tool_job(&tool_call_id, cancel.clone()).unwrap();
        assert!(cancel.load(std::sync::atomic::Ordering::Acquire));

        let _registry = super::local_tool_registry_lock().lock().unwrap();
        super::local_tool_jobs()
            .lock()
            .unwrap()
            .remove(&tool_call_id);
    }
}
