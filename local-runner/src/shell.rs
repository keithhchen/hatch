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

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
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

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::io::Read;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::Ordering;
    use std::thread;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;

    const POWERSHELL: &str = "powershell.exe";
    const MAX_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;
    const POLL_INTERVAL: Duration = Duration::from_millis(10);

    pub(super) fn execute(
        workspace: &Path,
        command: &str,
        timeout_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<ShellExecOutput> {
        if cancel.load(Ordering::Acquire) {
            return Err(LocalRunnerError::ToolExecutionCancelled);
        }

        let workspace = workspace.canonicalize().map_err(|error| {
            LocalRunnerError::ShellSandboxInitialization(format!(
                "could not canonicalize the Windows Workspace: {error}"
            ))
        })?;
        if !workspace.is_dir() {
            return Err(LocalRunnerError::ShellSandboxInitialization(
                "the Windows Workspace is not a directory".into(),
            ));
        }
        if workspace.parent().is_none() {
            return Err(LocalRunnerError::ShellSandboxInitialization(
                "the filesystem root cannot be granted as a Shell Workspace".into(),
            ));
        }

        let job = JobObject::new()?;
        let mut child = Command::new(POWERSHELL)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command,
            ])
            .creation_flags(CREATE_NEW_PROCESS_GROUP)
            .current_dir(&workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                LocalRunnerError::ShellSandboxUnavailable(format!(
                    "could not start {POWERSHELL}: {error}"
                ))
            })?;

        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }

        let mut stdout_pipe = child.stdout.take().ok_or_else(|| {
            LocalRunnerError::ShellSandboxInitialization(
                "Windows shell stdout pipe was unavailable".into(),
            )
        })?;
        let mut stderr_pipe = child.stderr.take().ok_or_else(|| {
            LocalRunnerError::ShellSandboxInitialization(
                "Windows shell stderr pipe was unavailable".into(),
            )
        })?;
        let stdout_reader = thread::spawn(move || drain_command_output(&mut stdout_pipe));
        let stderr_reader = thread::spawn(move || drain_command_output(&mut stderr_pipe));

        let started_at = Instant::now();
        let deadline = started_at
            .checked_add(Duration::from_millis(timeout_ms))
            .unwrap_or(started_at);
        let stop_reason = loop {
            if cancel.load(Ordering::Acquire) {
                job.terminate_best_effort();
                break StopReason::Cancelled;
            }
            match child.try_wait() {
                Ok(Some(_)) => {
                    // The PowerShell parent may have exited while a child
                    // process still owns the pipes. The Job Object keeps the
                    // whole process tree under one cleanup boundary.
                    job.terminate_best_effort();
                    break StopReason::Completed;
                }
                Ok(None) => {}
                Err(error) => {
                    job.terminate_best_effort();
                    let _ = child.wait();
                    return Err(LocalRunnerError::ShellSandboxInitialization(format!(
                        "could not poll the Windows shell: {error}"
                    )));
                }
            }
            if Instant::now() >= deadline {
                job.terminate_best_effort();
                break StopReason::TimedOut;
            }
            thread::sleep(POLL_INTERVAL);
        };

        let status = child.wait().map_err(|error| {
            LocalRunnerError::ShellSandboxInitialization(format!(
                "could not wait for the Windows shell: {error}"
            ))
        })?;
        let stdout_output = join_output_reader(stdout_reader, "stdout")?;
        let stderr_output = join_output_reader(stderr_reader, "stderr")?;

        if stop_reason == StopReason::Cancelled {
            return Err(LocalRunnerError::ToolExecutionCancelled);
        }

        let (stdout, stderr, stdout_truncated, stderr_truncated) =
            cap_command_output(&stdout_output.bytes, &stderr_output.bytes, &workspace);
        Ok(ShellExecOutput {
            stdout,
            stderr,
            exit_code: status.code().unwrap_or(-1),
            timed_out: stop_reason == StopReason::TimedOut,
            stdout_truncated: stdout_output.truncated || stdout_truncated,
            stderr_truncated: stderr_output.truncated || stderr_truncated,
        })
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum StopReason {
        Completed,
        TimedOut,
        Cancelled,
    }

    struct JobObject {
        handle: HANDLE,
    }

    impl JobObject {
        fn new() -> Result<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(win32_error("could not create the Windows Job Object"));
            }

            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                unsafe { CloseHandle(handle) };
                return Err(win32_error(
                    "could not configure the Windows Job Object cleanup policy",
                ));
            }
            Ok(Self { handle })
        }

        fn assign(&self, child: &Child) -> Result<()> {
            let process = child.as_raw_handle() as HANDLE;
            if unsafe { AssignProcessToJobObject(self.handle, process) } == 0 {
                return Err(win32_error(
                    "could not attach the Windows shell to its Job Object",
                ));
            }
            Ok(())
        }

        fn terminate_best_effort(&self) {
            let _ = unsafe { TerminateJobObject(self.handle, 1) };
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    fn win32_error(context: &str) -> LocalRunnerError {
        LocalRunnerError::ShellSandboxInitialization(format!(
            "{context}: {}",
            std::io::Error::last_os_error()
        ))
    }

    struct BoundedCommandOutput {
        bytes: Vec<u8>,
        truncated: bool,
    }

    fn drain_command_output<R: Read>(reader: &mut R) -> std::io::Result<BoundedCommandOutput> {
        let mut bytes = Vec::with_capacity(MAX_COMMAND_OUTPUT_BYTES);
        let mut chunk = [0u8; 8192];
        let mut truncated = false;
        loop {
            let read = reader.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            let remaining = MAX_COMMAND_OUTPUT_BYTES.saturating_sub(bytes.len());
            if remaining > 0 {
                bytes.extend_from_slice(&chunk[..read.min(remaining)]);
            }
            if read > remaining {
                truncated = true;
            }
        }
        Ok(BoundedCommandOutput { bytes, truncated })
    }

    fn join_output_reader(
        reader: thread::JoinHandle<std::io::Result<BoundedCommandOutput>>,
        stream: &str,
    ) -> Result<BoundedCommandOutput> {
        reader
            .join()
            .map_err(|_| {
                LocalRunnerError::ShellSandboxInitialization(format!(
                    "Windows shell {stream} reader panicked"
                ))
            })?
            .map_err(|error| {
                LocalRunnerError::ShellSandboxInitialization(format!(
                    "could not read Windows shell {stream}: {error}"
                ))
            })
    }

    fn cap_command_output(
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
        let native = workspace.to_string_lossy();
        let forward = native.replace('\\', "/");
        let backward = native.replace('/', "\\");
        text.replace(native.as_ref(), "<WORKSPACE>")
            .replace(&forward, "<WORKSPACE>")
            .replace(&backward, "<WORKSPACE>")
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
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::{CStr, CString, OsStr, OsString};
    use std::fs::{self, File};
    use std::io::Read;
    use std::mem::MaybeUninit;
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::ExitStatusExt;
    use std::path::{Path, PathBuf};
    use std::process::ExitStatus;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
    const SYSTEM_SHELL: &str = "/bin/sh";
    const SAFE_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
    const SAFE_LANG: &str = "en_US.UTF-8";
    const SELF_CHECK_MARKER: &str = "hatch-seatbelt-ready";
    const MAX_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;
    const PROCESS_GROUP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

    // `system.sb` supplies the minimum macOS runtime and dyld reads needed to
    // launch signed system binaries. Explicit denies below remove ambient IPC,
    // networking, process-inspection, and process-control grants that must not
    // cross the Workspace capability boundary. Only fork/exec are restored so
    // interpreters and child processes inherit the same Seatbelt policy.
    //
    // The only mutable filesystem subtrees added by Hatch are the canonical,
    // user-selected Workspace and a per-call, runner-owned temporary directory.
    // The scratch parent is deliberately outside both grants, so the sandboxed
    // process cannot rename or replace the scratch root to evade cleanup.
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
(deny syscall-unix
    (syscall-number SYS_posix_spawn)
    (syscall-number SYS_setpgid)
    (syscall-number SYS_setsid))
(deny signal)
(deny process-info*)
(deny file-read*
    (literal "/private/etc/passwd")
    (literal "/private/etc/master.passwd")
    (literal "/private/etc/group")
    (literal "/private/etc/sudoers")
    (subpath "/private/var/db/dslocal"))
(deny file-write-unlink (literal (param "SCRATCH")))
(deny file-write-flags file-write-acl file-write-owner
    (subpath (param "SCRATCH")))
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
        if let Err(error) = cleanup {
            return Err(LocalRunnerError::ShellSandboxInitialization(format!(
                "could not remove the runner-private per-call scratch directory: {error}"
            )));
        }
        execution
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

        let mut probe = spawn_sandboxed_shell(
            sandbox_exec,
            workspace,
            scratch,
            concat!(
                "if /bin/cat \"$1\" >/dev/null 2>&1; then exit 70; fi; ",
                "if kill -0 \"$PPID\" >/dev/null 2>&1; then exit 71; fi; ",
                "if /bin/launchctl print system >/dev/null 2>&1; then exit 72; fi; ",
                "if /usr/bin/nc -z 127.0.0.1 \"$2\" >/dev/null 2>&1; then exit 73; fi; ",
                "/usr/bin/ruby --disable-gems -e 'begin; Process.setsid; exit 70; rescue Errno::EPERM; exit 0; rescue; exit 76; end' >/dev/null || exit 74; ",
                "/usr/bin/ruby --disable-gems -e 'begin; Process.setpgid(0, 0); exit 70; rescue Errno::EPERM; exit 0; rescue; exit 76; end' >/dev/null || exit 75; ",
                "printf hatch-seatbelt-ready"
            ),
            &[
                OsString::from("hatch-seatbelt-probe"),
                outside_target.into_os_string(),
                OsString::from(network_port),
            ],
        )?;
        let mut stdout_pipe = probe.take_stdout()?;
        let mut stderr_pipe = probe.take_stderr()?;
        let stdout_reader =
            thread::spawn(move || drain_command_output(&mut stdout_pipe, 64 * 1024));
        let stderr_reader =
            thread::spawn(move || drain_command_output(&mut stderr_pipe, 64 * 1024));
        let status = probe.wait().map_err(|error| {
            LocalRunnerError::ShellSandboxInitialization(format!(
                "could not wait for the Seatbelt self-check: {error}"
            ))
        })?;
        probe.terminate_group()?;
        probe.confirm_group_terminated(PROCESS_GROUP_SHUTDOWN_TIMEOUT)?;
        let stdout = join_output_reader(stdout_reader, "self-check stdout")?;
        let stderr = join_output_reader(stderr_reader, "self-check stderr")?;
        let stdout =
            redact_local_paths(&String::from_utf8_lossy(&stdout.bytes), workspace, scratch);
        let stderr =
            redact_local_paths(&String::from_utf8_lossy(&stderr.bytes), workspace, scratch);
        if !status.success() || stdout != SELF_CHECK_MARKER {
            return Err(LocalRunnerError::ShellSandboxInitialization(format!(
                "Seatbelt self-check failed (status {}, stdout {:?}, stderr {:?}); refusing unsafe fallback",
                status, stdout, stderr
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

    fn profile_parameter(name: &str, path: &Path) -> OsString {
        // Passing `-D` as one argv value avoids interpolating a user-controlled
        // path into SBPL source. Quotes, whitespace, Unicode, and `=` therefore
        // remain data rather than policy syntax.
        let mut value = OsString::from(name);
        value.push("=");
        value.push(path.as_os_str());
        value
    }

    unsafe extern "C" {
        fn posix_spawn_file_actions_addchdir_np(
            actions: *mut libc::posix_spawn_file_actions_t,
            path: *const libc::c_char,
        ) -> libc::c_int;
    }

    fn spawn_sandboxed_shell(
        sandbox_exec: &Path,
        workspace: &Path,
        scratch: &Path,
        command_text: &str,
        positional_arguments: &[OsString],
    ) -> Result<SandboxedChild> {
        let anchor = ProcessGroupAnchor::spawn()?;
        let stdout = CloexecPipe::new().map_err(spawn_io_error)?;
        let stderr = CloexecPipe::new().map_err(spawn_io_error)?;
        let mut actions = SpawnFileActions::new().map_err(spawn_io_error)?;
        let mut attributes = SpawnAttributes::new().map_err(spawn_io_error)?;

        let dev_null = CString::new("/dev/null").expect("static path contains no NUL");
        actions
            .add_open(libc::STDIN_FILENO, &dev_null, libc::O_RDONLY, 0)
            .and_then(|_| actions.add_dup2(stdout.write_fd(), libc::STDOUT_FILENO))
            .and_then(|_| actions.add_dup2(stderr.write_fd(), libc::STDERR_FILENO))
            .and_then(|_| actions.add_chdir(workspace))
            .map_err(spawn_io_error)?;

        // POSIX_SPAWN_CLOEXEC_DEFAULT atomically treats every descriptor as
        // close-on-exec unless a file action explicitly carries it across the
        // boundary. This is the macOS primitive that prevents an unrelated
        // host file or connected socket from becoming a shell capability.
        attributes
            .configure(
                (libc::POSIX_SPAWN_CLOEXEC_DEFAULT | libc::POSIX_SPAWN_SETPGROUP) as libc::c_short,
                anchor.pid,
            )
            .map_err(spawn_io_error)?;

        let mut arguments = vec![
            sandbox_exec.as_os_str().to_os_string(),
            OsString::from("-D"),
            profile_parameter("WORKSPACE", workspace),
            OsString::from("-D"),
            profile_parameter("SCRATCH", scratch),
            OsString::from("-p"),
            OsString::from(SANDBOX_PROFILE),
            OsString::from(SYSTEM_SHELL),
            OsString::from("-c"),
            OsString::from(command_text),
        ];
        arguments.extend_from_slice(positional_arguments);
        let arguments = cstring_vector(arguments.iter().map(OsString::as_os_str), "argument")?;

        let environment = [
            OsString::from(format!("PATH={SAFE_PATH}")),
            environment_path("HOME", scratch),
            environment_path("TMPDIR", scratch),
            OsString::from(format!("LANG={SAFE_LANG}")),
        ];
        let environment =
            cstring_vector(environment.iter().map(OsString::as_os_str), "environment")?;
        let executable = os_string_to_cstring(sandbox_exec.as_os_str(), "sandbox executable")?;

        let mut argv = arguments
            .iter()
            .map(|argument| argument.as_ptr().cast_mut())
            .collect::<Vec<_>>();
        argv.push(std::ptr::null_mut());
        let mut envp = environment
            .iter()
            .map(|value| value.as_ptr().cast_mut())
            .collect::<Vec<_>>();
        envp.push(std::ptr::null_mut());

        let mut pid = 0;
        let result = unsafe {
            libc::posix_spawn(
                &mut pid,
                executable.as_ptr(),
                actions.as_ptr(),
                attributes.as_ptr(),
                argv.as_ptr(),
                envp.as_ptr(),
            )
        };
        if result != 0 {
            return Err(LocalRunnerError::ShellSandboxInitialization(format!(
                "could not launch the Seatbelt-confined shell with posix_spawn: {}",
                std::io::Error::from_raw_os_error(result)
            )));
        }
        let process_group = unsafe { libc::getpgid(pid) };
        if process_group != anchor.pid {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
                libc::waitpid(pid, std::ptr::null_mut(), 0);
            }
            return Err(LocalRunnerError::ShellSandboxInitialization(format!(
                "posix_spawn did not join the isolated process group (pid {pid}, expected pgid {}, actual pgid {process_group}); refusing shell execution",
                anchor.pid
            )));
        }

        drop(stdout.write);
        drop(stderr.write);
        Ok(SandboxedChild {
            pid,
            process_group: anchor.pid,
            anchor,
            stdout: Some(stdout.read),
            stderr: Some(stderr.read),
            status: None,
        })
    }

    fn environment_path(name: &str, path: &Path) -> OsString {
        let mut value = OsString::from(name);
        value.push("=");
        value.push(path.as_os_str());
        value
    }

    fn cstring_vector<'a>(
        values: impl Iterator<Item = &'a OsStr>,
        label: &str,
    ) -> Result<Vec<CString>> {
        values
            .map(|value| os_string_to_cstring(value, label))
            .collect()
    }

    fn os_string_to_cstring(value: &OsStr, label: &str) -> Result<CString> {
        CString::new(value.as_bytes()).map_err(|_| {
            LocalRunnerError::ShellSandboxInitialization(format!(
                "{label} unexpectedly contained a NUL byte"
            ))
        })
    }

    fn spawn_io_error(error: std::io::Error) -> LocalRunnerError {
        LocalRunnerError::ShellSandboxInitialization(format!(
            "could not configure the Seatbelt-confined shell process: {error}"
        ))
    }

    struct CloexecPipe {
        read: File,
        write: File,
    }

    impl CloexecPipe {
        fn new() -> std::io::Result<Self> {
            let mut descriptors = [-1; 2];
            if unsafe { libc::pipe(descriptors.as_mut_ptr()) } == -1 {
                return Err(std::io::Error::last_os_error());
            }
            let read = unsafe { File::from_raw_fd(descriptors[0]) };
            let write = unsafe { File::from_raw_fd(descriptors[1]) };
            set_close_on_exec(read.as_raw_fd())?;
            set_close_on_exec(write.as_raw_fd())?;
            Ok(Self { read, write })
        }

        fn write_fd(&self) -> RawFd {
            self.write.as_raw_fd()
        }
    }

    fn set_close_on_exec(fd: RawFd) -> std::io::Result<()> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags == -1 {
            return Err(std::io::Error::last_os_error());
        }
        if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    struct SpawnFileActions(libc::posix_spawn_file_actions_t);

    impl SpawnFileActions {
        fn new() -> std::io::Result<Self> {
            let mut actions = MaybeUninit::uninit();
            spawn_result(unsafe { libc::posix_spawn_file_actions_init(actions.as_mut_ptr()) })?;
            Ok(Self(unsafe { actions.assume_init() }))
        }

        fn as_ptr(&self) -> *const libc::posix_spawn_file_actions_t {
            &self.0
        }

        fn add_open(
            &mut self,
            fd: RawFd,
            path: &CString,
            flags: libc::c_int,
            mode: libc::mode_t,
        ) -> std::io::Result<()> {
            spawn_result(unsafe {
                libc::posix_spawn_file_actions_addopen(&mut self.0, fd, path.as_ptr(), flags, mode)
            })
        }

        fn add_dup2(&mut self, fd: RawFd, target: RawFd) -> std::io::Result<()> {
            spawn_result(unsafe { libc::posix_spawn_file_actions_adddup2(&mut self.0, fd, target) })
        }

        fn add_chdir(&mut self, path: &Path) -> std::io::Result<()> {
            let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "Workspace path contained a NUL byte",
                )
            })?;
            spawn_result(unsafe {
                posix_spawn_file_actions_addchdir_np(&mut self.0, path.as_ptr())
            })
        }
    }

    impl Drop for SpawnFileActions {
        fn drop(&mut self) {
            unsafe {
                libc::posix_spawn_file_actions_destroy(&mut self.0);
            }
        }
    }

    struct SpawnAttributes(libc::posix_spawnattr_t);

    impl SpawnAttributes {
        fn new() -> std::io::Result<Self> {
            let mut attributes = MaybeUninit::uninit();
            spawn_result(unsafe { libc::posix_spawnattr_init(attributes.as_mut_ptr()) })?;
            Ok(Self(unsafe { attributes.assume_init() }))
        }

        fn as_ptr(&self) -> *const libc::posix_spawnattr_t {
            &self.0
        }

        fn configure(
            &mut self,
            flags: libc::c_short,
            process_group: libc::pid_t,
        ) -> std::io::Result<()> {
            spawn_result(unsafe { libc::posix_spawnattr_setpgroup(&mut self.0, process_group) })?;
            spawn_result(unsafe { libc::posix_spawnattr_setflags(&mut self.0, flags) })
        }
    }

    impl Drop for SpawnAttributes {
        fn drop(&mut self) {
            unsafe {
                libc::posix_spawnattr_destroy(&mut self.0);
            }
        }
    }

    fn spawn_result(result: libc::c_int) -> std::io::Result<()> {
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::from_raw_os_error(result))
        }
    }

    struct ProcessGroupAnchor {
        pid: libc::pid_t,
        active: bool,
    }

    impl ProcessGroupAnchor {
        fn spawn() -> Result<Self> {
            let mut actions = SpawnFileActions::new().map_err(spawn_io_error)?;
            let mut attributes = SpawnAttributes::new().map_err(spawn_io_error)?;
            let dev_null = CString::new("/dev/null").expect("static path contains no NUL");
            actions
                .add_open(libc::STDIN_FILENO, &dev_null, libc::O_RDONLY, 0)
                .and_then(|_| actions.add_open(libc::STDOUT_FILENO, &dev_null, libc::O_WRONLY, 0))
                .and_then(|_| actions.add_open(libc::STDERR_FILENO, &dev_null, libc::O_WRONLY, 0))
                .map_err(spawn_io_error)?;
            attributes
                .configure(
                    (libc::POSIX_SPAWN_CLOEXEC_DEFAULT | libc::POSIX_SPAWN_SETPGROUP)
                        as libc::c_short,
                    0,
                )
                .map_err(spawn_io_error)?;

            let executable = CString::new("/bin/sleep").expect("static path contains no NUL");
            let argument = CString::new("86400").expect("static argument contains no NUL");
            let argv = [
                executable.as_ptr().cast_mut(),
                argument.as_ptr().cast_mut(),
                std::ptr::null_mut(),
            ];
            let envp = [std::ptr::null_mut()];
            let mut pid = 0;
            let result = unsafe {
                libc::posix_spawn(
                    &mut pid,
                    executable.as_ptr(),
                    actions.as_ptr(),
                    attributes.as_ptr(),
                    argv.as_ptr(),
                    envp.as_ptr(),
                )
            };
            if result != 0 {
                return Err(LocalRunnerError::ShellSandboxInitialization(format!(
                    "could not launch the isolated process-group anchor: {}",
                    std::io::Error::from_raw_os_error(result)
                )));
            }
            let actual_group = unsafe { libc::getpgid(pid) };
            if actual_group != pid {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                    libc::waitpid(pid, std::ptr::null_mut(), 0);
                }
                return Err(LocalRunnerError::ShellSandboxInitialization(format!(
                    "process-group anchor was not isolated (pid {pid}, pgid {actual_group})"
                )));
            }
            Ok(Self { pid, active: true })
        }

        fn reap(&mut self) -> std::io::Result<()> {
            if !self.active {
                return Ok(());
            }
            loop {
                let result = unsafe { libc::waitpid(self.pid, std::ptr::null_mut(), 0) };
                if result == self.pid {
                    self.active = false;
                    return Ok(());
                }
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                if error.raw_os_error() == Some(libc::ECHILD) {
                    self.active = false;
                    return Ok(());
                }
                return Err(error);
            }
        }
    }

    impl Drop for ProcessGroupAnchor {
        fn drop(&mut self) {
            if self.active {
                unsafe {
                    libc::kill(self.pid, libc::SIGKILL);
                }
                let _ = self.reap();
            }
        }
    }

    struct SandboxedChild {
        pid: libc::pid_t,
        process_group: libc::pid_t,
        anchor: ProcessGroupAnchor,
        stdout: Option<File>,
        stderr: Option<File>,
        status: Option<ExitStatus>,
    }

    impl SandboxedChild {
        fn take_stdout(&mut self) -> Result<File> {
            self.stdout.take().ok_or_else(|| {
                LocalRunnerError::ShellSandboxInitialization(
                    "Seatbelt shell stdout pipe was unavailable".into(),
                )
            })
        }

        fn take_stderr(&mut self) -> Result<File> {
            self.stderr.take().ok_or_else(|| {
                LocalRunnerError::ShellSandboxInitialization(
                    "Seatbelt shell stderr pipe was unavailable".into(),
                )
            })
        }

        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            if let Some(status) = self.status {
                return Ok(Some(status));
            }
            loop {
                let mut raw_status = 0;
                let result = unsafe { libc::waitpid(self.pid, &mut raw_status, libc::WNOHANG) };
                if result == self.pid {
                    let status = ExitStatus::from_raw(raw_status);
                    self.status = Some(status);
                    return Ok(Some(status));
                }
                if result == 0 {
                    return Ok(None);
                }
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
        }

        fn wait(&mut self) -> std::io::Result<ExitStatus> {
            if let Some(status) = self.status {
                return Ok(status);
            }
            loop {
                let mut raw_status = 0;
                let result = unsafe { libc::waitpid(self.pid, &mut raw_status, 0) };
                if result == self.pid {
                    let status = ExitStatus::from_raw(raw_status);
                    self.status = Some(status);
                    return Ok(status);
                }
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
        }

        fn terminate_group(&self) -> Result<()> {
            signal_process_group(self.process_group, libc::SIGKILL).map_err(|error| {
                let current_group = unsafe { libc::getpgid(self.pid) };
                LocalRunnerError::ShellSandboxInitialization(format!(
                    "could not terminate the Seatbelt shell process group {} (root pid {}, current root pgid {}): {error}",
                    self.process_group, self.pid, current_group
                ))
            })
        }

        fn confirm_group_terminated(&mut self, timeout: Duration) -> Result<()> {
            self.anchor.reap().map_err(|error| {
                LocalRunnerError::ShellSandboxInitialization(format!(
                    "could not reap the process-group lifecycle anchor: {error}"
                ))
            })?;
            let deadline = Instant::now() + timeout;
            loop {
                match process_group_exists(self.process_group) {
                    Ok(false) => return Ok(()),
                    Ok(true) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Ok(true) => {
                        return Err(LocalRunnerError::ShellSandboxInitialization(
                            "the Seatbelt shell process group did not terminate before cleanup; refusing to return while a descendant may still hold Workspace access".into(),
                        ))
                    }
                    Err(error) => {
                        return Err(LocalRunnerError::ShellSandboxInitialization(format!(
                            "could not confirm Seatbelt shell process-group termination: {error}"
                        )))
                    }
                }
            }
        }
    }

    impl Drop for SandboxedChild {
        fn drop(&mut self) {
            let _ = signal_process_group(self.process_group, libc::SIGKILL);
            if self.status.is_none() {
                loop {
                    let result = unsafe { libc::waitpid(self.pid, std::ptr::null_mut(), 0) };
                    if result == self.pid {
                        break;
                    }
                    if result == -1
                        && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
                    {
                        break;
                    }
                }
            }
        }
    }

    fn signal_process_group(
        process_group: libc::pid_t,
        signal: libc::c_int,
    ) -> std::io::Result<()> {
        if unsafe { libc::kill(-process_group, signal) } == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }

    fn process_group_exists(process_group: libc::pid_t) -> std::io::Result<bool> {
        if unsafe { libc::kill(-process_group, 0) } == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(false)
        } else if error.raw_os_error() == Some(libc::EPERM) {
            // The group still exists, but macOS may reject a signal probe once
            // only sandboxed dying/zombie members remain. Treat this as
            // present and keep waiting; never mistake EPERM for termination.
            Ok(true)
        } else {
            Err(error)
        }
    }

    fn execute_sandboxed_command(
        sandbox_exec: &Path,
        workspace: &Path,
        scratch: &Path,
        command_text: &str,
        timeout_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<ShellExecOutput> {
        let mut child = spawn_sandboxed_shell(sandbox_exec, workspace, scratch, command_text, &[])?;
        let mut stdout_pipe = child.take_stdout()?;
        let mut stderr_pipe = child.take_stderr()?;

        // Keep one extra transformed-path window so an occurrence that begins
        // at the visible-output boundary can be fully redacted before truncation.
        let capture_limit = MAX_COMMAND_OUTPUT_BYTES
            .saturating_add(max_redaction_variant_len(workspace, scratch).saturating_mul(2));
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
                child.terminate_group()?;
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
                child.terminate_group()?;
                break StopReason::Completed;
            }
            if Instant::now() >= deadline {
                child.terminate_group()?;
                break StopReason::TimedOut;
            }
            thread::sleep(Duration::from_millis(10));
        };

        let status = child.wait().map_err(|error| {
            LocalRunnerError::ShellSandboxInitialization(format!(
                "could not wait for the sandboxed shell: {error}"
            ))
        })?;
        child.confirm_group_terminated(PROCESS_GROUP_SHUTDOWN_TIMEOUT)?;
        let stdout_output = join_output_reader(stdout_reader, "stdout")?;
        let stderr_output = join_output_reader(stderr_reader, "stderr")?;

        if stop_reason == StopReason::Cancelled {
            return Err(LocalRunnerError::ToolExecutionCancelled);
        }

        let (stdout, stderr, stdout_combined_truncated, stderr_combined_truncated) =
            cap_combined_command_output(
                &stdout_output.bytes,
                &stderr_output.bytes,
                workspace,
                scratch,
            );
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
        scratch: &Path,
    ) -> (String, String, bool, bool) {
        let stdout = redact_local_paths(&String::from_utf8_lossy(stdout), workspace, scratch);
        let stderr = redact_local_paths(&String::from_utf8_lossy(stderr), workspace, scratch);
        let stdout_budget = stdout.len().min(MAX_COMMAND_OUTPUT_BYTES);
        let stderr_budget = MAX_COMMAND_OUTPUT_BYTES.saturating_sub(stdout_budget);
        let (stdout, stdout_truncated) = truncate_text(&stdout, stdout_budget);
        let (stderr, stderr_truncated) = truncate_text(&stderr, stderr_budget);
        (stdout, stderr, stdout_truncated, stderr_truncated)
    }

    fn redact_local_paths(text: &str, workspace: &Path, scratch: &Path) -> String {
        let mut redacted = redact_path_variants(text, scratch, "<SCRATCH>");
        redacted = redact_path_variants(&redacted, workspace, "<WORKSPACE>");
        redacted
    }

    fn redact_path_variants(text: &str, path: &Path, replacement: &str) -> String {
        let mut redacted = text.to_string();
        for variant in path_redaction_variants(path) {
            redacted = redacted.replace(&variant, replacement);
        }
        redacted
    }

    fn max_redaction_variant_len(workspace: &Path, scratch: &Path) -> usize {
        [workspace, scratch]
            .into_iter()
            .flat_map(path_redaction_variants)
            .map(|variant| variant.len())
            .max()
            .unwrap_or(0)
    }

    fn path_redaction_variants(path: &Path) -> Vec<String> {
        let path = path.to_string_lossy();
        if path.is_empty() {
            return Vec::new();
        }
        let bytes = path.as_bytes();
        let percent_encoded = percent_encode_path(bytes);
        let shell_escaped = shell_escape_path(path.as_ref());
        let hex_lower = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let hex_upper = hex_lower.to_ascii_uppercase();
        let base64 = base64_encode(bytes, false);
        let base64_url = base64_encode(bytes, true);
        let mut variants = vec![
            format!("file://{path}"),
            format!("file://{percent_encoded}"),
            path.into_owned(),
            percent_encoded,
            shell_escaped,
            hex_lower,
            hex_upper,
            base64.clone(),
            base64.trim_end_matches('=').to_string(),
            base64_url.clone(),
            base64_url.trim_end_matches('=').to_string(),
        ];
        variants.retain(|variant| !variant.is_empty());
        variants.sort_by_key(|variant| std::cmp::Reverse(variant.len()));
        variants.dedup();
        variants
    }

    fn percent_encode_path(bytes: &[u8]) -> String {
        let mut output = String::with_capacity(bytes.len());
        for &byte in bytes {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'.' | b'_' | b'~') {
                output.push(byte as char);
            } else {
                output.push_str(&format!("%{byte:02X}"));
            }
        }
        output
    }

    fn shell_escape_path(path: &str) -> String {
        let mut output = String::with_capacity(path.len());
        for character in path.chars() {
            if character.is_alphanumeric() || matches!(character, '/' | '-' | '.' | '_' | '~') {
                output.push(character);
            } else {
                output.push('\\');
                output.push(character);
            }
        }
        output
    }

    fn base64_encode(bytes: &[u8], url_safe: bool) -> String {
        let alphabet = if url_safe {
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        } else {
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        };
        let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let first = chunk[0];
            let second = chunk.get(1).copied().unwrap_or(0);
            let third = chunk.get(2).copied().unwrap_or(0);
            output.push(alphabet[(first >> 2) as usize] as char);
            output.push(alphabet[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
            if chunk.len() > 1 {
                output.push(alphabet[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char);
            } else {
                output.push('=');
            }
            if chunk.len() > 2 {
                output.push(alphabet[(third & 0x3f) as usize] as char);
            } else {
                output.push('=');
            }
        }
        output
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
        directory: Option<tempfile::TempDir>,
    }

    impl ScratchDirectory {
        fn create(workspace: &Path) -> Result<Self> {
            let temporary_root = darwin_user_temporary_directory().map_err(|error| {
                LocalRunnerError::ShellSandboxInitialization(format!(
                    "could not resolve the runner-private macOS temporary directory: {error}"
                ))
            })?;
            if temporary_root.starts_with(workspace) {
                return Err(LocalRunnerError::ShellSandboxInitialization(
                    "the runner-private temporary root resolves inside the Workspace; refusing a movable scratch capability".into(),
                ));
            }
            let directory = tempfile::Builder::new()
                .prefix(".hatch-shell-tmp-")
                .tempdir_in(&temporary_root)
                .map_err(|error| {
                    LocalRunnerError::ShellSandboxInitialization(format!(
                        "could not create the runner-private per-call scratch directory: {error}"
                    ))
                })?;
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).map_err(
                |error| {
                    LocalRunnerError::ShellSandboxInitialization(format!(
                        "could not restrict the per-call scratch directory: {error}"
                    ))
                },
            )?;
            let path = directory.path().canonicalize().map_err(|error| {
                LocalRunnerError::ShellSandboxInitialization(format!(
                    "could not canonicalize the per-call scratch directory: {error}"
                ))
            })?;
            Ok(Self {
                path,
                directory: Some(directory),
            })
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn cleanup(&mut self) -> std::io::Result<()> {
            if self.directory.is_none() {
                return Ok(());
            }
            make_tree_removable(&self.path)?;
            match fs::remove_dir_all(&self.path) {
                Ok(()) => {
                    self.directory.take();
                    Ok(())
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.directory.take();
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

    fn darwin_user_temporary_directory() -> std::io::Result<PathBuf> {
        let required =
            unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, std::ptr::null_mut(), 0) };
        if required == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut buffer = vec![0u8; required];
        let written = unsafe {
            libc::confstr(
                libc::_CS_DARWIN_USER_TEMP_DIR,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
            )
        };
        if written == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let path = CStr::from_bytes_until_nul(&buffer)
            .map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "macOS temporary-directory result was not NUL terminated",
                )
            })?
            .to_bytes();
        PathBuf::from(OsString::from_vec(path.to_vec())).canonicalize()
    }

    fn make_tree_removable(path: &Path) -> std::io::Result<()> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Ok(());
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                make_tree_removable(&entry.path())?;
            }
        }
        Ok(())
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
        fn common_workspace_path_representations_are_redacted() {
            let workspace = Path::new("/private/tmp/Hatch Workspace");
            let scratch = Path::new("/private/tmp/Hatch Scratch");
            let representations = path_redaction_variants(workspace).join("\n");
            let redacted = redact_local_paths(&representations, workspace, scratch);
            assert!(!redacted.contains("/private/tmp/Hatch Workspace"));
            assert_eq!(
                redacted
                    .lines()
                    .filter(|line| *line == "<WORKSPACE>")
                    .count(),
                representations.lines().count()
            );
        }

        #[test]
        fn base64_encoder_matches_rfc_4648_examples() {
            assert_eq!(base64_encode(b"", false), "");
            assert_eq!(base64_encode(b"f", false), "Zg==");
            assert_eq!(base64_encode(b"fo", false), "Zm8=");
            assert_eq!(base64_encode(b"foo", false), "Zm9v");
        }
    }
}
