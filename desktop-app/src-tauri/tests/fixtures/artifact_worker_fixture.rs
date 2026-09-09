// Compiled only by scripts/test-artifact-workers.mjs using extracted production
// functions and the real Tauri async runtime. Native grant/OS presentation are
// test doubles; canonicalization and symlink checks use real temporary files.
use std::os::unix::{fs::symlink, process::ExitStatusExt};
use std::{
    cell::RefCell,
    future::Future,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

include!(env!("HATCH_ARTIFACT_COMMAND_SOURCE"));

#[derive(Clone)]
struct AppHandle {
    root: PathBuf,
    state: Arc<State>,
}
struct State {
    caller: std::thread::ThreadId,
    alive: AtomicBool,
    called: AtomicBool,
    fail: bool,
}
struct WorkspaceArtifactRequest {
    workspace_grant_id: String,
    relative_path: String,
}
struct ScopedWorkspaceGrant {
    path: PathBuf,
    state: Arc<State>,
    owner: std::thread::ThreadId,
}
impl Drop for ScopedWorkspaceGrant {
    fn drop(&mut self) {
        assert_eq!(self.owner, std::thread::current().id());
        self.state.alive.store(false, Ordering::SeqCst);
    }
}
thread_local! { static ACTION_STATE: RefCell<Option<Arc<State>>> = const { RefCell::new(None) }; }
fn resolve_scoped_workspace_grant(
    app: &AppHandle,
    grant: &str,
) -> Result<ScopedWorkspaceGrant, String> {
    assert_ne!(
        app.state.caller,
        std::thread::current().id(),
        "grant/FS resolution ran on caller thread"
    );
    if grant != "authorized" {
        return Err("workspace_grant_revoked".into());
    }
    app.state.alive.store(true, Ordering::SeqCst);
    ACTION_STATE.with(|slot| *slot.borrow_mut() = Some(app.state.clone()));
    Ok(ScopedWorkspaceGrant {
        path: app.root.clone(),
        state: app.state.clone(),
        owner: std::thread::current().id(),
    })
}
fn action() -> Result<(), String> {
    ACTION_STATE.with(|slot| {
        let state = slot.borrow();
        let state = state.as_ref().unwrap();
        assert_ne!(
            state.caller,
            std::thread::current().id(),
            "OS wait ran on caller thread"
        );
        assert!(
            state.alive.load(Ordering::SeqCst),
            "grant dropped before OS handoff"
        );
        state.called.store(true, Ordering::SeqCst);
        if state.fail {
            Err("test OS failure".into())
        } else {
            Ok(())
        }
    })
}
fn open_workspace_artifact_with_platform(_: &Path) -> Result<(), String> {
    action()
}
struct Command;
impl Command {
    fn new(_: &str) -> Self {
        Self
    }
    fn arg(self, _: impl AsRef<std::ffi::OsStr>) -> Self {
        self
    }
    fn status(self) -> std::io::Result<std::process::ExitStatus> {
        action()
            .map(|()| std::process::ExitStatus::from_raw(0))
            .map_err(std::io::Error::other)
    }
}
fn fixture(fail: bool) -> (AppHandle, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "artifact-worker-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("file.txt"), "artifact").unwrap();
    let state = Arc::new(State {
        caller: std::thread::current().id(),
        alive: AtomicBool::new(false),
        called: AtomicBool::new(false),
        fail,
    });
    (
        AppHandle {
            root: root.clone(),
            state,
        },
        root,
    )
}
fn run(app: &AppHandle, reveal: bool, grant: &str, relative: &str) -> Result<(), String> {
    let request = WorkspaceArtifactRequest {
        workspace_grant_id: grant.into(),
        relative_path: relative.into(),
    };
    let future: std::pin::Pin<Box<dyn Future<Output = Result<(), String>>>> = if reveal {
        Box::pin(reveal_workspace_artifact(app.clone(), request))
    } else {
        Box::pin(open_workspace_artifact(app.clone(), request))
    };
    tauri::async_runtime::block_on(future)
}

#[test]
fn both_commands_keep_fs_and_os_handoff_on_worker_and_drop_scope_there() {
    let (app, root) = fixture(false);
    for reveal in [true, false] {
        app.state.called.store(false, Ordering::SeqCst);
        run(&app, reveal, "authorized", "file.txt").unwrap();
        assert!(app.state.called.load(Ordering::SeqCst));
        assert!(!app.state.alive.load(Ordering::SeqCst));
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn path_and_grant_failures_never_reach_os_handoff() {
    let (app, root) = fixture(false);
    symlink("/etc/passwd", root.join("escape")).unwrap();
    for reveal in [true, false] {
        for (grant, relative) in [
            ("revoked", "file.txt"),
            ("authorized", "../escape"),
            ("authorized", "/etc/passwd"),
            ("authorized", "missing"),
            ("authorized", "escape"),
        ] {
            assert!(run(&app, reveal, grant, relative).is_err());
            assert!(!app.state.called.load(Ordering::SeqCst));
            assert!(!app.state.alive.load(Ordering::SeqCst));
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn os_failure_is_reported_and_scope_is_released() {
    let (app, root) = fixture(true);
    for reveal in [true, false] {
        assert!(run(&app, reveal, "authorized", "file.txt")
            .unwrap_err()
            .contains("test OS failure"));
        assert!(!app.state.alive.load(Ordering::SeqCst));
    }
    std::fs::remove_dir_all(root).unwrap();
}
