use hatch_local_runner::{LocalRunner, ToolCallRequest};
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::future::Future;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
struct CommandTrace {
    path: Option<PathBuf>,
}

static WORKSPACE_PICK_SEQUENCE: AtomicU64 = AtomicU64::new(1);

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
            "timestamp_ms": SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
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
    // A workspace is a user grant. Never infer Documents, $HOME, or cwd as consent.
    String::new()
}

#[tauri::command]
async fn pick_workspace() -> Option<String> {
    let trace = CommandTrace::from_env();
    let correlation_id = format!(
        "workspace-picker-{}-{}",
        std::process::id(),
        WORKSPACE_PICK_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    trace.record("workspace.pick.entry", Some("requested"), &correlation_id);
    let initial = default_workspace();
    let picked = async move {
        rfd::AsyncFileDialog::new()
            .set_directory(initial)
            .pick_folder()
            .await
            .map(|handle| handle.path().to_path_buf())
    };
    resolve_workspace_pick(picked, &trace, &correlation_id).await
}

async fn resolve_workspace_pick<F>(
    picked: F,
    trace: &CommandTrace,
    correlation_id: &str,
) -> Option<String>
where
    F: Future<Output = Option<PathBuf>>,
{
    let Some(path) = picked.await else {
        trace.record("workspace.pick.cancel", Some("cancelled"), &correlation_id);
        return None;
    };

    match path.canonicalize() {
        Ok(path) => {
            trace.record("workspace.pick.result", Some("selected"), &correlation_id);
            Some(path.to_string_lossy().to_string())
        }
        Err(_) => {
            trace.record(
                "workspace.pick.error",
                Some("canonicalize_error"),
                &correlation_id,
            );
            None
        }
    }
}

#[tauri::command]
fn record_workspace_trace(
    phase: String,
    status: String,
    correlation_id: String,
) -> Result<(), String> {
    if !valid_trace_field(&phase, 64)
        || !valid_trace_field(&status, 32)
        || !valid_trace_field(&correlation_id, 128)
    {
        return Err("invalid workspace trace field".to_string());
    }
    CommandTrace::from_env().record(&phase, Some(&status), &correlation_id);
    Ok(())
}

fn valid_trace_field(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
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
            let result = execute_tool_call_blocking_observed(
                workspace_root,
                request,
                Some(&worker_trace),
                &worker_correlation_id,
            );
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

#[cfg(test)]
fn execute_tool_call_blocking(workspace_root: String, request: Value) -> Result<Value, String> {
    execute_tool_call_blocking_observed(workspace_root, request, None, "unknown")
}

fn execute_tool_call_blocking_observed(
    workspace_root: String,
    request: Value,
    trace: Option<&CommandTrace>,
    correlation_id: &str,
) -> Result<Value, String> {
    trace_phase(trace, "workspace.start", None, correlation_id);
    let workspace = match ensure_workspace(workspace_root.clone()) {
        Ok(workspace) => {
            trace_phase(trace, "workspace.end", Some("ok"), correlation_id);
            workspace
        }
        Err(error) => {
            trace_phase(trace, "workspace.end", Some("error"), correlation_id);
            return Err(format!(
                "workspace initialization failed for {workspace_root:?}: {error}"
            ));
        }
    };

    trace_phase(trace, "runner.start", None, correlation_id);
    let runner = match LocalRunner::new(&workspace) {
        Ok(runner) => {
            trace_phase(trace, "runner.end", Some("ok"), correlation_id);
            runner
        }
        Err(error) => {
            trace_phase(trace, "runner.end", Some("error"), correlation_id);
            return Err(format!(
                "local runner initialization failed for {workspace:?}: {error}"
            ));
        }
    };

    trace_phase(trace, "decode.start", None, correlation_id);
    let request: ToolCallRequest = match serde_json::from_value(request) {
        Ok(request) => {
            trace_phase(trace, "decode.end", Some("ok"), correlation_id);
            request
        }
        Err(error) => {
            trace_phase(trace, "decode.end", Some("error"), correlation_id);
            return Err(format!("tool request decoding failed: {error}"));
        }
    };

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

    trace_phase(trace, "execute.start", None, correlation_id);
    let result = runner.execute_tool_call_request(request);
    trace_phase(trace, "execute.end", Some("returned"), correlation_id);

    let encoded = serde_json::to_value(result);
    trace_phase(
        trace,
        "encode.end",
        Some(if encoded.is_ok() { "ok" } else { "error" }),
        correlation_id,
    );
    encoded.map_err(|error| format!("tool result encoding failed: {error}"))
}

fn trace_phase(
    trace: Option<&CommandTrace>,
    phase: &str,
    status: Option<&str>,
    correlation_id: &str,
) {
    if let Some(trace) = trace {
        trace.record(phase, status, correlation_id);
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            default_workspace,
            pick_workspace,
            record_workspace_trace,
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
        default_workspace, ensure_workspace, execute_tool_call_blocking,
        execute_tool_call_with_trace, resolve_workspace_pick, CommandTrace,
    };
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    #[tokio::test]
    async fn async_workspace_picker_seam_records_resolve_cancel_and_error() {
        let temp = tempdir().unwrap();
        let trace_path = temp.path().join("picker-trace.jsonl");
        let trace = CommandTrace::new(trace_path.clone());
        let selected_path = temp.path().to_path_buf();

        let selected = resolve_workspace_pick(
            async move { Some(selected_path) },
            &trace,
            "picker-selected",
        )
        .await;
        assert_eq!(
            selected,
            Some(
                temp.path()
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            )
        );

        let cancelled = resolve_workspace_pick(async { None }, &trace, "picker-cancelled").await;
        assert_eq!(cancelled, None);

        let missing_path = temp.path().join("does-not-exist");
        let errored =
            resolve_workspace_pick(async move { Some(missing_path) }, &trace, "picker-error").await;
        assert_eq!(errored, None);

        let trace_contents = fs::read_to_string(trace_path).unwrap();
        assert!(trace_contents.contains("workspace.pick.result"));
        assert!(trace_contents.contains("workspace.pick.cancel"));
        assert!(trace_contents.contains("workspace.pick.error"));
    }

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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn empty_workspace_with_existing_audit_file_lists_without_blocking() {
        let temp = tempdir().unwrap();
        let trace_dir = tempdir().unwrap();
        fs::write(temp.path().join("audit.jsonl"), "old audit event\n").unwrap();
        let trace_path = trace_dir.path().join("empty-workspace-trace.jsonl");
        let output = execute_tool_call_with_trace(
            temp.path().to_string_lossy().to_string(),
            json!({
                "type": "tool_call.request",
                "run_id": "run_empty_workspace",
                "tool_call_id": "call_empty_list",
                "name": "fs.list",
                "arguments": { "path": "." },
                "approval": "auto"
            }),
            CommandTrace::new(trace_path.clone()),
        )
        .await
        .unwrap();

        assert_eq!(output["status"], "ok");
        assert_eq!(output["result"]["entries"].as_array().unwrap().len(), 0);
        let trace = fs::read_to_string(trace_path).unwrap();
        for phase in [
            "workspace.start",
            "workspace.end",
            "runner.start",
            "runner.end",
            "decode.start",
            "decode.end",
            "execute.start",
            "execute.end",
            "encode.end",
        ] {
            assert!(
                trace.contains(&format!("\"phase\":\"{phase}\"")),
                "missing {phase}"
            );
        }
        assert!(!trace.contains("audit.jsonl"));
        assert!(!trace.contains("old audit event"));
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
