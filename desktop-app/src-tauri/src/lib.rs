use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use hatch_local_runner::{LocalRunner, ToolCallRequest};
use serde_json::Value;
use std::path::PathBuf;

const LOCAL_TOOL_RESULT_TTL: Duration = Duration::from_secs(60);

struct StoredToolResult {
    created_at: Instant,
    payload: Value,
}

fn local_tool_results() -> &'static Mutex<HashMap<String, StoredToolResult>> {
    static RESULTS: OnceLock<Mutex<HashMap<String, StoredToolResult>>> = OnceLock::new();
    RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
fn default_workspace() -> String {
    // A workspace is a user grant. Never infer Documents, $HOME, or cwd as consent.
    String::new()
}

#[tauri::command]
fn ensure_workspace(workspace_root: String) -> Result<String, String> {
    if workspace_root.trim().is_empty() {
        return Err("Choose a workspace folder before granting access".into());
    }
    let path = expand_home(workspace_root);
    if !path.is_dir() {
        return Err("The selected workspace must be an existing folder".into());
    }
    path.canonicalize()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(to_string)
}

#[tauri::command]
async fn pick_workspace_folder() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Choose a workspace")
        .pick_folder()
        .await
        .map(|handle| handle.path().to_path_buf())
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn execute_tool_call(workspace_root: String, request: Value) -> Result<(), String> {
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

    std::thread::spawn(move || {
        let payload = match execute_tool_call_blocking(workspace_root, request) {
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

        if let Ok(mut results) = local_tool_results().lock() {
            results.retain(|_, result| result.created_at.elapsed() < LOCAL_TOOL_RESULT_TTL);
            results.insert(
                result_key,
                StoredToolResult {
                    created_at: Instant::now(),
                    payload,
                },
            );
        }
    });

    Ok(())
}

#[tauri::command]
fn poll_tool_call(tool_call_id: String) -> Option<Value> {
    let mut results = local_tool_results().lock().ok()?;
    results.retain(|_, result| result.created_at.elapsed() < LOCAL_TOOL_RESULT_TTL);
    results.remove(&tool_call_id).map(|result| result.payload)
}

fn execute_tool_call_blocking(workspace_root: String, request: Value) -> Result<Value, String> {
    let workspace = ensure_workspace(workspace_root)?;
    let runner = LocalRunner::new(workspace).map_err(to_string)?;
    let request: ToolCallRequest = serde_json::from_value(request).map_err(to_string)?;
    if matches!(
        request.name.as_str(),
        "fs.write" | "fs.patch" | "shell.exec"
    ) && request.approval.as_deref() != Some("approved_by_user")
    {
        return Err(format!(
            "{} requires explicit approval in the Hatch window",
            request.name
        ));
    }
    serde_json::to_value(runner.execute_tool_call_request(request)).map_err(to_string)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            default_workspace,
            ensure_workspace,
            pick_workspace_folder,
            execute_tool_call,
            poll_tool_call
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Hatch desktop app");
}

fn expand_home(path: String) -> PathBuf {
    if path == "~" {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home);
        }
    }

    if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(stripped);
        }
    }

    PathBuf::from(path)
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::{default_workspace, ensure_workspace, execute_tool_call_blocking};
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn canonical_tool_request_executes_inside_workspace() {
        let temp = tempdir().unwrap();
        let workspace = ensure_workspace(temp.path().to_string_lossy().to_string()).unwrap();
        std::fs::write(temp.path().join("note.txt"), "Hatch desktop local harness").unwrap();

        let output = execute_tool_call_blocking(
            workspace,
            json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": "call_read",
                "name": "fs.read",
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

    #[test]
    fn rejects_file_changes_without_desktop_user_approval() {
        let temp = tempdir().unwrap();
        let error = execute_tool_call_blocking(
            temp.path().to_string_lossy().to_string(),
            json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": "call_write",
                "name": "fs.write",
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
        let output = execute_tool_call_blocking(
            temp.path().to_string_lossy().to_string(),
            json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": "call_write",
                "name": "fs.write",
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
        let error = execute_tool_call_blocking(
            temp.path().to_string_lossy().to_string(),
            json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": "call_shell_denied",
                "name": "shell.exec",
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
        let output = execute_tool_call_blocking(
            temp.path().to_string_lossy().to_string(),
            json!({
                "type": "tool_call.request",
                "run_id": "run_test",
                "tool_call_id": "call_shell_approved",
                "name": "shell.exec",
                "arguments": { "command": "printf shell-ok", "timeout_ms": 30000 },
                "approval": "approved_by_user"
            }),
        )
        .unwrap();

        assert_eq!(output["type"], "tool_call.result");
        assert_eq!(output["status"], "ok");
        assert_eq!(output["result"]["stdout"], "shell-ok");
    }
}
