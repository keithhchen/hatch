//! Native desktop command routing and multi-window coordination.
//!
//! The renderer owns the product action behind a command; this module owns
//! the native entry points that make those actions feel like desktop actions:
//! application menus, native context menus, and the lifecycle of a secondary
//! conversation window. Keeping the wire format deliberately semantic means
//! the same command can originate from a menu, a keyboard accelerator, or a
//! context menu without teaching Rust about React component state.

use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{
        CheckMenuItem, CheckMenuItemBuilder, ContextMenu, Menu, MenuBuilder, MenuItem,
        MenuItemBuilder, SubmenuBuilder,
    },
    webview::PageLoadEvent,
    AppHandle, Emitter, LogicalPosition, Manager, Runtime, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window, WindowEvent,
};

/// Renderer-side listeners subscribe to exactly one event regardless of where
/// a command originated. Tauri permits `:` and `/` in event names.
pub const NATIVE_COMMAND_EVENT: &str = "hatch://command";

pub const COMMAND_CONVERSATION_NEW: &str = "conversation.new";
pub const COMMAND_CONVERSATION_NEW_WINDOW: &str = "conversation.newWindow";
pub const COMMAND_CONVERSATION_RENAME: &str = "conversation.rename";
pub const COMMAND_CONVERSATION_OPEN_WINDOW: &str = "conversation.openWindow";
pub const COMMAND_CONVERSATION_ARCHIVE: &str = "conversation.archive";
pub const COMMAND_SIDEBAR_TOGGLE: &str = "sidebar.toggle";
pub const COMMAND_INSPECTOR_TOGGLE: &str = "inspector.toggle";
pub const COMMAND_RUN_STOP: &str = "run.stop";
pub const COMMAND_WORKSPACE_CHOOSE: &str = "workspace.choose";
pub const COMMAND_SETTINGS_OPEN: &str = "settings.open";
pub const COMMAND_ABOUT_OPEN: &str = "about.open";
pub const COMMAND_VIEW_ZOOM_IN: &str = "view.zoomIn";
pub const COMMAND_VIEW_ZOOM_OUT: &str = "view.zoomOut";
pub const COMMAND_VIEW_ZOOM_RESET: &str = "view.zoomReset";
pub const COMMAND_ARTIFACT_REVEAL: &str = "artifact.reveal";
pub const COMMAND_ARTIFACT_QUICK_LOOK: &str = "artifact.quickLook";
pub const COMMAND_ARTIFACT_COPY_PATH: &str = "artifact.copyPath";
pub const COMMAND_TOOL_COPY_OUTPUT: &str = "tool.copyOutput";

const CONTEXT_CONVERSATION_RENAME: &str = "hatch.context.conversation.rename";
const CONTEXT_CONVERSATION_OPEN_WINDOW: &str = "hatch.context.conversation.open-window";
const CONTEXT_CONVERSATION_ARCHIVE: &str = "hatch.context.conversation.archive";
const CONTEXT_ARTIFACT_REVEAL: &str = "hatch.context.artifact.reveal";
const CONTEXT_ARTIFACT_QUICK_LOOK: &str = "hatch.context.artifact.quick-look";
const CONTEXT_ARTIFACT_COPY_PATH: &str = "hatch.context.artifact.copy-path";
const CONTEXT_TOOL_COPY_OUTPUT: &str = "hatch.context.tool.copy-output";

const MAX_CONVERSATION_ID_BYTES: usize = 256;
const MAX_CONTEXT_TARGET_BYTES: usize = 1_024;
const CONVERSATION_WINDOW_MANIFEST_FILE: &str = "conversation-windows.json";
const CONVERSATION_WINDOW_MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_RESTORED_CONVERSATION_WINDOWS: usize = 16;
const MAX_CONVERSATION_WINDOW_MANIFEST_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationWindowManifest {
    schema_version: u32,
    conversation_ids: Vec<String>,
}

impl Default for ConversationWindowManifest {
    fn default() -> Self {
        Self {
            schema_version: CONVERSATION_WINDOW_MANIFEST_SCHEMA_VERSION,
            conversation_ids: Vec::new(),
        }
    }
}

fn conversation_window_manifest_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn normalize_manifest_conversation_ids(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut normalized = ids
        .into_iter()
        .filter_map(|id| validate_conversation_id(&id).ok())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized.truncate(MAX_RESTORED_CONVERSATION_WINDOWS);
    normalized
}

fn conversation_window_manifest_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("conversation_window_manifest_path_failed: {error}"))?
        .join(CONVERSATION_WINDOW_MANIFEST_FILE))
}

fn read_conversation_window_manifest<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<ConversationWindowManifest, String> {
    let path = conversation_window_manifest_path(app)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConversationWindowManifest::default())
        }
        Err(error) => return Err(format!("conversation_window_manifest_read_failed: {error}")),
    };
    if bytes.len() > MAX_CONVERSATION_WINDOW_MANIFEST_BYTES {
        return Err("conversation_window_manifest_invalid: Manifest is too large".into());
    }
    let mut manifest: ConversationWindowManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("conversation_window_manifest_invalid: {error}"))?;
    if manifest.schema_version != CONVERSATION_WINDOW_MANIFEST_SCHEMA_VERSION {
        return Err("conversation_window_manifest_invalid: Unsupported schema version".into());
    }
    manifest.conversation_ids = normalize_manifest_conversation_ids(manifest.conversation_ids);
    Ok(manifest)
}

