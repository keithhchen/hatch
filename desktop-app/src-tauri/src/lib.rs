use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::process::Command;
#[cfg(unix)]
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use hatch_local_runner::{LocalRunner, ToolCallRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, State, UserAttentionType, WebviewWindow,
    WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;

mod desktop_state;
mod window_commands;

#[cfg(target_os = "windows")]
mod workspace_grants;

#[cfg(target_os = "macos")]
use dispatch2::{run_on_main, MainThreadBound};
#[cfg(target_os = "macos")]
use objc2::{rc::Retained, runtime::Bool};
#[cfg(target_os = "macos")]
use objc2_app_kit::NSApplication;
#[cfg(target_os = "macos")]
use objc2_foundation::{
    NSData, NSPoint, NSRect, NSSize, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions,
    NSURL,
};
#[cfg(target_os = "macos")]
use objc2_quick_look_ui::QLPreviewPanel;
#[cfg(target_os = "macos")]
use quicklook::{PreviewItem, QuickLookPanel};
const LOCAL_TOOL_RESULT_TTL: Duration = Duration::from_secs(60);
const PENDING_TOOL_APPROVAL_TTL: Duration = Duration::from_secs(5 * 60);
const NATIVE_DROP_CONTEXT_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_NATIVE_DROP_CONTEXTS: usize = 8;
const MAX_NATIVE_DROP_CONTEXT_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_NATIVE_DROP_CONTEXT_BYTES: usize = 64 * 1024;
const MAX_NATIVE_DROP_CONTEXT_TOTAL_BYTES: usize = 24 * 1024 * 1024;
const MAX_NATIVE_DROP_CONTEXT_REQUESTS: usize = 8;
const PRODUCT_OPEN_EVENT: &str = "hatch://product-open";

#[cfg(target_os = "macos")]
static QUICK_LOOK_PANEL: OnceLock<Mutex<Option<MainThreadBound<QuickLookPanel>>>> = OnceLock::new();

struct StoredToolResult {
    created_at: Instant,
    payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ChangePermissionPolicy {
    AskBeforeChanges,
    AllowChanges,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowToolContext {
    workspace_grant_id: String,
    permission_policy: ChangePermissionPolicy,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct WindowToolCallKey {
    window_label: String,
    tool_call_id: String,
}

impl WindowToolCallKey {
    fn new(window_label: impl Into<String>, tool_call_id: impl Into<String>) -> Self {
        Self {
            window_label: window_label.into(),
            tool_call_id: tool_call_id.into(),
        }
    }

    // The local registries predate multi-window support and use String keys.
    // Prefixing with the byte length makes this unambiguous even if a server
    // happens to issue an id containing punctuation.
    fn registry_key(&self) -> String {
        format!(
            "{}:{}{}",
            self.window_label.len(),
            self.window_label,
            self.tool_call_id
        )
    }
}

#[derive(Clone, Debug)]
struct NativeToolCall {
    workspace_grant_id: String,
    request: Value,
    run_id: String,
    tool_call_id: String,
    name: String,
}

impl NativeToolCall {
    fn from_renderer_request(mut request: Value) -> Result<Self, String> {
        let parsed: ToolCallRequest = serde_json::from_value(request.clone()).map_err(to_string)?;
        if parsed.message_type != "tool_call.request" {
            return Err(format!(
                "invalid_tool_call: expected tool_call.request, got {}",
                parsed.message_type
            ));
        }
        if parsed.run_id.trim().is_empty() {
            return Err("invalid_tool_call: A local tool call requires run_id".into());
        }
        if parsed.tool_call_id.trim().is_empty() {
            return Err("invalid_tool_call: A local tool call requires tool_call_id".into());
        }
        if parsed.name.trim().is_empty() {
            return Err("invalid_tool_call: A local tool call requires name".into());
        }

        // `approval` is untrusted transport metadata. It is deliberately
        // stripped before the request reaches LocalRunner: only a native
        // pending-approval record can authorize a change or shell command.
        let Some(object) = request.as_object_mut() else {
            return Err("invalid_tool_call: A local tool call must be an object".into());
        };
        object.remove("approval");

        Ok(Self {
            workspace_grant_id: String::new(),
            request,
            run_id: parsed.run_id,
            tool_call_id: parsed.tool_call_id,
            name: parsed.name,
        })
    }

    fn is_change(&self) -> bool {
        matches!(
            self.name.as_str(),
            "file_write" | "file_patch" | "shell_exec"
        )
    }

    fn requires_native_approval(&self, policy: &ChangePermissionPolicy) -> bool {
        self.is_change() && *policy == ChangePermissionPolicy::AskBeforeChanges
    }
}

#[derive(Clone, Debug)]
struct PendingToolApproval {
    call: NativeToolCall,
    created_at: Instant,
}

#[derive(Default)]
struct NativeToolAuthorityState {
    contexts: HashMap<String, WindowToolContext>,
    pending: HashMap<WindowToolCallKey, PendingToolApproval>,
    // The workspace id is retained solely for close/revoke cleanup. The
    // executor gets the authoritative grant id captured at submission time.
    active: HashMap<WindowToolCallKey, String>,
}

#[derive(Clone, Default)]
struct NativeToolAuthority {
    state: Arc<Mutex<NativeToolAuthorityState>>,
}

enum ToolCallDisposition {
    Start(NativeToolCall),
    Pending,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallSubmission {
    status: &'static str,
    tool_call_id: String,
}

impl NativeToolAuthority {
    fn set_context(
        &self,
        window_label: &str,
        context: WindowToolContext,
    ) -> Result<Vec<(WindowToolCallKey, PendingToolApproval)>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native tool authority is unavailable")?;
        let changed = state.contexts.get(window_label) != Some(&context);
        state.contexts.insert(window_label.to_string(), context);
        Ok(if changed {
            take_pending_for_window(&mut state, window_label)
        } else {
            Vec::new()
        })
    }

    fn clear_window(
        &self,
        window_label: &str,
    ) -> Result<
        (
            Vec<(WindowToolCallKey, PendingToolApproval)>,
            Vec<WindowToolCallKey>,
        ),
        String,
    > {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native tool authority is unavailable")?;
        state.contexts.remove(window_label);
        let pending = take_pending_for_window(&mut state, window_label);
        let active = take_active_for_window(&mut state, window_label);
        Ok((pending, active))
    }

    fn clear_workspace_grant(
        &self,
        workspace_grant_id: &str,
    ) -> Result<
        (
            Vec<(WindowToolCallKey, PendingToolApproval)>,
            Vec<WindowToolCallKey>,
        ),
        String,
    > {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native tool authority is unavailable")?;
        state
            .contexts
            .retain(|_, context| context.workspace_grant_id != workspace_grant_id);
        let pending_keys = state
            .pending
            .iter()
            .filter_map(|(key, pending)| {
                (pending.call.workspace_grant_id == workspace_grant_id).then_some(key.clone())
            })
            .collect::<Vec<_>>();
        let pending = pending_keys
            .into_iter()
            .filter_map(|key| state.pending.remove_entry(&key))
            .collect();
        let active_keys = state
            .active
            .iter()
            .filter_map(|(key, grant_id)| (grant_id == workspace_grant_id).then_some(key.clone()))
            .collect::<Vec<_>>();
        for key in &active_keys {
            state.active.remove(key);
        }
        Ok((pending, active_keys))
    }

    fn submit(
        &self,
        key: WindowToolCallKey,
        mut call: NativeToolCall,
    ) -> Result<ToolCallDisposition, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native tool authority is unavailable")?;
        let context = state.contexts.get(&key.window_label).cloned().ok_or_else(|| {
            "window_tool_context_missing: Choose a workspace and set permissions before running local tools"
                .to_string()
        })?;
        if state.pending.contains_key(&key) || state.active.contains_key(&key) {
            return Err(format!(
                "local_tool_call_duplicate: Tool call is already pending or running: {}",
                key.tool_call_id
            ));
        }
        call.workspace_grant_id = context.workspace_grant_id.clone();
        if call.requires_native_approval(&context.permission_policy) {
            state.pending.insert(
                key,
                PendingToolApproval {
                    call,
                    created_at: Instant::now(),
                },
            );
            return Ok(ToolCallDisposition::Pending);
        }
        state.active.insert(key, context.workspace_grant_id);
        Ok(ToolCallDisposition::Start(call))
    }

    fn approve(&self, key: &WindowToolCallKey) -> Result<NativeToolCall, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native tool authority is unavailable")?;
        let pending = state.pending.remove(key).ok_or_else(|| {
            format!(
                "tool_approval_missing: No pending native approval for {}",
                key.tool_call_id
            )
        })?;
        state
            .active
            .insert(key.clone(), pending.call.workspace_grant_id.clone());
        Ok(pending.call)
    }

    fn deny(&self, key: &WindowToolCallKey) -> Result<PendingToolApproval, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native tool authority is unavailable")?;
        state.pending.remove(key).ok_or_else(|| {
            format!(
                "tool_approval_missing: No pending native approval for {}",
                key.tool_call_id
            )
        })
    }

    fn cancel_pending(
        &self,
        key: &WindowToolCallKey,
    ) -> Result<Option<PendingToolApproval>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native tool authority is unavailable")?;
        Ok(state.pending.remove(key))
    }

    fn finish(&self, key: &WindowToolCallKey) {
        if let Ok(mut state) = self.state.lock() {
            state.active.remove(key);
        }
    }

    fn expire_pending(&self) -> Result<Vec<(WindowToolCallKey, PendingToolApproval)>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native tool authority is unavailable")?;
        let expired_keys = state
            .pending
            .iter()
            .filter_map(|(key, pending)| {
                (pending.created_at.elapsed() >= PENDING_TOOL_APPROVAL_TTL).then_some(key.clone())
            })
            .collect::<Vec<_>>();
        Ok(expired_keys
            .into_iter()
            .filter_map(|key| state.pending.remove_entry(&key))
            .collect())
    }
}

fn take_pending_for_window(
    state: &mut NativeToolAuthorityState,
    window_label: &str,
) -> Vec<(WindowToolCallKey, PendingToolApproval)> {
    let keys = state
        .pending
        .keys()
        .filter(|key| key.window_label == window_label)
        .cloned()
        .collect::<Vec<_>>();
    keys.into_iter()
        .filter_map(|key| state.pending.remove_entry(&key))
        .collect()
}

