//! Native desktop command routing and multi-window coordination.
//!
//! The renderer owns the product action behind a command; this module owns
//! the native entry points that make those actions feel like desktop actions:
//! the application menu bar and the lifecycle of a secondary conversation
//! window. Keeping the wire format deliberately semantic means the same
//! command can originate from a menu or a keyboard accelerator without
//! teaching Rust about React component state. Context menus are built by the
//! renderer with `@tauri-apps/api/menu`.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{
        AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem,
        MenuItemBuilder, SubmenuBuilder,
    },
    webview::PageLoadEvent,
    AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    Window, WindowEvent,
};

use crate::window_shell::{prepare_window, reveal_if_still_hidden, MAIN_WINDOW_LABEL};

/// Renderer-side listeners subscribe to exactly one event regardless of where
/// a command originated. Tauri permits `:` and `/` in event names.
pub const NATIVE_COMMAND_EVENT: &str = "hatch://command";

pub const COMMAND_CONVERSATION_NEW: &str = "conversation.new";
pub const COMMAND_CONVERSATION_NEW_WINDOW: &str = "conversation.newWindow";
pub const COMMAND_CONVERSATION_SEARCH: &str = "conversation.search";
pub const COMMAND_EDIT_FIND: &str = "edit.find";
pub const COMMAND_CONVERSATION_RENAME: &str = "conversation.rename";
pub const COMMAND_CONVERSATION_ARCHIVE: &str = "conversation.archive";
pub const COMMAND_CONVERSATION_OPEN_WINDOW: &str = "conversation.openWindow";
pub const COMMAND_CONVERSATION_PREVIOUS: &str = "conversation.previous";
pub const COMMAND_CONVERSATION_NEXT: &str = "conversation.next";
pub const COMMAND_SIDEBAR_TOGGLE: &str = "sidebar.toggle";
pub const COMMAND_RUN_STOP: &str = "run.stop";
pub const COMMAND_WORKSPACE_CHOOSE: &str = "workspace.choose";
pub const COMMAND_SETTINGS_OPEN: &str = "settings.open";
pub const COMMAND_VIEW_ZOOM_IN: &str = "view.zoomIn";
pub const COMMAND_VIEW_ZOOM_OUT: &str = "view.zoomOut";
pub const COMMAND_VIEW_ZOOM_RESET: &str = "view.zoomReset";

const MAX_MENU_AGENTS: usize = 9;
const MAX_MENU_AGENT_NAME_CHARS: usize = 120;
/// `agent.select.N` selects the N-th Agent of the focused window's sidebar.
const COMMAND_AGENT_SELECT: [&str; MAX_MENU_AGENTS] = [
    "agent.select.1",
    "agent.select.2",
    "agent.select.3",
    "agent.select.4",
    "agent.select.5",
    "agent.select.6",
    "agent.select.7",
    "agent.select.8",
    "agent.select.9",
];
const AGENT_SELECT_ACCELERATORS: [&str; MAX_MENU_AGENTS] = [
    "CmdOrCtrl+1",
    "CmdOrCtrl+2",
    "CmdOrCtrl+3",
    "CmdOrCtrl+4",
    "CmdOrCtrl+5",
    "CmdOrCtrl+6",
    "CmdOrCtrl+7",
    "CmdOrCtrl+8",
    "CmdOrCtrl+9",
];
const SIDEBAR_ACCELERATOR: &str = if cfg!(target_os = "macos") {
    "Cmd+Ctrl+S"
} else {
    "Ctrl+Shift+S"
};
const MENU_WINDOW_FOCUS_PREFIX: &str = "window.focus:";
const MENU_HELP_OPEN: &str = "help.open";
const HELP_PATH: &str = "/account/help";

const MAX_CONVERSATION_ID_BYTES: usize = 256;
const CONVERSATION_WINDOW_MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_RESTORED_CONVERSATION_WINDOWS: usize = 16;

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

fn read_conversation_window_manifest<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<ConversationWindowManifest, String> {
    let state = crate::desktop_state::read(app)?;
    Ok(ConversationWindowManifest {
        schema_version: CONVERSATION_WINDOW_MANIFEST_SCHEMA_VERSION,
        conversation_ids: normalize_manifest_conversation_ids(state.open_conversation_ids),
    })
}

fn write_conversation_window_manifest<R: Runtime>(
    app: &AppHandle<R>,
    manifest: &ConversationWindowManifest,
) -> Result<(), String> {
    let conversation_ids = normalize_manifest_conversation_ids(manifest.conversation_ids.clone());
    crate::desktop_state::update(app, |state| {
        state.open_conversation_ids = conversation_ids;
        Ok(())
    })
}

/// The renderer projects only presentational command state into this value.
/// It is deliberately window-scoped and never grants access to a workspace,
/// tool, account, or conversation. The native menu uses it only for disabled
/// items, checkmarks and the Agent shortcut labels; the renderer remains
/// responsible for every action.
///
/// `set_native_command_state` accepts a complete snapshot instead of partial
/// patches, so a renderer that reloads mid-transition cannot leave stale
/// enablement behind.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCommandState {
    pub new_conversation_enabled: bool,
    pub new_window_enabled: bool,
    pub workspace_enabled: bool,
    pub run_stop_enabled: bool,
    pub sidebar_visible: bool,
    pub conversation_enabled: bool,
    pub agents: Vec<String>,
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
            // Stop and conversation actions must never look actionable until
            // the renderer reports them for this specific window.
            run_stop_enabled: false,
            sidebar_visible: true,
            conversation_enabled: false,
            agents: Vec::new(),
        }
    }
}

