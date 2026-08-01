use crate::audit::AuditLogger;
use crate::error::{LocalRunnerError, Result};
use crate::patch::{apply_text_patch, HatchPatch};
use crate::sandbox::{path_to_string, Sandbox};
use calamine::{open_workbook_auto, Data, Reader};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use walkdir::WalkDir;

const MAX_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_WORKSPACE_DIFF_BYTES: usize = 64 * 1024;
const MAX_SEARCH_FILES_SCANNED: usize = 2_000;
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;
const MAX_SEARCH_ELAPSED: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
pub struct LocalRunner {
    sandbox: Sandbox,
    audit: AuditLogger,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DirectoryEntry {
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    pub len: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileStat {
    pub path: String,
    pub kind: EntryKind,
    pub len: u64,
    pub readonly: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchMatch {
    pub path: String,
    pub line_number: usize,
    pub line: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ShellExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

impl LocalRunner {
    pub fn new(sandbox_root: impl AsRef<Path>) -> Result<Self> {
        let sandbox = Sandbox::new(sandbox_root)?;
        let audit = AuditLogger::new(sandbox.audit_path());
        Ok(Self { sandbox, audit })
    }

    pub fn sandbox_root(&self) -> &Path {
        self.sandbox.root()
    }

    pub fn audit_path(&self) -> &Path {
        self.audit.path()
    }

    pub fn list(&self, path: impl AsRef<Path>) -> Result<Vec<DirectoryEntry>> {
        let label = display_input_path(path.as_ref());
        let result = self.list_inner(path.as_ref());
        let detail = match &result {
            Ok(entries) => json!({ "entry_count": entries.len() }),
            Err(_) => json!({}),
        };
        self.audit_outcome("list", vec![label], detail, &result)?;
        result
    }

    pub fn stat(&self, path: impl AsRef<Path>) -> Result<FileStat> {
        let label = display_input_path(path.as_ref());
        let result = self.stat_inner(path.as_ref());
        let detail = match &result {
            Ok(stat) => json!({ "kind": stat.kind.clone(), "len": stat.len }),
            Err(_) => json!({}),
        };
        self.audit_outcome("stat", vec![label], detail, &result)?;
        result
    }

    pub fn search(
        &self,
        path: impl AsRef<Path>,
        query: &str,
        max_results: usize,
    ) -> Result<Vec<SearchMatch>> {
        let label = display_input_path(path.as_ref());
        let result = self.search_inner(path.as_ref(), query, max_results);
        let detail = match &result {
            Ok(matches) => json!({ "query_len": query.len(), "match_count": matches.len() }),
            Err(_) => json!({ "query_len": query.len() }),
        };
        self.audit_outcome("search", vec![label], detail, &result)?;
        result
    }

    pub fn read_file(&self, path: impl AsRef<Path>) -> Result<String> {
        let label = display_input_path(path.as_ref());
        let result = self.read_file_inner(path.as_ref());
        let detail = match &result {
            Ok(content) => json!({ "bytes": content.len() }),
            Err(_) => json!({}),
        };
        self.audit_outcome("read", vec![label], detail, &result)?;
        result
    }

    pub fn write_file(&self, path: impl AsRef<Path>, content: &str) -> Result<()> {
        self.write_file_with_diff(path, content).map(|_| ())
    }

    pub fn write_file_with_diff(
        &self,
        path: impl AsRef<Path>,
        content: &str,
    ) -> Result<Option<String>> {
        let label = display_input_path(path.as_ref());
        let before = self.read_file_inner(path.as_ref()).ok();
        let result = self.write_file_inner(path.as_ref(), content);
        let detail = json!({ "bytes": content.len() });
        self.audit_outcome("write_file", vec![label], detail, &result)?;
        result.map(|_| render_workspace_diff(path.as_ref(), before.as_deref(), content))
    }

    pub fn append_file(&self, path: impl AsRef<Path>, content: &str) -> Result<()> {
        let label = display_input_path(path.as_ref());
        let result = self.append_file_inner(path.as_ref(), content);
        let detail = json!({ "bytes": content.len() });
        self.audit_outcome("append_file", vec![label], detail, &result)?;
        result
    }

    pub fn copy(
        &self,
        src: impl AsRef<Path>,
        dst: impl AsRef<Path>,
        overwrite: bool,
    ) -> Result<()> {
        let src_label = display_input_path(src.as_ref());
        let dst_label = display_input_path(dst.as_ref());
        let result = self.copy_inner(src.as_ref(), dst.as_ref(), overwrite);
        let detail = json!({ "overwrite": overwrite });
        self.audit_outcome("copy", vec![src_label, dst_label], detail, &result)?;
        result
    }

    pub fn move_path(
        &self,
        src: impl AsRef<Path>,
        dst: impl AsRef<Path>,
        overwrite: bool,
    ) -> Result<()> {
        let src_label = display_input_path(src.as_ref());
        let dst_label = display_input_path(dst.as_ref());
        let result = self.move_inner(src.as_ref(), dst.as_ref(), overwrite);
        let detail = json!({ "overwrite": overwrite });
        self.audit_outcome("move", vec![src_label, dst_label], detail, &result)?;
        result
    }

    pub fn apply_patch(&self, path: impl AsRef<Path>, patch_text: &str) -> Result<()> {
        self.apply_patch_with_diff(path, patch_text).map(|_| ())
    }

    pub fn apply_patch_with_diff(
        &self,
        path: impl AsRef<Path>,
        patch_text: &str,
    ) -> Result<Option<String>> {
        let label = display_input_path(path.as_ref());
        let before = self.read_file_inner(path.as_ref()).ok();
        let result = self.apply_patch_inner(path.as_ref(), patch_text);
        let detail = json!({ "patch_bytes": patch_text.len() });
        self.audit_outcome("apply_patch", vec![label], detail, &result)?;
        result.and_then(|_| {
            let after = self.read_file_inner(path.as_ref())?;
            Ok(render_workspace_diff(
                path.as_ref(),
                before.as_deref(),
                &after,
            ))
        })
    }

    pub fn shell_exec(&self, command: &str, timeout_ms: u64) -> Result<ShellExecOutput> {
        let result = self.shell_exec_inner(command, timeout_ms);
        let detail = match &result {
            Ok(output) => json!({
                "command_bytes": command.len(),
                "timeout_ms": timeout_ms,
                "exit_code": output.exit_code,
                "timed_out": output.timed_out,
                "stdout_bytes": output.stdout.len(),
                "stderr_bytes": output.stderr.len(),
                "stdout_truncated": output.stdout_truncated,
                "stderr_truncated": output.stderr_truncated
            }),
            Err(_) => json!({
                "command_bytes": command.len(),
                "timeout_ms": timeout_ms
            }),
        };
        self.audit_outcome("shell_exec", Vec::new(), detail, &result)?;
        result
    }

    pub fn git_diff(&self, path: impl AsRef<Path>) -> Result<String> {
        let label = display_input_path(path.as_ref());
        let result = self.git_diff_inner(path.as_ref());
        let detail = match &result {
            Ok(diff) => json!({ "bytes": diff.len() }),
            Err(_) => json!({}),
        };
        self.audit_outcome("git_diff", vec![label], detail, &result)?;
        result
    }

    fn list_inner(&self, path: &Path) -> Result<Vec<DirectoryEntry>> {
        let resolved = self.sandbox.resolve_existing(path)?;
        let metadata = fs::metadata(&resolved.absolute)
            .map_err(|source| LocalRunnerError::io(&resolved.absolute, source))?;
        if !metadata.is_dir() {
            return Err(LocalRunnerError::ExpectedDirectory(
                resolved.relative.display().to_string(),
            ));
        }

        let mut entries = Vec::new();
        let read_dir = fs::read_dir(&resolved.absolute)
            .map_err(|source| LocalRunnerError::io(&resolved.absolute, source))?;
        for entry in read_dir {
            let entry = entry.map_err(|source| LocalRunnerError::io(&resolved.absolute, source))?;
            let path = entry.path();
            if self.sandbox.is_reserved_path(&path) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path)
                .map_err(|source| LocalRunnerError::io(&path, source))?;
            let relative = path.strip_prefix(self.sandbox.root()).unwrap_or(&path);
            entries.push(DirectoryEntry {
                path: path_to_string(relative),
                name: entry.file_name().to_string_lossy().into_owned(),
                kind: kind_from_metadata(&metadata),
                len: metadata.len(),
            });
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(entries)
    }

    fn stat_inner(&self, path: &Path) -> Result<FileStat> {
        let resolved = self.sandbox.resolve_existing(path)?;
        let metadata = fs::symlink_metadata(&resolved.absolute)
            .map_err(|source| LocalRunnerError::io(&resolved.absolute, source))?;

        Ok(FileStat {
            path: path_to_string(&resolved.relative),
            kind: kind_from_metadata(&metadata),
            len: metadata.len(),
            readonly: metadata.permissions().readonly(),
        })
    }

    fn search_inner(
        &self,
        path: &Path,
        query: &str,
        max_results: usize,
    ) -> Result<Vec<SearchMatch>> {
        let query = query.trim();
        if query.is_empty() || max_results == 0 {
            return Ok(Vec::new());
        }

        let resolved = self.sandbox.resolve_existing(path)?;
        let metadata = fs::metadata(&resolved.absolute)
            .map_err(|source| LocalRunnerError::io(&resolved.absolute, source))?;

        let started_at = Instant::now();
        let mut scanned_files = 0usize;
        let mut matches = Vec::new();
        if metadata.is_file() {
            self.search_file(&resolved.absolute, query, max_results, &mut matches)?;
        } else if metadata.is_dir() {
            let walker = WalkDir::new(&resolved.absolute)
                .follow_links(false)
                .into_iter()
                .filter_entry(|entry| {
                    entry.depth() == 0
                        || !self.sandbox.is_reserved_path(entry.path())
                            && !is_search_ignored_entry(
                                entry.file_name().to_string_lossy().as_ref(),
                            )
                });
            for entry in walker {
                if matches.len() >= max_results
                    || scanned_files >= MAX_SEARCH_FILES_SCANNED
                    || started_at.elapsed() >= MAX_SEARCH_ELAPSED
                {
                    break;
                }
                let entry = entry.map_err(|source| walkdir_error(&resolved.absolute, source))?;
                if self.sandbox.is_reserved_path(entry.path()) {
                    continue;
                }
                if entry.file_type().is_file() {
                    scanned_files += 1;
                    self.search_file(entry.path(), query, max_results, &mut matches)?;
                }
            }
        } else {
            return Err(LocalRunnerError::ExpectedFile(
                resolved.relative.display().to_string(),
            ));
        }

        Ok(matches)
    }

    fn search_file(
        &self,
        file: &Path,
        query: &str,
        max_results: usize,
        matches: &mut Vec<SearchMatch>,
    ) -> Result<()> {
        let relative_path = self.sandbox.to_relative_string(file);
        if relative_path.contains(query) {
            matches.push(SearchMatch {
                path: relative_path.clone(),
                line_number: 0,
                line: "path match".to_string(),
            });
            if matches.len() >= max_results {
                return Ok(());
            }
        }

        let metadata = fs::metadata(file).map_err(|source| LocalRunnerError::io(file, source))?;
        if metadata.len() > MAX_SEARCH_FILE_BYTES {
            return Ok(());
        }
        let bytes = match fs::read(file) {
            Ok(bytes) => bytes,
            Err(source) => return Err(LocalRunnerError::io(file, source)),
        };
        let Ok(content) = String::from_utf8(bytes) else {
            return Ok(());
        };

        for (line_index, line) in content.lines().enumerate() {
            if line.contains(query) {
                matches.push(SearchMatch {
                    path: relative_path.clone(),
                    line_number: line_index + 1,
                    line: line.to_string(),
                });

                if matches.len() >= max_results {
                    break;
                }
            }
        }

        Ok(())
    }

    fn read_file_inner(&self, path: &Path) -> Result<String> {
        let resolved = self.sandbox.resolve_existing(path)?;
        let metadata = fs::metadata(&resolved.absolute)
            .map_err(|source| LocalRunnerError::io(&resolved.absolute, source))?;
        if !metadata.is_file() {
            return Err(LocalRunnerError::ExpectedFile(
                resolved.relative.display().to_string(),
            ));
        }

        if is_xlsx_path(&resolved.absolute) {
            return read_xlsx_as_text(&resolved.absolute);
        }

        let bytes = fs::read(&resolved.absolute)
            .map_err(|source| LocalRunnerError::io(&resolved.absolute, source))?;
        String::from_utf8(bytes)
            .map_err(|source| LocalRunnerError::invalid_utf8(&resolved.absolute, source))
    }

    fn write_file_inner(&self, path: &Path, content: &str) -> Result<()> {
        let resolved = self.sandbox.resolve_candidate(path, false)?;
        ensure_writable_file_target(&resolved.absolute)?;
        ensure_parent_dir(&resolved.absolute)?;
        fs::write(&resolved.absolute, content)
            .map_err(|source| LocalRunnerError::io(&resolved.absolute, source))
    }

    fn append_file_inner(&self, path: &Path, content: &str) -> Result<()> {
        let resolved = self.sandbox.resolve_candidate(path, false)?;
        ensure_writable_file_target(&resolved.absolute)?;
        ensure_parent_dir(&resolved.absolute)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&resolved.absolute)
            .map_err(|source| LocalRunnerError::io(&resolved.absolute, source))?;
        file.write_all(content.as_bytes())
            .map_err(|source| LocalRunnerError::io(&resolved.absolute, source))
    }

    fn copy_inner(&self, src: &Path, dst: &Path, overwrite: bool) -> Result<()> {
        let src = self.sandbox.resolve_existing(src)?;
        let dst = self.sandbox.resolve_candidate(dst, false)?;
        let src_metadata = fs::metadata(&src.absolute)
            .map_err(|source| LocalRunnerError::io(&src.absolute, source))?;
        if !src_metadata.is_file() {
            return Err(LocalRunnerError::ExpectedFile(
                src.relative.display().to_string(),
            ));
        }

        if dst.absolute.exists() && !overwrite {
            return Err(LocalRunnerError::DestinationExists(
                dst.relative.display().to_string(),
            ));
        }

        ensure_writable_file_target(&dst.absolute)?;
        ensure_parent_dir(&dst.absolute)?;
        fs::copy(&src.absolute, &dst.absolute)
            .map(|_| ())
            .map_err(|source| LocalRunnerError::io(&dst.absolute, source))
    }

    fn move_inner(&self, src: &Path, dst: &Path, overwrite: bool) -> Result<()> {
        let src = self.sandbox.resolve_existing(src)?;
        let dst = self.sandbox.resolve_candidate(dst, false)?;
        let src_metadata = fs::metadata(&src.absolute)
            .map_err(|source| LocalRunnerError::io(&src.absolute, source))?;
        if !src_metadata.is_file() {
            return Err(LocalRunnerError::ExpectedFile(
                src.relative.display().to_string(),
            ));
        }

        if dst.absolute.exists() {
            if !overwrite {
                return Err(LocalRunnerError::DestinationExists(
                    dst.relative.display().to_string(),
                ));
            }
            ensure_writable_file_target(&dst.absolute)?;
            fs::remove_file(&dst.absolute)
                .map_err(|source| LocalRunnerError::io(&dst.absolute, source))?;
        }

        ensure_parent_dir(&dst.absolute)?;
        fs::rename(&src.absolute, &dst.absolute)
            .map_err(|source| LocalRunnerError::io(&dst.absolute, source))
    }

    fn apply_patch_inner(&self, path: &Path, patch_text: &str) -> Result<()> {
        let patch = HatchPatch::parse(patch_text)?;

        match &patch {
            HatchPatch::Append { .. } => {
                let existing = match self.read_file_inner(path) {
                    Ok(existing) => existing,
                    Err(LocalRunnerError::NotFound(_)) => String::new(),
                    Err(error) => return Err(error),
                };
                let next = apply_text_patch(&existing, &patch)?;
                self.write_file_inner(path, &next)
            }
            HatchPatch::Replace { .. } => {
                let existing = self.read_file_inner(path)?;
                let next = apply_text_patch(&existing, &patch)?;
                self.write_file_inner(path, &next)
            }
        }
    }

    fn shell_exec_inner(&self, command: &str, timeout_ms: u64) -> Result<ShellExecOutput> {
        let mut child = Command::new("sh")
            .arg("-lc")
            .arg(command)
            .current_dir(self.sandbox.root())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|source| LocalRunnerError::io(self.sandbox.root(), source))?;

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut timed_out = false;
        loop {
            if child
                .try_wait()
                .map_err(|source| LocalRunnerError::io(self.sandbox.root(), source))?
                .is_some()
            {
                break;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                child
                    .kill()
                    .map_err(|source| LocalRunnerError::io(self.sandbox.root(), source))?;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        let output = child
            .wait_with_output()
            .map_err(|source| LocalRunnerError::io(self.sandbox.root(), source))?;
        let (stdout, stdout_truncated) = truncate_command_output(&output.stdout);
        let (stderr, stderr_truncated) = truncate_command_output(&output.stderr);
        Ok(ShellExecOutput {
            stdout,
            stderr,
            exit_code: output.status.code().unwrap_or(-1),
            timed_out,
            stdout_truncated,
            stderr_truncated,
        })
    }

    fn git_diff_inner(&self, path: &Path) -> Result<String> {
        self.stat_inner(path)?;
        let output = Command::new("git")
            .arg("diff")
            .arg("--")
            .arg(path)
            .current_dir(self.sandbox.root())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|source| LocalRunnerError::io(self.sandbox.root(), source))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(LocalRunnerError::CommandFailed {
                command: "git diff".into(),
                exit_code: output.status.code().unwrap_or(-1),
                stderr,
            });
        }

        let (diff, _) = truncate_command_output(&output.stdout);
        Ok(diff)
    }

    fn audit_outcome<T>(
        &self,
        tool: &str,
        paths: Vec<String>,
        detail: Value,
        result: &Result<T>,
    ) -> Result<()> {
        match result {
            Ok(_) => self.audit.record_success(tool, paths, detail),
            Err(error) => self.audit.record_failure(tool, paths, detail, error),
        }
    }
}

fn display_input_path(path: &Path) -> String {
    path_to_string(path)
}

fn kind_from_metadata(metadata: &fs::Metadata) -> EntryKind {
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        EntryKind::Symlink
    } else if file_type.is_file() {
        EntryKind::File
    } else if file_type.is_dir() {
        EntryKind::Directory
    } else {
        EntryKind::Other
    }
}

fn ensure_parent_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| LocalRunnerError::io(parent, source))?;
    }
    Ok(())
}

