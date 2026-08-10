#![cfg(target_os = "macos")]

use hatch_local_runner::{LocalRunner, ToolCallRequest, ToolCallResult};
use serde_json::{json, Value};
use std::fs;
use std::io::ErrorKind;
use std::net::TcpListener;
use std::os::unix::fs::symlink;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tempfile::{tempdir_in, TempDir};

const SHELL_TIMEOUT_MS: u64 = 10_000;

#[test]
fn allows_workspace_io_and_interpreters_but_redacts_the_canonical_path() {
    let fixture = ShellFixture::new();
    let output = fixture.run(
        "printf inside > notes.txt && /bin/sh -c 'printf child >> notes.txt' && \
         /usr/bin/awk 'BEGIN { print \"awk\" }' >> notes.txt && /bin/cat notes.txt && /bin/pwd",
    );

    assert_eq!(output["exit_code"], 0);
    assert!(output["stdout"]
        .as_str()
        .unwrap()
        .contains("insidechildawk"));
    assert!(output["stdout"].as_str().unwrap().contains("<WORKSPACE>"));
    assert!(!output["stdout"]
        .as_str()
        .unwrap()
        .contains(fixture.workspace.to_string_lossy().as_ref()));
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("notes.txt")).unwrap(),
        "insidechildawk\n"
    );
    fixture.assert_scratch_cleaned();
}

#[test]
fn blocks_parent_absolute_symlink_redirection_and_interpreter_escapes() {
    let fixture = ShellFixture::new();
    let outside = fixture.root.path().join("outside.txt");
    fs::write(&outside, "outside-secret").unwrap();
    let outside_quote = shell_quote(&outside);
    symlink(&outside, fixture.workspace.join("outside-link")).unwrap();

    for command in [
        "/bin/cat ../outside.txt".to_string(),
        format!("/bin/cat {outside_quote}"),
        "/bin/cat outside-link".to_string(),
        format!("printf escaped > {outside_quote}"),
        "printf escaped > outside-link".to_string(),
        format!(
            "/bin/sh -c {}",
            shell_quote_text(&format!("cat {outside_quote}"))
        ),
    ] {
        let output = fixture.run(&command);
        assert_ne!(
            output["exit_code"], 0,
            "escape unexpectedly succeeded: {command}"
        );
    }

    // awk reports a failed getline as EOF and can still exit zero; the
    // security assertion is that no outside content crosses the boundary.
    let awk = fixture.run(&format!(
        "/usr/bin/awk 'BEGIN {{ while ((getline line < \"{}\") > 0) print line }}'",
        escape_for_awk(&outside)
    ));
    assert!(!awk["stdout"].as_str().unwrap().contains("outside-secret"));

    assert_eq!(fs::read_to_string(&outside).unwrap(), "outside-secret");
    fixture.assert_scratch_cleaned();
}

