//! Real Runner/PowerShell integration tests for Windows, including Wuying Windows.
//! These exercise execution and cleanup, not ACL isolation or Desktop end-to-end UAT.
#![cfg(target_os = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use hatch_local_runner::{LocalRunner, ToolCallRequest, ToolCallResult};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::tempdir;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

#[test]
fn chinese_and_space_workspace_supports_relative_file_io() {
    let temp = tempdir().unwrap();
    let workspace = temp.path().join("中文 workspace with spaces");
    let runner = LocalRunner::new(&workspace).unwrap();
    let output = ok(runner.execute_tool_call_request(request(
        "unicode_workspace",
        r#"$ErrorActionPreference = 'Stop'; Set-Content -LiteralPath '.\中文 文件.txt' -Value 'real-file-ok' -Encoding UTF8 -NoNewline; [Console]::Out.Write((Get-Content -LiteralPath '.\中文 文件.txt' -Raw))"#,
        30_000,
    )));
    assert_eq!(output["exit_code"], 0, "{output}");
    assert_eq!(output["timed_out"], false, "{output}");
    assert_eq!(output["stdout"], "real-file-ok", "{output}");
    assert_eq!(output["stderr"], "", "{output}");
    // Check the real file at the intended cwd, independently of captured output.
    assert_eq!(
        fs::read_to_string(workspace.join("中文 文件.txt"))
            .unwrap()
            .trim_start_matches('\u{feff}'),
        "real-file-ok"
    );
}

#[test]
fn stdout_stderr_and_nonzero_exit_are_preserved() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    let output = ok(runner.execute_tool_call_request(request(
        "streams_and_exit",
        "[Console]::Out.Write('stdout-ok'); [Console]::Error.Write('stderr-ok'); exit 37",
        30_000,
    )));
    assert_eq!(output["stdout"], "stdout-ok", "{output}");
    assert_eq!(output["stderr"], "stderr-ok", "{output}");
    assert_eq!(output["exit_code"], 37, "{output}");
    assert_eq!(output["timed_out"], false, "{output}");
    assert_eq!(output["stdout_truncated"], false, "{output}");
    assert_eq!(output["stderr_truncated"], false, "{output}");
}

#[test]
fn cancellation_after_child_ready_returns_cancelled_and_stops_both_processes() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    let running = RunningCall::start(runner, process_tree_command(temp.path()), 60_000);
    let parent = running.wait_for_process(&temp.path().join("parent.pid"));
    let child = running.wait_for_process(&temp.path().join("child.pid"));
    parent.assert_running();
    child.assert_running();

    let cancelled_at = Instant::now();
    running.cancel.store(true, Ordering::Release);
    let response = running.receive(Duration::from_secs(10));
    match response {
        ToolCallResult::Error { error, .. } => {
            assert_eq!(error.code, "cancelled");
            assert_eq!(error.message, "local tool execution was cancelled");
        }
        other => panic!("expected cancellation, got {other:?}"),
    }
    parent.assert_exited();
    child.assert_exited();
    assert!(cancelled_at.elapsed() < Duration::from_secs(15));
}

#[test]
fn timeout_preserves_partial_output_and_stops_both_processes() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    // Allow real PowerShell startup on a cold cloud desktop before the timeout.
    let running = RunningCall::start(runner, process_tree_command(temp.path()), 30_000);
    let parent = running.wait_for_process(&temp.path().join("parent.pid"));
    let child = running.wait_for_process(&temp.path().join("child.pid"));
    parent.assert_running();
    child.assert_running();

    let output = ok(running.receive(Duration::from_secs(40)));
    parent.assert_exited();
    child.assert_exited();
    assert_eq!(output["timed_out"], true, "{output}");
    assert_eq!(output["stdout"], "before-stop", "{output}");
    // Terminated Windows PowerShell may append its CLIXML diagnostic header.
    // The Runner preserves raw stderr; require our pre-timeout bytes without
    // pretending the shell cannot emit additional shutdown diagnostics.
    assert!(
        output["stderr"]
            .as_str()
            .unwrap()
            .starts_with("before-stop-error"),
        "{output}"
    );
}