fn write_conversation_window_manifest<R: Runtime>(
    app: &AppHandle<R>,
    manifest: &ConversationWindowManifest,
) -> Result<(), String> {
    let path = conversation_window_manifest_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("conversation_window_manifest_write_failed: {error}"))?;
    }
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(manifest)
        .map_err(|error| format!("conversation_window_manifest_encode_failed: {error}"))?;
    let mut file = fs::OpenOptions::new();
    file.create(true).truncate(true).write(true);
    let mut file = file
        .open(&temporary)
        .map_err(|error| format!("conversation_window_manifest_write_failed: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("conversation_window_manifest_write_failed: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("conversation_window_manifest_sync_failed: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("conversation_window_manifest_commit_failed: {error}"))
}

/// The renderer projects only presentational command state into this value.
/// It is deliberately window-scoped and never grants access to a workspace,
/// tool, account, or conversation. The native menu uses it only for disabled
/// items and checkmarks; the renderer remains responsible for the action.
///
/// `set_native_command_state` accepts a complete snapshot instead of partial
/// patches. That avoids stale enablement when a renderer reloads halfway
/// through a transition: the next successful projection completely replaces
/// the previous one for that WebviewWindow.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCommandState {
    pub new_conversation_enabled: bool,
    pub new_window_enabled: bool,
    pub workspace_enabled: bool,
    pub settings_enabled: bool,
    pub run_stop_enabled: bool,
    pub sidebar_visible: bool,
    pub inspector_visible: bool,
}

impl Default for NativeCommandState {
    fn default() -> Self {
        Self {
            // These actions are guarded again by the renderer. They start
            // enabled so the first focused window has a usable standard menu
            // before its first React projection arrives.
            new_conversation_enabled: true,
            new_window_enabled: true,
            workspace_enabled: true,
            settings_enabled: true,
            // Stop must never look actionable until the renderer reports a
            // live run for this specific window.
            run_stop_enabled: false,
            sidebar_visible: true,
            inspector_visible: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeMenuSnapshot {
    has_focused_window: bool,
    state: NativeCommandState,
}

impl NativeMenuSnapshot {
    fn command_enabled(&self, command_id: &str) -> bool {
        if !self.has_focused_window {
            return false;
        }
        match command_id {
            COMMAND_CONVERSATION_NEW => self.state.new_conversation_enabled,
            COMMAND_CONVERSATION_NEW_WINDOW => self.state.new_window_enabled,
            COMMAND_WORKSPACE_CHOOSE => self.state.workspace_enabled,
            COMMAND_SETTINGS_OPEN | COMMAND_ABOUT_OPEN => self.state.settings_enabled,
            COMMAND_RUN_STOP => self.state.run_stop_enabled,
            COMMAND_SIDEBAR_TOGGLE
            | COMMAND_INSPECTOR_TOGGLE
            | COMMAND_VIEW_ZOOM_IN
            | COMMAND_VIEW_ZOOM_OUT
            | COMMAND_VIEW_ZOOM_RESET => true,
            _ => false,
        }
    }

    fn command_checked(&self, command_id: &str) -> Option<bool> {
        match command_id {
            COMMAND_SIDEBAR_TOGGLE => Some(self.state.sidebar_visible),
            COMMAND_INSPECTOR_TOGGLE => Some(self.state.inspector_visible),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
struct CommandDefinition {
    id: &'static str,
    label: &'static str,
    accelerator: Option<&'static str>,
    checkable: bool,
}

const APPLICATION_COMMANDS: &[CommandDefinition] = &[
    CommandDefinition {
        id: COMMAND_CONVERSATION_NEW,
        label: "New Conversation",
        accelerator: Some("CmdOrCtrl+N"),
        checkable: false,
    },
    CommandDefinition {
        id: COMMAND_CONVERSATION_NEW_WINDOW,
        label: "New Conversation Window",
        accelerator: Some("CmdOrCtrl+Shift+N"),
        checkable: false,
    },
    CommandDefinition {
        id: COMMAND_WORKSPACE_CHOOSE,
        label: "Open Workspace…",
        accelerator: Some("CmdOrCtrl+O"),
        checkable: false,
    },
    CommandDefinition {
        id: COMMAND_SETTINGS_OPEN,
        label: "Settings…",
        accelerator: Some("CmdOrCtrl+,"),
        checkable: false,
    },
    CommandDefinition {
        id: COMMAND_ABOUT_OPEN,
        label: "About Hatch",
        accelerator: None,
        checkable: false,
    },
    CommandDefinition {
        id: COMMAND_SIDEBAR_TOGGLE,
        label: "Show Sidebar",
        accelerator: Some("CmdOrCtrl+Shift+S"),
        checkable: true,
    },
    CommandDefinition {
        id: COMMAND_INSPECTOR_TOGGLE,
        label: "Show Inspector",
        accelerator: None,
        checkable: true,
    },
    CommandDefinition {
        id: COMMAND_VIEW_ZOOM_IN,
        label: "Zoom In",
        // `=` is the portable physical key spelling accepted by Tauri/muda;
        // macOS displays it as the familiar Command-Plus shortcut.
        accelerator: Some("CmdOrCtrl+="),
        checkable: false,
    },
    CommandDefinition {
        id: COMMAND_VIEW_ZOOM_OUT,
        label: "Zoom Out",
        accelerator: Some("CmdOrCtrl+-"),
        checkable: false,
    },
    CommandDefinition {
        id: COMMAND_VIEW_ZOOM_RESET,
        label: "Actual Size",
        accelerator: Some("CmdOrCtrl+0"),
        checkable: false,
    },
    CommandDefinition {
        id: COMMAND_RUN_STOP,
        label: "Stop Run",
        accelerator: Some("CmdOrCtrl+."),
        checkable: false,
    },
];

fn application_command_definition(command_id: &str) -> Option<&'static CommandDefinition> {
    APPLICATION_COMMANDS
        .iter()
        .find(|definition| definition.id == command_id)
}

#[derive(Clone, Default)]
pub struct NativeCommandRouter {
    state: Arc<Mutex<NativeCommandRouterState>>,
}

#[derive(Default)]
struct NativeCommandRouterState {
    active_window_label: Option<String>,
    preserve_conversation_manifest_on_exit: bool,
    command_state_by_window: HashMap<String, NativeCommandState>,
    conversations_by_id: HashMap<String, ConversationWindowEntry>,
    conversation_by_label: HashMap<String, String>,
    pending_context_by_window: HashMap<String, PendingContextMenu>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ConversationWindowEntry {
    label: String,
    phase: ConversationWindowPhase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConversationWindowPhase {
    Creating,
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ConversationReservation {
    New {
        label: String,
    },
    Existing {
        label: String,
        phase: ConversationWindowPhase,
    },
}

#[derive(Clone, Debug)]
struct PendingContextMenu {
    kind: NativeContextMenuKind,
    target: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeContextMenuKind {
    Conversation,
    Artifact,
    ToolResult,
}

impl NativeContextMenuKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "conversation" => Ok(Self::Conversation),
            "artifact" => Ok(Self::Artifact),
            "tool-result" => Ok(Self::ToolResult),
            _ => Err("native_context_menu_invalid: Unsupported context menu kind".into()),
        }
    }

    fn requires_target(self) -> bool {
        matches!(self, Self::Conversation | Self::Artifact)
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::Artifact => "artifact",
            Self::ToolResult => "tool-result",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeContextMenuRequest {
    /// One of `conversation`, `artifact`, or `tool-result`.
    pub kind: String,
    /// Opaque renderer presentation data. It is returned to the same renderer
    /// with the semantic command and is never used as native authority.
    pub target: Option<String>,
    pub position: Option<NativeContextMenuPosition>,
    /// Editable fields should retain WebView's standard Cut/Copy/Paste menu.
    /// The renderer passes this from the DOM target rather than globally
    /// suppressing browser context menus or DevTools.
    #[serde(default)]
    pub editable: bool,
}

#[derive(Clone, Copy, Deserialize)]
pub struct NativeContextMenuPosition {
    pub x: f64,
    pub y: f64,
}

/// Placement for the toolbar's single native overflow button. The menu items
/// themselves come from the same registry as the application menu; renderer
/// code supplies only where the user clicked, never a list of capabilities.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCommandMenuRequest {
    pub position: Option<NativeContextMenuPosition>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenConversationWindowResult {
    pub conversation_id: String,
    pub window_label: String,
    /// `opened` means a live window was focused or created. `opening` means a
    /// duplicate request arrived while the original hidden window is loading.
    pub status: &'static str,
    pub reused: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAuxiliaryWindowResult {
    pub window_label: String,
    pub status: &'static str,
    pub reused: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCommandEvent {
    id: String,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

impl NativeCommandRouter {
    /// The `Focused` event is the authoritative routing signal for the
    /// app-wide macOS menu. On Windows it gives the same menu the expected
    /// focused-window behavior instead of accidentally broadcasting commands.
    ///
    /// `Focused(false)` intentionally retains the last Hatch window. Native
    /// menu interaction can transiently move focus away from the WebView;
    /// clearing the label there causes menu selections to become no-ops. Once
    /// another Hatch window is focused it replaces this label, and destruction
    /// always clears it.
    pub fn handle_window_event(&self, window: &Window, event: &WindowEvent) {
        match event {
            WindowEvent::Focused(true) => {
                self.set_active_window(window.label());
                let _ = self.refresh_native_menu(window.app_handle());
            }
            WindowEvent::Focused(false) => {}
            WindowEvent::Destroyed => {
                self.clear_window(window.label());
                if !self.should_preserve_conversation_manifest() {
                    let _ = persist_conversation_window_manifest(window.app_handle(), self);
                }
                let _ = self.refresh_native_menu(window.app_handle());
            }
            _ => {}
        }
    }

    pub fn set_active_window(&self, label: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.active_window_label = Some(label.to_string());
            state
                .command_state_by_window
                .entry(label.to_string())
                .or_insert_with(NativeCommandState::default);
        }
    }

    /// Keep the manifest intact while Tauri tears down windows for a normal
    /// application quit/restart. A user closing one conversation window does
    /// not set this flag, so that individual window is removed from the next
    /// manifest snapshot.
    pub fn preserve_conversation_manifest_on_exit(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.preserve_conversation_manifest_on_exit = true;
        }
    }

    fn should_preserve_conversation_manifest(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.preserve_conversation_manifest_on_exit)
            .unwrap_or(false)
    }

    fn clear_active_window_if(&self, label: &str) {
        if let Ok(mut state) = self.state.lock() {
            if state.active_window_label.as_deref() == Some(label) {
                state.active_window_label = None;
            }
        }
    }

    /// Replace the presentational command-state snapshot for a single native
    /// window. The caller cannot select a window label: Tauri injects the
    /// `WebviewWindow` into the command, so a renderer may alter only its own
    /// menu representation.
    pub fn set_window_command_state<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        window_label: &str,
        command_state: NativeCommandState,
    ) -> Result<(), String> {
        self.replace_window_command_state(window_label, command_state)?;
        self.refresh_native_menu(app)
    }

    fn replace_window_command_state(
        &self,
        window_label: &str,
        command_state: NativeCommandState,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native command router is unavailable")?;
        state
            .command_state_by_window
            .insert(window_label.to_string(), command_state);
        Ok(())
    }

    fn menu_snapshot(&self) -> Result<NativeMenuSnapshot, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Native command router is unavailable")?;
        let command_state = state
            .active_window_label
            .as_deref()
            .and_then(|label| state.command_state_by_window.get(label))
            .cloned()
            .unwrap_or_default();
        Ok(NativeMenuSnapshot {
            has_focused_window: state.active_window_label.is_some(),
            state: command_state,
        })
    }

    fn command_enabled_for_active_window(&self, command_id: &str) -> Result<bool, String> {
        Ok(self.menu_snapshot()?.command_enabled(command_id))
    }

    fn flip_checked_command_for_active_window(
        &self,
        command_id: &str,
    ) -> Result<Option<bool>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native command router is unavailable")?;
        let Some(label) = state.active_window_label.clone() else {
            return Ok(None);
        };
        let command_state = state
            .command_state_by_window
            .entry(label)
            .or_insert_with(NativeCommandState::default);
        match command_id {
            COMMAND_SIDEBAR_TOGGLE => {
                let previous = command_state.sidebar_visible;
                command_state.sidebar_visible = !previous;
                Ok(Some(previous))
            }
            COMMAND_INSPECTOR_TOGGLE => {
                let previous = command_state.inspector_visible;
                command_state.inspector_visible = !previous;
                Ok(Some(previous))
            }
            _ => Ok(None),
        }
    }

    fn restore_checked_command_for_active_window(&self, command_id: &str, previous: Option<bool>) {
        let Some(previous) = previous else {
            return;
        };
        if let Ok(mut state) = self.state.lock() {
            let Some(label) = state.active_window_label.clone() else {
                return;
            };
            let command_state = state
                .command_state_by_window
                .entry(label)
                .or_insert_with(NativeCommandState::default);
            match command_id {
                COMMAND_SIDEBAR_TOGGLE => command_state.sidebar_visible = previous,
                COMMAND_INSPECTOR_TOGGLE => command_state.inspector_visible = previous,
                _ => {}
            }
        }
    }

    fn refresh_native_menu<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let menu = build_application_menu(app, &self.menu_snapshot()?)?;
        app.set_menu(menu)
            .map(|_| ())
            .map_err(|error| format!("native_menu_install_failed: {error}"))
    }

    fn conversation_ids(&self) -> Result<Vec<String>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Native command router is unavailable")?;
        Ok(normalize_manifest_conversation_ids(
            state.conversations_by_id.keys().cloned(),
        ))
    }

    /// Remove transient context state and any reverse conversation lookup as
    /// soon as a Tauri webview is destroyed. This is intentionally separate
    /// from renderer cleanup, which might not run on a forced window close.
    pub fn clear_window(&self, label: &str) {
        if let Ok(mut state) = self.state.lock() {
            if state.active_window_label.as_deref() == Some(label) {
                state.active_window_label = None;
            }
            state.pending_context_by_window.remove(label);
            state.command_state_by_window.remove(label);
            if let Some(conversation_id) = state.conversation_by_label.remove(label) {
                let is_same_entry = state
                    .conversations_by_id
                    .get(&conversation_id)
                    .map(|entry| entry.label == label)
                    .unwrap_or(false);
                if is_same_entry {
                    state.conversations_by_id.remove(&conversation_id);
                }
            }
        }
    }

    fn reserve_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<ConversationReservation, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native window registry is unavailable")?;

        if let Some(entry) = state.conversations_by_id.get(conversation_id) {
            return Ok(ConversationReservation::Existing {
                label: entry.label.clone(),
                phase: entry.phase,
            });
        }

        let label = conversation_window_label(conversation_id);
        if let Some(existing_conversation_id) = state.conversation_by_label.get(&label) {
            return Err(format!(
                "native_window_label_collision: Conversation window label is already reserved for {existing_conversation_id}"
            ));
        }
        state
            .conversation_by_label
            .insert(label.clone(), conversation_id.to_string());
        state.conversations_by_id.insert(
            conversation_id.to_string(),
            ConversationWindowEntry {
                label: label.clone(),
                phase: ConversationWindowPhase::Creating,
            },
        );
        Ok(ConversationReservation::New { label })
    }

    fn mark_conversation_ready(&self, conversation_id: &str, label: &str) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(entry) = state.conversations_by_id.get_mut(conversation_id) {
                if entry.label == label {
                    entry.phase = ConversationWindowPhase::Ready;
                }
            }
        }
    }

    fn forget_conversation_if(&self, conversation_id: &str, label: &str) {
        if let Ok(mut state) = self.state.lock() {
            let is_same_entry = state
                .conversations_by_id
                .get(conversation_id)
                .map(|entry| entry.label == label)
                .unwrap_or(false);
            if is_same_entry {
                state.conversations_by_id.remove(conversation_id);
                state.conversation_by_label.remove(label);
            }
        }
    }

    fn active_window_label(&self) -> Result<Option<String>, String> {
        self.state
            .lock()
            .map(|state| state.active_window_label.clone())
            .map_err(|_| "Native command router is unavailable".into())
    }

    fn dispatch_to_active_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        command_id: &str,
        source: &'static str,
    ) -> Result<(), String> {
        let Some(label) = self.active_window_label()? else {
            return Err("No Hatch window is focused for this command".into());
        };
        if app.get_webview_window(&label).is_none() {
            self.clear_active_window_if(&label);
            return Err("The focused Hatch window is no longer available".into());
        }
        self.dispatch_to_window(app, &label, command_id, source, None, None)
    }

    fn dispatch_to_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        window_label: &str,
        command_id: &str,
        source: &'static str,
        context: Option<&'static str>,
        target: Option<String>,
    ) -> Result<(), String> {
        app.emit_to(
            window_label,
            NATIVE_COMMAND_EVENT,
            NativeCommandEvent {
                id: command_id.to_string(),
                source,
                context,
                target,
            },
        )
        .map_err(|error| format!("native_command_dispatch_failed: {error}"))
    }

    pub fn route_menu_event<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        menu_id: &str,
    ) -> Result<(), String> {
        if let Some(command_id) = app_menu_command(menu_id) {
            // Disabled native items normally cannot emit events, but this
            // guard also covers automation or an event arriving immediately
            // after the focus changes.
            if !self.command_enabled_for_active_window(command_id)? {
                return Ok(());
            }
            // Sidebar/Inspector are native check items. Flip the visual state
            // before sending the semantic command, then restore it if Tauri
            // cannot deliver the event to the focused renderer.
            let previous_check = self.flip_checked_command_for_active_window(command_id)?;
            let dispatch = self.dispatch_to_active_window(app, command_id, "menu");
            if dispatch.is_err() {
                self.restore_checked_command_for_active_window(command_id, previous_check);
            }
            let refresh = self.refresh_native_menu(app);
            dispatch?;
            return refresh;
        }

        let Some((command_id, expected_kind)) = context_menu_command(menu_id) else {
            // Standard Tauri/OS menu items (Undo, Cut, Quit, …) deliberately
            // retain their native behavior and are not forwarded to React.
            return Ok(());
        };
        let Some(window_label) = self.active_window_label()? else {
            return Ok(());
        };
        let pending = self.take_pending_context(&window_label, expected_kind);
        let Some(pending) = pending else {
            return Ok(());
        };
        self.dispatch_to_window(
            app,
            &window_label,
            command_id,
            "context-menu",
            Some(pending.kind.as_str()),
            pending.target,
        )
    }

    fn set_pending_context(
        &self,
        window_label: &str,
        kind: NativeContextMenuKind,
        target: Option<String>,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native command router is unavailable")?;
        state.pending_context_by_window.insert(
            window_label.to_string(),
            PendingContextMenu { kind, target },
        );
        Ok(())
    }

    fn take_pending_context(
        &self,
        window_label: &str,
        expected_kind: NativeContextMenuKind,
    ) -> Option<PendingContextMenu> {
        let Ok(mut state) = self.state.lock() else {
            return None;
        };
        let kind_matches = state
            .pending_context_by_window
            .get(window_label)
            .map(|pending| pending.kind == expected_kind)
            .unwrap_or(false);
        kind_matches
            .then(|| state.pending_context_by_window.remove(window_label))
            .flatten()
    }

    #[cfg(test)]
    fn clear_pending_context_if(
        &self,
        window_label: &str,
        expected_kind: NativeContextMenuKind,
        expected_target: &Option<String>,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let matches = state
            .pending_context_by_window
            .get(window_label)
            .map(|pending| pending.kind == expected_kind && pending.target == *expected_target)
            .unwrap_or(false);
        if matches {
            state.pending_context_by_window.remove(window_label);
        }
    }
}

