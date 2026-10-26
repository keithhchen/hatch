//! Native desktop command routing and multi-window coordination.
//!
//! The renderer owns the product action behind a command; this module owns
//! the native entry points that make those actions feel like desktop actions:
//! the application menu bar, one Chat window per Agent (the `main` window is
//! the Library), conversation ownership for native tool contexts, and the
//! app-wide Dock badge. Keeping the wire format deliberately semantic means
//! the same command can originate from a menu or a keyboard accelerator
//! without teaching Rust about React component state. Context menus are
//! built by the renderer with `@tauri-apps/api/menu`.

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
/// The main renderer shows the Library when signed in, else the welcome window.
pub const REOPEN_EVENT: &str = "hatch://reopen";

pub const COMMAND_CONVERSATION_NEW: &str = "conversation.new";
pub const COMMAND_EDIT_FIND: &str = "edit.find";
pub const COMMAND_CONVERSATION_RENAME: &str = "conversation.rename";
pub const COMMAND_CONVERSATION_ARCHIVE: &str = "conversation.archive";
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
/// `agent.select.N` opens or focuses the Chat window of the N-th Agent in
/// Library order (the renderer performs it).
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
const MENU_WINDOW_LIBRARY: &str = "window.library";
const MENU_WINDOW_LIBRARY_ACCELERATOR: &str = "CmdOrCtrl+Shift+L";
const MENU_HELP_OPEN: &str = "help.open";
const HELP_PATH: &str = "/account/help";

const MAX_CONVERSATION_ID_BYTES: usize = 256;
const MAX_RESTORED_AGENT_WINDOWS: usize = 16;
const AGENT_WINDOW_PREFIX: &str = "agent-";

fn agent_window_manifest_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Valid, sorted, deduplicated and bounded `product_id:<uuid>` /
/// `entitlement_id:<uuid>` entries.
fn normalize_agent_window_manifest(entries: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut normalized = entries
        .into_iter()
        .filter_map(|entry| AgentBinding::parse(&entry).ok())
        .map(|binding| binding.manifest_key())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized.truncate(MAX_RESTORED_AGENT_WINDOWS);
    normalized
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
            COMMAND_WORKSPACE_CHOOSE => self.state.workspace_enabled,
            COMMAND_RUN_STOP => self.state.run_stop_enabled,
            COMMAND_CONVERSATION_RENAME
            | COMMAND_CONVERSATION_ARCHIVE
            | COMMAND_CONVERSATION_PREVIOUS
            | COMMAND_CONVERSATION_NEXT => self.state.conversation_enabled,
            COMMAND_EDIT_FIND
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
    command(COMMAND_EDIT_FIND, "Find…", Some("CmdOrCtrl+F")),
    command(COMMAND_CONVERSATION_RENAME, "Rename…", None),
    command(COMMAND_CONVERSATION_ARCHIVE, "Archive", None),
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
    preserve_agent_manifest_on_exit: bool,
    command_state_by_window: HashMap<String, NativeCommandState>,
    conversations_by_id: HashMap<String, ConversationOwnerEntry>,
    /// Chat window label → its Agent binding manifest key.
    agent_windows: HashMap<String, String>,
    /// Pending approvals per window; the Dock badge shows the sum.
    attention_by_window: HashMap<String, u32>,
}

