use hatch_local_runner::{
    EntryKind, LocalRunner, LocalRunnerError, ToolCallRequest, ToolCallResult,
    MAX_TOOL_RESULT_BYTES,
};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tempfile::tempdir;

#[test]
fn writes_reads_appends_and_audits_tool_calls() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    runner
        .write_file("notes/lorem.txt", "Lorem ipsum for Person A.")
        .unwrap();
    runner
        .append_file("notes/lorem.txt", "\nDolor sit amet.")
        .unwrap();

    let content = runner.read_file("notes/lorem.txt").unwrap();
    assert_eq!(content, "Lorem ipsum for Person A.\nDolor sit amet.");

    let audit = fs::read_to_string(runner.audit_path()).unwrap();
    let events: Vec<Value> = audit
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0]["tool"], "write_file");
    assert_eq!(events[1]["tool"], "append_file");
    assert_eq!(events[2]["tool"], "read");
    assert_eq!(events[0]["outcome"], "success");
}

#[test]
fn rejects_paths_that_escape_the_sandbox() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    let err = runner.write_file("../outside.txt", "Person A").unwrap_err();
    assert!(matches!(err, LocalRunnerError::PathEscapesSandbox(_)));

    let audit = fs::read_to_string(runner.audit_path()).unwrap();
    assert!(audit.contains("\"outcome\":\"failure\""));
    assert!(audit.contains("path escapes sandbox"));
}

#[test]
fn lists_stats_copies_and_moves_files() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    runner
        .write_file("inbox/source.txt", "Lorem ipsum for Person B.")
        .unwrap();
    runner
        .copy("inbox/source.txt", "outputs/copy.txt", false)
        .unwrap();
    runner
        .move_path("outputs/copy.txt", "outputs/final.txt", false)
        .unwrap();

    let entries = runner.list("outputs").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "outputs/final.txt");
    assert_eq!(entries[0].kind, EntryKind::File);

    let stat = runner.stat("outputs/final.txt").unwrap();
    assert_eq!(stat.kind, EntryKind::File);
    assert_eq!(stat.len, "Lorem ipsum for Person B.".len() as u64);
}

#[test]
fn move_cannot_delete_directory_via_overwrite() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    runner
        .write_file("inbox/source.txt", "Lorem ipsum.")
        .unwrap();
    fs::create_dir_all(temp.path().join("outputs/existing")).unwrap();
    fs::write(temp.path().join("outputs/existing/keep.txt"), "keep").unwrap();

    let err = runner
        .move_path("inbox/source.txt", "outputs/existing", true)
        .unwrap_err();

    assert!(matches!(err, LocalRunnerError::ExpectedFile(_)));
    assert_eq!(
        fs::read_to_string(temp.path().join("outputs/existing/keep.txt")).unwrap(),
        "keep"
    );
}

#[test]
fn searches_utf8_files_with_synthetic_placeholders() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    runner
        .write_file("inbox/a.txt", "Lorem ipsum\nPerson A likes hatch notes.")
        .unwrap();
    runner
        .write_file("inbox/b.txt", "Dolor sit amet\nPerson B keeps a list.")
        .unwrap();

    let matches = runner.search("inbox", "Person A", 10).unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].path, "inbox/a.txt");
    assert_eq!(matches[0].line_number, 2);
}

#[test]
fn search_matches_workspace_relative_file_paths() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    runner
        .write_file(
            "legal-samples/acme-analytics-saas-agreement.md",
            "# SaaS Agreement\nNo filename appears in this content.",
        )
        .unwrap();

    let matches = runner
        .search(".", "acme-analytics-saas-agreement", 10)
        .unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(
        matches[0].path,
        "legal-samples/acme-analytics-saas-agreement.md"
    );
    assert_eq!(matches[0].line_number, 0);
    assert_eq!(matches[0].line, "path match");
}