impl NativeCommandState {
    fn validate(&self) -> Result<(), String> {
        let valid_agents = self.agents.len() <= MAX_MENU_AGENTS
            && self.agents.iter().all(|name| {
                let count = name.chars().count();
                count > 0
                    && count <= MAX_MENU_AGENT_NAME_CHARS
                    && !name.chars().any(char::is_control)
            });
        if valid_agents {
            Ok(())
        } else {
            Err(format!(
                "native_command_state_invalid: at most {MAX_MENU_AGENTS} bounded Agent names are allowed"
            ))
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeMenuSnapshot {
    has_focused_window: bool,
    active_window_label: Option<String>,
    state: NativeCommandState,
}

impl NativeMenuSnapshot {
    fn command_enabled(&self, command_id: &str) -> bool {
        if !self.has_focused_window {
            return false;
        }
        if let Some(index) = COMMAND_AGENT_SELECT.iter().position(|id| *id == command_id) {
            return index < self.state.agents.len();
        }
        match command_id {
            COMMAND_CONVERSATION_NEW => self.state.new_conversation_enabled,
            COMMAND_CONVERSATION_NEW_WINDOW => self.state.new_window_enabled,
            COMMAND_WORKSPACE_CHOOSE => self.state.workspace_enabled,
            COMMAND_RUN_STOP => self.state.run_stop_enabled,
            COMMAND_CONVERSATION_RENAME
            | COMMAND_CONVERSATION_ARCHIVE
            | COMMAND_CONVERSATION_OPEN_WINDOW
            | COMMAND_CONVERSATION_PREVIOUS
            | COMMAND_CONVERSATION_NEXT => self.state.conversation_enabled,
            COMMAND_CONVERSATION_SEARCH
            | COMMAND_EDIT_FIND
            | COMMAND_SETTINGS_OPEN
            | COMMAND_SIDEBAR_TOGGLE
            | COMMAND_VIEW_ZOOM_IN
            | COMMAND_VIEW_ZOOM_OUT
            | COMMAND_VIEW_ZOOM_RESET => true,
            _ => false,
        }
    }

    fn command_checked(&self, command_id: &str) -> Option<bool> {
        (command_id == COMMAND_SIDEBAR_TOGGLE).then_some(self.state.sidebar_visible)
    }
}

#[derive(Clone, Copy)]
struct CommandDefinition {
    id: &'static str,
    label: &'static str,
    accelerator: Option<&'static str>,
}

const fn command(
    id: &'static str,
    label: &'static str,
    accelerator: Option<&'static str>,
) -> CommandDefinition {
    CommandDefinition {
        id,
        label,
        accelerator,
    }
}

/// Static application commands. The sidebar toggle is the single check item;
/// Agent shortcuts are built from the focused window's Agent names.
const APPLICATION_COMMANDS: &[CommandDefinition] = &[
    command(
        COMMAND_CONVERSATION_NEW,
        "New Conversation",
        Some("CmdOrCtrl+N"),
    ),
    command(
        COMMAND_CONVERSATION_NEW_WINDOW,
        "New Conversation Window",
        Some("CmdOrCtrl+Shift+N"),
    ),
    command(
        COMMAND_CONVERSATION_SEARCH,
        "Search Conversations…",
        Some("CmdOrCtrl+K"),
    ),
    command(COMMAND_EDIT_FIND, "Find…", Some("CmdOrCtrl+F")),
    command(COMMAND_CONVERSATION_RENAME, "Rename…", None),
    command(COMMAND_CONVERSATION_ARCHIVE, "Archive", None),
    command(COMMAND_CONVERSATION_OPEN_WINDOW, "Open in New Window", None),
    command(
        COMMAND_CONVERSATION_PREVIOUS,
        "Previous Conversation",
        Some("CmdOrCtrl+Shift+["),
    ),
    command(
        COMMAND_CONVERSATION_NEXT,
        "Next Conversation",
        Some("CmdOrCtrl+Shift+]"),
    ),
    command(
        COMMAND_SIDEBAR_TOGGLE,
        "Show Sidebar",
        Some(SIDEBAR_ACCELERATOR),
    ),
    command(COMMAND_RUN_STOP, "Stop", Some("CmdOrCtrl+.")),
    command(
        COMMAND_WORKSPACE_CHOOSE,
        "Open Workspace…",
        Some("CmdOrCtrl+O"),
    ),
    command(COMMAND_SETTINGS_OPEN, "Settings…", Some("CmdOrCtrl+,")),
    // `=` is the portable physical key spelling accepted by Tauri/muda;
    // macOS displays it as the familiar Command-Plus shortcut.
    command(COMMAND_VIEW_ZOOM_IN, "Zoom In", Some("CmdOrCtrl+=")),
    command(COMMAND_VIEW_ZOOM_OUT, "Zoom Out", Some("CmdOrCtrl+-")),
    command(COMMAND_VIEW_ZOOM_RESET, "Actual Size", Some("CmdOrCtrl+0")),
];

fn application_command_definition(command_id: &str) -> Option<&'static CommandDefinition> {
    APPLICATION_COMMANDS
        .iter()
        .find(|definition| definition.id == command_id)
}

fn app_menu_command(menu_id: &str) -> Option<&'static str> {
    application_command_definition(menu_id)
        .map(|definition| definition.id)
        .or_else(|| {
            COMMAND_AGENT_SELECT
                .iter()
                .copied()
                .find(|id| *id == menu_id)
        })
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
}

#[derive(Clone, Debug)]
struct ConversationWindowEntry {
    label: String,
    phase: ConversationWindowPhase,
    session: Option<ConversationSessionLease>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationSessionLease {
    account_id: String,
    access_key: String,
    lease: String,
    // An entry-local I/O/revocation gate, not another owner registry.
    #[serde(skip)]
    live: Arc<Mutex<bool>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionClaim {
    owned: bool,
    window_label: String,
    lease: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConversationWindowPhase {
    Creating,
    Ready,
    Closing,
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

/// Non-secret routing hint for a secondary Conversation window: exactly one
/// access scope (an owned Product or an acquired entitlement). Runtime still
/// re-checks the signed-in account on every request.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ConversationWindowBinding {
    key: &'static str,
    id: String,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCommandEvent {
    id: String,
    source: &'static str,
}

impl NativeCommandRouter {
    pub fn claim_session(
        &self,
        account: &str,
        conversation: &str,
        access_key: &str,
        window: &str,
    ) -> Result<ConversationSessionClaim, String> {
        if [account, conversation, access_key, window]
            .iter()
            .any(|value| {
                value.is_empty() || value.len() > 256 || value.chars().any(char::is_control)
            })
        {
            return Err("conversation_owner_invalid: Invalid session identity".into());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native window registry is unavailable")?;
        if let Some(entry) = state.conversations_by_id.get_mut(conversation) {
            if entry.phase == ConversationWindowPhase::Closing {
                return Err("conversation_owner_closing: Owner session is draining".into());
            }
            if let Some(session) = &entry.session {
                if session.account_id != account || session.access_key != access_key {
                    return Err(
                        "conversation_owner_binding_mismatch: Session belongs to another binding"
                            .into(),
                    );
                }
            }
            if entry.label != window {
                return Ok(ConversationSessionClaim {
                    owned: false,
                    window_label: entry.label.clone(),
                    lease: None,
                });
            }
            let session = entry
                .session
                .get_or_insert_with(|| ConversationSessionLease {
                    account_id: account.into(),
                    access_key: access_key.into(),
                    lease: uuid::Uuid::new_v4().to_string(),
                    live: Arc::new(Mutex::new(true)),
                });
            return Ok(ConversationSessionClaim {
                owned: true,
                window_label: window.into(),
                lease: Some(session.lease.clone()),
            });
        }
        let lease = uuid::Uuid::new_v4().to_string();
        state.conversations_by_id.insert(
            conversation.into(),
            ConversationWindowEntry {
                label: window.into(),
                phase: ConversationWindowPhase::Ready,
                session: Some(ConversationSessionLease {
                    account_id: account.into(),
                    access_key: access_key.into(),
                    lease: lease.clone(),
                    live: Arc::new(Mutex::new(true)),
                }),
            },
        );
        Ok(ConversationSessionClaim {
            owned: true,
            window_label: window.into(),
            lease: Some(lease),
        })
    }

    // Context registration is short and has no filesystem operations here.
    pub fn with_window_session<T>(
        &self,
        conversation: &str,
        window: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Native window registry is unavailable")?;
        let session = state
            .conversations_by_id
            .get(conversation)
            .filter(|entry| {
                entry.label == window && entry.phase != ConversationWindowPhase::Closing
            })
            .and_then(|entry| entry.session.clone())
            .ok_or("conversation_owner_required: This window does not own the session")?;
        drop(state);
        let live = session
            .live
            .lock()
            .map_err(|_| "Session lease lock unavailable")?;
        if !*live {
            return Err("conversation_owner_required: Session was released".into());
        }
        operation()
    }

    pub fn with_session_lease<T>(
        &self,
        account: &str,
        conversation: &str,
        window: &str,
        lease: Option<&str>,
        operation: impl FnOnce(&str) -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Native window registry is unavailable")?;
        let entry = state
            .conversations_by_id
            .get(conversation)
            .ok_or("conversation_owner_required: Claim the session first")?;
        let session = entry
            .session
            .as_ref()
            .ok_or("conversation_owner_required: Session is not attached")?;
        if entry.phase == ConversationWindowPhase::Closing
            || entry.label != window
            || session.account_id != account
            || lease.is_some_and(|value| value != session.lease)
        {
            return Err("draft_lease_lost: This window is not the conversation owner".into());
        }
        let session = session.clone();
        drop(state);
        // Never hold the global routing lock across filesystem I/O.
        let live = session
            .live
            .lock()
            .map_err(|_| "Session lease lock unavailable")?;
        if !*live {
            return Err("draft_lease_lost: Session was released".into());
        }
        operation(&session.lease)
    }

    pub fn release_session(
        &self,
        account: &str,
        conversation: &str,
        window: &str,
        lease: &str,
    ) -> Result<(), String> {
        let live = {
            let state = self
                .state
                .lock()
                .map_err(|_| "Native window registry is unavailable")?;
            state
                .conversations_by_id
                .get(conversation)
                .filter(|entry| entry.label == window)
                .and_then(|entry| entry.session.as_ref())
                .filter(|session| session.account_id == account && session.lease == lease)
                .map(|session| session.live.clone())
        };
        let Some(live) = live else {
            return Ok(());
        };
        *live.lock().map_err(|_| "Session lease lock unavailable")? = false;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native window registry is unavailable")?;
        let matches = state
            .conversations_by_id
            .get(conversation)
            .is_some_and(|entry| {
                entry.phase != ConversationWindowPhase::Closing
                    && entry.label == window
                    && entry.session.as_ref().is_some_and(|session| {
                        session.account_id == account && session.lease == lease
                    })
            });
        if matches {
            state.conversations_by_id.remove(conversation);
            if state
                .conversation_by_label
                .get(window)
                .is_some_and(|id| id == conversation)
            {
                state.conversation_by_label.remove(window);
            }
        }
        Ok(())
    }

    fn session_activation(&self, conversation: &str) -> Result<Option<serde_json::Value>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Native window registry is unavailable")?;
        Ok(state.conversations_by_id.get(conversation).and_then(|entry| entry.session.as_ref()).map(|session|
            serde_json::json!({ "conversationId": conversation, "accountId": session.account_id, "accessKey": session.access_key })))
    }
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
            active_window_label: state.active_window_label.clone(),
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
            if command_id == COMMAND_SIDEBAR_TOGGLE {
                command_state.sidebar_visible = previous;
            }
        }
    }

    pub(crate) fn refresh_native_menu<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
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
            state
                .conversations_by_id
                .iter()
                .filter(|(id, entry)| entry.label == conversation_window_label(id))
                .map(|(id, _)| id.clone()),
        ))
    }