fn persist_conversation_window_manifest<R: Runtime>(
    app: &AppHandle<R>,
    router: &NativeCommandRouter,
) -> Result<(), String> {
    let _guard = conversation_window_manifest_lock()
        .lock()
        .map_err(|_| "Conversation window manifest lock is unavailable")?;
    let manifest = ConversationWindowManifest {
        schema_version: CONVERSATION_WINDOW_MANIFEST_SCHEMA_VERSION,
        conversation_ids: router.conversation_ids()?,
    };
    write_conversation_window_manifest(app, &manifest)
}

/// Recreate the native conversation windows left in app-data by a previous
/// process. The manifest contains only server-issued conversation IDs; each
/// restored WebView still performs normal auth, account binding, workspace
/// revalidation and snapshot hydration before it can run anything.
pub fn restore_conversation_windows<R: Runtime>(
    app: &AppHandle<R>,
    router: &NativeCommandRouter,
) -> Result<usize, String> {
    let _guard = conversation_window_manifest_lock()
        .lock()
        .map_err(|_| "Conversation window manifest lock is unavailable")?;
    let manifest = read_conversation_window_manifest(app)?;
    drop(_guard);

    let mut restored = 0;
    for conversation_id in manifest.conversation_ids {
        if open_conversation_window_impl(app, conversation_id, router, false).is_ok() {
            restored += 1;
        }
    }
    // Rewrite after filtering invalid/stale IDs and after all builders have
    // reserved their labels. A corrupted or over-sized manifest therefore
    // cannot make every subsequent launch retry the same bad entries.
    persist_conversation_window_manifest(app, router)?;
    Ok(restored)
}