fn ensure_writable_file_target(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(LocalRunnerError::SymlinkWriteTarget(
                    path.display().to_string(),
                ));
            }
            if metadata.is_dir() {
                return Err(LocalRunnerError::ExpectedFile(path.display().to_string()));
            }
            Ok(())
        }
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(LocalRunnerError::io(path, source)),
    }
}

fn walkdir_error(root: &Path, source: walkdir::Error) -> LocalRunnerError {
    let path = source
        .path()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.to_path_buf());

    match source.into_io_error() {
        Some(error) => LocalRunnerError::io(path, error),
        None => LocalRunnerError::InvalidPath(path.display().to_string()),
    }
}

fn truncate_command_output(bytes: &[u8]) -> (String, bool) {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= MAX_COMMAND_OUTPUT_BYTES {
        return (text.into_owned(), false);
    }

    let mut used = 0usize;
    let mut output = String::new();
    for ch in text.chars() {
        let width = ch.len_utf8();
        if used + width > MAX_COMMAND_OUTPUT_BYTES {
            break;
        }
        output.push(ch);
        used += width;
    }
    (output, true)
}

fn is_xlsx_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("xlsx"))
}

fn is_search_ignored_entry(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }

    matches!(
        name,
        "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".git"
            | "__pycache__"
            | "Library"
            | "Caches"
            | "Cache"
    )
}