    /// Remove transient context state and any reverse conversation lookup as
    /// soon as a Tauri webview is destroyed. This is intentionally separate
    /// from renderer cleanup, which might not run on a forced window close.
    pub fn begin_close_window(&self, label: &str) {
        if let Ok(mut state) = self.state.lock() {
            for entry in state
                .conversations_by_id
                .values_mut()
                .filter(|entry| entry.label == label)
            {
                entry.phase = ConversationWindowPhase::Closing;
            }
        }
    }

    pub fn revoke_window_sessions(&self, label: &str) {
        let leases: Vec<_> = match self.state.lock() {
            Ok(state) => state
                .conversations_by_id
                .values()
                .filter(|entry| entry.label == label)
                .filter_map(|entry| entry.session.as_ref().map(|session| session.live.clone()))
                .collect(),
            Err(_) => return,
        };
        for live in leases {
            if let Ok(mut live) = live.lock() {
                *live = false;
            }
        }
    }

    pub fn clear_window(&self, label: &str) {
        self.revoke_window_sessions(label);
        if let Ok(mut state) = self.state.lock() {
            if state.active_window_label.as_deref() == Some(label) {
                state.active_window_label = None;
            }
            state.command_state_by_window.remove(label);
            state.conversation_by_label.remove(label);
            state
                .conversations_by_id
                .retain(|_, entry| entry.label != label);
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
                session: None,
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
        self.dispatch_to_window(app, &label, command_id, source)
    }

    fn dispatch_to_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        window_label: &str,
        command_id: &str,
        source: &'static str,
    ) -> Result<(), String> {
        app.emit_to(
            window_label,
            NATIVE_COMMAND_EVENT,
            NativeCommandEvent {
                id: command_id.to_string(),
                source,
            },
        )
        .map_err(|error| format!("native_command_dispatch_failed: {error}"))
    }