#[test]
fn applies_append_and_replace_patches() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    runner
        .apply_patch(
            "sessions/note.txt",
            "HATCH-PATCH v1\nappend\n---\nLorem ipsum for Person A.",
        )
        .unwrap();
    runner
        .apply_patch(
            "sessions/note.txt",
            "HATCH-PATCH v1\nreplace\n--- old\nPerson A\n--- new\nPerson C",
        )
        .unwrap();

    let content = runner.read_file("sessions/note.txt").unwrap();
    assert_eq!(content, "Lorem ipsum for Person C.");
}

#[test]
fn rejects_ambiguous_replace_patch() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    runner
        .write_file("state/names.txt", "Person A\nPerson A\n")
        .unwrap();
    let err = runner
        .apply_patch(
            "state/names.txt",
            "HATCH-PATCH v1\nreplace\n--- old\nPerson A\n--- new\nPerson D",
        )
        .unwrap_err();

    assert!(matches!(
        err,
        LocalRunnerError::PatchAmbiguousReplacement(2)
    ));
}

#[cfg(unix)]
#[test]
fn rejects_symlink_write_escape() {
    use std::os::unix::fs::symlink;

    let temp = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let outside_file = outside.path().join("outside.txt");
    fs::write(&outside_file, "outside Person A").unwrap();
    symlink(&outside_file, temp.path().join("link.txt")).unwrap();

    let runner = LocalRunner::new(temp.path()).unwrap();
    let err = runner.append_file("link.txt", " mutated").unwrap_err();

    assert!(matches!(err, LocalRunnerError::PathEscapesSandbox(_)));
    assert_eq!(
        fs::read_to_string(outside_file).unwrap(),
        "outside Person A"
    );
}

#[test]
fn reserves_root_audit_jsonl_from_tool_access() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    let err = runner.write_file("audit.jsonl", "tamper").unwrap_err();
    assert!(matches!(err, LocalRunnerError::ReservedPath(_)));
}

#[test]
fn listing_root_hides_audit_jsonl() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    runner
        .write_file("notes/lorem.txt", "Lorem ipsum.")
        .unwrap();

    let entries = runner.list(".").unwrap();
    assert!(entries.iter().any(|entry| entry.path == "notes"));
    assert!(!entries.iter().any(|entry| entry.path == "audit.jsonl"));
}

#[test]
fn search_root_does_not_return_audit_log_contents() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    runner
        .write_file("notes/lorem.txt", "Lorem ipsum.")
        .unwrap();

    let matches = runner.search(".", "write_file", 10).unwrap();
    assert!(matches.is_empty());
}

#[test]
fn executes_canonical_tool_call_requests_for_filesystem_tools() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    let write = runner.execute_tool_call_request(tool_request(
        "call_write",
        "fs.write",
        json!({
            "path": "notes/hatch.txt",
            "content": "Hatch routes local tools through Rust.\n"
        }),
    ));
    assert_ok_result(write, |result| {
        assert_eq!(result["ok"], true);
        assert_eq!(result["path"], "notes/hatch.txt");
        let diff = result["diff"].as_str().unwrap();
        assert!(diff.contains("--- /dev/null"));
        assert!(diff.contains("+++ b/notes/hatch.txt"));
        assert!(diff.contains("+Hatch routes local tools through Rust."));
    });

    let read = runner.execute_tool_call_request(tool_request(
        "call_read",
        "fs.read",
        json!({ "path": "notes/hatch.txt" }),
    ));
    assert_ok_result(read, |result| {
        assert_eq!(
            result["content"],
            "Hatch routes local tools through Rust.\n"
        );
    });

    let search = runner.execute_tool_call_request(tool_request(
        "call_search",
        "fs.search",
        json!({ "path": ".", "query": "Rust", "max_results": 5 }),
    ));
    assert_ok_result(search, |result| {
        let matches = result["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["path"], "notes/hatch.txt");
        assert_eq!(matches[0]["line_number"], 1);
        assert_eq!(matches[0]["text"], "Hatch routes local tools through Rust.");
    });

    let list = runner.execute_tool_call_request(tool_request(
        "call_list",
        "fs.list",
        json!({ "path": "notes" }),
    ));
    assert_ok_result(list, |result| {
        let entries = result["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["path"], "notes/hatch.txt");
        assert_eq!(entries[0]["kind"], "file");
    });
}

#[test]
fn canonical_fs_read_extracts_xlsx_text_without_shelling_out() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    let workbook_path = temp.path().join("2024 Birthday Dinner.xlsx");
    let mut workbook = rust_xlsxwriter::Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet.write_string(0, 0, "Guest").unwrap();
    worksheet.write_string(0, 1, "Dish").unwrap();
    worksheet.write_string(1, 0, "Alice").unwrap();
    worksheet.write_string(1, 1, "Noodles").unwrap();
    workbook.save(&workbook_path).unwrap();

    let read = runner.execute_tool_call_request(tool_request(
        "call_xlsx_read",
        "fs.read",
        json!({ "path": "2024 Birthday Dinner.xlsx" }),
    ));

    assert_ok_result(read, |result| {
        let content = result["content"].as_str().unwrap();
        assert!(content.contains("# Sheet: Sheet1"));
        assert!(content.contains("Guest\tDish"));
        assert!(content.contains("Alice\tNoodles"));
    });
}

