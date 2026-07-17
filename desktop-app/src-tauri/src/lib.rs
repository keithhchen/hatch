use hatch_local_runner::{LocalRunner, ToolCallRequest};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::thread;

#[derive(Clone, Debug)]
struct CommandTrace {
    path: Option<PathBuf>,
}

impl CommandTrace {
    fn from_env() -> Self {
        Self {
            path: std::env::var_os("HATCH_DESKTOP_COMMAND_TRACE").map(PathBuf::from),
        }
    }

    #[cfg(test)]
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn record(&self, phase: &str, status: Option<&str>, correlation_id: &str) {
        let mut event = json!({
            "phase": phase,
            "correlation_id": correlation_id,
        });
        if let Some(status) = status {
            event["status"] = Value::String(status.to_string());
        }
        let Ok(mut line) = serde_json::to_vec(&event) else {
            return;
        };
        line.push(b'\n');

        if let Some(path) = &self.path {
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = file.write_all(&line);
                let _ = file.flush();
            }
        }
        eprintln!("hatch.local_tool {}", phase);
    }
}

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
async fn execute_tool_call(workspace_root: String, request: Value) -> Result<Value, String> {
    execute_tool_call_with_trace(workspace_root, request, CommandTrace::from_env()).await
}

async fn execute_tool_call_with_trace(
    workspace_root: String,
    request: Value,
    trace: CommandTrace,
) -> Result<Value, String> {
    let correlation_id = request
        .get("tool_call_id")
        .and_then(Value::as_str)
        .or_else(|| request.get("run_id").and_then(Value::as_str))
        .unwrap_or("unknown")
        .to_string();
    trace.record("command.entry", None, &correlation_id);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let worker_trace = trace.clone();
    let worker_correlation_id = correlation_id.clone();
    let worker = thread::Builder::new()
        .name("hatch-local-tool".into())
        .spawn(move || {
            worker_trace.record("blocking.start", None, &worker_correlation_id);
            let result = execute_tool_call_blocking(workspace_root, request);
            worker_trace.record(
                "blocking.end",
                Some(command_result_status(&result)),
                &worker_correlation_id,
            );
            let _ = sender.send(result);
        });
    if worker.is_err() {
        trace.record("command.error", Some("worker_start_error"), &correlation_id);
        return Err("local tool worker could not start".to_string());
    }

    let result = match receiver.await {
        Ok(result) => result,
        Err(_) => {
            trace.record("command.error", Some("worker_stopped"), &correlation_id);
            return Err("local tool worker stopped unexpectedly".to_string());
        }
    };
    let status = command_result_status(&result);
    trace.record(
        if status == "ok" {
            "command.result"
        } else {
            "command.error"
        },
        Some(status),
        &correlation_id,
    );
    result
}

fn command_result_status(result: &Result<Value, String>) -> &'static str {
    match result {
        Err(_) => "error",
        Ok(value) if value["status"] == "error" => "tool_error",
        Ok(_) => "ok",
    }
}

fn execute_tool_call_blocking(workspace_root: String, request: Value) -> Result<Value, String> {
    let workspace = ensure_workspace(workspace_root.clone()).map_err(|error| {
        format!("workspace initialization failed for {workspace_root:?}: {error}")
    })?;
    let runner = LocalRunner::new(&workspace).map_err(|error| {
        format!("local runner initialization failed for {workspace:?}: {error}")
    })?;
    let request: ToolCallRequest = serde_json::from_value(request)
        .map_err(|error| format!("tool request decoding failed: {error}"))?;
    serde_json::to_value(runner.execute_tool_call_request(request))
        .map_err(|error| format!("tool result encoding failed: {error}"))
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
    use super::{
        ensure_workspace, execute_tool_call_blocking, execute_tool_call_with_trace, CommandTrace,
    };
    use serde_json::json;
    use std::fs;
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn async_tauri_command_wrapper_runs_worker_and_records_lifecycle() {
        let temp = tempdir().unwrap();
        let workspace = ensure_workspace(temp.path().to_string_lossy().to_string()).unwrap();
        fs::write(
            temp.path().join("note.txt"),
            "Hatch async invoke regression",
        )
        .unwrap();
        let trace_path = temp.path().join("command-trace.jsonl");
        let output = execute_tool_call_with_trace(
            workspace,
            json!({
                "type": "tool_call.request",
                "run_id": "run_async_test",
                "tool_call_id": "call_read",
                "name": "fs.read",
                "arguments": {
                    "path": "note.txt"
                },
                "approval": "auto"
            }),
            CommandTrace::new(trace_path.clone()),
        )
        .await
        .unwrap();

        assert_eq!(output["status"], "ok");
        let trace = fs::read_to_string(trace_path).unwrap();
        assert!(trace.contains("\"phase\":\"command.entry\""));
        assert!(trace.contains("\"correlation_id\":\"call_read\""));
        assert!(trace.contains("\"phase\":\"blocking.start\""));
        assert!(trace.contains("\"phase\":\"blocking.end\",\"status\":\"ok\""));
        assert!(trace.contains("\"phase\":\"command.result\",\"status\":\"ok\""));
        assert!(!trace.contains("note.txt"));
        assert!(!trace.contains("Hatch async invoke regression"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn async_tauri_command_wrapper_records_runner_errors_without_payloads() {
        let temp = tempdir().unwrap();
        let workspace = ensure_workspace(temp.path().to_string_lossy().to_string()).unwrap();
        let trace_path = temp.path().join("command-error-trace.jsonl");
        let output = execute_tool_call_with_trace(
            workspace,
            json!({
                "type": "tool_call.request",
                "run_id": "run_async_error_test",
                "tool_call_id": "call_missing",
                "name": "fs.read",
                "arguments": {
                    "path": "missing-private-file.txt"
                },
                "approval": "auto"
            }),
            CommandTrace::new(trace_path.clone()),
        )
        .await
        .unwrap();

        assert_eq!(output["status"], "error");
        let trace = fs::read_to_string(trace_path).unwrap();
        assert!(trace.contains("\"phase\":\"blocking.end\",\"status\":\"tool_error\""));
        assert!(trace.contains("\"phase\":\"command.error\",\"status\":\"tool_error\""));
        assert!(trace.contains("\"correlation_id\":\"call_missing\""));
        assert!(!trace.contains("missing-private-file.txt"));
    }
}