    pub fn route_menu_event<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        menu_id: &str,
    ) -> Result<(), String> {
        if let Some(label) = menu_id.strip_prefix(MENU_WINDOW_FOCUS_PREFIX) {
            // Window menu entries are handled natively; they never reach React.
            let window = app
                .get_webview_window(label)
                .ok_or("The selected Hatch window is no longer available")?;
            window
                .unminimize()
                .and_then(|_| window.show())
                .and_then(|_| window.set_focus())
                .map_err(|error| format!("native_window_focus_failed: {error}"))?;
            self.set_active_window(label);
            return self.refresh_native_menu(app);
        }
        if menu_id == MENU_HELP_OPEN {
            return crate::open_external_url(format!("{}{HELP_PATH}", crate::WEB_ORIGIN));
        }
        let Some(command_id) = app_menu_command(menu_id) else {
            // Standard Tauri/OS menu items (Undo, Cut, Quit, …) deliberately
            // retain their native behavior and are not forwarded to React.
            return Ok(());
        };
        // Disabled native items normally cannot emit events, but this guard
        // also covers automation or an event arriving right after focus moves.
        if !self.command_enabled_for_active_window(command_id)? {
            return Ok(());
        }
        // Sidebar is a native check item. Flip the visual state before sending
        // the semantic command, then restore it if Tauri cannot deliver it.
        let previous_check = self.flip_checked_command_for_active_window(command_id)?;
        let dispatch = self.dispatch_to_active_window(app, command_id, "menu");
        if dispatch.is_err() {
            self.restore_checked_command_for_active_window(command_id, previous_check);
        }
        let refresh = self.refresh_native_menu(app);
        dispatch?;
        refresh
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
        if open_conversation_window_impl(app, conversation_id, None, router, false, false).is_ok() {
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
    state.validate()?;
    router
        .inner()
        .set_window_command_state(&app, window.label(), state.clone())?;
    Ok(state)
}

#[tauri::command]
pub async fn claim_conversation_session(
    window: WebviewWindow,
    account_id: String,
    conversation_id: String,
    access_key: String,
    router: State<'_, NativeCommandRouter>,
) -> Result<ConversationSessionClaim, String> {
    let conversation_id = validate_conversation_id(&conversation_id)?;
    for _ in 0..2 {
        let claim =
            router.claim_session(&account_id, &conversation_id, &access_key, window.label())?;
        if claim.owned {
            return Ok(claim);
        }
        if let Some(owner) = window.app_handle().get_webview_window(&claim.window_label) {
            if let Some(payload) = router.session_activation(&conversation_id)? {
                owner
                    .emit("hatch://conversation-activate", payload)
                    .map_err(|error| error.to_string())?;
                owner.show().map_err(|error| error.to_string())?;
                owner.set_focus().map_err(|error| error.to_string())?;
            }
            // A reserved, loading window gets the conversation from its URL.
            return Ok(claim);
        }
        // A Creating entry must not be reclaimed before its builder publishes it.
        let creating = router
            .state
            .lock()
            .map_err(|_| "Native window registry is unavailable")?
            .conversations_by_id
            .get(&conversation_id)
            .is_some_and(|entry| entry.phase == ConversationWindowPhase::Creating);
        if creating {
            return Ok(claim);
        }
        // Attached sessions may still be draining after native destruction.
        // Only Destroyed cleanup may release them, never a competing claimant.
        if router.session_activation(&conversation_id)?.is_some() {
            return Err("conversation_owner_unavailable: Owner cleanup is pending".into());
        }
        router.clear_window(&claim.window_label);
    }
    Err("conversation_owner_unavailable: Owner window disappeared".into())
}

#[tauri::command]
pub async fn release_conversation_session(
    window: WebviewWindow,
    account_id: String,
    conversation_id: String,
    lease: String,
    router: State<'_, NativeCommandRouter>,
) -> Result<(), String> {
    router.release_session(&account_id, &conversation_id, window.label(), &lease)
}

/// Opens a conversation in a distinct Tauri window. The command is async even
/// though construction is synchronous because Tauri documents async commands
/// as the safe cross-platform path for Webview2 window creation.
#[tauri::command]
pub async fn open_conversation_window(
    app: AppHandle,
    conversation_id: String,
    product_id: Option<String>,
    entitlement_id: Option<String>,
    start_task: Option<bool>,
    router: State<'_, NativeCommandRouter>,
) -> Result<OpenConversationWindowResult, String> {
    let conversation_id = validate_conversation_id(&conversation_id)?;
    let binding =
        validate_conversation_window_binding(product_id.as_deref(), entitlement_id.as_deref())?;
    open_conversation_window_impl(
        &app,
        conversation_id,
        Some(binding),
        router.inner(),
        true,
        start_task.unwrap_or(false),
    )
}

fn open_conversation_window_impl<R: Runtime>(
    app: &AppHandle<R>,
    conversation_id: String,
    binding: Option<ConversationWindowBinding>,
    router: &NativeCommandRouter,
    persist_manifest: bool,
    start_task: bool,
) -> Result<OpenConversationWindowResult, String> {
    // A previous ready entry can become stale if a platform destroys a window
    // before its Destroyed event reaches our registry. Recover once instead of
    // returning a dead label; a Creating entry remains reserved to prevent two
    // simultaneous commands from building the same native window.
    for _ in 0..2 {
        match router.reserve_conversation(&conversation_id)? {
            ConversationReservation::Existing { label, phase } => {
                if phase == ConversationWindowPhase::Closing {
                    return Err("conversation_owner_closing: Owner session is draining".into());
                }
                if let Some(window) = app.get_webview_window(&label) {
                    if phase == ConversationWindowPhase::Ready {
                        if let Some(payload) = router.session_activation(&conversation_id)? {
                            window
                                .emit("hatch://conversation-activate", payload)
                                .map_err(|error| error.to_string())?;
                        }
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
                if router.session_activation(&conversation_id)?.is_some() {
                    return Err("conversation_owner_unavailable: Owner cleanup is pending".into());
                }
                router.forget_conversation_if(&conversation_id, &label);
            }
            ConversationReservation::New { label } => {
                let page_router = router.clone();
                let page_conversation_id = conversation_id.clone();
                let page_label = label.clone();
                let builder = prepare_window(
                    app,
                    WebviewWindowBuilder::new(
                        app,
                        label.clone(),
                        WebviewUrl::App(conversation_window_path(
                            &conversation_id,
                            binding.as_ref(),
                            start_task,
                        )),
                    ),
                )
                .title("Hatch")
                .inner_size(1180.0, 780.0)
                .min_inner_size(640.0, 600.0)
                .resizable(true)
                .focused(false)
                .on_page_load(move |window, payload| {
                    if payload.event() != PageLoadEvent::Finished {
                        return;
                    }
                    page_router.mark_conversation_ready(&page_conversation_id, &page_label);
                    // The renderer reveals the window with `app_ready` after
                    // its first frame; this only guards a renderer that never
                    // reports ready.
                    reveal_if_still_hidden(window);
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

fn validate_uuid_v4(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    let bytes = value.as_bytes();
    let valid_hex = |byte: u8| byte.is_ascii_hexdigit();
    let valid = bytes.len() == 36
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || valid_hex(*byte))
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b');
    if !valid {
        return Err(format!(
            "conversation_window_binding_invalid: {field} must be a UUID v4"
        ));
    }
    Ok(value)
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

fn validate_conversation_window_binding(
    product_id: Option<&str>,
    entitlement_id: Option<&str>,
) -> Result<ConversationWindowBinding, String> {
    match (product_id, entitlement_id) {
        (Some(product_id), None) => Ok(ConversationWindowBinding {
            key: "product_id",
            id: validate_uuid_v4(product_id, "product_id")?,
        }),
        (None, Some(entitlement_id)) => Ok(ConversationWindowBinding {
            key: "entitlement_id",
            id: validate_uuid_v4(entitlement_id, "entitlement_id")?,
        }),
        _ => Err(
            "conversation_window_binding_invalid: Provide exactly one of product_id or entitlement_id"
                .into(),
        ),
    }
}

fn conversation_window_path(
    conversation_id: &str,
    binding: Option<&ConversationWindowBinding>,
    start_task: bool,
) -> PathBuf {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("conversation_id", conversation_id);
    if let Some(binding) = binding {
        query.append_pair(binding.key, &binding.id);
    }
    if start_task {
        query.append_pair("task_start", "1");
    }
    PathBuf::from(format!("index.html?{}", query.finish()))
}

// ---------------------------------------------------------------------------
// Application menu

fn menu_error(error: impl std::fmt::Display) -> String {
    format!("native_menu_build_failed: {error}")
}

fn build_application_menu<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &NativeMenuSnapshot,
) -> Result<Menu<R>, String> {
    let item = |id: &str| command_menu_item(app, snapshot, id);
    let settings = item(COMMAND_SETTINGS_OPEN)?;
    let about = AboutMetadataBuilder::new()
        .name(Some("Hatch"))
        .version(Some(app.package_info().version.to_string()))
        .copyright(Some("© Hatch"))
        .build();

    #[cfg(target_os = "macos")]
    let application = SubmenuBuilder::new(app, "Hatch")
        .about(Some(about))
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()
        .map_err(menu_error)?;
    #[cfg(not(target_os = "macos"))]
    let application = SubmenuBuilder::new(app, "Hatch")
        .about(Some(about))
        .separator()
        .item(&settings)
        .separator()
        .quit()
        .build()
        .map_err(menu_error)?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item(COMMAND_CONVERSATION_NEW)?)
        .item(&item(COMMAND_CONVERSATION_NEW_WINDOW)?)
        .item(&item(COMMAND_WORKSPACE_CHOOSE)?)
        .separator()
        .close_window()
        .build()
        .map_err(menu_error)?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item(COMMAND_EDIT_FIND)?)
        .build()
        .map_err(menu_error)?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&sidebar_menu_item(app, snapshot)?)
        .item(&item(COMMAND_CONVERSATION_SEARCH)?)
        .separator()
        .item(&item(COMMAND_VIEW_ZOOM_IN)?)
        .item(&item(COMMAND_VIEW_ZOOM_OUT)?)
        .item(&item(COMMAND_VIEW_ZOOM_RESET)?);
    #[cfg(target_os = "macos")]
    let view = view.separator().fullscreen();
    let view = view.build().map_err(menu_error)?;

    let mut conversation = SubmenuBuilder::new(app, "Conversation")
        .item(&item(COMMAND_CONVERSATION_RENAME)?)
        .item(&item(COMMAND_CONVERSATION_ARCHIVE)?)
        .item(&item(COMMAND_CONVERSATION_OPEN_WINDOW)?)
        .separator()
        .item(&item(COMMAND_CONVERSATION_PREVIOUS)?)
        .item(&item(COMMAND_CONVERSATION_NEXT)?);
    if !snapshot.state.agents.is_empty() {
        conversation = conversation.separator();
        for (index, name) in snapshot.state.agents.iter().enumerate() {
            let agent = MenuItemBuilder::with_id(COMMAND_AGENT_SELECT[index], name)
                .accelerator(AGENT_SELECT_ACCELERATORS[index])
                .enabled(snapshot.command_enabled(COMMAND_AGENT_SELECT[index]))
                .build(app)
                .map_err(menu_error)?;
            conversation = conversation.item(&agent);
        }
    }
    let conversation = conversation.build().map_err(menu_error)?;

    let run = SubmenuBuilder::new(app, "Run")
        .item(&item(COMMAND_RUN_STOP)?)
        .build()
        .map_err(menu_error)?;

    let mut window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator();
    for entry in open_window_entries(app) {
        let checked = snapshot.active_window_label.as_deref() == Some(entry.label.as_str());
        let item: CheckMenuItem<R> = CheckMenuItemBuilder::with_id(
            format!("{MENU_WINDOW_FOCUS_PREFIX}{}", entry.label),
            entry.title,
        )
        .checked(checked)
        .build(app)
        .map_err(menu_error)?;
        window = window.item(&item);
    }
    let window = window.build().map_err(menu_error)?;

    let help_item = MenuItemBuilder::with_id(MENU_HELP_OPEN, "Hatch Help")
        .build(app)
        .map_err(menu_error)?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&help_item)
        .build()
        .map_err(menu_error)?;

    MenuBuilder::new(app)
        .item(&application)
        .item(&file)
        .item(&edit)
        .item(&view)
        .item(&conversation)
        .item(&run)
        .item(&window)
        .item(&help)
        .build()
        .map_err(menu_error)
}

struct OpenWindowEntry {
    label: String,
    title: String,
}

/// Visible Hatch windows in a stable order (main first), titled as the
/// renderer titled them — the conversation name.
fn open_window_entries<R: Runtime>(app: &AppHandle<R>) -> Vec<OpenWindowEntry> {
    let mut entries = app
        .webview_windows()
        .into_iter()
        .filter(|(_, window)| window.is_visible().unwrap_or(false))
        .map(|(label, window)| OpenWindowEntry {
            title: window
                .title()
                .ok()
                .filter(|title| !title.trim().is_empty())
                .unwrap_or_else(|| "Hatch".into()),
            label,
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        (left.label != MAIN_WINDOW_LABEL, &left.label)
            .cmp(&(right.label != MAIN_WINDOW_LABEL, &right.label))
    });
    entries
}

fn command_menu_item<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &NativeMenuSnapshot,
    command_id: &str,
) -> Result<MenuItem<R>, String> {
    let definition = application_command_definition(command_id)
        .ok_or_else(|| format!("native_menu_registry_invalid: Unknown command {command_id}"))?;
    let mut builder = MenuItemBuilder::with_id(definition.id, definition.label)
        .enabled(snapshot.command_enabled(definition.id));
    if let Some(accelerator) = definition.accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app).map_err(menu_error)
}

fn sidebar_menu_item<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &NativeMenuSnapshot,
) -> Result<CheckMenuItem<R>, String> {
    CheckMenuItemBuilder::with_id(COMMAND_SIDEBAR_TOGGLE, sidebar_label(snapshot))
        .enabled(snapshot.command_enabled(COMMAND_SIDEBAR_TOGGLE))
        .checked(
            snapshot
                .command_checked(COMMAND_SIDEBAR_TOGGLE)
                .unwrap_or(false),
        )
        .accelerator(SIDEBAR_ACCELERATOR)
        .build(app)
        .map_err(menu_error)
}

fn sidebar_label(snapshot: &NativeMenuSnapshot) -> &'static str {
    if snapshot
        .command_checked(COMMAND_SIDEBAR_TOGGLE)
        .unwrap_or(false)
    {
        "Hide Sidebar"
    } else {
        "Show Sidebar"
    }
}