#[test]
fn fs_read_enforces_one_mib_boundary_for_utf8_files() {
    const MAX_READ_BYTES: usize = 1024 * 1024;
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    let suffix = "中文";
    let exact_prefix = "a".repeat(MAX_READ_BYTES - suffix.len());
    fs::write(
        temp.path().join("exact-utf8.txt"),
        format!("{exact_prefix}{suffix}"),
    )
    .unwrap();
    fs::write(
        temp.path().join("over-utf8.txt"),
        format!("{exact_prefix}{suffix}x"),
    )
    .unwrap();

    let exact = runner.execute_tool_call_request(tool_request(
        "call_exact_utf8",
        "fs.read",
        json!({ "path": "exact-utf8.txt" }),
    ));
    assert_ok_result(exact, |result| {
        let content = result["content"].as_str().unwrap();
        assert_eq!(content.len(), MAX_READ_BYTES);
        assert!(content.ends_with(suffix));
    });

    let over = runner.execute_tool_call_request(tool_request(
        "call_over_utf8",
        "fs.read",
        json!({ "path": "over-utf8.txt" }),
    ));
    assert_error_result(over, |error| {
        assert_eq!(error["code"], "file_too_large");
        assert!(error["message"].as_str().unwrap().contains("1048577"));
    });
}

#[test]
fn xlsx_rendered_output_rejects_over_limit_without_truncating() {
    const CELL_BYTES: usize = 30_000;
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    let cell = "x".repeat(CELL_BYTES);

    for (name, rows) in [("xlsx-under-limit.xlsx", 34), ("xlsx-over-limit.xlsx", 36)] {
        let path = temp.path().join(name);
        let mut workbook = rust_xlsxwriter::Workbook::new();
        let worksheet = workbook.add_worksheet();
        for row in 0..rows {
            worksheet.write_string(row, 0, &cell).unwrap();
        }
        workbook.save(path).unwrap();
    }

    let under = runner.execute_tool_call_request(tool_request(
        "call_xlsx_under",
        "fs.read",
        json!({ "path": "xlsx-under-limit.xlsx" }),
    ));
    assert_ok_result(under, |result| {
        assert!(result["content"].as_str().unwrap().len() <= 1024 * 1024);
    });

    let over = runner.execute_tool_call_request(tool_request(
        "call_xlsx_over",
        "fs.read",
        json!({ "path": "xlsx-over-limit.xlsx" }),
    ));
    assert_error_result(over, |error| {
        assert_eq!(error["code"], "file_too_large");
        assert!(error["message"]
            .as_str()
            .unwrap()
            .contains("rendered spreadsheet output"));
    });
}

#[test]
fn canonical_tool_call_result_reports_sandbox_errors() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    let result = runner.execute_tool_call_request(tool_request(
        "call_escape",
        "fs.read",
        json!({ "path": "../outside.txt" }),
    ));

    assert_error_result(result, |error| {
        assert_eq!(error["code"], "tool_failed");
        assert!(error["message"]
            .as_str()
            .unwrap()
            .contains("path escapes sandbox"));
    });
}