/// Install one native application menu for all Hatch windows. macOS displays
/// an app-wide menu; the router's focused-window state is updated by
/// `WindowEvent::Focused`, so a menu selection still reaches the correct
/// WebView. Windows uses the same menu and routing contract.
pub fn install_native_menu<R: Runtime>(
    app: &AppHandle<R>,
    router: &NativeCommandRouter,
) -> Result<(), String> {
    // The initial window may have received focus before the app-wide menu was
    // installed. It is the only eligible fallback; subsequent routing is
    // replaced by the latest focused Hatch window.
    if app.get_webview_window("main").is_some() {
        router.set_active_window("main");
    }
    router.refresh_native_menu(app)
}

/// Project the current renderer state into the operating-system menu for the
/// invoking window. This command intentionally receives an injected
/// `WebviewWindow` instead of a renderer-supplied label, so a background
/// renderer cannot alter another Hatch window's checkmarks or enablement.
#[tauri::command]
pub fn set_native_command_state(
    app: AppHandle,
    window: WebviewWindow,
    state: NativeCommandState,
    router: State<'_, NativeCommandRouter>,
) -> Result<NativeCommandState, String> {
    router
        .inner()
        .set_window_command_state(&app, window.label(), state.clone())?;
    Ok(state)
}

/// Show the toolbar overflow as a real native menu. The renderer cannot
/// inject arbitrary entries: this function always builds the menu from the
/// semantic command registry and applies the focused window's current
/// enablement/check state.
#[tauri::command]
pub fn show_native_command_menu(
    app: AppHandle,
    window: WebviewWindow,
    request: NativeCommandMenuRequest,
    router: State<'_, NativeCommandRouter>,
) -> Result<bool, String> {
    let position = request
        .position
        .map(validate_context_position)
        .transpose()?;
    let router = router.inner().clone();
    router.set_active_window(window.label());
    let snapshot = router.menu_snapshot()?;
    router.refresh_native_menu(&app)?;
    let menu = build_command_overflow_menu(&app, &snapshot)?;
    let native_window = window.as_ref().window();
    let result = match position {
        Some(position) => menu.popup_at(native_window, position),
        None => menu.popup(native_window),
    };
    result
        .map(|_| true)
        .map_err(|error| format!("native_command_menu_show_failed: {error}"))
}