#[cfg(test)]
mod tests {
    use super::{
        app_menu_command, application_command_definition, conversation_window_label,
        conversation_window_path, normalize_manifest_conversation_ids, sidebar_label,
        validate_conversation_id, validate_conversation_window_binding, ConversationReservation,
        ConversationWindowPhase, NativeCommandRouter, NativeCommandState, NativeMenuSnapshot,
        COMMAND_AGENT_SELECT, COMMAND_CONVERSATION_ARCHIVE, COMMAND_CONVERSATION_NEW,
        COMMAND_CONVERSATION_NEW_WINDOW, COMMAND_CONVERSATION_NEXT,
        COMMAND_CONVERSATION_OPEN_WINDOW, COMMAND_CONVERSATION_PREVIOUS,
        COMMAND_CONVERSATION_RENAME, COMMAND_CONVERSATION_SEARCH, COMMAND_EDIT_FIND,
        COMMAND_RUN_STOP, COMMAND_SETTINGS_OPEN, COMMAND_SIDEBAR_TOGGLE, COMMAND_VIEW_ZOOM_IN,
        COMMAND_VIEW_ZOOM_OUT, COMMAND_VIEW_ZOOM_RESET, COMMAND_WORKSPACE_CHOOSE,
        MAX_RESTORED_CONVERSATION_WINDOWS,
    };