#[test]
fn denies_tcp_and_unix_socket_connections() {
    let fixture = ShellFixture::new();
    let tcp = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    tcp.set_nonblocking(true).unwrap();
    let port = tcp.local_addr().unwrap().port();
    let tcp_output = fixture.run(&format!("/usr/bin/nc -z 127.0.0.1 {port}"));
    assert_ne!(tcp_output["exit_code"], 0);
    assert_eq!(tcp.accept().unwrap_err().kind(), ErrorKind::WouldBlock);

    let socket_path = fixture.workspace.join("listener.sock");
    let unix = UnixListener::bind(&socket_path).unwrap();
    unix.set_nonblocking(true).unwrap();
    let unix_output = fixture.run(&format!("/usr/bin/nc -zU {}", shell_quote(&socket_path)));
    assert_ne!(unix_output["exit_code"], 0);
    assert_eq!(unix.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
    fixture.assert_scratch_cleaned();
}

#[test]
fn denies_keychain_apple_events_launchd_and_app_launching() {
    let fixture = ShellFixture::new();
    let commands = [
        "/usr/bin/security list-keychains -d user >/dev/null 2>&1",
        "/usr/bin/osascript -e 'tell application \"Finder\" to get name of startup disk' >/dev/null 2>&1",
        "/bin/launchctl print system >/dev/null 2>&1",
        "/usr/bin/open . >/dev/null 2>&1",
    ];

    for command in commands {
        let output = fixture.run(command);
        assert_ne!(
            output["exit_code"], 0,
            "ambient user-data channel was available: {command}"
        );
    }
    fixture.assert_scratch_cleaned();
}

#[test]
fn denies_signals_and_process_inspection_outside_the_sandbox() {
    let fixture = ShellFixture::new();
    let mut victim = HostChild::sleeping();
    let pid = victim.0.id();

    let signal = fixture.run(&format!("/bin/kill -0 {pid}"));
    assert_ne!(signal["exit_code"], 0);
    assert!(victim.0.try_wait().unwrap().is_none());

    let inspect = fixture.run(&format!("/bin/ps -p {pid} -o pid="));
    assert_ne!(inspect["exit_code"], 0);
    assert!(!inspect["stdout"]
        .as_str()
        .unwrap()
        .contains(&pid.to_string()));
    fixture.assert_scratch_cleaned();
}

#[test]
fn clears_parent_secrets_and_confines_home_and_tmpdir_to_scratch() {
    let fixture = ShellFixture::new();
    let secret_name = format!("HATCH_RED_TEAM_SECRET_{}", std::process::id());
    std::env::set_var(&secret_name, "must-not-cross-exec");
    let output = fixture.run("/usr/bin/env");
    std::env::remove_var(&secret_name);

    assert_eq!(output["exit_code"], 0);
    let environment = output["stdout"].as_str().unwrap();
    assert!(!environment.contains(&secret_name));
    assert!(!environment.contains("must-not-cross-exec"));
    assert!(environment.contains("PATH=/usr/bin:/bin:/usr/sbin:/sbin"));
    assert!(environment.contains("LANG=en_US.UTF-8"));
    assert!(environment.contains("HOME=<WORKSPACE>/.hatch-shell-tmp-"));
    assert!(environment.contains("TMPDIR=<WORKSPACE>/.hatch-shell-tmp-"));
    fixture.assert_scratch_cleaned();
}

#[test]
fn cancellation_kills_the_entire_shell_process_group_and_is_structured() {
    let fixture = ShellFixture::new();
    let started = fixture.workspace.join("started.txt");
    let delayed = fixture.workspace.join("must-not-appear.txt");
    let request = tool_request(
        "cancel_shell",
        format!(
            "(/bin/sleep 1; printf leaked > {}) & printf started > {}; /bin/sleep 30",
            shell_quote(&delayed),
            shell_quote(&started)
        ),
        30_000,
    );
    let runner = fixture.runner.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let worker =
        thread::spawn(move || runner.execute_tool_call_request_with_cancel(request, worker_cancel));

    wait_until_exists(&started, Duration::from_secs(5));
    cancel.store(true, Ordering::Release);
    let response = response_json(worker.join().unwrap());
    assert_eq!(response["status"], "error");
    assert_eq!(response["error"]["code"], "cancelled");
    assert_eq!(
        response["error"]["message"],
        "local tool execution was cancelled"
    );

    thread::sleep(Duration::from_millis(1_200));
    assert!(
        !delayed.exists(),
        "a cancelled background child survived its process group"
    );
    fixture.assert_scratch_cleaned();
}

#[test]
fn preserves_timeout_and_bounded_output_semantics() {
    let fixture = ShellFixture::new();
    let timeout = fixture.run_with_timeout("printf before-timeout; /bin/sleep 10", 100);
    assert_eq!(timeout["timed_out"], true);
    assert_eq!(timeout["stdout"], "before-timeout");

    let bounded = fixture.run_with_timeout("/usr/bin/yes x", 100);
    let stdout = bounded["stdout"].as_str().unwrap();
    let stderr = bounded["stderr"].as_str().unwrap();
    assert!(stdout.len() + stderr.len() <= 1024 * 1024);
    assert_eq!(bounded["timed_out"], true);
    assert_eq!(bounded["stdout_truncated"], true);
    fixture.assert_scratch_cleaned();
}

struct ShellFixture {
    root: TempDir,
    workspace: PathBuf,
    runner: LocalRunner,
}

impl ShellFixture {
    fn new() -> Self {
        let root = tempdir_in("/tmp").unwrap();
        let workspace = root.path().join("Workspace 'quoted' 空格");
        fs::create_dir(&workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let runner = LocalRunner::new(&workspace).unwrap();
        Self {
            root,
            workspace,
            runner,
        }
    }

    fn run(&self, command: &str) -> Value {
        self.run_with_timeout(command, SHELL_TIMEOUT_MS)
    }

    fn run_with_timeout(&self, command: &str, timeout_ms: u64) -> Value {
        let response = response_json(self.runner.execute_tool_call_request(tool_request(
            "red_team_shell",
            command.to_string(),
            timeout_ms,
        )));
        assert_eq!(
            response["status"], "ok",
            "shell tool failed before returning an exit status: {response}"
        );
        response["result"].clone()
    }

    fn assert_scratch_cleaned(&self) {
        let leaked = fs::read_dir(&self.workspace)
            .unwrap()
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".hatch-shell-tmp-"))
            .collect::<Vec<_>>();
        assert!(leaked.is_empty(), "per-call scratch leaked: {leaked:?}");
    }
}

fn tool_request(tool_call_id: &str, command: String, timeout_ms: u64) -> ToolCallRequest {
    ToolCallRequest {
        message_type: "tool_call.request".into(),
        run_id: "run_shell_red_team".into(),
        tool_call_id: tool_call_id.into(),
        name: "shell.exec".into(),
        arguments: json!({ "command": command, "timeout_ms": timeout_ms }),
        approval: Some("auto".into()),
    }
}

fn response_json(response: ToolCallResult) -> Value {
    serde_json::to_value(response).unwrap()
}

fn shell_quote(path: &Path) -> String {
    shell_quote_text(path.to_string_lossy().as_ref())
}

fn shell_quote_text(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\"'\"'"))
}

fn escape_for_awk(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn wait_until_exists(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {}", path.display());
}

struct HostChild(Child);

impl HostChild {
    fn sleeping() -> Self {
        Self(Command::new("/bin/sleep").arg("30").spawn().unwrap())
    }
}

impl Drop for HostChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