fn open_auxiliary_window(
    app: &AppHandle,
    label: &'static str,
    title: &'static str,
    query: &'static str,
) -> Result<OpenAuxiliaryWindowResult, String> {
    if let Some(window) = app.get_webview_window(label) {
        window
            .show()
            .map_err(|error| format!("native_window_show_failed: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("native_window_focus_failed: {error}"))?;
        return Ok(OpenAuxiliaryWindowResult {
            window_label: label.to_string(),
            status: "opened",
            reused: true,
        });
    }
    let builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(PathBuf::from(format!("index.html?{query}"))),
    )
    .title(title)
    .inner_size(720.0, 560.0)
    .min_inner_size(520.0, 420.0)
    .resizable(true)
    .visible(false)
    .focused(false)
    // Product windows must not expose WebKit's browser/devtools context menu.
    // The browser/Vite preview remains the development inspection surface.
    .devtools(false)
    .on_page_load(move |window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Visible);
    builder
        .build()
        .map_err(|error| format!("native_window_create_failed: {error}"))?;
    Ok(OpenAuxiliaryWindowResult {
        window_label: label.to_string(),
        status: "opening",
        reused: false,
    })
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<OpenAuxiliaryWindowResult, String> {
    open_auxiliary_window(&app, "settings", "Hatch Settings", "settings=1")
}

#[tauri::command]
pub fn open_about_window(app: AppHandle) -> Result<OpenAuxiliaryWindowResult, String> {
    open_auxiliary_window(&app, "about", "About Hatch", "about=1")
}

/// Opens a conversation in a distinct Tauri window. The command is async even
/// though construction is synchronous because Tauri documents async commands
/// as the safe cross-platform path for Webview2 window creation.
#[tauri::command]
pub async fn open_conversation_window(
    app: AppHandle,
    conversation_id: String,
    router: State<'_, NativeCommandRouter>,
) -> Result<OpenConversationWindowResult, String> {
    let conversation_id = validate_conversation_id(&conversation_id)?;
    open_conversation_window_impl(&app, conversation_id, router.inner(), true)
}

fn open_conversation_window_impl<R: Runtime>(
    app: &AppHandle<R>,
    conversation_id: String,
    router: &NativeCommandRouter,
    persist_manifest: bool,
) -> Result<OpenConversationWindowResult, String> {
    // A previous ready entry can become stale if a platform destroys a window
    // before its Destroyed event reaches our registry. Recover once instead of
    // returning a dead label; a Creating entry remains reserved to prevent two
    // simultaneous commands from building the same native window.
    for _ in 0..2 {
        match router.reserve_conversation(&conversation_id)? {
            ConversationReservation::Existing { label, phase } => {
                if let Some(window) = app.get_webview_window(&label) {
                    if phase == ConversationWindowPhase::Ready {
                        window
                            .show()
                            .map_err(|error| format!("native_window_show_failed: {error}"))?;
                        window
                            .set_focus()
                            .map_err(|error| format!("native_window_focus_failed: {error}"))?;
                        router.set_active_window(&label);
                        return Ok(OpenConversationWindowResult {
                            conversation_id,
                            window_label: label,
                            status: "opened",
                            reused: true,
                        });
                    }

                    // The original hidden window has not finished loading.
                    // Do not reveal a blank view simply because a duplicate
                    // request arrived; PageLoadEvent::Finished owns showing it.
                    return Ok(OpenConversationWindowResult {
                        conversation_id,
                        window_label: label,
                        status: "opening",
                        reused: true,
                    });
                }

                if phase == ConversationWindowPhase::Creating {
                    return Ok(OpenConversationWindowResult {
                        conversation_id,
                        window_label: label,
                        status: "opening",
                        reused: true,
                    });
                }
                router.forget_conversation_if(&conversation_id, &label);
            }
            ConversationReservation::New { label } => {
                let page_router = router.clone();
                let page_conversation_id = conversation_id.clone();
                let page_label = label.clone();
                let builder = WebviewWindowBuilder::new(
                    app,
                    label.clone(),
                    WebviewUrl::App(conversation_window_path(&conversation_id)),
                )
                .title("Hatch — Conversation")
                .inner_size(1180.0, 780.0)
                .min_inner_size(640.0, 600.0)
                .resizable(true)
                .visible(false)
                .focused(false)
                // Keep secondary product windows aligned with the main window:
                // no browser Inspect Element affordance in ad-hoc/debug UAT.
                .devtools(false)
                .on_page_load(move |window, payload| {
                    if payload.event() != PageLoadEvent::Finished {
                        return;
                    }
                    page_router.mark_conversation_ready(&page_conversation_id, &page_label);
                    // The window begins hidden so callers never see a blank
                    // webview. A page-load completion is the visibility gate.
                    let _ = window.show();
                    let _ = window.set_focus();
                    page_router.set_active_window(&page_label);
                });
                #[cfg(target_os = "macos")]
                let builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);

                if let Err(error) = builder.build() {
                    router.forget_conversation_if(&conversation_id, &label);
                    return Err(format!("native_window_create_failed: {error}"));
                }

                if persist_manifest {
                    // A manifest write failure must not make an already
                    // visible conversation window unusable. The frame/context
                    // settings path is likewise best effort; a later launch
                    // simply starts with the durable main window.
                    let _ = persist_conversation_window_manifest(app, router);
                }

                return Ok(OpenConversationWindowResult {
                    conversation_id,
                    window_label: label,
                    status: "opened",
                    reused: false,
                });
            }
        }
    }

    Err("native_window_registry_unavailable: Could not reserve a conversation window".into())
}

/// Opt-in context-menu bridge for non-editable product surfaces. Text inputs
/// preserve the standard operating-system editing menu; product windows have
/// WebKit devtools disabled, while the browser/Vite preview remains the
/// development inspection surface.
#[tauri::command]
pub fn show_native_context_menu(
    app: AppHandle,
    window: WebviewWindow,
    request: NativeContextMenuRequest,
    router: State<'_, NativeCommandRouter>,
) -> Result<bool, String> {
    if request.editable {
        return Ok(false);
    }
    let kind = NativeContextMenuKind::parse(&request.kind)?;
    let target = request
        .target
        .as_deref()
        .map(validate_context_target)
        .transpose()?;
    if kind.requires_target() && target.is_none() {
        return Err("native_context_menu_invalid: This context menu requires a target".into());
    }
    let position = request
        .position
        .map(validate_context_position)
        .transpose()?;
    let router = router.inner().clone();
    // The popup belongs to this WebviewWindow even when a platform does not
    // synchronously emit a Focused event for a right click. That prevents a
    // context action from being delivered to a different Hatch conversation.
    router.set_active_window(window.label());
    router.refresh_native_menu(&app)?;
    router.set_pending_context(window.label(), kind, target.clone())?;
    let menu = build_context_menu(&app, kind)?;
    let native_window = window.as_ref().window();
    let result = match position {
        Some(position) => menu.popup_at(native_window, position),
        None => menu.popup(native_window),
    };
    // Do not clear the pending record here. On macOS the native popup returns
    // before the user chooses an item; `route_menu_event` consumes the record
    // later. A canceled popup is harmless because the next popup for this
    // window replaces it, and window destruction clears it unconditionally.
    result
        .map(|_| true)
        .map_err(|error| format!("native_context_menu_show_failed: {error}"))
}

fn build_application_menu<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &NativeMenuSnapshot,
) -> Result<Menu<R>, String> {
    let new_conversation = command_menu_item(app, snapshot, COMMAND_CONVERSATION_NEW)?;
    let new_conversation_window =
        command_menu_item(app, snapshot, COMMAND_CONVERSATION_NEW_WINDOW)?;
    let choose_workspace = command_menu_item(app, snapshot, COMMAND_WORKSPACE_CHOOSE)?;
    let settings = command_menu_item(app, snapshot, COMMAND_SETTINGS_OPEN)?;
    let about = command_menu_item(app, snapshot, COMMAND_ABOUT_OPEN)?;
    let toggle_sidebar = checked_command_menu_item(app, snapshot, COMMAND_SIDEBAR_TOGGLE)?;
    let toggle_inspector = checked_command_menu_item(app, snapshot, COMMAND_INSPECTOR_TOGGLE)?;
    let zoom_in = command_menu_item(app, snapshot, COMMAND_VIEW_ZOOM_IN)?;
    let zoom_out = command_menu_item(app, snapshot, COMMAND_VIEW_ZOOM_OUT)?;
    let zoom_reset = command_menu_item(app, snapshot, COMMAND_VIEW_ZOOM_RESET)?;
    let stop_run = command_menu_item(app, snapshot, COMMAND_RUN_STOP)?;

    #[cfg(target_os = "macos")]
    let application = SubmenuBuilder::new(app, "Hatch")
        .item(&about)
        .separator()
        .services()
        .separator()
        .item(&settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()
        .map_err(|error| format!("native_menu_build_failed: {error}"))?;
    #[cfg(not(target_os = "macos"))]
    let application = SubmenuBuilder::new(app, "Hatch")
        .item(&about)
        .separator()
        .item(&settings)
        .separator()
        .quit()
        .build()
        .map_err(|error| format!("native_menu_build_failed: {error}"))?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&new_conversation)
        .item(&new_conversation_window)
        .separator()
        .item(&choose_workspace)
        .build()
        .map_err(|error| format!("native_menu_build_failed: {error}"))?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()
        .map_err(|error| format!("native_menu_build_failed: {error}"))?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .item(&toggle_inspector)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()
        .map_err(|error| format!("native_menu_build_failed: {error}"))?;
    let run = SubmenuBuilder::new(app, "Run")
        .item(&stop_run)
        .build()
        .map_err(|error| format!("native_menu_build_failed: {error}"))?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()
        .map_err(|error| format!("native_menu_build_failed: {error}"))?;

    MenuBuilder::new(app)
        .item(&application)
        .item(&file)
        .item(&edit)
        .item(&view)
        .item(&run)
        .item(&window)
        .build()
        .map_err(|error| format!("native_menu_build_failed: {error}"))
}

