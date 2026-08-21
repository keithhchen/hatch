use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

const STATE_FILE: &str = "state.json";
const STATE_SCHEMA_VERSION: u32 = 1;
const MAX_STATE_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopSessionState {
    pub(crate) token: String,
    pub(crate) expires_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopWorkspaceState {
    pub(crate) grant_id: String,
    pub(crate) display_path: String,
    #[serde(default)]
    pub(crate) native_platform: String,
    #[serde(default)]
    pub(crate) bookmark: Vec<u8>,
    #[serde(default)]
    pub(crate) security_scoped: bool,
    #[serde(default)]
    pub(crate) canonical_path_utf16: Vec<u16>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopPreferencesState {
    pub(crate) language: String,
}

impl Default for DesktopPreferencesState {
    fn default() -> Self {
        Self {
            language: "system".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopWindowLayoutState {
    pub(crate) sidebar_open: bool,
    pub(crate) inspector_open: bool,
    pub(crate) sidebar_width: Option<f64>,
    pub(crate) inspector_width: Option<f64>,
    pub(crate) zoom: Option<f64>,
}

impl Default for DesktopWindowLayoutState {
    fn default() -> Self {
        Self {
            sidebar_open: true,
            inspector_open: true,
            sidebar_width: None,
            inspector_width: None,
            zoom: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopWindowState {
    pub(crate) conversation_id: Option<String>,
    pub(crate) entitlement_id: Option<String>,
    pub(crate) frame: Option<Value>,
    pub(crate) layout: DesktopWindowLayoutState,
}

impl Default for DesktopWindowState {
    fn default() -> Self {
        Self {
            conversation_id: None,
            entitlement_id: None,
            frame: None,
            layout: DesktopWindowLayoutState::default(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopTaskState {
    pub(crate) entitlement_id: String,
    pub(crate) creator_id: Option<String>,
    pub(crate) product_id: Option<String>,
    pub(crate) workspace_grant_id: Option<String>,
    pub(crate) permission_mode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopState {
    pub(crate) schema_version: u32,
    pub(crate) session: Option<DesktopSessionState>,
    pub(crate) preferences: DesktopPreferencesState,
    pub(crate) windows: HashMap<String, DesktopWindowState>,
    pub(crate) open_conversation_ids: Vec<String>,
    pub(crate) workspace_grants: Vec<DesktopWorkspaceState>,
    pub(crate) tasks: HashMap<String, DesktopTaskState>,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            session: None,
            preferences: DesktopPreferencesState::default(),
            windows: HashMap::new(),
            open_conversation_ids: Vec::new(),
            workspace_grants: Vec::new(),
            tasks: HashMap::new(),
        }
    }
}

fn state_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn read<R: Runtime>(app: &AppHandle<R>) -> Result<DesktopState, String> {
    let _guard = state_lock()
        .lock()
        .map_err(|_| "Desktop state lock is unavailable".to_string())?;
    read_or_migrate(app)
}

pub(crate) fn update<R: Runtime, T>(
    app: &AppHandle<R>,
    mutate: impl FnOnce(&mut DesktopState) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = state_lock()
        .lock()
        .map_err(|_| "Desktop state lock is unavailable".to_string())?;
    let mut state = read_or_migrate(app)?;
    let output = mutate(&mut state)?;
    write_state(&state_path(app)?, &state)?;
    Ok(output)
}

fn state_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(STATE_FILE))
}

fn read_or_migrate<R: Runtime>(app: &AppHandle<R>) -> Result<DesktopState, String> {
    let path = state_path(app)?;
    match fs::metadata(&path) {
        Ok(metadata) => {
            if metadata.len() > MAX_STATE_BYTES {
                return Err("desktop_state_invalid: state.json is too large".into());
            }
            let bytes =
                fs::read(&path).map_err(|error| format!("desktop_state_unavailable: {error}"))?;
            let state: DesktopState = serde_json::from_slice(&bytes)
                .map_err(|error| format!("desktop_state_invalid: {error}"))?;
            if state.schema_version != STATE_SCHEMA_VERSION {
                return Err("desktop_state_invalid: unsupported schema version".into());
            }
            Ok(state)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let state = migrate_legacy_state(app)?;
            write_state(&path, &state)?;
            remove_legacy_files(app);
            Ok(state)
        }
        Err(error) => Err(format!("desktop_state_unavailable: {error}")),
    }
}

fn migrate_legacy_state<R: Runtime>(app: &AppHandle<R>) -> Result<DesktopState, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let settings = read_json_if_present(&data_dir.join("settings.json"))?;
    let grants = read_json_if_present(&data_dir.join("workspace-grants.json"))?;
    let windows = read_json_if_present(&data_dir.join("conversation-windows.json"))?;
    let mut state = DesktopState::default();

    if let Some(language) = settings.pointer("/app/language").and_then(Value::as_str) {
        state.preferences.language = language.to_string();
    }
    let context = settings.pointer("/window_settings/main/context");
    let account_id = context
        .and_then(|value| value.get("accountId"))
        .and_then(Value::as_str);
    let profile = account_id.and_then(|id| settings.pointer(&format!("/accounts/{id}")));
    let permission_mode = context
        .and_then(|value| value.get("permissionMode"))
        .and_then(Value::as_str)
        .or_else(|| {
            profile
                .and_then(|value| value.get("permission_mode"))
                .and_then(Value::as_str)
        })
        .unwrap_or("ask-before-changes")
        .to_string();
    let mut main_window = DesktopWindowState::default();
    main_window.frame = settings.pointer("/window_settings/main/frame").cloned();
    if let Some(layout) = settings.pointer("/window_settings/main/layout") {
        main_window.layout.sidebar_open = layout
            .get("sidebarPreference")
            .and_then(Value::as_str)
            .map(|value| value == "open")
            .unwrap_or(true);
        main_window.layout.inspector_open = layout
            .get("inspectorPreference")
            .and_then(Value::as_str)
            .map(|value| value == "open")
            .unwrap_or(true);
        main_window.layout.sidebar_width = layout.get("sidebarWidth").and_then(Value::as_f64);
        main_window.layout.inspector_width = layout.get("inspectorWidth").and_then(Value::as_f64);
        main_window.layout.zoom = layout.get("zoom").and_then(Value::as_f64);
    }
    main_window.entitlement_id = context
        .and_then(|value| value.get("entitlementId"))
        .and_then(Value::as_str)
        .or_else(|| {
            profile
                .and_then(|value| value.get("last_selected_entitlement_id"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    main_window.conversation_id = context
        .and_then(|value| value.get("conversationId"))
        .and_then(Value::as_str)
        .or_else(|| {
            profile
                .and_then(|value| value.get("conversation_id"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let workspace_id = context
        .and_then(|value| value.pointer("/workspaceGrant/grant_id"))
        .and_then(Value::as_str)
        .or_else(|| {
            profile
                .and_then(|value| value.pointer("/workspace_grant/grant_id"))
                .and_then(Value::as_str)
        });
    if let Some(conversation_id) = main_window.conversation_id.clone() {
        let workspace_grant = workspace_id.and_then(|grant_id| {
            grants
                .pointer(&format!("/grants/{grant_id}"))
                .map(|record| DesktopWorkspaceState {
                    grant_id: grant_id.to_string(),
                    display_path: record
                        .get("display_path")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    native_platform: record
                        .get("native_platform")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    bookmark: value_u8_array(record.get("bookmark")),
                    security_scoped: record
                        .get("security_scoped")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    canonical_path_utf16: value_u16_array(record.get("canonical_path_utf16")),
                })
        });
        let workspace_grant_id = workspace_grant.as_ref().map(|grant| grant.grant_id.clone());
        if let Some(workspace_grant) = workspace_grant {
            state.workspace_grants.push(workspace_grant);
        }
        state.tasks.insert(
            conversation_id,
            DesktopTaskState {
                entitlement_id: main_window.entitlement_id.clone().unwrap_or_default(),
                creator_id: context
                    .and_then(|value| value.get("creatorId"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                product_id: context
                    .and_then(|value| value.get("productId"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                workspace_grant_id,
                permission_mode,
            },
        );
    }
    state.windows.insert("main".into(), main_window);
    state.open_conversation_ids = windows
        .get("conversationIds")
        .or_else(|| windows.get("conversation_ids"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    Ok(state)
}

fn read_json_if_present(path: &Path) -> Result<Value, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "desktop_state_migration_failed: {}: {error}",
                path.display()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(Value::Object(Default::default()))
        }
        Err(error) => Err(format!(
            "desktop_state_migration_failed: {}: {error}",
            path.display()
        )),
    }
}

fn value_u8_array(value: Option<&Value>) -> Vec<u8> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
        .filter_map(|value| u8::try_from(value).ok())
        .collect()
}

fn value_u16_array(value: Option<&Value>) -> Vec<u16> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
        .filter_map(|value| u16::try_from(value).ok())
        .collect()
}

fn remove_legacy_files<R: Runtime>(app: &AppHandle<R>) {
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    for name in [
        "settings.json",
        "workspace-grants.json",
        "conversation-windows.json",
        "native-authority-v1.json",
    ] {
        let _ = fs::remove_file(data_dir.join(name));
    }
}

fn write_state(path: &Path, state: &DesktopState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("desktop_state_unavailable: {error}"))?;
    }
    let bytes =
        serde_json::to_vec(state).map_err(|error| format!("desktop_state_invalid: {error}"))?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("desktop_state_invalid: state.json is too large".into());
    }
    let temporary = path.with_file_name(format!("state.{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> std::io::Result<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("desktop_state_unavailable: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    for attempt in 0..8 {
        let moved = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved != 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::PermissionDenied || attempt == 7 {
            return Err(error);
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_uses_one_grant_array_and_one_current_grant_per_task() {
        let mut state = DesktopState::default();
        state.workspace_grants = vec![
            DesktopWorkspaceState {
                grant_id: "workspace_a".into(),
                display_path: "/work/a".into(),
                native_platform: "macos".into(),
                bookmark: vec![1, 2, 3],
                security_scoped: false,
                canonical_path_utf16: Vec::new(),
            },
            DesktopWorkspaceState {
                grant_id: "workspace_b".into(),
                display_path: "/work/b".into(),
                native_platform: "windows".into(),
                bookmark: Vec::new(),
                security_scoped: false,
                canonical_path_utf16: vec![67, 58, 92],
            },
        ];
        state.tasks.insert(
            "conversation_a".into(),
            DesktopTaskState {
                entitlement_id: "entitlement_a".into(),
                creator_id: None,
                product_id: None,
                workspace_grant_id: Some("workspace_a".into()),
                permission_mode: "ask-before-changes".into(),
            },
        );
        state.tasks.insert(
            "conversation_b".into(),
            DesktopTaskState {
                entitlement_id: "entitlement_b".into(),
                creator_id: None,
                product_id: None,
                workspace_grant_id: Some("workspace_b".into()),
                permission_mode: "allow-changes".into(),
            },
        );

        assert_eq!(state.workspace_grants.len(), 2);
        assert_eq!(
            state.tasks["conversation_a"].workspace_grant_id.as_deref(),
            Some("workspace_a")
        );
        assert_eq!(
            state.tasks["conversation_b"].workspace_grant_id.as_deref(),
            Some("workspace_b")
        );
    }

    #[test]
    fn serialized_state_keeps_layout_boolean_and_excludes_profile_password_draft_and_installation()
    {
        let state = DesktopState::default();
        let value = serde_json::to_value(state).unwrap();
        assert_eq!(value.pointer("/windows").unwrap(), &serde_json::json!({}));
        let text = value.to_string();
        for forbidden in [
            "password",
            "profile",
            "composer",
            "draft",
            "installation_id",
        ] {
            assert!(!text.contains(forbidden));
        }

        let layout = serde_json::to_value(DesktopWindowLayoutState::default()).unwrap();
        assert_eq!(layout["sidebar_open"], true);
        assert_eq!(layout["inspector_open"], true);
    }

    #[test]
    fn state_file_is_replaced_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        let mut state = DesktopState::default();
        state.preferences.language = "zh-CN".into();
        write_state(&path, &state).unwrap();
        state.preferences.language = "en".into();
        write_state(&path, &state).unwrap();
        let stored: DesktopState = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored.preferences.language, "en");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
