mod audit;
mod error;
mod patch;
mod protocol;
mod sandbox;
mod shell;
mod tools;

pub use error::{LocalRunnerError, Result};
pub use patch::{apply_text_patch, HatchPatch};
pub use protocol::{
    ToolCallError, ToolCallRequest, ToolCallResult, MAX_RICH_TOOL_RESULT_BYTES,
    MAX_TOOL_RESULT_BYTES,
};
pub use tools::{DirectoryEntry, EntryKind, FileStat, LocalRunner, SearchMatch, ShellExecOutput};