fn command_menu_item<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &NativeMenuSnapshot,
    command_id: &str,
) -> Result<MenuItem<R>, String> {
    let definition = application_command_definition(command_id)
        .ok_or_else(|| format!("native_menu_registry_invalid: Unknown command {command_id}"))?;
    if definition.checkable {
        return Err(format!(
            "native_menu_registry_invalid: {} requires a check menu item",
            definition.id
        ));
    }
    let mut builder = MenuItemBuilder::with_id(definition.id, definition.label)
        .enabled(snapshot.command_enabled(definition.id));
    if let Some(accelerator) = definition.accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder
        .build(app)
        .map_err(|error| format!("native_menu_item_build_failed: {error}"))
}

fn checked_command_menu_item<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &NativeMenuSnapshot,
    command_id: &str,
) -> Result<CheckMenuItem<R>, String> {
    let definition = application_command_definition(command_id)
        .ok_or_else(|| format!("native_menu_registry_invalid: Unknown command {command_id}"))?;
    if !definition.checkable {
        return Err(format!(
            "native_menu_registry_invalid: {} requires a normal menu item",
            definition.id
        ));
    }
    let mut builder =
        CheckMenuItemBuilder::with_id(definition.id, checked_command_label(definition, snapshot))
            .enabled(snapshot.command_enabled(definition.id))
            .checked(snapshot.command_checked(definition.id).unwrap_or(false));
    if let Some(accelerator) = definition.accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder
        .build(app)
        .map_err(|error| format!("native_menu_item_build_failed: {error}"))
}

fn checked_command_label<'a>(
    definition: &'a CommandDefinition,
    snapshot: &NativeMenuSnapshot,
) -> &'a str {
    match definition.id {
        COMMAND_SIDEBAR_TOGGLE => {
            if snapshot
                .command_checked(COMMAND_SIDEBAR_TOGGLE)
                .unwrap_or(false)
            {
                "Hide Sidebar"
            } else {
                "Show Sidebar"
            }
        }
        COMMAND_INSPECTOR_TOGGLE => {
            if snapshot
                .command_checked(COMMAND_INSPECTOR_TOGGLE)
                .unwrap_or(false)
            {
                "Hide Inspector"
            } else {
                "Show Inspector"
            }
        }
        _ => definition.label,
    }
}

fn build_command_overflow_menu<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &NativeMenuSnapshot,
) -> Result<Menu<R>, String> {
    // This is deliberately a compact projection, not a second toolbar model.
    // Every actionable item is constructed from APPLICATION_COMMANDS above,
    // so app-menu labels, accelerators, enablement and check state cannot
    // silently diverge from the toolbar overflow.
    let new_conversation = command_menu_item(app, snapshot, COMMAND_CONVERSATION_NEW)?;
    let new_window = command_menu_item(app, snapshot, COMMAND_CONVERSATION_NEW_WINDOW)?;
    let choose_workspace = command_menu_item(app, snapshot, COMMAND_WORKSPACE_CHOOSE)?;
    let toggle_sidebar = checked_command_menu_item(app, snapshot, COMMAND_SIDEBAR_TOGGLE)?;
    let toggle_inspector = checked_command_menu_item(app, snapshot, COMMAND_INSPECTOR_TOGGLE)?;
    let zoom_in = command_menu_item(app, snapshot, COMMAND_VIEW_ZOOM_IN)?;
    let zoom_out = command_menu_item(app, snapshot, COMMAND_VIEW_ZOOM_OUT)?;
    let zoom_reset = command_menu_item(app, snapshot, COMMAND_VIEW_ZOOM_RESET)?;
    let stop_run = command_menu_item(app, snapshot, COMMAND_RUN_STOP)?;
    let settings = command_menu_item(app, snapshot, COMMAND_SETTINGS_OPEN)?;

    MenuBuilder::new(app)
        .item(&new_conversation)
        .item(&new_window)
        .item(&choose_workspace)
        .separator()
        .item(&toggle_sidebar)
        .item(&toggle_inspector)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&stop_run)
        .separator()
        .item(&settings)
        .build()
        .map_err(|error| format!("native_command_menu_build_failed: {error}"))
}

fn build_context_menu<R: Runtime>(
    app: &AppHandle<R>,
    kind: NativeContextMenuKind,
) -> Result<Menu<R>, String> {
    let items: &[(&str, &str)] = match kind {
        NativeContextMenuKind::Conversation => &[
            (CONTEXT_CONVERSATION_RENAME, "Rename Conversation"),
            (CONTEXT_CONVERSATION_OPEN_WINDOW, "Open in New Window"),
            (CONTEXT_CONVERSATION_ARCHIVE, "Archive Conversation"),
        ],
        NativeContextMenuKind::Artifact => &[
            (CONTEXT_ARTIFACT_REVEAL, artifact_reveal_menu_label()),
            (CONTEXT_ARTIFACT_QUICK_LOOK, artifact_open_menu_label()),
            (CONTEXT_ARTIFACT_COPY_PATH, "Copy Path"),
        ],
        NativeContextMenuKind::ToolResult => &[(CONTEXT_TOOL_COPY_OUTPUT, "Copy Output")],
    };
    let mut builder = MenuBuilder::new(app);
    for (id, title) in items {
        let item = MenuItemBuilder::with_id(*id, *title)
            .build(app)
            .map_err(|error| format!("native_context_menu_build_failed: {error}"))?;
        builder = builder.item(&item);
    }
    builder
        .build()
        .map_err(|error| format!("native_context_menu_build_failed: {error}"))
}

fn artifact_reveal_menu_label() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Reveal in Finder"
    }
    #[cfg(target_os = "windows")]
    {
        "Reveal in Explorer"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "Reveal in File Manager"
    }
}

fn artifact_open_menu_label() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Quick Look"
    }
    #[cfg(target_os = "windows")]
    {
        "Open"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "Open"
    }
}

fn app_menu_command(menu_id: &str) -> Option<&'static str> {
    application_command_definition(menu_id).map(|definition| definition.id)
}

fn context_menu_command(menu_id: &str) -> Option<(&'static str, NativeContextMenuKind)> {
    match menu_id {
        CONTEXT_CONVERSATION_RENAME => Some((
            COMMAND_CONVERSATION_RENAME,
            NativeContextMenuKind::Conversation,
        )),
        CONTEXT_CONVERSATION_OPEN_WINDOW => Some((
            COMMAND_CONVERSATION_OPEN_WINDOW,
            NativeContextMenuKind::Conversation,
        )),
        CONTEXT_CONVERSATION_ARCHIVE => Some((
            COMMAND_CONVERSATION_ARCHIVE,
            NativeContextMenuKind::Conversation,
        )),
        CONTEXT_ARTIFACT_REVEAL => Some((COMMAND_ARTIFACT_REVEAL, NativeContextMenuKind::Artifact)),
        CONTEXT_ARTIFACT_QUICK_LOOK => {
            Some((COMMAND_ARTIFACT_QUICK_LOOK, NativeContextMenuKind::Artifact))
        }
        CONTEXT_ARTIFACT_COPY_PATH => {
            Some((COMMAND_ARTIFACT_COPY_PATH, NativeContextMenuKind::Artifact))
        }
        CONTEXT_TOOL_COPY_OUTPUT => {
            Some((COMMAND_TOOL_COPY_OUTPUT, NativeContextMenuKind::ToolResult))
        }
        _ => None,
    }
}