fn take_active_for_window(
    state: &mut NativeToolAuthorityState,
    window_label: &str,
) -> Vec<WindowToolCallKey> {
    let keys = state
        .active
        .keys()
        .filter(|key| key.window_label == window_label)
        .cloned()
        .collect::<Vec<_>>();
    for key in &keys {
        state.active.remove(key);
    }
    keys
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct WorkspaceGrantInfo {
    grant_id: String,
    display_path: String,
}

/// A file dropped from Finder/Explorer is an explicit user gesture, but its
/// path must not become renderer authority. Rust snapshots a bounded UTF-8
/// projection at drop time, keeps only that projection behind a short-lived
/// opaque handle, and consumes it once when the composer sends.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDropContextInfo {
    context_id: String,
    asset_id: String,
    display_name: String,
    media_type: String,
    size: u64,
    sha256: String,
    is_image: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDropRejectionInfo {
    display_name: String,
    reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDropPickResult {
    files: Vec<NativeDropContextInfo>,
    rejected_files: Vec<NativeDropRejectionInfo>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDropContextContent {
    context_id: String,
    asset_id: String,
    display_name: String,
    media_type: String,
    source_bytes: u64,
    text: String,
    text_sha256: String,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

#[derive(Clone, Debug)]
struct StoredNativeDropContext {
    content: NativeDropContextContent,
    created_at: Instant,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct NativeDropContextKey {
    window_label: String,
    context_id: String,
}

#[derive(Clone, Default)]
struct NativeDropContextStore {
    state: Arc<Mutex<HashMap<NativeDropContextKey, StoredNativeDropContext>>>,
}

impl NativeDropContextStore {
    fn insert(
        &self,
        window_label: &str,
        path: &std::path::Path,
    ) -> Result<NativeDropContextInfo, String> {
        let context_id = format!("drop_{}", uuid::Uuid::new_v4().simple());
        let content = snapshot_native_drop_context(path, context_id.clone())?;
        let key = NativeDropContextKey {
            window_label: window_label.to_string(),
            context_id: context_id.clone(),
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native drop context store is unavailable")?;
        state.retain(|_, entry| entry.created_at.elapsed() < NATIVE_DROP_CONTEXT_TTL);
        while state
            .keys()
            .filter(|key| key.window_label == window_label)
            .count()
            >= MAX_NATIVE_DROP_CONTEXTS
        {
            let oldest = state
                .iter()
                .filter(|(key, _)| key.window_label == window_label)
                .min_by_key(|(_, entry)| entry.created_at)
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else { break };
            state.remove(&oldest);
        }
        let current_bytes = state
            .values()
            .filter(|entry| entry.content.context_id.starts_with("drop_"))
            .map(|entry| entry.content.source_bytes as usize)
            .sum::<usize>();
        if current_bytes.saturating_add(content.source_bytes as usize)
            > MAX_NATIVE_DROP_CONTEXT_TOTAL_BYTES
        {
            return Err(format!(
                "native_drop_context_too_large: Pending attachments exceed {} MiB total",
                MAX_NATIVE_DROP_CONTEXT_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        let info = NativeDropContextInfo {
            context_id: context_id.clone(),
            asset_id: content.asset_id.clone(),
            display_name: content.display_name.clone(),
            media_type: content.media_type.clone(),
            size: content.source_bytes,
            sha256: content
                .sha256
                .clone()
                .unwrap_or_else(|| content.text_sha256.clone()),
            is_image: content.media_type.starts_with("image/"),
        };
        state.insert(
            key,
            StoredNativeDropContext {
                content: content.clone(),
                created_at: Instant::now(),
            },
        );
        Ok(info)
    }

    fn consume(
        &self,
        window_label: &str,
        context_ids: Vec<String>,
    ) -> Result<Vec<NativeDropContextContent>, String> {
        if context_ids.len() > MAX_NATIVE_DROP_CONTEXT_REQUESTS {
            return Err("native_drop_context_invalid: Too many dropped files".into());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native drop context store is unavailable")?;
        state.retain(|_, entry| entry.created_at.elapsed() < NATIVE_DROP_CONTEXT_TTL);
        let mut keys = Vec::with_capacity(context_ids.len());
        let mut identifiers = std::collections::HashSet::new();
        for context_id in context_ids {
            if !valid_native_drop_context_id(&context_id) {
                return Err("native_drop_context_invalid: Invalid dropped file handle".into());
            }
            if !identifiers.insert(context_id.clone()) {
                return Err("native_drop_context_invalid: Duplicate dropped file handle".into());
            }
            let key = NativeDropContextKey {
                window_label: window_label.to_string(),
                context_id,
            };
            if !state.contains_key(&key) {
                return Err(
                    "native_drop_context_missing: The dropped file is no longer available".into(),
                );
            }
            keys.push(key);
        }
        let output = keys
            .iter()
            .filter_map(|key| state.get(key).map(|entry| entry.content.clone()))
            .collect::<Vec<_>>();
        if output.len() != keys.len() {
            return Err(
                "native_drop_context_missing: The dropped file is no longer available".into(),
            );
        }
        let total_bytes = output
            .iter()
            .map(|content| content.source_bytes as usize)
            .sum::<usize>();
        if total_bytes > MAX_NATIVE_DROP_CONTEXT_TOTAL_BYTES {
            return Err(format!(
                "native_drop_context_invalid: Dropped context exceeds {} KiB total",
                MAX_NATIVE_DROP_CONTEXT_TOTAL_BYTES / 1024
            ));
        }
        // Validate every requested handle before consuming any. A failed
        // multi-file send remains retryable instead of losing an arbitrary
        // prefix of the attachment chips.
        for key in keys {
            state.remove(&key);
        }
        Ok(output)
    }

    fn discard(&self, window_label: &str, context_ids: Vec<String>) -> Result<(), String> {
        if context_ids.len() > MAX_NATIVE_DROP_CONTEXT_REQUESTS {
            return Err("native_drop_context_invalid: Too many dropped files".into());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native drop context store is unavailable")?;
        state.retain(|_, entry| entry.created_at.elapsed() < NATIVE_DROP_CONTEXT_TTL);
        if context_ids
            .iter()
            .any(|context_id| !valid_native_drop_context_id(context_id))
        {
            return Err("native_drop_context_invalid: Invalid dropped file handle".into());
        }
        for context_id in context_ids {
            state.remove(&NativeDropContextKey {
                window_label: window_label.to_string(),
                context_id,
            });
        }
        Ok(())
    }

    fn clear_window(&self, window_label: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.retain(|key, _| key.window_label != window_label);
        }
    }
}

fn valid_native_drop_context_id(value: &str) -> bool {
    value.len() <= 96 && value.starts_with("drop_")
}

fn snapshot_native_drop_context(
    path: &std::path::Path,
    context_id: String,
) -> Result<NativeDropContextContent, String> {
    let metadata = fs::symlink_metadata(path).map_err(to_string)?;
    if !metadata.file_type().is_file() {
        return Err("native_drop_context_invalid: Only regular files can be attached".into());
    }
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "native_drop_context_invalid: The dropped file has no name".to_string())?;
    if display_name.chars().count() > 256 || display_name.chars().any(char::is_control) {
        return Err("native_drop_context_invalid: The dropped file name is not displayable".into());
    }
    let canonical_path = fs::canonicalize(path).map_err(to_string)?;
    let canonical_metadata = fs::symlink_metadata(&canonical_path).map_err(to_string)?;
    if !canonical_metadata.file_type().is_file() {
        return Err(
            "native_drop_context_invalid: The dropped item is no longer a regular file".into(),
        );
    }
    let mut file = fs::File::open(&canonical_path).map_err(to_string)?;
    if !file.metadata().map_err(to_string)?.is_file() {
        return Err(
            "native_drop_context_invalid: The dropped item is no longer a regular file".into(),
        );
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(
            canonical_metadata
                .len()
                .min(MAX_NATIVE_DROP_CONTEXT_SOURCE_BYTES),
        )
        .unwrap_or(MAX_NATIVE_DROP_CONTEXT_BYTES),
    );
    file.by_ref()
        .take(MAX_NATIVE_DROP_CONTEXT_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(to_string)?;
    if bytes.len() as u64 > MAX_NATIVE_DROP_CONTEXT_SOURCE_BYTES {
        return Err(format!(
            "native_drop_context_too_large: Attachments are limited to {} MiB",
            MAX_NATIVE_DROP_CONTEXT_SOURCE_BYTES / (1024 * 1024)
        ));
    }
    let source_bytes = bytes.len() as u64;
    let raw_sha256 = format!("{:x}", Sha256::digest(&bytes));
    let mut media_type = native_drop_media_type(path).to_string();
    let is_known_rich = native_drop_is_rich_media_type(&media_type);
    let projection_len = bytes.len().min(MAX_NATIVE_DROP_CONTEXT_BYTES);
    let (text, truncated, data_base64) = if is_known_rich {
        (String::new(), false, Some(BASE64_STANDARD.encode(&bytes)))
    } else {
        match decode_native_drop_text(
            &bytes[..projection_len],
            source_bytes > projection_len as u64,
        ) {
            Ok((text, truncated)) => (text, truncated, None),
            Err(_) => {
                if media_type == "application/octet-stream" {
                    media_type = "application/octet-stream".to_string();
                }
                (String::new(), false, Some(BASE64_STANDARD.encode(&bytes)))
            }
        }
    };
    let text_sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
    Ok(NativeDropContextContent {
        asset_id: context_id.clone(),
        context_id,
        display_name,
        media_type,
        source_bytes,
        text,
        text_sha256,
        truncated,
        data_base64,
        sha256: Some(raw_sha256),
    })
}

fn decode_native_drop_text(bytes: &[u8], truncated: bool) -> Result<(String, bool), String> {
    let text = match String::from_utf8(bytes.to_vec()) {
        Ok(value) => value,
        Err(error) if truncated && error.utf8_error().error_len().is_none() => {
            let valid_up_to = error.utf8_error().valid_up_to();
            String::from_utf8(error.into_bytes()[..valid_up_to].to_vec()).map_err(|_| {
                "native_drop_context_invalid: Attachment must be UTF-8 text".to_string()
            })?
        }
        Err(_) => return Err("native_drop_context_invalid: Attachment must be UTF-8 text".into()),
    };
    if text.contains('\0') {
        return Err("native_drop_context_invalid: Attachment must be text, not binary data".into());
    }
    Ok((text, truncated))
}

fn safe_drop_display_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() {
                '\u{FFFD}'
            } else {
                character
            }
        })
        .collect::<String>();
    sanitized.chars().take(255).collect()
}

fn native_drop_rejection_reason(error: &str) -> &'static str {
    if error.contains("native_drop_context_too_large") {
        "File is larger than the 16 MiB attachment limit."
    } else {
        "This item could not be attached as a local file."
    }
}

fn native_drop_media_type(path: &std::path::Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("md") | Some("mdx") | Some("markdown") => "text/markdown",
        Some("csv") | Some("tsv") => "text/csv",
        Some("json") => "application/json",
        Some("yaml") | Some("yml") => "application/yaml",
        Some("xml") => "application/xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("pdf") => "application/pdf",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("docm") => "application/vnd.ms-word.document.macroEnabled.12",
        Some("dotx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
        Some("dotm") => "application/vnd.ms-word.template.macroEnabled.12",
        Some("rtf") => "application/rtf",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("xlsm") => "application/vnd.ms-excel.sheet.macroEnabled.12",
        Some("xltx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
        Some("xltm") => "application/vnd.ms-excel.template.macroEnabled.12",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("pptm") => "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
        Some("potx") => "application/vnd.openxmlformats-officedocument.presentationml.template",
        Some("potm") => "application/vnd.ms-powerpoint.template.macroEnabled.12",
        Some("ppsx") => "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
        Some("ppsm") => "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
        Some("doc") => "application/msword",
        Some("xls") => "application/vnd.ms-excel",
        Some("ppt") => "application/vnd.ms-powerpoint",
        Some("rs") | Some("js") | Some("jsx") | Some("ts") | Some("tsx") | Some("toml") => {
            "text/plain"
        }
        _ => "application/octet-stream",
    }
}

fn native_drop_is_rich_media_type(media_type: &str) -> bool {
    media_type.starts_with("image/")
        || matches!(
            media_type,
            "application/pdf"
                | "application/msword"
                | "application/rtf"
                | "application/vnd.ms-excel"
                | "application/vnd.ms-powerpoint"
                | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                | "application/vnd.openxmlformats-officedocument.wordprocessingml.template"
                | "application/vnd.ms-word.document.macroEnabled.12"
                | "application/vnd.ms-word.template.macroEnabled.12"
                | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                | "application/vnd.openxmlformats-officedocument.spreadsheetml.template"
                | "application/vnd.ms-excel.sheet.macroEnabled.12"
                | "application/vnd.ms-excel.template.macroEnabled.12"
                | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                | "application/vnd.openxmlformats-officedocument.presentationml.template"
                | "application/vnd.openxmlformats-officedocument.presentationml.slideshow"
                | "application/vnd.ms-powerpoint.presentation.macroEnabled.12"
                | "application/vnd.ms-powerpoint.template.macroEnabled.12"
                | "application/vnd.ms-powerpoint.slideshow.macroEnabled.12"
        )
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceArtifactRequest {
    workspace_grant_id: String,
    relative_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WorkspaceGrantRecord {
    display_path: String,
    bookmark: Vec<u8>,
    #[serde(default)]
    security_scoped: bool,
    // This is an explicit platform discriminator rather than a capability.
    // A Windows record stores its canonical root below; macOS records retain
    // the original bookmark representation above.
    #[serde(default)]
    native_platform: String,
    // Windows paths are persisted as UTF-16 so the authoritative root remains
    // lossless even when it cannot be represented as UTF-8. The renderer only
    // receives `display_path`, never this value.
    #[serde(default)]
    canonical_path_utf16: Vec<u16>,
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

fn store_local_tool_result(tool_call_id: &str, payload: Value) -> Result<(), String> {
    let _registry = local_tool_registry_lock()
        .lock()
        .map_err(|_| "Local tool registry is unavailable")?;
    let mut results = local_tool_results()
        .lock()
        .map_err(|_| "Local tool result registry is unavailable")?;
    results.retain(|_, result| result.created_at.elapsed() < LOCAL_TOOL_RESULT_TTL);
    results.insert(
        tool_call_id.to_string(),
        StoredToolResult {
            created_at: Instant::now(),
            payload,
        },
    );
    Ok(())
}

fn complete_local_tool_job(tool_call_id: &str, payload: Value) {
    if let Ok(_registry) = local_tool_registry_lock().lock() {
        if let Ok(mut results) = local_tool_results().lock() {
            results.retain(|_, result| result.created_at.elapsed() < LOCAL_TOOL_RESULT_TTL);
            results.insert(
                tool_call_id.to_string(),
                StoredToolResult {
                    created_at: Instant::now(),
                    payload,
                },
            );
        }
        if let Ok(mut jobs) = local_tool_jobs().lock() {
            jobs.remove(tool_call_id);
        }
        if let Ok(mut cancellations) = local_tool_cancel_requests().lock() {
            cancellations.remove(tool_call_id);
        }
    }
}

fn native_tool_error(call: &NativeToolCall, code: &str, message: impl Into<String>) -> Value {
    serde_json::json!({
        "type": "tool_call.result",
        "run_id": call.run_id,
        "tool_call_id": call.tool_call_id,
        "status": "error",
        "error": {
            "code": code,
            "message": message.into(),
        }
    })
}

fn record_pending_outcomes(
    pending: Vec<(WindowToolCallKey, PendingToolApproval)>,
    code: &str,
    message: &str,
) {
    for (key, pending) in pending {
        let _ = store_local_tool_result(
            &key.registry_key(),
            native_tool_error(&pending.call, code, message),
        );
    }
}

fn expire_pending_approvals(authority: &NativeToolAuthority) -> Result<(), String> {
    let expired = authority.expire_pending()?;
    record_pending_outcomes(
        expired,
        "approval_timed_out",
        "The native approval request timed out",
    );
    Ok(())
}

fn start_native_tool_call(
    app: AppHandle,
    authority: NativeToolAuthority,
    key: WindowToolCallKey,
    call: NativeToolCall,
) -> Result<(), String> {
    // Local tools belong to the Desktop, but they must not block its WebView.
    // The result is stored as a short-lived job and polled by the same window
    // that submitted it.
    let registry_key = key.registry_key();
    let cancel = Arc::new(AtomicBool::new(false));
    if let Err(error) = register_local_tool_job(&registry_key, cancel.clone()) {
        authority.finish(&key);
        return Err(error);
    }

    std::thread::spawn(move || {
        let payload = match execute_tool_call_blocking(&app, &call, cancel) {
            Ok(result) => result,
            Err(error) => native_tool_error(&call, "local_runner_error", error),
        };
        complete_local_tool_job(&registry_key, payload);
        authority.finish(&key);
    });

    Ok(())
}

fn signal_local_tool_cancellation(tool_call_id: &str) -> Result<bool, String> {
    let _registry = local_tool_registry_lock()
        .lock()
        .map_err(|_| "Local tool registry is unavailable")?;
    let result_is_ready = local_tool_results()
        .lock()
        .map_err(|_| "Local tool result registry is unavailable")?
        .contains_key(tool_call_id);
    if result_is_ready {
        return Ok(false);
    }
    let cancel = local_tool_jobs()
        .lock()
        .map_err(|_| "Local tool job registry is unavailable")?
        .get(tool_call_id)
        .cloned();
    if let Some(cancel) = cancel {
        cancel.store(true, Ordering::Release);
        return Ok(true);
    }
    let mut cancellations = local_tool_cancel_requests()
        .lock()
        .map_err(|_| "Local tool cancellation registry is unavailable")?;
    cancellations.retain(|_, created_at| created_at.elapsed() < LOCAL_TOOL_RESULT_TTL);
    cancellations.insert(tool_call_id.to_string(), Instant::now());
    Ok(true)
}

fn cancel_registered_local_tool_job(tool_call_id: &str) -> Result<bool, String> {
    let signalled = signal_local_tool_cancellation(tool_call_id)?;
    if !signalled {
        return Ok(false);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let still_running = {
            let _registry = local_tool_registry_lock()
                .lock()
                .map_err(|_| "Local tool registry is unavailable")?;
            local_tool_jobs()
                .lock()
                .map_err(|_| "Local tool job registry is unavailable")?
                .contains_key(tool_call_id)
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
}

fn cancel_active_tool_calls(keys: &[WindowToolCallKey]) {
    for key in keys {
        let _ = signal_local_tool_cancellation(&key.registry_key());
    }
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
fn read_task_settings(app: AppHandle, task_id: String) -> Result<Option<Value>, String> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Ok(None);
    }
    let state = desktop_state::read(&app)?;
    let Some(task) = state.tasks.get(task_id) else {
        return Ok(None);
    };
    let workspace_grant = task
        .workspace_grant_id
        .as_deref()
        .and_then(|grant_id| {
            state
                .workspace_grants
                .iter()
                .find(|grant| grant.grant_id == grant_id)
        })
        .map(|grant| {
            serde_json::json!({
                "grant_id": grant.grant_id,
                "display_path": grant.display_path
            })
        });
    Ok(Some(serde_json::json!({
        "taskId": task_id,
        "entitlementId": task.entitlement_id,
        "creatorId": task.creator_id,
        "productId": task.product_id,
        "workspaceGrant": workspace_grant,
        "permissionMode": task.permission_mode
    })))
}

#[tauri::command]
fn read_native_drop_contexts(
    window: WebviewWindow,
    context_ids: Vec<String>,
    store: State<'_, NativeDropContextStore>,
) -> Result<Vec<NativeDropContextContent>, String> {
    store.inner().consume(window.label(), context_ids)
}

#[tauri::command]
async fn pick_native_drop_files(
    window: WebviewWindow,
    store: State<'_, NativeDropContextStore>,
) -> Result<NativeDropPickResult, String> {
    let selected = rfd::AsyncFileDialog::new()
        .set_title("Attach context files")
        .set_parent(&window)
        .pick_files()
        .await;
    let Some(handles) = selected else {
        return Ok(NativeDropPickResult {
            files: Vec::new(),
            rejected_files: Vec::new(),
        });
    };
    let mut files = Vec::new();
    let mut rejected_files = Vec::new();
    for handle in handles {
        // Invalid UTF-8/binary/oversized files are rejected at the same Rust
        // boundary as Finder/Explorer drops. Do not expose their path or raw
        // bytes to the renderer; the UI can keep the picker path retryable.
        match store.inner().insert(window.label(), handle.path()) {
            Ok(info) => files.push(info),
            Err(error) => rejected_files.push(NativeDropRejectionInfo {
                display_name: safe_drop_display_name(&handle.file_name()),
                reason: native_drop_rejection_reason(&error).to_string(),
            }),
        }
        if files.len() >= MAX_NATIVE_DROP_CONTEXTS {
            break;
        }
    }
    Ok(NativeDropPickResult {
        files,
        rejected_files,
    })
}

#[tauri::command]
fn discard_native_drop_contexts(
    window: WebviewWindow,
    context_ids: Vec<String>,
    store: State<'_, NativeDropContextStore>,
) -> Result<(), String> {
    store.inner().discard(window.label(), context_ids)
}

#[tauri::command]
async fn pick_workspace_folder(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<WorkspaceGrantInfo>, String> {
    let selected = rfd::AsyncFileDialog::new()
        .set_title("Choose a workspace")
        .set_parent(&window)
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

/// Reveal an artifact through the operating system without accepting an
/// arbitrary renderer path as authority. The renderer may only provide a
/// relative presentation path together with the opaque grant selected for
/// this window; Rust re-resolves the grant and checks canonical containment
/// immediately before invoking Finder/Explorer.
#[tauri::command]
fn reveal_workspace_artifact(
    app: AppHandle,
    request: WorkspaceArtifactRequest,
) -> Result<(), String> {
    let path =
        resolve_workspace_artifact_path(&app, &request.workspace_grant_id, &request.relative_path)?;
    #[cfg(target_os = "macos")]
    let status = Command::new("/usr/bin/open").arg("-R").arg(&path).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open")
        .arg(path.parent().unwrap_or(&path))
        .status();
    status
        .map_err(|error| format!("artifact_reveal_failed: {error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| {
            "artifact_reveal_failed: The system file browser could not reveal the artifact".into()
        })
}

/// Open an artifact with the platform's native preview/default-file action.
///
/// The renderer still supplies only an opaque workspace grant and a relative
/// path. The path is resolved and contained by `resolve_workspace_artifact_path`
/// immediately before handing it to the operating system. On macOS, Apple's
/// `QLPreviewPanel` is the primary path and `qlmanage -p` is retained as a
/// fallback; Windows uses the documented
/// ShellExecute `open` verb so the user's default file association decides what
/// opens. Other Unix desktops use `xdg-open` as their native default handler.
#[tauri::command]
fn open_workspace_artifact(
    app: AppHandle,
    request: WorkspaceArtifactRequest,
) -> Result<(), String> {
    let path =
        resolve_workspace_artifact_path(&app, &request.workspace_grant_id, &request.relative_path)?;
    open_workspace_artifact_with_platform(&path)
}

fn open_workspace_artifact_with_platform(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return open_workspace_artifact_macos(path);
    #[cfg(target_os = "windows")]
    return open_workspace_artifact_windows(path);
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    #[cfg(all(unix, not(target_os = "macos")))]
    status
        .map_err(|error| format!("artifact_open_failed: {error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| {
            "artifact_open_failed: The native file preview could not open the artifact".into()
        })
}

#[cfg(target_os = "macos")]
fn open_workspace_artifact_macos(path: &std::path::Path) -> Result<(), String> {
    let path = path.to_path_buf();
    let panel_path = path.clone();
    let panel_result = run_on_main(move |mtm| {
        let panel_store = QUICK_LOOK_PANEL.get_or_init(|| Mutex::new(None));
        let mut panel = panel_store
            .lock()
            .map_err(|_| "artifact_open_failed: Quick Look panel state was poisoned".to_string())?;

        if panel.is_none() {
            let quicklook = QuickLookPanel::shared().ok_or_else(|| {
                "artifact_open_failed: Quick Look panel is unavailable on this host".to_string()
            })?;
            *panel = Some(MainThreadBound::new(quicklook, mtm.clone()));
        }

        let quicklook = panel
            .as_ref()
            .expect("Quick Look panel initialized")
            .get(mtm);
        let item = PreviewItem::from_file_url(&panel_path, None).ok_or_else(|| {
            "artifact_open_failed: Quick Look could not represent the artifact path".to_string()
        })?;
        quicklook.set_items(vec![item]);
        quicklook.reload_if_dirty();
        NSApplication::sharedApplication(mtm.clone()).activate();
        quicklook.show();
        // QLPreviewPanel can retain a stale off-screen frame after a previous
        // host session. Re-center and order the shared AppKit panel explicitly
        // so this command always produces an observable native window.
        if let Some(native_panel) = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) } {
            native_panel.setFloatingPanel(true);
            native_panel.setHidesOnDeactivate(false);
            native_panel.setBecomesKeyOnlyIfNeeded(false);
            native_panel.setFrame_display(
                NSRect::new(NSPoint::new(600.0, 200.0), NSSize::new(760.0, 560.0)),
                true,
            );
            native_panel.orderFrontRegardless();
            native_panel.makeKeyAndOrderFront(None);
        }
        Ok::<(), String>(())
    });

    match panel_result {
        Ok(()) => Ok(()),
        Err(panel_error) => Command::new("/usr/bin/qlmanage")
            .arg("-p")
            .arg(path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|fallback_error| {
                format!("{panel_error}; qlmanage fallback failed: {fallback_error}")
            }),
    }
}

#[cfg(target_os = "windows")]
fn open_workspace_artifact_windows(path: &std::path::Path) -> Result<(), String> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;

    let operation: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(once(0))
        .collect();
    let file: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
    // ShellExecuteW returns a value greater than 32 on success. Passing the
    // path as a wide string avoids command-shell parsing and quoting issues.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if (result as usize) > 32 {
        Ok(())
    } else {
        Err("artifact_open_failed: Windows could not open the artifact".into())
    }
}

#[tauri::command]
fn request_window_attention(window: WebviewWindow) -> Result<(), String> {
    window
        .request_user_attention(Some(UserAttentionType::Informational))
        .map_err(|error| format!("window_attention_failed: {error}"))
}

fn resolve_workspace_artifact_path(
    app: &AppHandle,
    workspace_grant_id: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let relative_path = validate_artifact_relative_path(relative_path)?;
    let workspace = resolve_scoped_workspace_grant(app, workspace_grant_id)?;
    let root = std::fs::canonicalize(&workspace.path).map_err(|error| {
        format!("workspace_grant_invalid: Could not resolve workspace root: {error}")
    })?;
    let candidate = workspace.path.join(relative_path);
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|error| format!("artifact_path_invalid: Artifact does not exist: {error}"))?;
    if !canonical.starts_with(&root) {
        return Err("artifact_path_invalid: Artifact escapes the selected workspace".into());
    }
    Ok(canonical)
}

fn validate_artifact_relative_path(relative_path: &str) -> Result<&std::path::Path, String> {
    let relative = relative_path.trim();
    if relative.is_empty() {
        return Err("artifact_path_invalid: A relative artifact path is required".into());
    }
    let relative_path = std::path::Path::new(relative);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                std::path::Component::Prefix(_)
                    | std::path::Component::RootDir
                    | std::path::Component::ParentDir
            )
        })
    {
        return Err(
            "artifact_path_invalid: Artifact paths must stay relative to the workspace".into(),
        );
    }
    Ok(relative_path)
}

#[tauri::command]
fn set_window_tool_context(
    app: AppHandle,
    window: WebviewWindow,
    task_id: String,
    workspace_grant_id: String,
    permission_policy: ChangePermissionPolicy,
    authority: State<'_, NativeToolAuthority>,
) -> Result<WorkspaceGrantInfo, String> {
    let task_id = task_id.trim().to_string();
    if task_id.is_empty() {
        return Err("window_tool_context_missing: A Task/Conversation ID is required".into());
    }
    // Resolve and probe the grant before installing it as a window authority.
    // A renderer can display a path, but it cannot turn that path into a grant.
    let scoped = resolve_scoped_workspace_grant(&app, &workspace_grant_id)?;
    let info = WorkspaceGrantInfo {
        grant_id: scoped.grant_id.clone(),
        display_path: scoped.path.to_string_lossy().to_string(),
    };
    let invalidated = authority.set_context(
        window.label(),
        WindowToolContext {
            workspace_grant_id,
            permission_policy: permission_policy.clone(),
        },
    )?;
    let persisted_permission = match permission_policy {
        ChangePermissionPolicy::AskBeforeChanges => "ask-before-changes",
        ChangePermissionPolicy::AllowChanges => "allow-changes",
    }
    .to_string();
    let persisted_grant_id = info.grant_id.clone();
    desktop_state::update(&app, |state| {
        let task =
            state
                .tasks
                .entry(task_id.clone())
                .or_insert_with(|| desktop_state::DesktopTaskState {
                    entitlement_id: String::new(),
                    creator_id: None,
                    product_id: None,
                    workspace_grant_id: None,
                    permission_mode: "ask-before-changes".into(),
                });
        task.workspace_grant_id = Some(persisted_grant_id);
        task.permission_mode = persisted_permission;
        let window_state = state.windows.entry(window.label().to_string()).or_default();
        window_state.conversation_id = Some(task_id);
        Ok(())
    })?;
    record_pending_outcomes(
        invalidated,
        "tool_context_changed",
        "The workspace or permission policy changed before this tool call was approved",
    );
    Ok(info)
}

#[tauri::command]
fn clear_window_tool_context(
    window: WebviewWindow,
    authority: State<'_, NativeToolAuthority>,
) -> Result<(), String> {
    let (pending, active) = authority.clear_window(window.label())?;
    record_pending_outcomes(
        pending,
        "tool_context_cleared",
        "The window no longer has permission to run this tool call",
    );
    cancel_active_tool_calls(&active);
    Ok(())
}

#[tauri::command]
fn revoke_workspace_grant(
    app: AppHandle,
    workspace_grant_id: String,
    authority: State<'_, NativeToolAuthority>,
) -> Result<(), String> {
    remove_workspace_grant(&app, &workspace_grant_id)?;
    let (pending, active) = authority.clear_workspace_grant(&workspace_grant_id)?;
    record_pending_outcomes(
        pending,
        "workspace_grant_revoked",
        "The workspace permission was revoked before this tool call was approved",
    );
    cancel_active_tool_calls(&active);
    Ok(())
}

#[tauri::command]
fn execute_tool_call(
    app: AppHandle,
    window: WebviewWindow,
    request: Value,
    authority: State<'_, NativeToolAuthority>,
) -> Result<ToolCallSubmission, String> {
    let authority = authority.inner().clone();
    expire_pending_approvals(&authority)?;
    let call = NativeToolCall::from_renderer_request(request)?;
    let key = WindowToolCallKey::new(window.label(), call.tool_call_id.clone());
    match authority.submit(key.clone(), call)? {
        ToolCallDisposition::Start(call) => {
            start_native_tool_call(app, authority, key.clone(), call)?;
            Ok(ToolCallSubmission {
                status: "started",
                tool_call_id: key.tool_call_id,
            })
        }
        ToolCallDisposition::Pending => Ok(ToolCallSubmission {
            status: "approval_required",
            tool_call_id: key.tool_call_id,
        }),
    }
}

#[tauri::command]
fn approve_pending_tool_call(
    app: AppHandle,
    window: WebviewWindow,
    tool_call_id: String,
    authority: State<'_, NativeToolAuthority>,
) -> Result<ToolCallSubmission, String> {
    let authority = authority.inner().clone();
    expire_pending_approvals(&authority)?;
    let key = WindowToolCallKey::new(window.label(), tool_call_id);
    let call = authority.approve(&key)?;
    start_native_tool_call(app, authority, key.clone(), call)?;
    Ok(ToolCallSubmission {
        status: "started",
        tool_call_id: key.tool_call_id,
    })
}

#[tauri::command]
fn deny_pending_tool_call(
    window: WebviewWindow,
    tool_call_id: String,
    authority: State<'_, NativeToolAuthority>,
) -> Result<ToolCallSubmission, String> {
    let authority = authority.inner().clone();
    expire_pending_approvals(&authority)?;
    let key = WindowToolCallKey::new(window.label(), tool_call_id);
    let pending = authority.deny(&key)?;
    store_local_tool_result(
        &key.registry_key(),
        native_tool_error(
            &pending.call,
            "approval_denied",
            "The native user denied this tool call",
        ),
    )?;
    Ok(ToolCallSubmission {
        status: "denied",
        tool_call_id: key.tool_call_id,
    })
}

#[tauri::command]
async fn cancel_tool_call(
    window: WebviewWindow,
    tool_call_id: String,
    authority: State<'_, NativeToolAuthority>,
) -> Result<bool, String> {
    let authority = authority.inner().clone();
    expire_pending_approvals(&authority)?;
    let key = WindowToolCallKey::new(window.label(), tool_call_id);
    if let Some(pending) = authority.cancel_pending(&key)? {
        store_local_tool_result(
            &key.registry_key(),
            native_tool_error(
                &pending.call,
                "cancelled",
                "The native user cancelled this pending tool call",
            ),
        )?;
        return Ok(true);
    }
    let registry_key = key.registry_key();
    tauri::async_runtime::spawn_blocking(move || cancel_registered_local_tool_job(&registry_key))
        .await
        .map_err(to_string)?
}

#[tauri::command]
fn poll_tool_call(
    window: WebviewWindow,
    tool_call_id: String,
    authority: State<'_, NativeToolAuthority>,
) -> Result<Option<Value>, String> {
    expire_pending_approvals(authority.inner())?;
    let key = WindowToolCallKey::new(window.label(), tool_call_id);
    let _registry = local_tool_registry_lock()
        .lock()
        .map_err(|_| "Local tool registry is unavailable")?;
    let mut results = local_tool_results()
        .lock()
        .map_err(|_| "Local tool result registry is unavailable")?;
    results.retain(|_, result| result.created_at.elapsed() < LOCAL_TOOL_RESULT_TTL);
    Ok(results
        .remove(&key.registry_key())
        .map(|result| result.payload))
}

#[tauri::command]
fn read_auth_token(app: AppHandle) -> Result<Option<String>, String> {
    Ok(desktop_state::read(&app)?
        .session
        .map(|session| session.token))
}

#[tauri::command]
fn write_auth_token(
    app: AppHandle,
    token: String,
    expires_at: Option<String>,
) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("A non-empty session token is required".into());
    }
    if token.len() > 4096 || expires_at.as_deref().is_some_and(|value| value.len() > 128) {
        return Err("The saved session is too large".into());
    }
    let token = token.trim().to_string();
    desktop_state::update(&app, |state| {
        state.session = Some(desktop_state::DesktopSessionState { token, expires_at });
        Ok(())
    })
}

#[tauri::command]
fn clear_auth_token(window: WebviewWindow) -> Result<(), String> {
    let result = desktop_state::update(window.app_handle(), |state| {
        state.session = None;
        Ok(())
    });
    // The token itself never crosses this event. Other conversation windows
    // must drop their in-memory session after logout/401, even when clearing
    // the native store reports an error in a signed release build.
    let _ = window.app_handle().emit(
        "hatch://auth-session",
        serde_json::json!({
            "kind": "cleared",
            "sourceWindow": window.label()
        }),
    );
    result
}

#[tauri::command]
fn read_app_settings(app: AppHandle) -> Result<String, String> {
    let state = desktop_state::read(&app)?;
    serde_json::to_string(&serde_json::json!({
        "schema_version": 1,
        "app": { "language": state.preferences.language },
        "accounts": {}
    }))
    .map_err(to_string)
}

#[tauri::command]
fn write_app_settings(app: AppHandle, settings: String) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(&settings).map_err(to_string)?;
    if !parsed.is_object() {
        return Err("Desktop settings must be a JSON object".into());
    }
    let language = parsed
        .pointer("/app/language")
        .and_then(Value::as_str)
        .unwrap_or("system")
        .to_string();
    desktop_state::update(&app, |state| {
        state.preferences.language = language;
        Ok(())
    })
}

/// Atomically patch one account's non-secret preferences without replacing
/// the whole settings document. Each renderer owns a separate in-memory
/// settings snapshot; a full-document write from two native windows could
/// otherwise erase the other window's latest profile update (or its window
/// namespace) with a last-writer-wins race.
#[tauri::command]
fn patch_app_settings(app: AppHandle, patch: Value) -> Result<(), String> {
    let object = patch
        .as_object()
        .ok_or_else(|| "Desktop settings patch must be a JSON object".to_string())?;
    if let Some(app_patch) = object.get("app").and_then(Value::as_object) {
        let language = app_patch
            .get("set")
            .and_then(Value::as_object)
            .and_then(|set| set.get("language"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let remove_language = app_patch
            .get("remove")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|value| value.as_str() == Some("language"));
        desktop_state::update(&app, |state| {
            if let Some(language) = language {
                state.preferences.language = language;
            } else if remove_language {
                state.preferences.language = "system".into();
            }
            Ok(())
        })?;
        return Ok(());
    }
    if object.get("profileId").is_none() {
        return Err("Desktop settings patch requires app or profileId".into());
    }
    // Profile identity and values are intentionally not stored on the device.
    // Task/workspace preferences are persisted by `patch_window_settings`.
    Ok(())
}

#[tauri::command]
fn read_window_settings(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    let state = desktop_state::read(&app)?;
    let saved_window = state
        .windows
        .get(window.label())
        .cloned()
        .unwrap_or_default();
    let task = saved_window
        .conversation_id
        .as_ref()
        .and_then(|conversation_id| state.tasks.get(conversation_id));
    let workspace_grant = task
        .and_then(|task| task.workspace_grant_id.as_deref())
        .and_then(|grant_id| {
            state
                .workspace_grants
                .iter()
                .find(|grant| grant.grant_id == grant_id)
        })
        .map(|grant| {
            serde_json::json!({
                "grant_id": grant.grant_id,
                "display_path": grant.display_path
            })
        });
    Ok(serde_json::json!({
        "canonicalState": true,
        "context": {
            "conversationId": saved_window.conversation_id,
            "entitlementId": task.map(|task| task.entitlement_id.clone()).or(saved_window.entitlement_id),
            "creatorId": task.and_then(|task| task.creator_id.clone()),
            "productId": task.and_then(|task| task.product_id.clone()),
            "workspaceGrant": workspace_grant,
            "permissionMode": task.map(|task| task.permission_mode.clone()).unwrap_or_else(|| "ask-before-changes".into())
        },
        "frame": saved_window.frame,
        "layout": {
            "sidebarPreference": if saved_window.layout.sidebar_open { "open" } else { "closed" },
            "inspectorPreference": if saved_window.layout.inspector_open { "open" } else { "closed" },
            "sidebarWidth": saved_window.layout.sidebar_width,
            "inspectorWidth": saved_window.layout.inspector_width,
            "zoom": saved_window.layout.zoom
        }
    }))
}

#[tauri::command]
fn patch_window_settings(
    app: AppHandle,
    window: WebviewWindow,
    patch: Value,
) -> Result<Value, String> {
    let patch = patch
        .as_object()
        .ok_or_else(|| "Window settings patch must be a JSON object".to_string())?
        .clone();
    desktop_state::update(&app, |state| {
        let saved_window = state.windows.entry(window.label().to_string()).or_default();
        if let Some(frame) = patch.get("frame") {
            saved_window.frame = (!frame.is_null()).then(|| frame.clone());
        }
        if let Some(layout) = patch.get("layout").and_then(Value::as_object) {
            if let Some(value) = layout.get("sidebarPreference").and_then(Value::as_str) {
                saved_window.layout.sidebar_open = value == "open";
            }
            if let Some(value) = layout.get("inspectorPreference").and_then(Value::as_str) {
                saved_window.layout.inspector_open = value == "open";
            }
            if let Some(value) = layout.get("sidebarWidth") {
                saved_window.layout.sidebar_width = value.as_f64();
            }
            if let Some(value) = layout.get("inspectorWidth") {
                saved_window.layout.inspector_width = value.as_f64();
            }
            if let Some(value) = layout.get("zoom") {
                saved_window.layout.zoom = value.as_f64();
            }
        }
        if let Some(context) = patch.get("context").and_then(Value::as_object) {
            if let Some(value) = context.get("conversationId") {
                saved_window.conversation_id = value
                    .as_str()
                    .map(str::to_string)
                    .filter(|value| !value.is_empty());
            }
            if let Some(value) = context.get("entitlementId") {
                saved_window.entitlement_id = value
                    .as_str()
                    .map(str::to_string)
                    .filter(|value| !value.is_empty());
            }
            if let Some(conversation_id) = saved_window.conversation_id.clone() {
                let task = state.tasks.entry(conversation_id).or_insert_with(|| {
                    desktop_state::DesktopTaskState {
                        entitlement_id: String::new(),
                        creator_id: None,
                        product_id: None,
                        workspace_grant_id: None,
                        permission_mode: "ask-before-changes".into(),
                    }
                });
                if let Some(value) = context.get("entitlementId").and_then(Value::as_str) {
                    task.entitlement_id = value.to_string();
                }
                if let Some(value) = context.get("creatorId") {
                    task.creator_id = value
                        .as_str()
                        .map(str::to_string)
                        .filter(|value| !value.is_empty());
                }
                if let Some(value) = context.get("productId") {
                    task.product_id = value
                        .as_str()
                        .map(str::to_string)
                        .filter(|value| !value.is_empty());
                }
                if let Some(value) = context.get("permissionMode").and_then(Value::as_str) {
                    task.permission_mode = value.to_string();
                }
                if let Some(value) = context.get("workspaceGrant") {
                    task.workspace_grant_id = value
                        .get("grant_id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .filter(|value| !value.is_empty());
                }
            }
        }
        Ok(())
    })?;
    read_window_settings(app, window)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !is_allowed_browse_url(&url) {
        return Err("Only the Hatch Creator Agent catalog can be opened from this action".into());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("/usr/bin/open").arg(&url).status();
    #[cfg(target_os = "windows")]
    return open_external_url_windows(&url);
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(&url).status();

    #[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
    status
        .map_err(to_string)?
        .success()
        .then_some(())
        .ok_or_else(|| "The system browser could not be opened".into())
}

#[cfg(target_os = "windows")]
fn open_external_url_windows(url: &str) -> Result<(), String> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;

    let operation: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(once(0))
        .collect();
    let target: Vec<u16> = std::ffi::OsStr::new(url)
        .encode_wide()
        .chain(once(0))
        .collect();
    // The URL has already passed the allow-list check. Passing it directly to
    // ShellExecuteW avoids `cmd /C start` parsing, where query-string
    // punctuation could otherwise become shell syntax.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    ((result as usize) > 32)
        .then_some(())
        .ok_or_else(|| "The system browser could not be opened".into())
}

fn is_allowed_browse_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.host_str() == Some("hatch.tokenquadrant.cn")
        && (parsed.path() == "/explore"
            || is_uuid_route(parsed.path(), "/products/")
            || is_uuid_route(parsed.path(), "/creators/"))
}

fn is_uuid_route(path: &str, prefix: &str) -> bool {
    let value = path.strip_prefix(prefix).unwrap_or_default();
    value.len() == 36
        && value
            .as_bytes()
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
        && value.as_bytes().get(14) == Some(&b'4')
        && matches!(value.as_bytes().get(19), Some(b'8' | b'9' | b'a' | b'b'))
}

fn normalize_product_open_url(url: &url::Url) -> Option<String> {
    if url.scheme() != "hatch" || url.host_str() != Some("products") || url.path() != "/open" {
        return None;
    }
    let entitlement_id = url
        .query_pairs()
        .find(|(key, _)| key == "entitlement_id")
        .map(|(_, value)| value.into_owned())?;
    let product_id = url
        .query_pairs()
        .find(|(key, _)| key == "product_id")
        .map(|(_, value)| value.into_owned())?;
    if !is_uuid_route(&format!("/{entitlement_id}"), "/")
        || !is_uuid_route(&format!("/{product_id}"), "/")
    {
        return None;
    }
    if let Some(creator_id) = url
        .query_pairs()
        .find(|(key, _)| key == "creator_id")
        .map(|(_, value)| value.into_owned())
    {
        if !is_uuid_route(&format!("/{creator_id}"), "/") {
            return None;
        }
    }
    Some(url.to_string())
}

#[tauri::command]
fn read_product_open_links(app: AppHandle) -> Result<Vec<String>, String> {
    let urls = app
        .deep_link()
        .get_current()
        .map_err(to_string)?
        .unwrap_or_default();
    Ok(urls.iter().filter_map(normalize_product_open_url).collect())
}

fn workspace_grant_record(app: &AppHandle, grant_id: &str) -> Result<WorkspaceGrantRecord, String> {
    if grant_id.trim().is_empty() {
        return Err(
            "workspace_grant_missing: Choose a workspace folder before granting access".into(),
        );
    }
    desktop_state::read(app)?
        .workspace_grants
        .into_iter()
        .find(|grant| grant.grant_id == grant_id)
        .map(|grant| WorkspaceGrantRecord {
            display_path: grant.display_path,
            bookmark: grant.bookmark,
            security_scoped: grant.security_scoped,
            native_platform: grant.native_platform,
            canonical_path_utf16: grant.canonical_path_utf16,
        })
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
    desktop_state::update(app, |state| {
        state
            .workspace_grants
            .retain(|grant| grant.grant_id != grant_id);
        state
            .workspace_grants
            .push(desktop_state::DesktopWorkspaceState {
                grant_id,
                display_path: record.display_path,
                native_platform: record.native_platform,
                bookmark: record.bookmark,
                security_scoped: record.security_scoped,
                canonical_path_utf16: record.canonical_path_utf16,
            });
        Ok(())
    })
}

fn remove_workspace_grant(app: &AppHandle, grant_id: &str) -> Result<(), String> {
    desktop_state::update(app, |state| {
        state
            .workspace_grants
            .retain(|grant| grant.grant_id != grant_id);
        for task in state.tasks.values_mut() {
            if task.workspace_grant_id.as_deref() == Some(grant_id) {
                task.workspace_grant_id = None;
            }
        }
        Ok(())
    })
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
            native_platform: "macos".into(),
            canonical_path_utf16: Vec::new(),
        },
    )?;
    Ok(WorkspaceGrantInfo {
        grant_id,
        display_path,
    })
}

#[cfg(target_os = "windows")]
fn create_workspace_grant(
    app: &AppHandle,
    selected_path: PathBuf,
) -> Result<WorkspaceGrantInfo, String> {
    // rfd uses the Windows native folder picker. Once the user has chosen a
    // folder, persist only the native, canonical root returned by the Windows
    // grant backend; never elevate a renderer-supplied display path.
    let root = workspace_grants::create_windows_workspace_root(selected_path)?;
    let grant_id = format!("workspace_{}", uuid::Uuid::new_v4().simple());
    save_workspace_grant(
        app,
        grant_id.clone(),
        WorkspaceGrantRecord {
            display_path: root.display_path.clone(),
            bookmark: Vec::new(),
            security_scoped: false,
            native_platform: "windows".into(),
            canonical_path_utf16: root.canonical_path_utf16,
        },
    )?;
    Ok(WorkspaceGrantInfo {
        grant_id,
        display_path: root.display_path,
    })
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn create_workspace_grant(
    _app: &AppHandle,
    _selected_path: PathBuf,
) -> Result<WorkspaceGrantInfo, String> {
    Err("workspace_grant_unavailable: Persisted workspace grants require macOS or Windows".into())
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

#[cfg(target_os = "windows")]
fn resolve_scoped_workspace_grant(
    app: &AppHandle,
    grant_id: &str,
) -> Result<ScopedWorkspaceGrant, String> {
    let record = workspace_grant_record(app, grant_id)?;
    let path = workspace_grants::resolve_windows_workspace_root(
        &record.native_platform,
        &record.canonical_path_utf16,
    )?;
    Ok(ScopedWorkspaceGrant {
        grant_id: grant_id.to_string(),
        path,
    })
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn resolve_scoped_workspace_grant(
    _app: &AppHandle,
    _grant_id: &str,
) -> Result<ScopedWorkspaceGrant, String> {
    Err("workspace_grant_unavailable: Persisted workspace grants require macOS or Windows".into())
}

fn execute_tool_call_blocking(
    app: &AppHandle,
    call: &NativeToolCall,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    let workspace = resolve_scoped_workspace_grant(app, &call.workspace_grant_id)?;
    let runtime_root = bundled_runtime_root(app)?;
    execute_tool_call_in_workspace_with_runtime(
        &workspace.path,
        call.request.clone(),
        cancel,
        Some(&runtime_root),
    )
}

#[cfg(test)]
fn execute_tool_call_in_workspace(
    workspace: &Path,
    request: Value,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    execute_tool_call_in_workspace_with_runtime(workspace, request, cancel, None)
}

fn execute_tool_call_in_workspace_with_runtime(
    workspace: &Path,
    request: Value,
    cancel: Arc<AtomicBool>,
    runtime_root: Option<&Path>,
) -> Result<Value, String> {
    let runner = LocalRunner::new_with_runtime(workspace, runtime_root).map_err(to_string)?;
    let request: ToolCallRequest = serde_json::from_value(request).map_err(to_string)?;
    if request.approval.is_some() {
        return Err(
            "tool_request_approval_invalid: Renderer approval metadata is never native authorization"
                .into(),
        );
    }
    serde_json::to_value(runner.execute_tool_call_request_with_cancel(request, cancel))
        .map_err(to_string)
}

fn bundled_runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|error| {
        format!("desktop_runtime_unavailable: could not resolve app resources: {error}")
    })?;
    let runtime_root = resource_dir.join("runtime");
    if runtime_root.is_dir() {
        return Ok(runtime_root);
    }
    if cfg!(debug_assertions) {
        // `prepare:runtime` produces the same real bundled resource in the
        // source tree for `tauri dev`; this is a development location, not a
        // fallback to a host Python/Node installation.
        let source_runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime");
        if source_runtime.is_dir() {
            return Ok(source_runtime);
        }
    }
    Err(format!(
        "desktop_runtime_missing: bundled application runtime was not found at {}",
        runtime_root.display()
    ))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let links = argv
                .iter()
                .filter_map(|argument| url::Url::parse(argument).ok())
                .filter_map(|url| normalize_product_open_url(&url))
                .collect::<Vec<_>>();
            if !links.is_empty() {
                let _ = app.emit(PRODUCT_OPEN_EVENT, links);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(NativeToolAuthority::default())
        .manage(NativeDropContextStore::default())
        .manage(window_commands::NativeCommandRouter::default())
        .setup(|app| {
            let deep_link_app = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let links = event
                    .urls()
                    .iter()
                    .filter_map(normalize_product_open_url)
                    .collect::<Vec<_>>();
                if !links.is_empty() {
                    let _ = deep_link_app.emit(PRODUCT_OPEN_EVENT, links);
                }
            });
            let router = app.state::<window_commands::NativeCommandRouter>();
            window_commands::install_native_menu(app.handle(), router.inner())
                .map_err(std::io::Error::other)?;
            // Conversation windows are native-owned session surfaces. Their
            // manifest is restored before the main renderer finishes booting;
            // each restored WebView still revalidates auth, account binding,
            // workspace grant and conversation snapshot on its own.
            let _ = window_commands::restore_conversation_windows(app.handle(), router.inner());
            Ok(())
        })
        .on_menu_event(|app, event| {
            let Some(router) = app.try_state::<window_commands::NativeCommandRouter>() else {
                return;
            };
            let _ = router.route_menu_event(app, event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            default_workspace,
            ensure_workspace,
            read_task_settings,
            read_native_drop_contexts,
            pick_native_drop_files,
            discard_native_drop_contexts,
            pick_workspace_folder,
            reveal_workspace_artifact,
            open_workspace_artifact,
            request_window_attention,
            set_window_tool_context,
            clear_window_tool_context,
            execute_tool_call,
            approve_pending_tool_call,
            deny_pending_tool_call,
            cancel_tool_call,
            poll_tool_call,
            read_auth_token,
            write_auth_token,
            clear_auth_token,
            read_app_settings,
            write_app_settings,
            patch_app_settings,
            read_window_settings,
            patch_window_settings,
            open_external_url,
            revoke_workspace_grant,
            read_product_open_links,
            window_commands::open_conversation_window,
            window_commands::open_settings_window,
            window_commands::open_about_window,
            window_commands::set_native_command_state,
            window_commands::show_native_command_menu,
            window_commands::show_native_context_menu
        ])
        .on_window_event(|window, event| {
            if let Some(router) = window.try_state::<window_commands::NativeCommandRouter>() {
                router.handle_window_event(window, event);
            }
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event {
                // The OS delivers these paths to Rust. A dropped directory is
                // converted into the same native grant as NSOpenPanel/IFileDialog
                // before the renderer sees it; a dropped file becomes a
                // short-lived, one-shot native context handle. The renderer
                // never receives the dropped path or gains filesystem authority.
                let mut directories = Vec::new();
                let mut files = Vec::new();
                let mut rejected_files = Vec::new();
                for path in paths {
                    if path.is_dir() {
                        if let Ok(grant) =
                            create_workspace_grant(&window.app_handle(), path.clone())
                        {
                            directories.push(grant);
                        }
                    } else if let Some(store) =
                        window.app_handle().try_state::<NativeDropContextStore>()
                    {
                        let display_name = path
                            .file_name()
                            .map(|name| safe_drop_display_name(&name.to_string_lossy()))
                            .unwrap_or_else(|| "Dropped file".to_string());
                        match store.insert(window.label(), &path) {
                            Ok(info) => files.push(info),
                            Err(error) => rejected_files.push(NativeDropRejectionInfo {
                                display_name,
                                reason: native_drop_rejection_reason(&error).to_string(),
                            }),
                        }
                    }
                }
                let _ = window.emit(
                    "hatch://native-drop",
                    serde_json::json!({
                        "directories": directories,
                        "files": files,
                        "rejectedFiles": rejected_files,
                        "position": { "x": position.x, "y": position.y }
                    }),
                );
            }
            if !matches!(event, WindowEvent::Destroyed) {
                return;
            }
            if let Some(drop_contexts) = window.try_state::<NativeDropContextStore>() {
                drop_contexts.clear_window(window.label());
            }
            let Some(authority) = window.try_state::<NativeToolAuthority>() else {
                return;
            };
            if let Ok((pending, active)) = authority.clear_window(window.label()) {
                record_pending_outcomes(
                    pending,
                    "window_closed",
                    "The Hatch window closed before this tool call was approved",
                );
                cancel_active_tool_calls(&active);
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Hatch desktop app")
        .run(|app: &AppHandle, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                if let Some(router) = app.try_state::<window_commands::NativeCommandRouter>() {
                    // Tauri destroys every window during a normal quit. Keep
                    // the manifest intact so the next launch can recreate
                    // the same conversation windows; an individual close
                    // outside app-exit still removes only that entry.
                    router.preserve_conversation_manifest_on_exit();
                }
            }
        });
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        default_workspace, is_allowed_browse_url, validate_artifact_relative_path,
        validate_workspace_path, ChangePermissionPolicy, NativeDropContextStore,
        NativeToolAuthority, NativeToolCall, ToolCallDisposition, WindowToolCallKey,
        WindowToolContext,
    };
    use serde_json::json;
    use std::sync::{atomic::AtomicBool, Arc};
    use tempfile::tempdir;

    fn execute_tool_call_in_workspace(
        workspace: &std::path::Path,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        super::execute_tool_call_in_workspace(workspace, request, Arc::new(AtomicBool::new(false)))
    }

    fn install_context(
        authority: &NativeToolAuthority,
        window_label: &str,
        workspace_grant_id: &str,
        permission_policy: ChangePermissionPolicy,
    ) {
        authority
            .set_context(
                window_label,
                WindowToolContext {
                    workspace_grant_id: workspace_grant_id.to_string(),
                    permission_policy,
                },
            )
            .unwrap();
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
                }
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

    #[test]
    fn artifact_reveal_accepts_only_workspace_relative_paths() {
        assert_eq!(
            validate_artifact_relative_path("reports/output.csv")
                .unwrap()
                .to_string_lossy(),
            "reports/output.csv"
        );
        for path in [
            "",
            "/tmp/output.csv",
            "../output.csv",
            "reports/../../output.csv",
        ] {
            assert!(
                validate_artifact_relative_path(path).is_err(),
                "accepted {path:?}"
            );
        }
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
            "https://hatch.tokenquadrant.cn/explore"
        ));
        assert!(is_allowed_browse_url(
            "https://hatch.tokenquadrant.cn/products/550e8400-e29b-41d4-a716-446655440000"
        ));
        assert!(is_allowed_browse_url(
            "https://hatch.tokenquadrant.cn/creators/550e8400-e29b-41d4-a716-446655440000"
        ));
        assert!(!is_allowed_browse_url(
            "https://hatch.tokenquadrant.cn/products/not-a-uuid"
        ));
        assert!(!is_allowed_browse_url(
            "https://hatch.tokenquadrant.cn/agents"
        ));
        assert!(!is_allowed_browse_url(
            "https://evil.example/products/550e8400-e29b-41d4-a716-446655440000"
        ));
        assert!(!is_allowed_browse_url(
            "https://hatch.tokenquadrant.cn.evil/products/550e8400-e29b-41d4-a716-446655440000"
        ));
    }

    #[test]
    fn product_open_deep_link_is_canonical_and_uuid_bound() {
        let valid = url::Url::parse(
            "hatch://products/open?entitlement_id=7aa7b10c-4db0-4d8a-8c2f-2e2c8cba1001&product_id=9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003&creator_id=8bb7b10c-4db0-4d8a-8c2f-2e2c8cba1002",
        )
        .unwrap();
        assert!(super::normalize_product_open_url(&valid).is_some());

        let legacy = url::Url::parse(
            "hatch://agents/open?entitlement_id=7aa7b10c-4db0-4d8a-8c2f-2e2c8cba1001&product_id=9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003",
        )
        .unwrap();
        assert!(super::normalize_product_open_url(&legacy).is_none());

        let malformed = url::Url::parse(
            "hatch://products/open?entitlement_id=ent_old&product_id=9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003",
        )
        .unwrap();
        assert!(super::normalize_product_open_url(&malformed).is_none());
    }

    #[test]
    fn rejects_forged_renderer_approval_metadata() {
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
        assert!(error.contains("tool_request_approval_invalid"));
        assert!(!temp.path().join("output.txt").exists());
    }

    #[test]
    fn native_pending_approval_is_the_only_path_that_executes_a_change() {
        let temp = tempdir().unwrap();
        let authority = NativeToolAuthority::default();
        let window = "window-a";
        install_context(
            &authority,
            window,
            "workspace_a",
            ChangePermissionPolicy::AskBeforeChanges,
        );
        let raw_request = json!({
            "type": "tool_call.request",
            "run_id": "run_test",
            "tool_call_id": "call_write",
            "name": "file_write",
            "arguments": { "path": "output.txt", "content": "approved by the native pending record" },
            "approval": "approved_by_user"
        });
        let call = NativeToolCall::from_renderer_request(raw_request).unwrap();
        assert!(call.request.get("approval").is_none());
        let key = WindowToolCallKey::new(window, call.tool_call_id.clone());
        assert!(matches!(
            authority.submit(key.clone(), call).unwrap(),
            ToolCallDisposition::Pending
        ));
        assert!(!temp.path().join("output.txt").exists());

        let approved = authority.approve(&key).unwrap();
        let output = execute_tool_call_in_workspace(temp.path(), approved.request).unwrap();

        assert_eq!(output["type"], "tool_call.result");
        assert_eq!(output["status"], "ok");
        assert_eq!(
            std::fs::read_to_string(temp.path().join("output.txt")).unwrap(),
            "approved by the native pending record"
        );
    }

    #[test]
    fn allow_policy_starts_changes_without_a_per_call_pending_record() {
        let authority = NativeToolAuthority::default();
        install_context(
            &authority,
            "window-a",
            "workspace_a",
            ChangePermissionPolicy::AllowChanges,
        );
        let call = NativeToolCall::from_renderer_request(json!({
            "type": "tool_call.request",
            "run_id": "run_test",
            "tool_call_id": "call_allowed",
            "name": "file_write",
            "arguments": { "path": "output.txt", "content": "allowed" },
            "approval": "anything-from-the-renderer"
        }))
        .unwrap();
        let key = WindowToolCallKey::new("window-a", call.tool_call_id.clone());
        let ToolCallDisposition::Start(call) = authority.submit(key.clone(), call).unwrap() else {
            panic!("Allow changes must start a change without a pending approval")
        };
        assert_eq!(call.workspace_grant_id, "workspace_a");
        assert!(call.request.get("approval").is_none());
    }

    #[test]
    fn allow_policy_starts_shell_without_a_native_pending_record() {
        let authority = NativeToolAuthority::default();
        install_context(
            &authority,
            "window-a",
            "workspace_a",
            ChangePermissionPolicy::AllowChanges,
        );
        let call = NativeToolCall::from_renderer_request(json!({
            "type": "tool_call.request",
            "run_id": "run_test",
            "tool_call_id": "call_shell",
            "name": "shell_exec",
            "arguments": { "command": "printf must-be-reviewed", "timeout_ms": 30000 }
        }))
        .unwrap();
        let key = WindowToolCallKey::new("window-a", call.tool_call_id.clone());
        assert!(matches!(
            authority.submit(key, call).unwrap(),
            ToolCallDisposition::Start(_)
        ));
    }

    #[test]
    fn ask_policy_requires_a_native_pending_record_for_shell() {
        let authority = NativeToolAuthority::default();
        install_context(
            &authority,
            "window-a",
            "workspace_a",
            ChangePermissionPolicy::AskBeforeChanges,
        );
        let call = NativeToolCall::from_renderer_request(json!({
            "type": "tool_call.request",
            "run_id": "run_test",
            "tool_call_id": "call_shell",
            "name": "shell_exec",
            "arguments": { "command": "printf must-be-reviewed", "timeout_ms": 30000 }
        }))
        .unwrap();
        let key = WindowToolCallKey::new("window-a", call.tool_call_id.clone());
        assert!(matches!(
            authority.submit(key, call).unwrap(),
            ToolCallDisposition::Pending
        ));
    }

    #[test]
    fn native_pending_approval_is_scoped_to_its_window() {
        let authority = NativeToolAuthority::default();
        install_context(
            &authority,
            "window-a",
            "workspace_a",
            ChangePermissionPolicy::AskBeforeChanges,
        );
        install_context(
            &authority,
            "window-b",
            "workspace_b",
            ChangePermissionPolicy::AskBeforeChanges,
        );
        let call = NativeToolCall::from_renderer_request(json!({
            "type": "tool_call.request",
            "run_id": "run_test",
            "tool_call_id": "same-call-id",
            "name": "file_write",
            "arguments": { "path": "output.txt", "content": "no cross-window approval" }
        }))
        .unwrap();
        let key_a = WindowToolCallKey::new("window-a", call.tool_call_id.clone());
        assert!(matches!(
            authority.submit(key_a.clone(), call).unwrap(),
            ToolCallDisposition::Pending
        ));
        let key_b = WindowToolCallKey::new("window-b", "same-call-id");
        assert!(authority
            .approve(&key_b)
            .unwrap_err()
            .contains("tool_approval_missing"));
        assert_eq!(
            authority.approve(&key_a).unwrap().workspace_grant_id,
            "workspace_a"
        );
    }

    #[test]
    fn native_deny_and_cancel_remove_pending_authority() {
        let authority = NativeToolAuthority::default();
        install_context(
            &authority,
            "window-a",
            "workspace_a",
            ChangePermissionPolicy::AskBeforeChanges,
        );
        for (tool_call_id, action) in [("call_deny", "deny"), ("call_cancel", "cancel")] {
            let call = NativeToolCall::from_renderer_request(json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": tool_call_id,
                "name": "file_patch",
                "arguments": { "path": "output.txt", "patch": "" }
            }))
            .unwrap();
            let key = WindowToolCallKey::new("window-a", tool_call_id);
            assert!(matches!(
                authority.submit(key.clone(), call).unwrap(),
                ToolCallDisposition::Pending
            ));
            if action == "deny" {
                assert!(authority.deny(&key).is_ok());
            } else {
                assert!(authority.cancel_pending(&key).unwrap().is_some());
            }
            assert!(authority
                .approve(&key)
                .unwrap_err()
                .contains("tool_approval_missing"));
        }
    }

    #[test]
    fn clearing_a_window_context_invalidates_its_pending_approvals() {
        let authority = NativeToolAuthority::default();
        install_context(
            &authority,
            "window-a",
            "workspace_a",
            ChangePermissionPolicy::AskBeforeChanges,
        );
        let call = NativeToolCall::from_renderer_request(json!({
            "type": "tool_call.request",
            "run_id": "run_test",
            "tool_call_id": "call_close",
            "name": "shell_exec",
            "arguments": { "command": "printf should-not-run", "timeout_ms": 30000 }
        }))
        .unwrap();
        let key = WindowToolCallKey::new("window-a", call.tool_call_id.clone());
        assert!(matches!(
            authority.submit(key.clone(), call).unwrap(),
            ToolCallDisposition::Pending
        ));
        let (pending, active) = authority.clear_window("window-a").unwrap();
        assert_eq!(pending.len(), 1);
        assert!(active.is_empty());
        assert!(authority
            .approve(&key)
            .unwrap_err()
            .contains("tool_approval_missing"));
    }

    #[test]
    fn expired_pending_approval_cannot_be_approved_later() {
        let authority = NativeToolAuthority::default();
        install_context(
            &authority,
            "window-a",
            "workspace_a",
            ChangePermissionPolicy::AskBeforeChanges,
        );
        let call = NativeToolCall::from_renderer_request(json!({
            "type": "tool_call.request",
            "run_id": "run_test",
            "tool_call_id": "call_timeout",
            "name": "file_write",
            "arguments": { "path": "output.txt", "content": "should-not-run" }
        }))
        .unwrap();
        let key = WindowToolCallKey::new("window-a", call.tool_call_id.clone());
        assert!(matches!(
            authority.submit(key.clone(), call).unwrap(),
            ToolCallDisposition::Pending
        ));
        {
            let mut state = authority.state.lock().unwrap();
            state.pending.get_mut(&key).unwrap().created_at =
                std::time::Instant::now() - super::PENDING_TOOL_APPROVAL_TTL;
        }
        assert_eq!(authority.expire_pending().unwrap().len(), 1);
        assert!(authority
            .approve(&key)
            .unwrap_err()
            .contains("tool_approval_missing"));
    }

    #[cfg(unix)]
    #[test]
    fn raw_shell_approval_metadata_is_rejected_before_execution() {
        let temp = tempdir().unwrap();
        let error = execute_tool_call_in_workspace(
            temp.path(),
            json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": "call_shell_forged",
                "name": "shell_exec",
                "arguments": { "command": "printf should-not-run", "timeout_ms": 30000 },
                "approval": "approved_by_user"
            }),
        )
        .unwrap_err();
        assert!(error.contains("tool_request_approval_invalid"));
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
                    }
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

    #[test]
    fn native_drop_context_is_window_scoped_one_shot_and_pathless() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("notes.md");
        std::fs::write(&path, "user-provided context").unwrap();
        let store = NativeDropContextStore::default();
        let info = store.insert("window-a", &path).unwrap();
        assert_eq!(info.display_name, "notes.md");
        assert!(!serde_json::to_string(&info)
            .unwrap()
            .contains(temp.path().to_string_lossy().as_ref()));
        assert!(store
            .consume("window-b", vec![info.context_id.clone()])
            .is_err());
        let contents = store
            .consume("window-a", vec![info.context_id.clone()])
            .unwrap();
        assert_eq!(contents[0].media_type, "text/markdown");
        assert_eq!(contents[0].source_bytes, 21);
        assert_eq!(contents[0].text_sha256.len(), 64);
        assert_eq!(contents[0].text, "user-provided context");
        assert!(store.consume("window-a", vec![info.context_id]).is_err());
    }

    #[test]
    fn native_drop_context_accepts_binary_assets_but_rejects_symlink_paths() {
        let temp = tempdir().unwrap();
        let binary = temp.path().join("image.bin");
        std::fs::write(&binary, [0, 159, 146, 150]).unwrap();
        let store = NativeDropContextStore::default();
        let info = store.insert("window-a", &binary).unwrap();
        let content = store
            .consume("window-a", vec![info.context_id])
            .unwrap()
            .remove(0);
        assert_eq!(content.media_type, "application/octet-stream");
        assert_eq!(content.data_base64.as_deref(), Some("AJ+Slg=="));
        #[cfg(unix)]
        {
            let link = temp.path().join("link.bin");
            std::os::unix::fs::symlink(&binary, &link).unwrap();
            assert!(store.insert("window-a", &link).is_err());
        }
    }

    #[test]
    fn native_drop_context_is_a_snapshot_not_a_late_path_read() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("mutable.md");
        std::fs::write(&path, "original").unwrap();
        let store = NativeDropContextStore::default();
        let info = store.insert("window-a", &path).unwrap();

        // A dropped file may be edited, replaced, or removed before the user
        // presses Send. The composer must attach the bytes observed at the
        // explicit drop gesture, never perform a second path-authority read.
        std::fs::write(&path, "changed after drop").unwrap();
        let contents = store.consume("window-a", vec![info.context_id]).unwrap();
        assert_eq!(contents[0].text, "original");
    }

    #[test]
    fn native_drop_context_multi_consume_is_atomic_on_missing_handle() {
        let temp = tempdir().unwrap();
        let first_path = temp.path().join("first.md");
        let second_path = temp.path().join("second.md");
        std::fs::write(&first_path, "first").unwrap();
        std::fs::write(&second_path, "second").unwrap();
        let store = NativeDropContextStore::default();
        let first = store.insert("window-a", &first_path).unwrap();
        let second = store.insert("window-a", &second_path).unwrap();

        assert!(store
            .consume(
                "window-a",
                vec![first.context_id.clone(), "drop_missing".to_string()]
            )
            .is_err());
        let remaining = store.consume("window-a", vec![first.context_id]).unwrap();
        assert_eq!(remaining[0].text, "first");
        let second_contents = store.consume("window-a", vec![second.context_id]).unwrap();
        assert_eq!(second_contents[0].text, "second");

        let third_path = temp.path().join("third.md");
        std::fs::write(&third_path, "third").unwrap();
        let third = store.insert("window-a", &third_path).unwrap();
        assert!(store
            .discard(
                "window-a",
                vec![third.context_id.clone(), "not-a-drop-handle".to_string()]
            )
            .is_err());
        assert_eq!(
            store.consume("window-a", vec![third.context_id]).unwrap()[0].text,
            "third"
        );
    }
}