#[test]
fn canonical_tool_call_result_rejects_unknown_local_tools() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    let result =
        runner.execute_tool_call_request(tool_request("call_unknown", "unknown.tool", json!({})));

    assert_error_result(result, |error| {
        assert_eq!(error["code"], "invalid_tool_call");
        assert!(error["message"]
            .as_str()
            .unwrap()
            .contains("unsupported local tool: unknown.tool"));
    });
}

#[cfg(target_os = "macos")]
#[test]
fn canonical_shell_exec_runs() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    let result = runner.execute_tool_call_request(tool_request(
        "call_shell",
        "shell.exec",
        json!({
            "command": "printf shell-ok",
            "timeout_ms": 30000
        }),
    ));
    assert_ok_result(result, |output| {
        assert_eq!(output["stdout"], "shell-ok");
        assert_eq!(output["exit_code"], 0);
        assert_eq!(output["timed_out"], false);
    });
}

#[cfg(not(target_os = "macos"))]
#[test]
fn shell_exec_fails_closed_without_a_supported_sandbox_backend() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    let result = runner.execute_tool_call_request(tool_request(
        "call_shell_unsupported",
        "shell.exec",
        json!({ "command": "printf unsafe", "timeout_ms": 30000 }),
    ));
    assert_error_result(result, |error| {
        assert_eq!(error["code"], "shell_sandbox_unavailable");
        assert!(error["message"].as_str().unwrap().contains("refusing"));
    });
}

#[test]
fn pre_cancelled_tool_call_returns_a_structured_cancellation() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    let cancel = Arc::new(AtomicBool::new(true));
    assert!(cancel.load(Ordering::Acquire));
    let result = runner.execute_tool_call_request_with_cancel(
        tool_request("call_cancelled", "fs.list", json!({ "path": "." })),
        cancel,
    );
    assert_error_result(result, |error| {
        assert_eq!(error["code"], "cancelled");
        assert_eq!(error["message"], "local tool execution was cancelled");
    });
}

#[test]
fn shell_exec_rejects_timeouts_outside_the_runtime_contract() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    let result = runner.execute_tool_call_request(tool_request(
        "call_invalid_shell_timeout",
        "shell.exec",
        json!({ "command": "printf hatch", "timeout_ms": 99 }),
    ));
    assert_error_result(result, |error| {
        assert_eq!(error["code"], "invalid_tool_call")
    });
}

#[test]
fn rejects_absolute_and_parent_paths_for_all_file_mutations() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    for path in ["/tmp/escaped", "../escaped", "nested/../../escaped"] {
        let write = runner.execute_tool_call_request(tool_request(
            "call_bad_write",
            "fs.write",
            json!({ "path": path, "content": "no" }),
        ));
        assert_error_result(write, |error| assert_eq!(error["code"], "tool_failed"));
        let patch = runner.execute_tool_call_request(tool_request(
            "call_bad_patch",
            "fs.patch",
            json!({ "path": path, "patch": "HATCH-PATCH v1\nappend\n---\nno" }),
        ));
        assert_error_result(patch, |error| assert_eq!(error["code"], "tool_failed"));
    }
}

#[test]
fn oversized_tool_result_is_rejected_before_serialization() {
    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    for index in 0..60_000 {
        fs::write(temp.path().join(format!("entry-{index:05}.txt")), "content").unwrap();
    }

    let result = runner.execute_tool_call_request(tool_request(
        "call_large_list",
        "fs.list",
        json!({ "path": "." }),
    ));
    assert_error_result(result, |error| {
        assert_eq!(error["code"], "tool_result_too_large");
        assert!(error["message"]
            .as_str()
            .unwrap()
            .contains(&MAX_TOOL_RESULT_BYTES.to_string()));
    });
}