    const PRODUCT: &str = "550e8400-e29b-41d4-a716-446655440000";
    const ENTITLEMENT: &str = "7aa7b10c-4db0-4d8a-8c2f-2e2c8cba1001";

    fn snapshot(state: NativeCommandState) -> NativeMenuSnapshot {
        NativeMenuSnapshot {
            has_focused_window: true,
            active_window_label: Some("main".into()),
            state,
        }
    }

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
    fn conversation_window_route_carries_exactly_one_access_scope() {
        let owned = validate_conversation_window_binding(Some(PRODUCT), None).unwrap();
        let path = conversation_window_path("conv_123", Some(&owned), true);
        assert_eq!(
            path.to_string_lossy(),
            format!("index.html?conversation_id=conv_123&product_id={PRODUCT}&task_start=1")
        );
        let acquired = validate_conversation_window_binding(None, Some(ENTITLEMENT)).unwrap();
        let path = conversation_window_path("conv_123", Some(&acquired), false);
        assert_eq!(
            path.to_string_lossy(),
            format!("index.html?conversation_id=conv_123&entitlement_id={ENTITLEMENT}")
        );
    }

    #[test]
    fn conversation_window_binding_rejects_both_neither_and_controlled_input() {
        assert!(validate_conversation_window_binding(Some(PRODUCT), Some(ENTITLEMENT)).is_err());
        assert!(validate_conversation_window_binding(None, None).is_err());
        assert!(validate_conversation_window_binding(Some("not-a-uuid"), None).is_err());
        assert!(
            validate_conversation_window_binding(None, Some(&format!("{ENTITLEMENT}\nx"))).is_err()
        );
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
        let normalized = normalize_manifest_conversation_ids(ids);
        assert!(normalized.len() <= MAX_RESTORED_CONVERSATION_WINDOWS);
        assert!(normalized.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(!normalized.iter().any(|id| id.contains('\n')));
        assert!(!normalized.iter().any(String::is_empty));
    }

    #[test]
    fn conversation_registry_slow_draft_io_does_not_lock_other_conversation_routes() {
        use std::sync::mpsc;
        use std::time::Duration;
        let router = NativeCommandRouter::default();
        router
            .claim_session("account", "a", "product:a", "main")
            .unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (finish_tx, finish_rx) = mpsc::channel();
        let writer = router.clone();
        let writing = std::thread::spawn(move || {
            writer.with_session_lease("account", "a", "main", None, |_| {
                entered_tx.send(()).unwrap();
                finish_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(())
            })
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let other = router.clone();
        let (routed_tx, routed_rx) = mpsc::channel();
        let routing = std::thread::spawn(move || {
            routed_tx
                .send(
                    other
                        .claim_session("account", "b", "product:a", "other")
                        .unwrap()
                        .owned,
                )
                .unwrap();
        });
        let result = routed_rx.recv_timeout(Duration::from_secs(1));
        finish_tx.send(()).unwrap();
        writing.join().unwrap().unwrap();
        routing.join().unwrap();
        assert!(result.unwrap());
    }

    #[test]
    fn conversation_registry_closing_fences_claims_contexts_and_drafts_until_cleanup() {
        let router = NativeCommandRouter::default();
        router
            .claim_session("account", "a", "product:a", "main")
            .unwrap();
        router.begin_close_window("main");
        let lease = router.state.lock().unwrap().conversations_by_id["a"]
            .session
            .as_ref()
            .unwrap()
            .lease
            .clone();
        router
            .release_session("account", "a", "main", &lease)
            .unwrap();
        assert!(router
            .claim_session("account", "a", "product:a", "other")
            .is_err());
        assert!(router.with_window_session("a", "main", || Ok(())).is_err());
        assert!(router
            .with_session_lease("account", "a", "main", None, |_| Ok(()))
            .is_err());
        router.revoke_window_sessions("main");
        assert!(
            router
                .claim_session("account", "b", "product:a", "other")
                .unwrap()
                .owned
        );
        router.clear_window("main");
        assert!(
            router
                .claim_session("account", "a", "product:a", "other")
                .unwrap()
                .owned
        );
    }

    #[test]
    fn conversation_registry_binds_owner_to_account_and_access_key() {
        let router = NativeCommandRouter::default();
        let a = router
            .claim_session("account", "a", "entitlement:x", "main")
            .unwrap();
        assert!(a.owned);
        let redirect = router
            .claim_session("account", "a", "entitlement:x", "other")
            .unwrap();
        assert!(!redirect.owned);
        assert_eq!(redirect.window_label, "main");
        let target = router.session_activation("a").unwrap().unwrap();
        assert_eq!(target["conversationId"], "a");
        assert_eq!(target["accountId"], "account");
        assert_eq!(target["accessKey"], "entitlement:x");
        assert!(router
            .claim_session("foreign", "a", "entitlement:x", "other")
            .is_err());
        assert!(router
            .claim_session("account", "a", "product:y", "other")
            .is_err());
        router
            .release_session("account", "a", "main", "stale")
            .unwrap();
        assert!(
            !router
                .claim_session("account", "a", "entitlement:x", "other")
                .unwrap()
                .owned
        );
        router
            .release_session("account", "a", "main", a.lease.as_deref().unwrap())
            .unwrap();
        assert!(
            router
                .claim_session("account", "a", "entitlement:x", "other")
                .unwrap()
                .owned
        );
    }

    #[test]
    fn conversation_registry_concurrent_claim_has_one_owner() {
        let router = NativeCommandRouter::default();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let router = router.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    router
                        .claim_session(
                            "account",
                            "concurrent",
                            "product:a",
                            &format!("window-{index}"),
                        )
                        .unwrap()
                })
            })
            .collect();
        let claims: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(claims.iter().filter(|claim| claim.owned).count(), 1);
        let reserved = match router.reserve_conversation("restored").unwrap() {
            ConversationReservation::New { label } => label,
            _ => panic!("expected restore reservation"),
        };
        assert!(
            router
                .claim_session("account", "restored", "product:a", &reserved)
                .unwrap()
                .owned
        );
    }

    #[test]
    fn conversation_registry_keeps_parallel_windows_independent() {
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
        assert!(matches!(
            router.reserve_conversation("conversation-a").unwrap(),
            ConversationReservation::Existing {
                phase: ConversationWindowPhase::Ready,
                ..
            }
        ));
        router.clear_window(&labels[1]);
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
    fn menu_commands_are_semantic_and_include_agent_shortcuts() {
        for command_id in [
            COMMAND_CONVERSATION_NEW,
            COMMAND_CONVERSATION_NEW_WINDOW,
            COMMAND_CONVERSATION_SEARCH,
            COMMAND_EDIT_FIND,
            COMMAND_CONVERSATION_RENAME,
            COMMAND_CONVERSATION_ARCHIVE,
            COMMAND_CONVERSATION_OPEN_WINDOW,
            COMMAND_CONVERSATION_PREVIOUS,
            COMMAND_CONVERSATION_NEXT,
            COMMAND_WORKSPACE_CHOOSE,
            COMMAND_SETTINGS_OPEN,
            COMMAND_SIDEBAR_TOGGLE,
            COMMAND_VIEW_ZOOM_IN,
            COMMAND_VIEW_ZOOM_OUT,
            COMMAND_VIEW_ZOOM_RESET,
            COMMAND_RUN_STOP,
        ] {
            assert_eq!(app_menu_command(command_id), Some(command_id));
            assert!(application_command_definition(command_id).is_some());
        }
        assert_eq!(app_menu_command("agent.select.9"), Some("agent.select.9"));
        assert_eq!(app_menu_command("window.focus:main"), None);
        assert_eq!(app_menu_command("inspector.toggle"), None);
        assert_eq!(app_menu_command("about.open"), None);
    }

    #[test]
    fn menu_enablement_follows_the_focused_window_projection() {
        let idle = snapshot(NativeCommandState::default());
        assert!(idle.command_enabled(COMMAND_CONVERSATION_SEARCH));
        assert!(idle.command_enabled(COMMAND_EDIT_FIND));
        assert!(idle.command_enabled(COMMAND_SETTINGS_OPEN));
        assert!(!idle.command_enabled(COMMAND_RUN_STOP));
        assert!(!idle.command_enabled(COMMAND_CONVERSATION_RENAME));
        assert!(!idle.command_enabled(COMMAND_AGENT_SELECT[0]));
        assert_eq!(sidebar_label(&idle), "Hide Sidebar");

        let active = snapshot(NativeCommandState {
            conversation_enabled: true,
            run_stop_enabled: true,
            sidebar_visible: false,
            agents: vec!["Writing Coach".into(), "Tax Helper".into()],
            ..NativeCommandState::default()
        });
        assert!(active.command_enabled(COMMAND_CONVERSATION_PREVIOUS));
        assert!(active.command_enabled(COMMAND_RUN_STOP));
        assert!(active.command_enabled(COMMAND_AGENT_SELECT[1]));
        assert!(!active.command_enabled(COMMAND_AGENT_SELECT[2]));
        assert_eq!(sidebar_label(&active), "Show Sidebar");

        let unfocused = NativeMenuSnapshot {
            has_focused_window: false,
            ..active
        };
        assert!(!unfocused.command_enabled(COMMAND_CONVERSATION_SEARCH));
    }

    #[test]
    fn focused_window_menu_state_is_scoped_and_sidebar_check_flips() {
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
                    ..NativeCommandState::default()
                },
            )
            .unwrap();
        assert!(!router
            .menu_snapshot()
            .unwrap()
            .command_enabled(COMMAND_CONVERSATION_NEW));
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
        router.clear_window("conversation-b");
        assert!(!router
            .menu_snapshot()
            .unwrap()
            .command_enabled(COMMAND_CONVERSATION_NEW));
    }

    #[test]
    fn command_state_is_a_complete_bounded_non_authority_snapshot() {
        let payload = serde_json::json!({
            "newConversationEnabled": true,
            "newWindowEnabled": false,
            "workspaceEnabled": true,
            "runStopEnabled": false,
            "sidebarVisible": false,
            "conversationEnabled": true,
            "agents": ["Writing Coach"]
        });
        let state: NativeCommandState = serde_json::from_value(payload.clone())
            .expect("the documented renderer payload must deserialize");
        assert!(state.validate().is_ok());
        assert!(!state.new_window_enabled);
        let mut extra = payload;
        extra["workspaceGrantId"] = "must-not-be-accepted-here".into();
        assert!(serde_json::from_value::<NativeCommandState>(extra).is_err());
        let too_many = NativeCommandState {
            agents: (0..10).map(|index| format!("Agent {index}")).collect(),
            ..NativeCommandState::default()
        };
        assert!(too_many.validate().is_err());
        let too_long = NativeCommandState {
            agents: vec!["x".repeat(121)],
            ..NativeCommandState::default()
        };
        assert!(too_long.validate().is_err());
        let controlled = NativeCommandState {
            agents: vec!["bad\nname".into()],
            ..NativeCommandState::default()
        };
        assert!(controlled.validate().is_err());
    }

    #[test]
    fn conversation_ids_reject_control_text() {
        assert!(validate_conversation_id(" conversation-1 ").is_ok());
        assert!(validate_conversation_id("bad\nconversation").is_err());
    }
}
