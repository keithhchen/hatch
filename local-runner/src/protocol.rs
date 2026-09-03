use crate::{LocalRunner, LocalRunnerError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const MAX_TOOL_RESULT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_RICH_TOOL_RESULT_BYTES: usize = 24 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct ToolCallRequest {
    #[serde(rename = "type")]
    pub message_type: String,
    pub run_id: String,
    pub tool_call_id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
    pub approval: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ToolCallResult {
    #[serde(rename = "ok")]
    Ok {
        #[serde(rename = "type")]
        message_type: &'static str,
        run_id: String,
        tool_call_id: String,
        result: Value,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(rename = "type")]
        message_type: &'static str,
        run_id: String,
        tool_call_id: String,
        error: ToolCallError,
    },
}

#[derive(Debug, Serialize)]
pub struct ToolCallError {
    pub code: String,
    pub message: String,
}

impl LocalRunner {
    pub fn execute_tool_call_request(&self, request: ToolCallRequest) -> ToolCallResult {
        self.execute_tool_call_request_with_cancel(request, Arc::new(AtomicBool::new(false)))
    }

    pub fn execute_tool_call_request_with_cancel(
        &self,
        request: ToolCallRequest,
        cancel: Arc<AtomicBool>,
    ) -> ToolCallResult {
        if request.message_type != "tool_call.request" {
            return tool_call_error(
                request.run_id,
                request.tool_call_id,
                "invalid_tool_call",
                format!("expected tool_call.request, got {}", request.message_type),
            );
        }
        if cancel.load(Ordering::Acquire) {
            return tool_call_error(
                request.run_id,
                request.tool_call_id,
                "cancelled",
                "local tool execution was cancelled",
            );
        }

        let run_id = request.run_id;
        let tool_call_id = request.tool_call_id;
        let result = match request.name.as_str() {
            "file_list" => self.protocol_file_list(&request.arguments),
            "file_search" => self.protocol_file_search(&request.arguments),
            "file_read" => self.protocol_file_read(&request.arguments),
            "file_write" => self.protocol_file_write(&request.arguments),
            "file_patch" => self.protocol_file_patch(&request.arguments),
            "shell_exec" => self.protocol_shell_exec(&request.arguments, cancel.as_ref()),
            "git_diff" => self.protocol_git_diff(&request.arguments),
            _ => Err(ProtocolToolError::UnsupportedTool(request.name)),
        };

        let response = match result {
            Ok(result) => ToolCallResult::Ok {
                message_type: "tool_call.result",
                run_id,
                tool_call_id,
                result,
            },
            Err(error) => tool_call_error(run_id, tool_call_id, error.code(), error.to_string()),
        };

        let result_limit = match &response {
            ToolCallResult::Ok { result, .. } if result.get("data_base64").is_some() => {
                MAX_RICH_TOOL_RESULT_BYTES
            }
            _ => MAX_TOOL_RESULT_BYTES,
        };
        if serde_json::to_vec(&response)
            .map(|payload| payload.len() > result_limit)
            .unwrap_or(true)
        {
            return tool_call_error(
                response_run_id(&response),
                response_tool_call_id(&response),
                "tool_result_too_large",
                format!(
                    "tool result exceeds the {}-byte transport envelope; narrow the request",
                    result_limit
                ),
            );
        }

        response
    }

    fn protocol_file_list(&self, arguments: &Value) -> ProtocolResult {
        let path = path_argument(arguments, "path", Some("."))?;
        let entries = self.list(path)?;
        Ok(json!({ "entries": entries }))
    }

    fn protocol_file_search(&self, arguments: &Value) -> ProtocolResult {
        let query = string_argument(arguments, "query", None)?;
        let path = path_argument(arguments, "path", Some("."))?;
        let max_results = usize_argument(arguments, "max_results", Some(20))?;
        let matches = self
            .search(path, &query, max_results)?
            .into_iter()
            .map(|item| {
                json!({
                    "path": item.path,
                    "line_number": item.line_number,
                    "text": item.line
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "matches": matches }))
    }

    fn protocol_file_read(&self, arguments: &Value) -> ProtocolResult {
        let path = path_argument(arguments, "path", None)?;
        self.read_file_result(path).map_err(ProtocolToolError::from)
    }

    fn protocol_file_write(&self, arguments: &Value) -> ProtocolResult {
        let path = path_argument(arguments, "path", None)?;
        let path_label = path.to_string_lossy().replace('\\', "/");
        let content = string_argument(arguments, "content", None)?;
        let diff = self.write_file_with_diff(&path, &content)?;
        Ok(result_with_optional_diff(path_label, diff))
    }

    fn protocol_file_patch(&self, arguments: &Value) -> ProtocolResult {
        let path = path_argument(arguments, "path", None)?;
        let path_label = path.to_string_lossy().replace('\\', "/");
        let patch = string_argument(arguments, "patch", None)?;
        let diff = self.apply_patch_with_diff(&path, &patch)?;
        Ok(result_with_optional_diff(path_label, diff))
    }

    fn protocol_git_diff(&self, arguments: &Value) -> ProtocolResult {
        let path = path_argument(arguments, "path", Some("."))?;
        let diff = self.git_diff(path)?;
        Ok(json!({ "diff": diff }))
    }

    fn protocol_shell_exec(&self, arguments: &Value, cancel: &AtomicBool) -> ProtocolResult {
        let command = string_argument(arguments, "command", None)?;
        let timeout_ms = usize_argument(arguments, "timeout_ms", Some(30_000))?;
        if !(100..=120_000).contains(&timeout_ms) {
            return Err(ProtocolToolError::InvalidTimeout);
        }
        let output = self.shell_exec_with_cancel(&command, timeout_ms as u64, cancel)?;
        Ok(json!({
            "stdout": output.stdout,
            "stderr": output.stderr,
            "exit_code": output.exit_code,
            "timed_out": output.timed_out,
            "stdout_truncated": output.stdout_truncated,
            "stderr_truncated": output.stderr_truncated,
        }))
    }
}

type ProtocolResult = std::result::Result<Value, ProtocolToolError>;

#[derive(Debug, thiserror::Error)]
enum ProtocolToolError {
    #[error("missing required string argument: {0}")]
    MissingStringArgument(&'static str),
    #[error("argument `{0}` must be a string")]
    InvalidStringArgument(&'static str),
    #[error("argument `{0}` must be a non-negative integer")]
    InvalidIntegerArgument(&'static str),
    #[error("unsupported local tool: {0}")]
    UnsupportedTool(String),
    #[error("timeout_ms must be between 100 and 120000")]
    InvalidTimeout,
    #[error("{0}")]
    Runner(#[from] crate::LocalRunnerError),
}

impl ProtocolToolError {
    fn code(&self) -> &'static str {
        match self {
            Self::MissingStringArgument(_)
            | Self::InvalidStringArgument(_)
            | Self::InvalidIntegerArgument(_)
            | Self::UnsupportedTool(_) => "invalid_tool_call",
            Self::Runner(LocalRunnerError::FileTooLarge { .. })
            | Self::Runner(LocalRunnerError::RenderedFileTooLarge { .. }) => "file_too_large",
            Self::InvalidTimeout => "invalid_tool_call",
            Self::Runner(LocalRunnerError::ShellSandboxUnavailable(_)) => {
                "shell_sandbox_unavailable"
            }
            Self::Runner(LocalRunnerError::ShellSandboxInitialization(_)) => "shell_sandbox_failed",
            Self::Runner(LocalRunnerError::ToolExecutionCancelled) => "cancelled",
            Self::Runner(_) => "tool_failed",
        }
    }
}

fn response_run_id(response: &ToolCallResult) -> String {
    match response {
        ToolCallResult::Ok { run_id, .. } | ToolCallResult::Error { run_id, .. } => run_id.clone(),
    }
}

fn response_tool_call_id(response: &ToolCallResult) -> String {
    match response {
        ToolCallResult::Ok { tool_call_id, .. } | ToolCallResult::Error { tool_call_id, .. } => {
            tool_call_id.clone()
        }
    }
}

fn tool_call_error(
    run_id: String,
    tool_call_id: String,
    code: impl Into<String>,
    message: impl Into<String>,
) -> ToolCallResult {
    ToolCallResult::Error {
        message_type: "tool_call.result",
        run_id,
        tool_call_id,
        error: ToolCallError {
            code: code.into(),
            message: message.into(),
        },
    }
}

fn path_argument(
    arguments: &Value,
    key: &'static str,
    fallback: Option<&'static str>,
) -> std::result::Result<PathBuf, ProtocolToolError> {
    string_argument(arguments, key, fallback).map(PathBuf::from)
}

fn result_with_optional_diff(path: String, diff: Option<String>) -> Value {
    match diff {
        Some(diff) => json!({ "ok": true, "path": path, "diff": diff }),
        None => json!({ "ok": true, "path": path }),
    }
}

fn string_argument(
    arguments: &Value,
    key: &'static str,
    fallback: Option<&'static str>,
) -> std::result::Result<String, ProtocolToolError> {
    match arguments.get(key) {
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => Err(ProtocolToolError::InvalidStringArgument(key)),
        None => fallback
            .map(str::to_owned)
            .ok_or(ProtocolToolError::MissingStringArgument(key)),
    }
}

fn usize_argument(
    arguments: &Value,
    key: &'static str,
    fallback: Option<usize>,
) -> std::result::Result<usize, ProtocolToolError> {
    match arguments.get(key) {
        Some(Value::Number(value)) => value
            .as_u64()
            .and_then(|number| usize::try_from(number).ok())
            .ok_or(ProtocolToolError::InvalidIntegerArgument(key)),
        Some(_) => Err(ProtocolToolError::InvalidIntegerArgument(key)),
        None => fallback.ok_or(ProtocolToolError::InvalidIntegerArgument(key)),
    }
}