#[test]
fn canonical_git_diff_returns_workspace_diff() {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }

    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();
    run_git(temp.path(), &["init"]);
    runner.write_file("notes.txt", "first\n").unwrap();
    run_git(temp.path(), &["add", "notes.txt"]);
    runner.write_file("notes.txt", "second\n").unwrap();

    let result = runner.execute_tool_call_request(tool_request(
        "call_git_diff",
        "git.diff",
        json!({ "path": "notes.txt" }),
    ));

    assert_ok_result(result, |result| {
        let diff = result["diff"].as_str().unwrap();
        assert!(diff.contains("-first"));
        assert!(diff.contains("+second"));
    });
}

#[test]
fn sidecar_serve_processes_multiple_jsonl_tool_calls() {
    let temp = tempdir().unwrap();
    let binary = env!("CARGO_BIN_EXE_hatch-local-runner");
    let mut child = Command::new(binary)
        .arg("--sandbox")
        .arg(temp.path())
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(
            stdin,
            "{}",
            json!({
                "type": "tool_call.request",
                "run_id": "run_sidecar",
                "tool_call_id": "call_write",
                "name": "fs.write",
                "arguments": {
                    "path": "notes/sidecar.txt",
                    "content": "sidecar jsonl works\n"
                },
                "approval": "auto"
            })
        )
        .unwrap();
        writeln!(
            stdin,
            "{}",
            json!({
                "type": "tool_call.request",
                "run_id": "run_sidecar",
                "tool_call_id": "call_read",
                "name": "fs.read",
                "arguments": {
                    "path": "notes/sidecar.txt"
                },
                "approval": "auto"
            })
        )
        .unwrap();
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let lines = String::from_utf8(output.stdout).unwrap();
    let responses = lines
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();

    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["type"], "tool_call.result");
    assert_eq!(responses[0]["status"], "ok");
    assert_eq!(responses[0]["tool_call_id"], "call_write");
    assert!(responses[0]["result"]["diff"]
        .as_str()
        .unwrap()
        .contains("+sidecar jsonl works"));
    assert_eq!(responses[1]["tool_call_id"], "call_read");
    assert_eq!(responses[1]["result"]["content"], "sidecar jsonl works\n");
}

#[cfg(unix)]
#[test]
fn rejects_symlink_alias_to_audit_jsonl() {
    use std::os::unix::fs::symlink;

    let temp = tempdir().unwrap();
    let runner = LocalRunner::new(temp.path()).unwrap();

    runner
        .write_file("notes/lorem.txt", "Lorem ipsum.")
        .unwrap();
    symlink(runner.audit_path(), temp.path().join("audit-link.jsonl")).unwrap();

    let err = runner.read_file("audit-link.jsonl").unwrap_err();
    assert!(matches!(err, LocalRunnerError::ReservedPath(_)));
}

fn tool_request(tool_call_id: &str, name: &str, arguments: Value) -> ToolCallRequest {
    ToolCallRequest {
        message_type: "tool_call.request".into(),
        run_id: "run_protocol".into(),
        tool_call_id: tool_call_id.into(),
        name: name.into(),
        arguments,
        approval: Some("auto".into()),
    }
}

fn assert_ok_result(result: ToolCallResult, check: impl FnOnce(Value)) {
    match serde_json::to_value(result).unwrap() {
        value @ Value::Object(_) => {
            assert_eq!(value["type"], "tool_call.result");
            assert_eq!(value["status"], "ok");
            assert_eq!(value["run_id"], "run_protocol");
            check(value["result"].clone());
        }
        other => panic!("expected object result, got {other:?}"),
    }
}

fn assert_error_result(result: ToolCallResult, check: impl FnOnce(Value)) {
    match serde_json::to_value(result).unwrap() {
        value @ Value::Object(_) => {
            assert_eq!(value["type"], "tool_call.result");
            assert_eq!(value["status"], "error");
            assert_eq!(value["run_id"], "run_protocol");
            check(value["error"].clone());
        }
        other => panic!("expected object result, got {other:?}"),
    }
}

fn run_git(cwd: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}
