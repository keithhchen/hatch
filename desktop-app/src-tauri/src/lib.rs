use hatch_local_runner::{LocalRunner, ToolCallRequest};
use serde_json::Value;
use std::path::PathBuf;

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
async fn execute_tool_call(workspace_root: String, request: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        execute_tool_call_blocking(workspace_root, request)
    })
    .await
    .map_err(to_string)?
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
            execute_tool_call
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
}
