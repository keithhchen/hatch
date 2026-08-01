use crate::LocalRunner;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

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
        if request.message_type != "tool_call.request" {
            return tool_call_error(
                request.run_id,
                request.tool_call_id,
                "invalid_tool_call",
                format!("expected tool_call.request, got {}", request.message_type),
            );
        }

        let run_id = request.run_id;
        let tool_call_id = request.tool_call_id;
        let result = match request.name.as_str() {
            "fs.list" => self.protocol_fs_list(&request.arguments),
            "fs.search" => self.protocol_fs_search(&request.arguments),
            "fs.read" => self.protocol_fs_read(&request.arguments),
            "fs.write" => self.protocol_fs_write(&request.arguments),
            "fs.patch" => self.protocol_fs_patch(&request.arguments),
            "shell.exec" => Err(ProtocolToolError::ShellDisabled),
            "git.diff" => self.protocol_git_diff(&request.arguments),
            _ => Err(ProtocolToolError::UnsupportedTool(request.name)),
        };

        match result {
            Ok(result) => ToolCallResult::Ok {
                message_type: "tool_call.result",
                run_id,
                tool_call_id,
                result,
            },
            Err(error) => tool_call_error(run_id, tool_call_id, error.code(), error.to_string()),
        }
    }

    fn protocol_fs_list(&self, arguments: &Value) -> ProtocolResult {
        let path = path_argument(arguments, "path", Some("."))?;
        let entries = self.list(path)?;
        Ok(json!({ "entries": entries }))
    }

    fn protocol_fs_search(&self, arguments: &Value) -> ProtocolResult {
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

    fn protocol_fs_read(&self, arguments: &Value) -> ProtocolResult {
        let path = path_argument(arguments, "path", None)?;
        let content = self.read_file(path)?;
        Ok(json!({ "content": content }))
    }

    fn protocol_fs_write(&self, arguments: &Value) -> ProtocolResult {
        let path = path_argument(arguments, "path", None)?;
        let path_label = path.to_string_lossy().replace('\\', "/");
        let content = string_argument(arguments, "content", None)?;
        let diff = self.write_file_with_diff(&path, &content)?;
        Ok(result_with_optional_diff(path_label, diff))
    }

    fn protocol_fs_patch(&self, arguments: &Value) -> ProtocolResult {
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
    #[error("shell execution is disabled: this build cannot provide a complete OS sandbox")]
    ShellDisabled,
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
            Self::ShellDisabled => "shell_disabled",
            Self::Runner(_) => "tool_failed",
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
