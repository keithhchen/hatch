use crate::tools::ShellExecOutput;
use crate::{LocalRunnerError, Result};
use std::path::Path;
use std::sync::atomic::AtomicBool;

pub(crate) fn execute(
    workspace: &Path,
    command: &str,
    timeout_ms: u64,
    cancel: &AtomicBool,
) -> Result<ShellExecOutput> {
    platform::execute(workspace, command, timeout_ms, cancel)
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub(super) fn execute(
        _workspace: &Path,
        _command: &str,
        _timeout_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<ShellExecOutput> {
        if cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err(LocalRunnerError::ToolExecutionCancelled);
        }
        Err(LocalRunnerError::ShellSandboxUnavailable(
            "the V1 secure shell backend requires macOS Seatbelt; refusing to run an unsafe host shell"
                .into(),
        ))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::OsString;
    use std::fs;
    use std::io::Read;
    use std::os::unix::fs::DirBuilderExt;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, ExitStatus, Stdio};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
    const SYSTEM_SHELL: &str = "/bin/sh";
    const SAFE_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
    const SAFE_LANG: &str = "en_US.UTF-8";
    const SELF_CHECK_MARKER: &str = "hatch-seatbelt-ready";
    const MAX_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;
    const SCRATCH_ATTEMPTS: u64 = 64;

    // `system.sb` supplies the minimum macOS runtime and dyld reads needed to
    // launch signed system binaries. Explicit denies below remove ambient IPC,
    // networking, process-inspection, and process-control grants that must not
    // cross the Workspace capability boundary. Only fork/exec are restored so
    // interpreters and child processes inherit the same Seatbelt policy.
    //
    // The only mutable filesystem subtree added by Hatch is the canonical,
    // user-selected Workspace. SCRATCH is a child of that Workspace and is
    // listed separately to make the lifecycle boundary explicit in the policy.
    const SANDBOX_PROFILE: &str = r#"
(version 1)
(deny default)
(import "system.sb")
(deny network*)
(deny mach-lookup)
(deny mach-register)
(deny mach-per-user-lookup)
(deny mach-issue-extension)
(deny generic-issue-extension)
(deny appleevent-send)
(deny distributed-notification-post)
(deny ipc-posix*)
(deny system-socket)
(deny job-creation)
(deny signal)
(deny process-info*)
(allow signal (target self))
(allow signal (target children))
(allow process-info* (target self))
(allow process-fork)
(allow process-exec*)
(deny process-exec*
    (literal "/usr/bin/security")
    (literal "/usr/bin/osascript")
    (literal "/usr/bin/open")
    (literal "/bin/launchctl")
    (literal "/usr/bin/launchctl"))
(allow file-read* (literal "/private/var/select/sh"))
(allow file-read* file-write*
    (subpath (param "WORKSPACE"))
    (subpath (param "SCRATCH")))
"#;

    static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

    pub(super) fn execute(
        workspace: &Path,
        command: &str,
        timeout_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<ShellExecOutput> {
        execute_with_backend(
            Path::new(SANDBOX_EXEC),
            workspace,
            command,
            timeout_ms,
            cancel,
        )
    }

    fn execute_with_backend(
        sandbox_exec: &Path,
        workspace: &Path,
        command: &str,
        timeout_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<ShellExecOutput> {
        if cancel.load(Ordering::Acquire) {
            return Err(LocalRunnerError::ToolExecutionCancelled);
        }

        let workspace = canonical_workspace(workspace)?;
        verify_backend_binary(sandbox_exec)?;
        let mut scratch = ScratchDirectory::create(&workspace)?;

        let execution = (|| {
            verify_seatbelt(sandbox_exec, &workspace, scratch.path())?;
            if cancel.load(Ordering::Acquire) {
                return Err(LocalRunnerError::ToolExecutionCancelled);
            }
            execute_sandboxed_command(
                sandbox_exec,
                &workspace,
                scratch.path(),
                command,
                timeout_ms,
                cancel,
            )
        })();

        let cleanup = scratch.cleanup();
        match (execution, cleanup) {
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(LocalRunnerError::ShellSandboxInitialization(format!(
                "could not remove the per-call Workspace scratch directory: {error}"
            ))),
            (Ok(output), Ok(())) => Ok(output),
        }
    }

    fn canonical_workspace(workspace: &Path) -> Result<PathBuf> {
        let canonical = workspace.canonicalize().map_err(|error| {
            LocalRunnerError::ShellSandboxInitialization(format!(
                "could not canonicalize the granted Workspace: {error}"
            ))
        })?;
        if !canonical.is_dir() {
            return Err(LocalRunnerError::ShellSandboxInitialization(
                "the canonical Workspace is not a directory".into(),
            ));
        }
        if canonical.parent().is_none() {
            return Err(LocalRunnerError::ShellSandboxInitialization(
                "the filesystem root cannot be granted as a Shell Workspace".into(),
            ));
        }
        Ok(canonical)
    }

    fn verify_backend_binary(sandbox_exec: &Path) -> Result<()> {
        let metadata = fs::metadata(sandbox_exec).map_err(|error| {
            LocalRunnerError::ShellSandboxUnavailable(format!(
                "{} is missing or inaccessible ({error}); refusing unsafe fallback",
                sandbox_exec.display()
            ))
        })?;
        if !metadata.is_file() {
            return Err(LocalRunnerError::ShellSandboxUnavailable(format!(
                "{} is not an executable file; refusing unsafe fallback",
                sandbox_exec.display()
            )));
        }
        Ok(())
    }

    fn verify_seatbelt(sandbox_exec: &Path, workspace: &Path, scratch: &Path) -> Result<()> {
        let outside_target = outside_probe_target(workspace).ok_or_else(|| {
            LocalRunnerError::ShellSandboxInitialization(
                "could not find a readable path outside the Workspace for the Seatbelt self-check"
                    .into(),
            )
        })?;
        let network_probe = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| {
                LocalRunnerError::ShellSandboxInitialization(format!(
                    "could not create the Seatbelt network self-check listener: {error}"
                ))
            })?;
        let network_port = network_probe
            .local_addr()
            .map_err(|error| {
                LocalRunnerError::ShellSandboxInitialization(format!(
                    "could not inspect the Seatbelt network self-check listener: {error}"
                ))
            })?
            .port()
            .to_string();

        let mut probe = sandbox_command(sandbox_exec, workspace, scratch);
        probe
            .arg(SYSTEM_SHELL)
            .arg("-c")
            .arg(concat!(
                "if /bin/cat \"$1\" >/dev/null 2>&1; then exit 70; fi; ",
                "if kill -0 \"$PPID\" >/dev/null 2>&1; then exit 71; fi; ",
                "if /bin/launchctl print system >/dev/null 2>&1; then exit 72; fi; ",
                "if /usr/bin/nc -z 127.0.0.1 \"$2\" >/dev/null 2>&1; then exit 73; fi; ",
                "printf hatch-seatbelt-ready"
            ))
            .arg("hatch-seatbelt-probe")
            .arg(outside_target)
            .arg(network_port)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let output = probe.output().map_err(|error| {
            LocalRunnerError::ShellSandboxUnavailable(format!(
                "could not start {} ({error}); refusing unsafe fallback",
                sandbox_exec.display()
            ))
        })?;
        let stdout = redact_workspace_path(&String::from_utf8_lossy(&output.stdout), workspace);
        let stderr = redact_workspace_path(&String::from_utf8_lossy(&output.stderr), workspace);
        if !output.status.success() || stdout != SELF_CHECK_MARKER {
            return Err(LocalRunnerError::ShellSandboxInitialization(format!(
                "Seatbelt self-check failed (status {}, stdout {:?}, stderr {:?}); refusing unsafe fallback",
                output.status, stdout, stderr
            )));
        }
        Ok(())
    }

    fn outside_probe_target(workspace: &Path) -> Option<PathBuf> {
        [
            "/private/etc/hosts",
            "/private/etc/passwd",
            "/private/var/db/timezone/zoneinfo/UTC",
        ]
        .into_iter()
        .filter_map(|candidate| Path::new(candidate).canonicalize().ok())
        .find(|candidate| !candidate.starts_with(workspace))
    }

    fn sandbox_command(sandbox_exec: &Path, workspace: &Path, scratch: &Path) -> Command {
        let mut command = Command::new(sandbox_exec);
        command
            .env_clear()
            .env("PATH", SAFE_PATH)
            .env("HOME", scratch)
            .env("TMPDIR", scratch)
            .env("LANG", SAFE_LANG)
            .arg("-D")
            .arg(profile_parameter("WORKSPACE", workspace))
            .arg("-D")
            .arg(profile_parameter("SCRATCH", scratch))
            .arg("-p")
            .arg(SANDBOX_PROFILE)
            .current_dir(workspace);
        command
    }

    fn profile_parameter(name: &str, path: &Path) -> OsString {
        // Passing `-D` as one argv value avoids interpolating a user-controlled
        // path into SBPL source. Quotes, whitespace, Unicode, and `=` therefore
        // remain data rather than policy syntax.
        let mut value = OsString::from(name);
        value.push("=");
        value.push(path.as_os_str());
        value
    }

    fn execute_sandboxed_command(
        sandbox_exec: &Path,
        workspace: &Path,
        scratch: &Path,
        command_text: &str,
        timeout_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<ShellExecOutput> {
        let mut command = sandbox_command(sandbox_exec, workspace, scratch);
        command
            .arg(SYSTEM_SHELL)
            .arg("-c")
            .arg(command_text)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = command.spawn().map_err(|error| {
            LocalRunnerError::ShellSandboxInitialization(format!(
                "could not launch the Seatbelt-confined shell: {error}"
            ))
        })?;
        let mut stdout_pipe = child.stdout.take().ok_or_else(|| {
            LocalRunnerError::ShellSandboxInitialization(
                "Seatbelt shell stdout pipe was unavailable".into(),
            )
        })?;
        let mut stderr_pipe = child.stderr.take().ok_or_else(|| {
            LocalRunnerError::ShellSandboxInitialization(
                "Seatbelt shell stderr pipe was unavailable".into(),
            )
        })?;

        // Keep one extra path-length window so an occurrence that begins at
        // the visible-output boundary can be fully redacted before truncation.
        let capture_limit = MAX_COMMAND_OUTPUT_BYTES
            .saturating_add(workspace.to_string_lossy().len().saturating_mul(2));
        let stdout_reader =
            thread::spawn(move || drain_command_output(&mut stdout_pipe, capture_limit));
        let stderr_reader =
            thread::spawn(move || drain_command_output(&mut stderr_pipe, capture_limit));

        let started_at = Instant::now();
        let deadline = started_at
            .checked_add(Duration::from_millis(timeout_ms))
            .unwrap_or(started_at);
        let stop_reason = loop {
            if cancel.load(Ordering::Acquire) {
                terminate_shell_process(&mut child).map_err(|error| {
                    LocalRunnerError::ShellSandboxInitialization(format!(
                        "could not terminate the cancelled shell process group: {error}"
                    ))
                })?;
                break StopReason::Cancelled;
            }
            if child
                .try_wait()
                .map_err(|error| {
                    LocalRunnerError::ShellSandboxInitialization(format!(
                        "could not poll the sandboxed shell: {error}"
                    ))
                })?
                .is_some()
            {
                // A shell can exit while a background child still holds the
                // output pipes. Kill the remaining process group before joins.
                terminate_shell_process(&mut child).map_err(|error| {
                    LocalRunnerError::ShellSandboxInitialization(format!(
                        "could not reap the completed shell process group: {error}"
                    ))
                })?;
                break StopReason::Completed;
            }
            if Instant::now() >= deadline {
                terminate_shell_process(&mut child).map_err(|error| {
                    LocalRunnerError::ShellSandboxInitialization(format!(
                        "could not terminate the timed-out shell process group: {error}"
                    ))
                })?;
                break StopReason::TimedOut;
            }
            thread::sleep(Duration::from_millis(10));
        };

        let status = child.wait().map_err(|error| {
            LocalRunnerError::ShellSandboxInitialization(format!(
                "could not wait for the sandboxed shell: {error}"
            ))
        })?;
        let stdout_output = join_output_reader(stdout_reader, "stdout")?;
        let stderr_output = join_output_reader(stderr_reader, "stderr")?;

        if stop_reason == StopReason::Cancelled {
            return Err(LocalRunnerError::ToolExecutionCancelled);
        }

        let (stdout, stderr, stdout_combined_truncated, stderr_combined_truncated) =
            cap_combined_command_output(&stdout_output.bytes, &stderr_output.bytes, workspace);
        Ok(ShellExecOutput {
            stdout,
            stderr,
            exit_code: exit_code(status),
            timed_out: stop_reason == StopReason::TimedOut,
            stdout_truncated: stdout_output.truncated || stdout_combined_truncated,
            stderr_truncated: stderr_output.truncated || stderr_combined_truncated,
        })
    }

    fn exit_code(status: ExitStatus) -> i32 {
        status.code().unwrap_or(-1)
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum StopReason {
        Completed,
        TimedOut,
        Cancelled,
    }

    fn terminate_shell_process(child: &mut std::process::Child) -> std::io::Result<()> {
        let process_group = child.id() as libc::pid_t;
        let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
        if result == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }

    fn join_output_reader(
        reader: thread::JoinHandle<std::io::Result<BoundedCommandOutput>>,
        stream: &str,
    ) -> Result<BoundedCommandOutput> {
        reader
            .join()
            .map_err(|_| {
                LocalRunnerError::ShellSandboxInitialization(format!(
                    "sandboxed shell {stream} reader panicked"
                ))
            })?
            .map_err(|error| {
                LocalRunnerError::ShellSandboxInitialization(format!(
                    "could not read sandboxed shell {stream}: {error}"
                ))
            })
    }

    #[derive(Debug)]
    struct BoundedCommandOutput {
        bytes: Vec<u8>,
        truncated: bool,
    }

    fn drain_command_output<R: Read>(
        reader: &mut R,
        max_bytes: usize,
    ) -> std::io::Result<BoundedCommandOutput> {
        let mut bytes = Vec::with_capacity(max_bytes);
        let mut chunk = [0u8; 8192];
        let mut truncated = false;
        loop {
            let read = reader.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            let remaining = max_bytes.saturating_sub(bytes.len());
            if remaining > 0 {
                bytes.extend_from_slice(&chunk[..read.min(remaining)]);
            }
            if read > remaining {
                truncated = true;
            }
        }
        Ok(BoundedCommandOutput { bytes, truncated })
    }

    fn cap_combined_command_output(
        stdout: &[u8],
        stderr: &[u8],
        workspace: &Path,
    ) -> (String, String, bool, bool) {
        let stdout = redact_workspace_path(&String::from_utf8_lossy(stdout), workspace);
        let stderr = redact_workspace_path(&String::from_utf8_lossy(stderr), workspace);
        let stdout_budget = stdout.len().min(MAX_COMMAND_OUTPUT_BYTES);
        let stderr_budget = MAX_COMMAND_OUTPUT_BYTES.saturating_sub(stdout_budget);
        let (stdout, stdout_truncated) = truncate_text(&stdout, stdout_budget);
        let (stderr, stderr_truncated) = truncate_text(&stderr, stderr_budget);
        (stdout, stderr, stdout_truncated, stderr_truncated)
    }

    fn redact_workspace_path(text: &str, workspace: &Path) -> String {
        let workspace = workspace.to_string_lossy();
        if workspace.is_empty() {
            return text.to_string();
        }
        text.replace(workspace.as_ref(), "<WORKSPACE>")
    }

    fn truncate_text(text: &str, max_bytes: usize) -> (String, bool) {
        if text.len() <= max_bytes {
            return (text.to_string(), false);
        }
        let mut used = 0usize;
        let mut output = String::new();
        for character in text.chars() {
            let width = character.len_utf8();
            if used + width > max_bytes {
                break;
            }
            output.push(character);
            used += width;
        }
        (output, true)
    }

    struct ScratchDirectory {
        path: PathBuf,
        active: bool,
    }

    impl ScratchDirectory {
        fn create(workspace: &Path) -> Result<Self> {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            for _ in 0..SCRATCH_ATTEMPTS {
                let counter = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = workspace.join(format!(
                    ".hatch-shell-tmp-{}-{timestamp:x}-{counter:x}",
                    std::process::id()
                ));
                let mut builder = fs::DirBuilder::new();
                builder.mode(0o700);
                match builder.create(&path) {
                    Ok(()) => return Ok(Self { path, active: true }),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => {
                        return Err(LocalRunnerError::ShellSandboxInitialization(format!(
                            "could not create the per-call Workspace scratch directory: {error}"
                        )))
                    }
                }
            }
            Err(LocalRunnerError::ShellSandboxInitialization(
                "could not allocate a unique per-call Workspace scratch directory".into(),
            ))
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn cleanup(&mut self) -> std::io::Result<()> {
            if !self.active {
                return Ok(());
            }
            match fs::remove_dir_all(&self.path) {
                Ok(()) => {
                    self.active = false;
                    Ok(())
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.active = false;
                    Ok(())
                }
                Err(error) => Err(error),
            }
        }
    }

    impl Drop for ScratchDirectory {
        fn drop(&mut self) {
            let _ = self.cleanup();
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn missing_backend_fails_closed_without_running_the_command() {
            let workspace = tempfile::tempdir().unwrap();
            let cancel = AtomicBool::new(false);
            let error = execute_with_backend(
                Path::new("/definitely/missing/hatch-sandbox-exec"),
                workspace.path(),
                "printf unsafe",
                1_000,
                &cancel,
            )
            .unwrap_err();
            assert!(matches!(
                error,
                LocalRunnerError::ShellSandboxUnavailable(_)
            ));
        }

        #[test]
        fn canonical_workspace_paths_are_redacted() {
            let workspace = Path::new("/private/tmp/Hatch Workspace");
            assert_eq!(
                redact_workspace_path("cwd=/private/tmp/Hatch Workspace/src\n", workspace),
                "cwd=<WORKSPACE>/src\n"
            );
        }
    }
}