fn read_xlsx_as_text(path: &Path) -> Result<String> {
    let mut workbook =
        open_workbook_auto(path).map_err(|source| LocalRunnerError::SpreadsheetRead {
            path: path.display().to_string(),
            message: source.to_string(),
        })?;
    let mut output = Vec::new();

    for sheet_name in workbook.sheet_names().to_owned() {
        let range = workbook.worksheet_range(&sheet_name).map_err(|source| {
            LocalRunnerError::SpreadsheetRead {
                path: path.display().to_string(),
                message: source.to_string(),
            }
        })?;

        output.push(format!("# Sheet: {sheet_name}"));
        for row in range.rows() {
            let cells = row.iter().map(format_spreadsheet_cell).collect::<Vec<_>>();
            if cells.iter().all(|cell| cell.is_empty()) {
                continue;
            }
            output.push(cells.join("\t"));
        }
        output.push(String::new());
    }

    Ok(output.join("\n"))
}

fn format_spreadsheet_cell(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(value) => value.clone(),
        Data::Float(value) => {
            if value.fract() == 0.0 {
                format!("{value:.0}")
            } else {
                value.to_string()
            }
        }
        Data::Int(value) => value.to_string(),
        Data::Bool(value) => value.to_string(),
        Data::DateTime(value) => value.to_string(),
        Data::DateTimeIso(value) => value.clone(),
        Data::DurationIso(value) => value.clone(),
        Data::Error(value) => format!("{value:?}"),
    }
}