fn validate_conversation_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_CONVERSATION_ID_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(
            "conversation_id_invalid: A bounded non-control conversation id is required".into(),
        );
    }
    Ok(value.to_string())
}

fn validate_context_target(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_CONTEXT_TARGET_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(
            "native_context_menu_invalid: Context target must be bounded non-control text".into(),
        );
    }
    Ok(value.to_string())
}

fn validate_context_position(
    position: NativeContextMenuPosition,
) -> Result<LogicalPosition<f64>, String> {
    let coordinates_are_sane = position.x.is_finite()
        && position.y.is_finite()
        && position.x.abs() <= 100_000.0
        && position.y.abs() <= 100_000.0;
    if !coordinates_are_sane {
        return Err("native_context_menu_invalid: Context menu position is invalid".into());
    }
    Ok(LogicalPosition::new(position.x, position.y))
}

fn conversation_window_path(conversation_id: &str) -> PathBuf {
    let encoded =
        url::form_urlencoded::byte_serialize(conversation_id.as_bytes()).collect::<String>();
    PathBuf::from(format!("index.html?conversation_id={encoded}"))
}

/// Tauri labels must be portable across macOS and Windows. Keep a short,
/// human-inspectable slug and append a deterministic hash so punctuation,
/// Unicode, and long server IDs cannot make a dangerous or colliding label.
fn conversation_window_label(conversation_id: &str) -> String {
    let mut slug = String::with_capacity(32);
    let mut previous_dash = false;
    for character in conversation_id.chars() {
        if slug.len() >= 32 {
            break;
        }
        let mapped = if character.is_ascii_alphanumeric() {
            previous_dash = false;
            character.to_ascii_lowercase()
        } else if !previous_dash {
            previous_dash = true;
            '-'
        } else {
            continue;
        };
        slug.push(mapped);
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() {
        "conversation"
    } else {
        slug
    };
    format!(
        "conversation-{slug}-{:016x}",
        stable_hash64(conversation_id.as_bytes())
    )
}

fn stable_hash64(bytes: &[u8]) -> u64 {
    // FNV-1a is used only for a stable, readable label suffix. It is not a
    // security boundary; the registry retains the full conversation id and
    // fails visibly should an astronomically unlikely collision occur.
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::{
        app_menu_command, application_command_definition, artifact_open_menu_label,
        artifact_reveal_menu_label, checked_command_label, context_menu_command,
        conversation_window_label, normalize_manifest_conversation_ids, validate_context_position,
        validate_context_target, validate_conversation_id, ConversationReservation,
        ConversationWindowPhase, NativeCommandRouter, NativeCommandState, NativeContextMenuKind,
        NativeContextMenuPosition, NativeMenuSnapshot, COMMAND_ABOUT_OPEN,
        COMMAND_CONVERSATION_NEW, COMMAND_CONVERSATION_NEW_WINDOW, COMMAND_INSPECTOR_TOGGLE,
        COMMAND_RUN_STOP, COMMAND_SETTINGS_OPEN, COMMAND_SIDEBAR_TOGGLE, COMMAND_VIEW_ZOOM_IN,
        COMMAND_VIEW_ZOOM_OUT, COMMAND_VIEW_ZOOM_RESET, COMMAND_WORKSPACE_CHOOSE,
        MAX_RESTORED_CONVERSATION_WINDOWS,
    };

    #[test]
    fn conversation_window_labels_are_stable_portable_and_distinct() {
        let first = conversation_window_label("Creator Agent / 数据库: 2026-08-11");
        let second = conversation_window_label("Creator Agent / 数据库: 2026-08-11");
        let other = conversation_window_label("Creator Agent / 数据库: 2026-08-12");
        assert_eq!(first, second);
        assert_ne!(first, other);
        assert!(first.starts_with("conversation-"));
        assert!(first.chars().all(|character| character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || character == '-'));
        assert!(first.len() <= 64);
    }

    #[test]
    fn conversation_window_manifest_normalizes_ids_and_bounds_restore_count() {
        let mut ids = vec![
            "conv-b".to_string(),
            "conv-a".to_string(),
            "conv-a".to_string(),
            "bad\nvalue".to_string(),
            "".to_string(),
        ];
        ids.extend(
            (0..(MAX_RESTORED_CONVERSATION_WINDOWS + 4)).map(|index| format!("conv-{index:02}")),
        );

        let normalized_duplicates = normalize_manifest_conversation_ids(vec![
            "conv-a".to_string(),
            "conv-a".to_string(),
            "conv-b".to_string(),
        ]);
        let normalized = normalize_manifest_conversation_ids(ids);
        assert!(normalized.len() <= MAX_RESTORED_CONVERSATION_WINDOWS);
        assert!(normalized.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(
            normalized_duplicates
                .iter()
                .filter(|id| *id == "conv-a")
                .count(),
            1
        );
        assert!(!normalized.iter().any(|id| id.contains('\n')));
        assert!(!normalized.iter().any(String::is_empty));
    }

    #[test]
    fn conversation_registry_reserves_once_and_releases_on_window_close() {
        let router = NativeCommandRouter::default();
        let label = match router.reserve_conversation("conversation-1").unwrap() {
            ConversationReservation::New { label } => label,
            reservation => panic!("expected a new reservation, got {reservation:?}"),
        };
        assert!(matches!(
            router.reserve_conversation("conversation-1").unwrap(),
            ConversationReservation::Existing { .. }
        ));
        router.clear_window(&label);
        assert!(matches!(
            router.reserve_conversation("conversation-1").unwrap(),
            ConversationReservation::New { .. }
        ));
    }

    #[test]
    fn conversation_registry_keeps_three_parallel_windows_independent() {
        let router = NativeCommandRouter::default();
        let mut labels = Vec::new();
        for conversation_id in ["conversation-a", "conversation-b", "conversation-c"] {
            let label = match router.reserve_conversation(conversation_id).unwrap() {
                ConversationReservation::New { label } => label,
                reservation => panic!("expected a new reservation, got {reservation:?}"),
            };
            router.mark_conversation_ready(conversation_id, &label);
            labels.push(label);
        }
        assert_eq!(
            labels
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );

        for conversation_id in ["conversation-a", "conversation-b", "conversation-c"] {
            assert!(matches!(
                router.reserve_conversation(conversation_id).unwrap(),
                ConversationReservation::Existing {
                    phase: ConversationWindowPhase::Ready,
                    ..
                }
            ));
        }

        // Closing the middle window releases only its own reverse lookup;
        // the other two remain reusable and keep their stable labels.
        router.clear_window(&labels[1]);
        assert!(matches!(
            router.reserve_conversation("conversation-a").unwrap(),
            ConversationReservation::Existing { .. }
        ));
        assert!(matches!(
            router.reserve_conversation("conversation-c").unwrap(),
            ConversationReservation::Existing { .. }
        ));
        assert!(matches!(
            router.reserve_conversation("conversation-b").unwrap(),
            ConversationReservation::New { .. }
        ));
    }

    #[test]
    fn command_ids_stay_semantic_and_context_bound() {
        for command_id in [
            COMMAND_CONVERSATION_NEW,
            COMMAND_CONVERSATION_NEW_WINDOW,
            COMMAND_WORKSPACE_CHOOSE,
            COMMAND_SETTINGS_OPEN,
            COMMAND_ABOUT_OPEN,
            COMMAND_SIDEBAR_TOGGLE,
            COMMAND_INSPECTOR_TOGGLE,
            COMMAND_VIEW_ZOOM_IN,
            COMMAND_VIEW_ZOOM_OUT,
            COMMAND_VIEW_ZOOM_RESET,
            COMMAND_RUN_STOP,
        ] {
            assert_eq!(app_menu_command(command_id), Some(command_id));
            assert!(application_command_definition(command_id).is_some());
        }
        assert_eq!(
            context_menu_command("hatch.context.conversation.open-window"),
            Some((
                "conversation.openWindow",
                NativeContextMenuKind::Conversation
            ))
        );
        assert_eq!(
            context_menu_command("hatch.context.artifact.reveal"),
            Some(("artifact.reveal", NativeContextMenuKind::Artifact))
        );
        assert_eq!(
            context_menu_command("hatch.context.artifact.quick-look"),
            Some(("artifact.quickLook", NativeContextMenuKind::Artifact))
        );
        assert_eq!(context_menu_command("unexpected"), None);
    }

    #[test]
    fn pane_menu_labels_follow_the_native_show_hide_convention() {
        let definition = application_command_definition(COMMAND_SIDEBAR_TOGGLE).unwrap();
        let open = NativeMenuSnapshot {
            has_focused_window: true,
            state: NativeCommandState::default(),
        };
        assert_eq!(checked_command_label(definition, &open), "Hide Sidebar");

        let closed = NativeMenuSnapshot {
            has_focused_window: true,
            state: NativeCommandState {
                sidebar_visible: false,
                inspector_visible: false,
                ..NativeCommandState::default()
            },
        };
        assert_eq!(checked_command_label(definition, &closed), "Show Sidebar");
        let inspector = application_command_definition(COMMAND_INSPECTOR_TOGGLE).unwrap();
        assert_eq!(checked_command_label(inspector, &closed), "Show Inspector");
    }

    #[test]
    fn artifact_reveal_uses_the_platform_file_browser_name() {
        #[cfg(target_os = "macos")]
        assert_eq!(artifact_reveal_menu_label(), "Reveal in Finder");
        #[cfg(target_os = "windows")]
        assert_eq!(artifact_reveal_menu_label(), "Reveal in Explorer");
        #[cfg(all(unix, not(target_os = "macos")))]
        assert_eq!(artifact_reveal_menu_label(), "Reveal in File Manager");
    }

    #[test]
    fn artifact_open_uses_the_platform_preview_name() {
        #[cfg(target_os = "macos")]
        assert_eq!(artifact_open_menu_label(), "Quick Look");
        #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
        assert_eq!(artifact_open_menu_label(), "Open");
    }

    #[test]
    fn focused_window_menu_state_is_scoped_and_checked_items_flip() {
        let router = NativeCommandRouter::default();
        assert!(!router
            .menu_snapshot()
            .unwrap()
            .command_enabled(COMMAND_CONVERSATION_NEW));

        router.set_active_window("conversation-a");
        router
            .replace_window_command_state(
                "conversation-a",
                NativeCommandState {
                    new_conversation_enabled: false,
                    new_window_enabled: true,
                    workspace_enabled: false,
                    settings_enabled: true,
                    run_stop_enabled: true,
                    sidebar_visible: true,
                    inspector_visible: false,
                },
            )
            .unwrap();
        let snapshot = router.menu_snapshot().unwrap();
        assert!(!snapshot.command_enabled(COMMAND_CONVERSATION_NEW));
        assert!(snapshot.command_enabled(COMMAND_CONVERSATION_NEW_WINDOW));
        assert!(!snapshot.command_enabled(COMMAND_WORKSPACE_CHOOSE));
        assert!(snapshot.command_enabled(COMMAND_SETTINGS_OPEN));
        assert!(snapshot.command_enabled(COMMAND_RUN_STOP));
        assert!(snapshot.command_enabled(COMMAND_VIEW_ZOOM_IN));
        assert!(snapshot.command_enabled(COMMAND_VIEW_ZOOM_OUT));
        assert!(snapshot.command_enabled(COMMAND_VIEW_ZOOM_RESET));
        assert_eq!(snapshot.command_checked(COMMAND_SIDEBAR_TOGGLE), Some(true));
        assert_eq!(
            snapshot.command_checked(COMMAND_INSPECTOR_TOGGLE),
            Some(false)
        );

        assert_eq!(
            router
                .flip_checked_command_for_active_window(COMMAND_SIDEBAR_TOGGLE)
                .unwrap(),
            Some(true)
        );
        assert_eq!(
            router
                .menu_snapshot()
                .unwrap()
                .command_checked(COMMAND_SIDEBAR_TOGGLE),
            Some(false)
        );

        router.set_active_window("conversation-b");
        assert!(router
            .menu_snapshot()
            .unwrap()
            .command_enabled(COMMAND_CONVERSATION_NEW));
        // Closing a background window must not erase foreground enablement.
        router.clear_window("conversation-a");
        assert!(router
            .menu_snapshot()
            .unwrap()
            .command_enabled(COMMAND_CONVERSATION_NEW));
        router.clear_window("conversation-b");
        assert!(!router
            .menu_snapshot()
            .unwrap()
            .command_enabled(COMMAND_CONVERSATION_NEW));
    }

    #[test]
    fn command_state_is_a_complete_non_authority_snapshot() {
        let state: NativeCommandState = serde_json::from_value(serde_json::json!({
            "newConversationEnabled": true,
            "newWindowEnabled": false,
            "workspaceEnabled": true,
            "settingsEnabled": true,
            "runStopEnabled": false,
            "sidebarVisible": false,
            "inspectorVisible": true
        }))
        .expect("the documented renderer payload must deserialize");
        assert!(!state.new_window_enabled);
        assert!(!state.sidebar_visible);
        assert!(
            serde_json::from_value::<NativeCommandState>(serde_json::json!({
                "newConversationEnabled": true,
                "newWindowEnabled": true,
                "workspaceEnabled": true,
                "settingsEnabled": true,
                "runStopEnabled": false,
                "sidebarVisible": true,
                "inspectorVisible": true,
                "workspaceGrantId": "must-not-be-accepted-here"
            }))
            .is_err()
        );
    }

    #[test]
    fn pending_context_menus_never_cross_window_or_kind_boundaries() {
        let router = NativeCommandRouter::default();
        router
            .set_pending_context(
                "conversation-a",
                NativeContextMenuKind::Conversation,
                Some("opaque-conversation-token".into()),
            )
            .unwrap();
        assert!(router
            .take_pending_context("conversation-b", NativeContextMenuKind::Conversation)
            .is_none());
        assert!(router
            .take_pending_context("conversation-a", NativeContextMenuKind::Artifact)
            .is_none());
        let pending = router
            .take_pending_context("conversation-a", NativeContextMenuKind::Conversation)
            .expect("matching popup selection must receive its own pending target");
        assert_eq!(pending.target.as_deref(), Some("opaque-conversation-token"));

        router
            .set_pending_context(
                "conversation-a",
                NativeContextMenuKind::Artifact,
                Some("opaque-artifact-token".into()),
            )
            .unwrap();
        router.clear_pending_context_if(
            "conversation-a",
            NativeContextMenuKind::Artifact,
            &Some("different-token".into()),
        );
        assert!(router
            .take_pending_context("conversation-a", NativeContextMenuKind::Artifact)
            .is_some());
    }

    #[test]
    fn input_validation_rejects_control_text_and_invalid_positions() {
        assert!(validate_conversation_id(" conversation-1 ").is_ok());
        assert!(validate_conversation_id("bad\nconversation").is_err());
        assert!(validate_context_target("artifact-token").is_ok());
        assert!(validate_context_target("artifact\u{0000}token").is_err());
        assert!(validate_context_position(NativeContextMenuPosition { x: 12.0, y: 48.0 }).is_ok());
        assert!(validate_context_position(NativeContextMenuPosition {
            x: f64::NAN,
            y: 0.0
        })
        .is_err());
    }
}