fn request(id: &str, command: &str, timeout_ms: u64) -> ToolCallRequest {
    ToolCallRequest {
        message_type: "tool_call.request".into(),
        run_id: "windows_execution_integration".into(),
        tool_call_id: id.into(),
        name: "shell_exec".into(),
        arguments: json!({ "command": command, "timeout_ms": timeout_ms }),
        approval: None,
    }
}

fn ok(response: ToolCallResult) -> Value {
    match response {
        ToolCallResult::Ok { result, .. } => result,
        other => panic!("real Runner execution failed: {other:?}"),
    }
}

fn ps_literal(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "''"))
}

fn process_tree_command(workspace: &Path) -> String {
    // The child publishes its own PID only once it is actually executing.
    // EncodedCommand avoids Start-Process argument quoting ambiguities.
    let child_script = format!(
        "[IO.File]::WriteAllText({}, [string]$PID); Start-Sleep -Seconds 90",
        ps_literal(&workspace.join("child.pid"))
    );
    let encoded = STANDARD.encode(
        child_script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    format!(
        "$ErrorActionPreference = 'Stop'; \
         [IO.File]::WriteAllText({}, [string]$PID); \
         [Console]::Out.Write('before-stop'); [Console]::Out.Flush(); \
         [Console]::Error.Write('before-stop-error'); [Console]::Error.Flush(); \
         $child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') \
         -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','{encoded}' \
         -PassThru -NoNewWindow; Start-Sleep -Seconds 90",
        ps_literal(&workspace.join("parent.pid"))
    )
}

struct RunningCall {
    cancel: Arc<AtomicBool>,
    receiver: mpsc::Receiver<ToolCallResult>,
    worker: Option<thread::JoinHandle<()>>,
    started: Instant,
}

impl RunningCall {
    fn start(runner: LocalRunner, command: String, timeout_ms: u64) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            let response = runner.execute_tool_call_request_with_cancel(
                request("process_tree", &command, timeout_ms),
                worker_cancel,
            );
            let _ = sender.send(response);
        });
        Self {
            cancel,
            receiver,
            worker: Some(worker),
            started: Instant::now(),
        }
    }

    fn wait_for_process(&self, marker: &Path) -> ProcessGuard {
        loop {
            // File creation and contents are not atomic; tolerate partial publication.
            if let Some(pid) = fs::read_to_string(marker)
                .ok()
                .and_then(|text| text.trim().parse::<u32>().ok())
            {
                return ProcessGuard::open(pid);
            }
            if let Ok(response) = self.receiver.try_recv() {
                panic!(
                    "Runner finished before {} was ready: {response:?}",
                    marker.display()
                );
            }
            assert!(
                self.started.elapsed() < Duration::from_secs(20),
                "real PowerShell did not publish {} within 20s",
                marker.display()
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn receive(&self, timeout: Duration) -> ToolCallResult {
        self.receiver
            .recv_timeout(timeout)
            .expect("Runner did not return within the integration-test deadline")
    }
}

impl Drop for RunningCall {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        // Do not let a broken Runner's wait/read loop hang the test harness.
        let deadline = Instant::now() + Duration::from_secs(5);
        if let Some(worker) = self.worker.take() {
            while !worker.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            if worker.is_finished() {
                let _ = worker.join();
            }
        }
    }
}

struct ProcessGuard(HANDLE);

impl ProcessGuard {
    fn open(pid: u32) -> Self {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
        assert!(
            !handle.is_null(),
            "cannot hold process {pid}: {}",
            std::io::Error::last_os_error()
        );
        Self(handle)
    }

    fn assert_running(&self) {
        assert_eq!(unsafe { WaitForSingleObject(self.0, 0) }, WAIT_TIMEOUT);
    }

    fn assert_exited(&self) {
        // Retain the same kernel object across termination, avoiding PID reuse.
        assert_eq!(
            unsafe { WaitForSingleObject(self.0, 2_000) },
            WAIT_OBJECT_0,
            "Runner returned but a real PowerShell process survived"
        );
    }
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        unsafe {
            // Cleanup happens AFTER the assertions; it cannot make them pass.
            if WaitForSingleObject(self.0, 0) == WAIT_TIMEOUT {
                TerminateProcess(self.0, 1);
                WaitForSingleObject(self.0, 2_000);
            }
            CloseHandle(self.0);
        }
    }
}