fn render_workspace_diff(path: &Path, before: Option<&str>, after: &str) -> Option<String> {
    if before == Some(after) {
        return None;
    }

    let path_label = path_to_string(path).replace('\\', "/");
    let before_label = before
        .map(|_| format!("a/{path_label}"))
        .unwrap_or_else(|| "/dev/null".to_string());
    let mut diff = String::new();
    diff.push_str(&format!("--- {before_label}\n"));
    diff.push_str(&format!("+++ b/{path_label}\n"));
    diff.push_str("@@\n");
    if let Some(before) = before {
        append_diff_lines(&mut diff, '-', before);
    }
    append_diff_lines(&mut diff, '+', after);
    Some(truncate_workspace_diff(diff))
}

fn append_diff_lines(output: &mut String, prefix: char, content: &str) {
    if content.is_empty() {
        return;
    }
    for line in content.split('\n') {
        output.push(prefix);
        output.push_str(line.strip_suffix('\r').unwrap_or(line));
        output.push('\n');
    }
}

fn truncate_workspace_diff(diff: String) -> String {
    if diff.len() <= MAX_WORKSPACE_DIFF_BYTES {
        return diff;
    }

    let suffix = "\n[diff truncated]\n";
    let budget = MAX_WORKSPACE_DIFF_BYTES.saturating_sub(suffix.len());
    let mut used = 0usize;
    let mut output = String::new();
    for ch in diff.chars() {
        let width = ch.len_utf8();
        if used + width > budget {
            break;
        }
        output.push(ch);
        used += width;
    }
    output.push_str(suffix);
    output
}