/// The window that owns one Conversation's native session (tool contexts).
#[derive(Clone, Debug)]
struct ConversationOwnerEntry {
    label: String,
    phase: ConversationOwnerPhase,
    session: ConversationSessionLease,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationSessionLease {
    account_id: String,
    access_key: String,
    lease: String,
    // An entry-local revocation gate, not another owner registry.
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
enum ConversationOwnerPhase {
    Ready,
    Closing,
}

/// Non-secret routing hint for an Agent's Chat window: exactly one access
/// scope (an owned Product or an acquired entitlement). Runtime still
/// re-checks the signed-in account on every request.
#[derive(Clone, Debug, PartialEq, Eq)]
struct AgentBinding {
    key: &'static str,
    id: String,
}

impl AgentBinding {
    fn new(product_id: Option<&str>, entitlement_id: Option<&str>) -> Result<Self, String> {
        match (product_id, entitlement_id) {
            (Some(product_id), None) => Ok(Self {
                key: "product_id",
                id: validate_uuid_v4(product_id, "product_id")?,
            }),
            (None, Some(entitlement_id)) => Ok(Self {
                key: "entitlement_id",
                id: validate_uuid_v4(entitlement_id, "entitlement_id")?,
            }),
            _ => Err(
                "agent_window_binding_invalid: Provide exactly one of product_id or entitlement_id"
                    .into(),
            ),
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value.split_once(':') {
            Some(("product_id", id)) => Self::new(Some(id), None),
            Some(("entitlement_id", id)) => Self::new(None, Some(id)),
            _ => Err("agent_window_binding_invalid: Unknown manifest entry".into()),
        }
    }

    fn manifest_key(&self) -> String {
        format!("{}:{}", self.key, self.id)
    }

    /// Stable, portable, distinct per binding: a short readable slug plus a
    /// deterministic hash of the full binding.
    fn window_label(&self) -> String {
        let scope = if self.key == "product_id" {
            "product"
        } else {
            "entitlement"
        };
        format!(
            "{AGENT_WINDOW_PREFIX}{scope}-{}-{:016x}",
            &self.id[..8],
            stable_hash64(self.manifest_key().as_bytes())
        )
    }

    fn window_path(&self) -> PathBuf {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query.append_pair("window", "chat");
        query.append_pair(self.key, &self.id);
        PathBuf::from(format!("index.html?{}", query.finish()))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAgentWindowResult {
    pub window_label: String,
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
        if let Some(entry) = state.conversations_by_id.get(conversation) {
            if entry.phase == ConversationOwnerPhase::Closing {
                return Err("conversation_owner_closing: Owner session is draining".into());
            }
            if entry.session.account_id != account || entry.session.access_key != access_key {
                return Err(
                    "conversation_owner_binding_mismatch: Session belongs to another binding"
                        .into(),
                );
            }
            return Ok(ConversationSessionClaim {
                owned: entry.label == window,
                window_label: entry.label.clone(),
                lease: (entry.label == window).then(|| entry.session.lease.clone()),
            });
        }
        let lease = uuid::Uuid::new_v4().to_string();
        state.conversations_by_id.insert(
            conversation.into(),
            ConversationOwnerEntry {
                label: window.into(),
                phase: ConversationOwnerPhase::Ready,
                session: ConversationSessionLease {
                    account_id: account.into(),
                    access_key: access_key.into(),
                    lease: lease.clone(),
                    live: Arc::new(Mutex::new(true)),
                },
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
            .filter(|entry| entry.label == window && entry.phase != ConversationOwnerPhase::Closing)
            .map(|entry| entry.session.clone())
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
                .filter(|entry| {
                    entry.label == window
                        && entry.session.account_id == account
                        && entry.session.lease == lease
                })
                .map(|entry| entry.session.live.clone())
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
                entry.phase != ConversationOwnerPhase::Closing
                    && entry.label == window
                    && entry.session.account_id == account
                    && entry.session.lease == lease
            });
        if matches {
            state.conversations_by_id.remove(conversation);
        }
        Ok(())
    }

    fn session_activation(&self, conversation: &str) -> Result<Option<serde_json::Value>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Native window registry is unavailable")?;
        Ok(state.conversations_by_id.get(conversation).map(|entry|
            serde_json::json!({ "conversationId": conversation, "accountId": entry.session.account_id, "accessKey": entry.session.access_key })))
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
                apply_badge(window.app_handle(), self.attention_total());
                if !self.should_preserve_agent_manifest() {
                    let _ = persist_agent_window_manifest(window.app_handle(), self);
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
    /// application quit/restart. A user closing one Chat window does not set
    /// this flag, so that window is removed from the next manifest snapshot.
    pub fn preserve_agent_manifest_on_exit(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.preserve_agent_manifest_on_exit = true;
        }
    }

    fn should_preserve_agent_manifest(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.preserve_agent_manifest_on_exit)
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

    fn register_agent_window(&self, label: &str, binding: &AgentBinding) {
        if let Ok(mut state) = self.state.lock() {
            state
                .agent_windows
                .insert(label.to_string(), binding.manifest_key());
        }
    }

    fn agent_window_manifest(&self) -> Result<Vec<String>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Native command router is unavailable")?;
        Ok(normalize_agent_window_manifest(
            state.agent_windows.values().cloned(),
        ))
    }

    /// Record one window's pending-approval count; returns the app-wide sum.
    fn set_attention(&self, label: &str, count: u32) -> u32 {
        if let Ok(mut state) = self.state.lock() {
            if count == 0 {
                state.attention_by_window.remove(label);
            } else {
                state.attention_by_window.insert(label.to_string(), count);
            }
        }
        self.attention_total()
    }

    fn attention_total(&self) -> u32 {
        self.state
            .lock()
            .map(|state| {
                state
                    .attention_by_window
                    .values()
                    .fold(0u32, |sum, count| sum.saturating_add(*count))
            })
            .unwrap_or(0)
    }

    /// Fence every conversation a closing window owns until cleanup finishes.
    pub fn begin_close_window(&self, label: &str) {
        if let Ok(mut state) = self.state.lock() {
            for entry in state
                .conversations_by_id
                .values_mut()
                .filter(|entry| entry.label == label)
            {
                entry.phase = ConversationOwnerPhase::Closing;
            }
        }
    }

    pub fn revoke_window_sessions(&self, label: &str) {
        let leases: Vec<_> = match self.state.lock() {
            Ok(state) => state
                .conversations_by_id
                .values()
                .filter(|entry| entry.label == label)
                .map(|entry| entry.session.live.clone())
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
            state.agent_windows.remove(label);
            state.attention_by_window.remove(label);
            state
                .conversations_by_id
                .retain(|_, entry| entry.label != label);
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
        app.emit_to(
            label.as_str(),
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
        if menu_id == MENU_WINDOW_LIBRARY {
            return app
                .emit_to(MAIN_WINDOW_LABEL, REOPEN_EVENT, ())
                .map_err(|error| format!("native_command_dispatch_failed: {error}"));
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

/// The Dock/taskbar badge is app-wide; any window applies it.
fn apply_badge<R: Runtime>(app: &AppHandle<R>, total: u32) {
    if let Some(window) = app.webview_windows().into_values().next() {
        let _ = window.set_badge_count((total > 0).then_some(i64::from(total)));
    }
}

fn persist_agent_window_manifest<R: Runtime>(
    app: &AppHandle<R>,
    router: &NativeCommandRouter,
) -> Result<(), String> {
    let _guard = agent_window_manifest_lock()
        .lock()
        .map_err(|_| "Agent window manifest lock is unavailable")?;
    let entries = router.agent_window_manifest()?;
    crate::desktop_state::update(app, |state| {
        state.open_agent_windows = entries;
        Ok(())
    })
}

/// Recreate the Chat windows left open by a previous process. The manifest
/// holds only access bindings; each restored WebView still performs normal
/// auth, account binding and Agent-list checks before it can run anything.
pub fn restore_agent_windows<R: Runtime>(
    app: &AppHandle<R>,
    router: &NativeCommandRouter,
) -> Result<usize, String> {
    let entries =
        normalize_agent_window_manifest(crate::desktop_state::read(app)?.open_agent_windows);
    let mut restored = 0;
    for entry in entries {
        if let Ok(binding) = AgentBinding::parse(&entry) {
            if open_agent_window_impl(app, &binding, router).is_ok() {
                restored += 1;
            }
        }
    }
    // Rewrite after filtering invalid entries so a corrupted manifest cannot
    // make every subsequent launch retry them.
    persist_agent_window_manifest(app, router)?;
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
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_some() {
        router.set_active_window(MAIN_WINDOW_LABEL);
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

/// This window's pending-approval count; the Dock badge shows the sum over
/// every Hatch window.
#[tauri::command]
pub fn set_window_attention(
    app: AppHandle,
    window: WebviewWindow,
    count: u32,
    router: State<'_, NativeCommandRouter>,
) -> Result<u32, String> {
    let total = router.set_attention(window.label(), count);
    apply_badge(&app, total);
    Ok(total)
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
            return Ok(claim);
        }
        // The owner window vanished without its Destroyed cleanup; reclaim.
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

/// Open — or focus, when it already exists — the Chat window of one Agent.
/// The command is async because Tauri documents async commands as the safe
/// cross-platform path for WebView2 window creation.
#[tauri::command]
pub async fn open_agent_window(
    app: AppHandle,
    product_id: Option<String>,
    entitlement_id: Option<String>,
    router: State<'_, NativeCommandRouter>,
) -> Result<OpenAgentWindowResult, String> {
    let binding = AgentBinding::new(product_id.as_deref(), entitlement_id.as_deref())?;
    let result = open_agent_window_impl(&app, &binding, router.inner())?;
    if !result.reused {
        // Best effort: a manifest failure must not make the window unusable.
        let _ = persist_agent_window_manifest(&app, router.inner());
    }
    Ok(result)
}

fn focus_agent_window<R: Runtime>(
    window: &WebviewWindow<R>,
    router: &NativeCommandRouter,
) -> Result<OpenAgentWindowResult, String> {
    // A still-loading hidden window is revealed by its renderer (app_ready)
    // or the reveal fallback; showing it here would flash a blank view.
    let shown = window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false);
    let _ = window.unminimize();
    if shown {
        window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|error| format!("native_window_focus_failed: {error}"))?;
        router.set_active_window(window.label());
    }
    Ok(OpenAgentWindowResult {
        window_label: window.label().to_string(),
        reused: true,
    })
}

fn open_agent_window_impl<R: Runtime>(
    app: &AppHandle<R>,
    binding: &AgentBinding,
    router: &NativeCommandRouter,
) -> Result<OpenAgentWindowResult, String> {
    let label = binding.window_label();
    if let Some(window) = app.get_webview_window(&label) {
        return focus_agent_window(&window, router);
    }
    let builder = prepare_window(
        app,
        WebviewWindowBuilder::new(app, label.clone(), WebviewUrl::App(binding.window_path())),
    )
    .title("Hatch")
    .inner_size(1180.0, 780.0)
    .min_inner_size(640.0, 600.0)
    .resizable(true)
    .on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            reveal_if_still_hidden(window);
        }
    });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    match builder.build() {
        Ok(_) => {
            router.register_agent_window(&label, binding);
            Ok(OpenAgentWindowResult {
                window_label: label,
                reused: false,
            })
        }
        // Two requests raced to create the same Agent window.
        Err(error) => match app.get_webview_window(&label) {
            Some(window) => focus_agent_window(&window, router),
            None => Err(format!("native_window_create_failed: {error}")),
        },
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
            "agent_window_binding_invalid: {field} must be a UUID v4"
        ));
    }
    Ok(value)
}

fn stable_hash64(bytes: &[u8]) -> u64 {
    // FNV-1a is used only for a stable, readable label suffix. It is not a
    // security boundary.
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
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
        .separator()
        .item(&item(COMMAND_VIEW_ZOOM_IN)?)
        .item(&item(COMMAND_VIEW_ZOOM_OUT)?)
        .item(&item(COMMAND_VIEW_ZOOM_RESET)?);
    #[cfg(target_os = "macos")]
    let view = view.separator().fullscreen();
    let view = view.build().map_err(menu_error)?;

    let conversation = SubmenuBuilder::new(app, "Conversation")
        .item(&item(COMMAND_CONVERSATION_RENAME)?)
        .item(&item(COMMAND_CONVERSATION_ARCHIVE)?)
        .separator()
        .item(&item(COMMAND_CONVERSATION_PREVIOUS)?)
        .item(&item(COMMAND_CONVERSATION_NEXT)?)
        .build()
        .map_err(menu_error)?;

    let run = SubmenuBuilder::new(app, "Run")
        .item(&item(COMMAND_RUN_STOP)?)
        .build()
        .map_err(menu_error)?;

    // Library, then one item per Agent (⌘1–⌘9 opens or focuses its Chat
    // window), then every open window.
    let library = MenuItemBuilder::with_id(MENU_WINDOW_LIBRARY, "Library")
        .accelerator(MENU_WINDOW_LIBRARY_ACCELERATOR)
        .build(app)
        .map_err(menu_error)?;
    let mut window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&library);
    for (index, name) in snapshot.state.agents.iter().enumerate() {
        let agent = MenuItemBuilder::with_id(COMMAND_AGENT_SELECT[index], name)
            .accelerator(AGENT_SELECT_ACCELERATORS[index])
            .enabled(snapshot.command_enabled(COMMAND_AGENT_SELECT[index]))
            .build(app)
            .map_err(menu_error)?;
        window = window.item(&agent);
    }
    window = window.separator();
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
        app_menu_command, application_command_definition, normalize_agent_window_manifest,
        sidebar_label, validate_conversation_id, AgentBinding, NativeCommandRouter,
        NativeCommandState, NativeMenuSnapshot, COMMAND_AGENT_SELECT, COMMAND_CONVERSATION_ARCHIVE,
        COMMAND_CONVERSATION_NEW, COMMAND_CONVERSATION_NEXT, COMMAND_CONVERSATION_PREVIOUS,
        COMMAND_CONVERSATION_RENAME, COMMAND_EDIT_FIND, COMMAND_RUN_STOP, COMMAND_SETTINGS_OPEN,
        COMMAND_SIDEBAR_TOGGLE, COMMAND_VIEW_ZOOM_IN, COMMAND_VIEW_ZOOM_OUT,
        COMMAND_VIEW_ZOOM_RESET, COMMAND_WORKSPACE_CHOOSE, MAX_RESTORED_AGENT_WINDOWS,
        MENU_WINDOW_LIBRARY,
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

    fn uuid(index: usize) -> String {
        format!("{index:08x}-e29b-41d4-a716-446655440000")
    }

    #[test]
    fn agent_window_labels_are_stable_portable_and_distinct_per_binding() {
        let owned = AgentBinding::new(Some(PRODUCT), None).unwrap();
        let again = AgentBinding::new(Some(&PRODUCT.to_uppercase()), None).unwrap();
        let acquired = AgentBinding::new(None, Some(ENTITLEMENT)).unwrap();
        let same_id_other_scope = AgentBinding::new(None, Some(PRODUCT)).unwrap();
        let label = owned.window_label();
        assert_eq!(label, again.window_label());
        assert_ne!(label, acquired.window_label());
        assert_ne!(label, same_id_other_scope.window_label());
        assert!(label.starts_with("agent-product-550e8400-"));
        assert!(label.chars().all(|character| character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || character == '-'));
        assert!(label.len() <= 64);
    }

    #[test]
    fn agent_window_route_carries_window_kind_and_exactly_one_access_scope() {
        let owned = AgentBinding::new(Some(PRODUCT), None).unwrap();
        assert_eq!(
            owned.window_path().to_string_lossy(),
            format!("index.html?window=chat&product_id={PRODUCT}")
        );
        let acquired = AgentBinding::new(None, Some(ENTITLEMENT)).unwrap();
        assert_eq!(
            acquired.window_path().to_string_lossy(),
            format!("index.html?window=chat&entitlement_id={ENTITLEMENT}")
        );
        assert_eq!(
            AgentBinding::parse(&acquired.manifest_key()).unwrap(),
            acquired
        );
    }

    #[test]
    fn agent_binding_rejects_both_neither_and_controlled_input() {
        assert!(AgentBinding::new(Some(PRODUCT), Some(ENTITLEMENT)).is_err());
        assert!(AgentBinding::new(None, None).is_err());
        assert!(AgentBinding::new(Some("not-a-uuid"), None).is_err());
        assert!(AgentBinding::new(None, Some(&format!("{ENTITLEMENT}\nx"))).is_err());
        assert!(AgentBinding::parse(&format!("creator_id:{PRODUCT}")).is_err());
    }

    #[test]
    fn agent_window_manifest_normalizes_entries_and_bounds_restore_count() {
        let mut entries = vec![
            format!("product_id:{PRODUCT}"),
            format!("product_id:{PRODUCT}"),
            format!("entitlement_id:{ENTITLEMENT}"),
            "product_id:bad\nvalue".to_string(),
            "conv_legacy".to_string(),
            String::new(),
        ];
        entries.extend(
            (0..(MAX_RESTORED_AGENT_WINDOWS + 4))
                .map(|index| format!("product_id:{}", uuid(index))),
        );
        let normalized = normalize_agent_window_manifest(entries);
        assert_eq!(normalized.len(), MAX_RESTORED_AGENT_WINDOWS);
        assert!(normalized.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(normalized
            .iter()
            .all(|entry| AgentBinding::parse(entry).is_ok()));
    }

    #[test]
    fn router_tracks_agent_windows_and_attention_per_window() {
        let router = NativeCommandRouter::default();
        let owned = AgentBinding::new(Some(PRODUCT), None).unwrap();
        let acquired = AgentBinding::new(None, Some(ENTITLEMENT)).unwrap();
        router.register_agent_window(&owned.window_label(), &owned);
        router.register_agent_window(&acquired.window_label(), &acquired);
        assert_eq!(router.agent_window_manifest().unwrap().len(), 2);
        assert_eq!(router.set_attention(&owned.window_label(), 2), 2);
        assert_eq!(router.set_attention(&acquired.window_label(), 3), 5);
        assert_eq!(router.set_attention(&owned.window_label(), 1), 4);
        router.clear_window(&acquired.window_label());
        assert_eq!(router.attention_total(), 1);
        assert_eq!(
            router.agent_window_manifest().unwrap(),
            vec![owned.manifest_key()]
        );
        assert_eq!(router.set_attention(&owned.window_label(), 0), 0);
    }

    #[test]
    fn conversation_registry_closing_fences_claims_and_contexts_until_cleanup() {
        let router = NativeCommandRouter::default();
        let claim = router
            .claim_session("account", "a", "product:a", "main")
            .unwrap();
        assert!(router.with_window_session("a", "main", || Ok(())).is_ok());
        assert!(router.with_window_session("a", "other", || Ok(())).is_err());
        router.begin_close_window("main");
        router
            .release_session("account", "a", "main", claim.lease.as_deref().unwrap())
            .unwrap();
        assert!(router
            .claim_session("account", "a", "product:a", "other")
            .is_err());
        assert!(router.with_window_session("a", "main", || Ok(())).is_err());
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
    fn released_session_no_longer_authorizes_tool_contexts() {
        let router = NativeCommandRouter::default();
        let claim = router
            .claim_session("account", "a", "product:a", "main")
            .unwrap();
        router
            .release_session("account", "a", "main", claim.lease.as_deref().unwrap())
            .unwrap();
        assert!(router.with_window_session("a", "main", || Ok(())).is_err());
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
    }

    #[test]
    fn menu_commands_are_semantic_and_include_agent_shortcuts() {
        for command_id in [
            COMMAND_CONVERSATION_NEW,
            COMMAND_EDIT_FIND,
            COMMAND_CONVERSATION_RENAME,
            COMMAND_CONVERSATION_ARCHIVE,
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
        for removed in [
            "conversation.search",
            "conversation.newWindow",
            "conversation.openWindow",
        ] {
            assert_eq!(app_menu_command(removed), None);
        }
        assert_eq!(app_menu_command("agent.select.1"), Some("agent.select.1"));
        assert_eq!(app_menu_command("agent.select.9"), Some("agent.select.9"));
        // Handled natively before command routing; never forwarded to React.
        assert_eq!(app_menu_command(MENU_WINDOW_LIBRARY), None);
        assert_eq!(app_menu_command("window.focus:main"), None);
        assert_eq!(app_menu_command("inspector.toggle"), None);
    }

    #[test]
    fn menu_enablement_follows_the_focused_window_projection() {
        let idle = snapshot(NativeCommandState::default());
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
        assert!(!unfocused.command_enabled(COMMAND_EDIT_FIND));
    }

    #[test]
    fn focused_window_menu_state_is_scoped_and_sidebar_check_flips() {
        let router = NativeCommandRouter::default();
        assert!(!router
            .menu_snapshot()
            .unwrap()
            .command_enabled(COMMAND_CONVERSATION_NEW));
        router.set_active_window("agent-a");
        router
            .replace_window_command_state(
                "agent-a",
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
        router.set_active_window("agent-b");
        assert!(router
            .menu_snapshot()
            .unwrap()
            .command_enabled(COMMAND_CONVERSATION_NEW));
        router.clear_window("agent-b");
        assert!(!router
            .menu_snapshot()
            .unwrap()
            .command_enabled(COMMAND_CONVERSATION_NEW));
    }

    #[test]
    fn command_state_is_a_complete_bounded_non_authority_snapshot() {
        let payload = serde_json::json!({
            "newConversationEnabled": true,
            "workspaceEnabled": true,
            "runStopEnabled": false,
            "sidebarVisible": false,
            "conversationEnabled": true,
            "agents": ["Writing Coach"]
        });
        let state: NativeCommandState = serde_json::from_value(payload.clone())
            .expect("the documented renderer payload must deserialize");
        assert!(state.validate().is_ok());
        let mut extra = payload.clone();
        extra["workspaceGrantId"] = "must-not-be-accepted-here".into();
        assert!(serde_json::from_value::<NativeCommandState>(extra).is_err());
        let mut legacy = payload;
        legacy["newWindowEnabled"] = true.into();
        assert!(serde_json::from_value::<NativeCommandState>(legacy).is_err());
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
