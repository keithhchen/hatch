use std::io;
use std::path::{Path, PathBuf};
use std::string::FromUtf8Error;

pub type Result<T> = std::result::Result<T, LocalRunnerError>;

#[derive(Debug, thiserror::Error)]
pub enum LocalRunnerError {
    #[error("absolute paths are not allowed: {0}")]
    AbsolutePath(String),
    #[error("path escapes sandbox: {0}")]
    PathEscapesSandbox(String),
    #[error("reserved audit path is not available to local tools: {0}")]
    ReservedPath(String),
    #[error("path does not exist: {0}")]
    NotFound(String),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("destination already exists: {0}")]
    DestinationExists(String),
    #[error("expected a file: {0}")]
    ExpectedFile(String),
    #[error("expected a directory: {0}")]
    ExpectedDirectory(String),
    #[error("refusing to write through a symlink: {0}")]
    SymlinkWriteTarget(String),
    #[error("file is not valid utf-8: {0}")]
    InvalidUtf8(String),
    #[error("patch parse error: {0}")]
    PatchParse(String),
    #[error("patch replacement text was not found")]
    PatchOldTextNotFound,
    #[error("patch replacement is ambiguous; found {0} matches")]
    PatchAmbiguousReplacement(usize),
    #[error("command `{command}` failed with exit code {exit_code}: {stderr}")]
    CommandFailed {
        command: String,
        exit_code: i32,
        stderr: String,
    },
    #[error("spreadsheet read error at {path}: {message}")]
    SpreadsheetRead { path: String, message: String },
    #[error("io error at {}: {source}", path.display())]
    Io { path: PathBuf, source: io::Error },
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

impl LocalRunnerError {
    pub fn io(path: impl AsRef<Path>, source: io::Error) -> Self {
        let path = path.as_ref().to_path_buf();
        if source.kind() == io::ErrorKind::NotFound {
            return Self::NotFound(path.display().to_string());
        }

        Self::Io { path, source }
    }

    pub fn invalid_utf8(path: impl AsRef<Path>, _source: FromUtf8Error) -> Self {
        Self::InvalidUtf8(path.as_ref().display().to_string())
    }
}
