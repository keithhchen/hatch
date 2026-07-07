use crate::error::{LocalRunnerError, Result};
use serde::Serialize;
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct AuditLogger {
    path: PathBuf,
}

#[derive(Debug, Serialize)]
struct AuditEvent {
    timestamp_ms: u64,
    tool: String,
    outcome: String,
    paths: Vec<String>,
    detail: Value,
    error: Option<String>,
}

impl AuditLogger {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn record_success(&self, tool: &str, paths: Vec<String>, detail: Value) -> Result<()> {
        self.record(tool, "success", paths, detail, None)
    }

    pub fn record_failure(
        &self,
        tool: &str,
        paths: Vec<String>,
        detail: Value,
        error: &LocalRunnerError,
    ) -> Result<()> {
        self.record(tool, "failure", paths, detail, Some(error.to_string()))
    }

    fn record(
        &self,
        tool: &str,
        outcome: &str,
        paths: Vec<String>,
        detail: Value,
        error: Option<String>,
    ) -> Result<()> {
        let event = AuditEvent {
            timestamp_ms: now_ms(),
            tool: tool.into(),
            outcome: outcome.into(),
            paths,
            detail,
            error,
        };

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|source| LocalRunnerError::io(&self.path, source))?;
        serde_json::to_writer(&mut file, &event)?;
        file.write_all(b"\n")
            .map_err(|source| LocalRunnerError::io(&self.path, source))?;
        file.flush()
            .map_err(|source| LocalRunnerError::io(&self.path, source))?;
        Ok(())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
