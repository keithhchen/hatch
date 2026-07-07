use hatch_local_runner::{LocalRunner, ToolCallRequest};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[tauri::command]
fn default_workspace() -> String {
    if let Some(home) = std::env::var_os("HOME") {
        let documents = PathBuf::from(home).join("Documents");
        if documents.is_dir() {
            return documents.to_string_lossy().to_string();
        }
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn ensure_workspace(workspace_root: String) -> Result<String, String> {
    let path = expand_home(workspace_root);
    fs::create_dir_all(&path).map_err(to_string)?;
    path.canonicalize()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(to_string)
}

#[tauri::command]
fn execute_tool_call(workspace_root: String, request: Value) -> Result<Value, String> {
    let workspace = ensure_workspace(workspace_root)?;
    let runner = LocalRunner::new(workspace).map_err(to_string)?;
    let request: ToolCallRequest = serde_json::from_value(request).map_err(to_string)?;
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
    use super::{ensure_workspace, execute_tool_call};
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn canonical_tool_request_executes_inside_workspace() {
        let temp = tempdir().unwrap();
        let workspace = ensure_workspace(temp.path().to_string_lossy().to_string()).unwrap();
        std::fs::write(temp.path().join("note.txt"), "Hatch desktop local harness").unwrap();

        let output = execute_tool_call(
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
}
