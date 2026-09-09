#![cfg(target_os = "macos")]

use hatch_local_runner::{LocalRunner, ToolCallRequest, ToolCallResult};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::net::TcpListener;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::{tempdir_in, TempDir};

const SHELL_TIMEOUT_MS: u64 = 10_000;

#[test]
#[ignore = "requires HATCH_TEST_RUNTIME_ROOT pointing at a relocated bundled runtime"]
fn bundled_fontconfig_finds_chinese_fonts_inside_runner_sandbox() {
    let runtime = std::env::var_os("HATCH_TEST_RUNTIME_ROOT").expect("real runtime required");
    let workspace = tempfile::tempdir().unwrap();
    let runner =
        LocalRunner::new_with_runtime(workspace.path(), Some(Path::new(&runtime))).unwrap();
    let result = response_json(runner.execute_tool_call_request(tool_request(
        "bundled_fontconfig",
        r#"test "$FONTCONFIG_FILE" = "$FONTCONFIG_PATH/fonts.conf" && test "$XDG_CACHE_HOME" = "$TMPDIR" && "$HATCH_NATIVE_RUNTIME_ROOT/poppler/bin/fc-list" :lang=zh family > chinese-fonts.txt && test -s chinese-fonts.txt && /bin/cat chinese-fonts.txt"#.into(),
        120_000,
    )));
    assert_eq!(result["result"]["exit_code"], 0, "{result}");
    assert_eq!(result["result"]["timed_out"], false, "{result}");
    assert_eq!(result["result"]["stderr"], "", "{result}");
    let fonts = fs::read_to_string(workspace.path().join("chinese-fonts.txt")).unwrap();
    assert!(!fonts.trim().is_empty(), "{result}");
    println!("Bundled Fontconfig Chinese families: {fonts}");
}

#[test]
#[ignore = "requires relocated bundled runtime with working Poppler CJK mappings"]
fn bundled_poppler_renders_nonembedded_chinese_font_inside_runner_sandbox() {
    let runtime = std::env::var_os("HATCH_TEST_RUNTIME_ROOT").expect("real runtime required");
    let workspace = tempfile::tempdir().unwrap();
    let runner =
        LocalRunner::new_with_runtime(workspace.path(), Some(Path::new(&runtime))).unwrap();
    // Non-embedded CJK font deliberately requires real Fontconfig substitution.
    // This PDF is an automated integration fixture, not product/UAT content.
    let content = "BT /F1 28 Tf 36 90 Td <4E2D65875B574F536D4B8BD5> Tj ET\n";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>".to_owned(),
        "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>".to_owned(),
        "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 6 0 R /DW 1000 >>".to_owned(),
        "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>".to_owned(),
        format!("<< /Length {} >>\nstream\n{content}endstream", content.len()),
    ];
    let mut pdf = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
    }
    let xref = pdf.len();
    pdf.push_str("xref\n0 8\n0000000000 65535 f \n");
    for offset in offsets {
        pdf.push_str(&format!("{offset:010} 00000 n \n"));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    ));
    fs::write(workspace.path().join("chinese.pdf"), pdf).unwrap();
    let rendered = response_json(
        runner.execute_tool_call_request(tool_request(
            "bundled_fontconfig_render",
            r#""$HATCH_PDFINFO" chinese.pdf > chinese-info.txt &&
"$HATCH_PDFTOPPM" -f 1 -singlefile -r 96 -png chinese.pdf chinese &&
"$HATCH_PDFTOPPM" -f 1 -singlefile -r 96 -jpeg -jpegopt quality=95 chinese.pdf chinese &&
"$HATCH_PDFTOPPM" -f 1 -singlefile -r 96 -tiff chinese.pdf chinese &&
"$HATCH_PYTHON" -c '
from PIL import Image, ImageChops
import json
results = {}
for suffix, expected in [("png", "PNG"), ("jpg", "JPEG"), ("tif", "TIFF")]:
    with Image.open("chinese." + suffix) as image:
        image.load()
        assert image.format == expected, image.format
        rgb = image.convert("RGB")
        bbox = ImageChops.difference(rgb, Image.new("RGB", rgb.size, "white")).getbbox()
        assert bbox is not None, "blank " + expected
        assert rgb.size == (480, 214), rgb.size
        results[expected] = {"size": rgb.size, "ink_bbox": bbox}
        if expected == "TIFF": rgb.save("chinese-tiff-preview.png")
with open("image-checks.json", "w") as output: json.dump(results, output)
'"#
            .into(),
            120_000,
        )),
    );
    let png = fs::read(workspace.path().join("chinese.png")).unwrap();
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    println!("Bundled pdftoppm Chinese PNG: {} bytes", png.len());
    if let Some(output) = std::env::var_os("HATCH_TEST_FONTCONFIG_EVIDENCE_DIR") {
        let output = Path::new(&output);
        fs::create_dir_all(output).unwrap();
        for name in [
            "chinese.pdf",
            "chinese.png",
            "chinese.jpg",
            "chinese.tif",
            "chinese-tiff-preview.png",
            "image-checks.json",
            "chinese-info.txt",
        ] {
            fs::copy(workspace.path().join(name), output.join(name)).unwrap();
        }
        fs::write(output.join("render-result.json"), rendered.to_string()).unwrap();
    }
    assert_eq!(rendered["result"]["exit_code"], 0, "{rendered}");
    assert_eq!(rendered["result"]["timed_out"], false, "{rendered}");
    assert_eq!(rendered["result"]["stderr"], "", "{rendered}");
    println!(
        "Decoded format checks: {}",
        fs::read_to_string(workspace.path().join("image-checks.json")).unwrap()
    );
}

/// Explicit integration test against an actual installed/built runtime, not a mock.
#[test]
#[ignore = "requires HATCH_TEST_RUNTIME_ROOT pointing at a complete bundled runtime"]
fn bundled_document_render_runs_inside_runner_sandbox() {
    let runtime = std::env::var_os("HATCH_TEST_RUNTIME_ROOT")
        .expect("set HATCH_TEST_RUNTIME_ROOT to the real bundled runtime");
    let workspace = tempfile::tempdir().unwrap();
    let runner =
        LocalRunner::new_with_runtime(workspace.path(), Some(Path::new(&runtime))).unwrap();
    let command = r#""$HATCH_PYTHON" -c 'from docx import Document; d=Document(); d.add_paragraph("Hatch Runner rendering integration test"); d.save("probe.docx")' && "$HATCH_PYTHON" "$HATCH_DOCUMENT_SKILLS_ROOT/documents/scripts/render_docx.py" probe.docx --output-dir rendered"#;
    // Source-Skill integration is explicitly separate from installed-package
    // coverage. Copy only the repository Skill bundle into the test Workspace.
    let command = if std::env::var_os("HATCH_TEST_SOURCE_SKILLS").is_some() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime-server/skills");
        let destination = workspace.path().join("skills");
        for entry in walkdir::WalkDir::new(&source) {
            let entry = entry.unwrap();
            let target = destination.join(entry.path().strip_prefix(&source).unwrap());
            if entry.file_type().is_dir() {
                fs::create_dir_all(&target).unwrap();
            } else if entry.file_type().is_file() {
                fs::copy(entry.path(), target).unwrap();
            } else {
                panic!("Skill test bundle must contain only regular files/directories");
            }
        }
        command.replace("$HATCH_DOCUMENT_SKILLS_ROOT", "./skills")
    } else {
        command.to_owned()
    };
    let result = response_json(runner.execute_tool_call_request(tool_request(
        "bundled_render",
        command,
        120_000,
    )));
    assert_eq!(result["result"]["exit_code"], 0, "{result}");
    assert_eq!(result["result"]["timed_out"], false, "{result}");
    assert!(
        workspace.path().join("rendered/probe.pdf").is_file(),
        "{result}"
    );
    let pages: Vec<_> = fs::read_dir(workspace.path().join("rendered"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "png"))
        .collect();
    assert!(
        !pages.is_empty(),
        "render must produce visual previews: {result}"
    );
    for page in pages {
        assert!(fs::read(page.path())
            .unwrap()
            .starts_with(b"\x89PNG\r\n\x1a\n"));
    }
    for (format, command) in [
        (
            "pptx",
            r#""$HATCH_PYTHON" -c 'from pptx import Presentation; p=Presentation(); s=p.slides.add_slide(p.slide_layouts[0]); s.shapes.title.text="Hatch render integration"; p.save("slides.pptx")' && "$HATCH_PYTHON" "$HATCH_DOCUMENT_SKILLS_ROOT/presentations/scripts/pptx_tool.py" render slides.pptx --output-dir rendered-pptx"#,
        ),
        (
            "xlsx",
            r#""$HATCH_PYTHON" -c 'from openpyxl import Workbook; w=Workbook(); w.active["A1"]="Hatch render integration"; w.active["A2"]=42; w.save("sheet.xlsx")' && "$HATCH_PYTHON" "$HATCH_DOCUMENT_SKILLS_ROOT/spreadsheets/scripts/xlsx_tool.py" render sheet.xlsx --output-dir rendered-xlsx"#,
        ),
    ] {
        let command = if std::env::var_os("HATCH_TEST_SOURCE_SKILLS").is_some() {
            command.replace("$HATCH_DOCUMENT_SKILLS_ROOT", "./skills")
        } else {
            command.to_owned()
        };
        let result = response_json(runner.execute_tool_call_request(tool_request(
            &format!("render_{format}"),
            command,
            120_000,
        )));
        assert_eq!(result["result"]["exit_code"], 0, "{format}: {result}");
        assert_eq!(result["result"]["timed_out"], false, "{format}: {result}");
        let output = workspace.path().join(format!("rendered-{format}"));
        let mut pdfs = 0;
        let mut pngs = 0;
        for entry in fs::read_dir(output).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "pdf") {
                assert!(fs::read(&path).unwrap().starts_with(b"%PDF-"));
                pdfs += 1;
            }
            if path.extension().is_some_and(|ext| ext == "png") {
                assert!(fs::read(&path).unwrap().starts_with(b"\x89PNG\r\n\x1a\n"));
                pngs += 1;
            }
        }
        assert_eq!(pdfs, 1, "{format}: must produce one PDF");
        assert!(pngs > 0, "{format}: must produce page previews");
    }
    let command = r#""$HATCH_PYTHON" -c 'from openpyxl import Workbook; w=Workbook(); w.active["A1"]=42; w.active["A2"]="=A1+8"; w.save("formula.xlsx")' && "$HATCH_PYTHON" "$HATCH_DOCUMENT_SKILLS_ROOT/spreadsheets/scripts/recalc.py" formula.xlsx --output calculated.xlsx && "$HATCH_PYTHON" -c 'from openpyxl import load_workbook; assert load_workbook("calculated.xlsx", data_only=True).active["A2"].value == 50; assert load_workbook("calculated.xlsx", data_only=False).active["A2"].value == "=A1+8"; assert load_workbook("formula.xlsx", data_only=True).active["A2"].value is None'"#;
    let command = if std::env::var_os("HATCH_TEST_SOURCE_SKILLS").is_some() {
        command.replace("$HATCH_DOCUMENT_SKILLS_ROOT", "./skills")
    } else {
        command.to_owned()
    };
    let result = response_json(runner.execute_tool_call_request(tool_request(
        "recalculate_xlsx",
        command,
        120_000,
    )));
    assert_eq!(result["result"]["exit_code"], 0, "{result}");
    assert_eq!(result["result"]["timed_out"], false, "{result}");
}

#[test]
fn allows_workspace_io_and_interpreters_but_redacts_the_canonical_path() {
    let fixture = ShellFixture::new();
    let output = fixture.run(
        "printf inside > notes.txt && /bin/sh -c 'printf child >> notes.txt' && \
         /usr/bin/awk 'BEGIN { print \"awk\" }' >> notes.txt && /bin/cat notes.txt && /bin/pwd",
    );

    assert_eq!(output["exit_code"], 0, "{output}");
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

    assert_eq!(output["exit_code"], 0, "{output}");
    let environment = output["stdout"].as_str().unwrap();
    assert!(!environment.contains(&secret_name));
    assert!(!environment.contains("must-not-cross-exec"));
    assert!(environment.contains("PATH=/usr/bin:/bin:/usr/sbin:/sbin"));
    assert!(environment.contains("LANG=en_US.UTF-8"));
    assert!(environment.contains("HOME=<SCRATCH>"));
    assert!(environment.contains("TMPDIR=<SCRATCH>"));
    fixture.assert_scratch_cleaned();
}

#[test]
fn closes_unrelated_parent_file_and_connected_socket_descriptors_at_spawn() {
    let fixture = ShellFixture::new();
    fixture.install_process_fixture();
    let outside = fixture.root.path().join("preopened-outside.txt");
    fs::write(&outside, "preopened-secret-must-not-cross-exec").unwrap();
    let outside_file = File::open(&outside).unwrap();
    clear_close_on_exec(outside_file.as_raw_fd());

    let (mut host_socket, inherited_socket) = UnixStream::pair().unwrap();
    clear_close_on_exec(inherited_socket.as_raw_fd());
    host_socket.set_nonblocking(true).unwrap();

    let output = fixture.run(&format!(
        "./process-escape-fixture probe-inherited-fds {} {}",
        outside_file.as_raw_fd(),
        inherited_socket.as_raw_fd()
    ));
    let stdout = output["stdout"].as_str().unwrap();
    assert!(stdout.contains("inherited-file-descriptor-closed"));
    assert!(stdout.contains("inherited-socket-descriptor-closed"));
    assert!(!stdout.contains("preopened-secret-must-not-cross-exec"));
    assert!(!stdout.contains("inherited-socket-write-succeeded"));

    let mut buffer = [0u8; 64];
    assert_eq!(
        host_socket.read(&mut buffer).unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
    fixture.assert_scratch_cleaned();
}

#[test]
fn scratch_is_runner_private_immovable_and_cleaned_after_hostile_permissions() {
    let fixture = ShellFixture::new();
    let output = fixture.run(
        "printf %s \"$TMPDIR\" > scratch-path.txt; \
         if /bin/mv \"$TMPDIR\" retained-scratch >/dev/null 2>&1; then printf moved; else printf move-denied; fi; \
         /bin/mkdir \"$TMPDIR/locked\"; /bin/mkdir \"$TMPDIR/locked/nested\"; \
         printf temporary > \"$TMPDIR/locked/nested/value\"; \
         if /bin/chflags uchg \"$TMPDIR/locked/nested/value\" >/dev/null 2>&1; then printf flags-allowed; fi; \
         /bin/chmod 000 \"$TMPDIR/locked/nested\" \"$TMPDIR/locked\"",
    );
    assert_eq!(output["exit_code"], 0, "{output}");
    assert_eq!(output["stdout"], "move-denied");
    let scratch_path =
        PathBuf::from(fs::read_to_string(fixture.workspace.join("scratch-path.txt")).unwrap());
    assert!(!scratch_path.starts_with(&fixture.workspace));
    assert!(!scratch_path.exists(), "scratch survived cleanup");
    assert!(!fixture.workspace.join("retained-scratch").exists());
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
    assert_eq!(response["error"]["code"], "cancelled", "{response}");
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
fn seatbelt_denies_new_sessions_and_process_groups_and_cancel_leaves_no_escapee() {
    let fixture = ShellFixture::new();
    fixture.install_process_fixture();

    let probes = fixture.run(
        "./process-escape-fixture probe-escape setsid; \
         ./process-escape-fixture probe-escape setpgid; \
         ./process-escape-fixture probe-spawn-pgroup",
    );
    let stdout = probes["stdout"].as_str().unwrap();
    assert!(stdout.contains("escape-denied:setsid"), "{probes}");
    assert!(stdout.contains("escape-denied:setpgid"), "{probes}");
    assert!(stdout.contains("spawn-pgroup-denied"), "{probes}");
    assert!(!stdout.contains("spawn-pgroup-allowed"), "{probes}");
    assert!(!stdout.contains("escape-allowed"), "{probes}");

    let started = fixture.workspace.join("escape-probes-started.txt");
    let setsid_marker = fixture.workspace.join("setsid-survived.txt");
    let setpgid_marker = fixture.workspace.join("setpgid-survived.txt");
    let spawn_marker = fixture.workspace.join("spawn-pgroup-survived.txt");
    let request = tool_request(
        "cancel_escape_probes",
        format!(
            "./process-escape-fixture spawn-escape-then-write {}; \
             ./process-escape-fixture escape-then-write setsid {} & \
             ./process-escape-fixture escape-then-write setpgid {} & \
             printf started > {}; /bin/sleep 30",
            shell_quote(&spawn_marker),
            shell_quote(&setsid_marker),
            shell_quote(&setpgid_marker),
            shell_quote(&started),
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
    assert_eq!(response["error"]["code"], "cancelled", "{response}");

    thread::sleep(Duration::from_millis(1_100));
    assert!(
        !setsid_marker.exists(),
        "setsid escape survived cancellation"
    );
    assert!(
        !setpgid_marker.exists(),
        "setpgid escape survived cancellation"
    );
    assert!(
        !spawn_marker.exists(),
        "posix_spawn process-group escape survived cancellation"
    );
    fixture.assert_scratch_cleaned();
}

#[test]
fn explicitly_denies_system_account_data_while_system_binaries_still_work() {
    let fixture = ShellFixture::new();
    for path in [
        "/private/etc/passwd",
        "/private/etc/master.passwd",
        "/private/etc/group",
        "/private/etc/sudoers",
    ] {
        if !Path::new(path).exists() {
            continue;
        }
        let output = fixture.run(&format!("/bin/cat {}", shell_quote(Path::new(path))));
        assert_ne!(
            output["exit_code"], 0,
            "system account file was readable: {path}"
        );
        assert_eq!(output["stdout"], "", "system account data escaped: {path}");
    }

    let normal = fixture
        .run("printf normal-system-binary | /usr/bin/awk '{ print $1 }' | /usr/bin/tr a-z A-Z");
    assert_eq!(normal["exit_code"], 0);
    assert_eq!(normal["stdout"], "NORMAL-SYSTEM-BINARY\n");
    fixture.assert_scratch_cleaned();
}

#[test]
fn best_effort_output_filter_covers_direct_file_url_hex_and_base64_paths() {
    let fixture = ShellFixture::new();
    let output = fixture.run(
        "printf 'direct=%s\\nfile-url=file://%s\\n' \"$PWD\" \"$PWD\"; \
         printf hex=; printf %s \"$PWD\" | /usr/bin/xxd -p | /usr/bin/tr -d '\\n'; printf '\\n'; \
         printf base64=; printf %s \"$PWD\" | /usr/bin/base64",
    );
    assert_eq!(output["exit_code"], 0);
    let stdout = output["stdout"].as_str().unwrap();
    assert!(!stdout.contains(fixture.workspace.to_string_lossy().as_ref()));
    assert!(stdout.contains("direct=<WORKSPACE>"));
    assert!(stdout.contains("file-url=<WORKSPACE>"));
    assert!(stdout.contains("hex=<WORKSPACE>"));
    assert!(stdout.contains("base64=<WORKSPACE>"));
    fixture.assert_scratch_cleaned();
}

#[test]
fn preserves_timeout_and_bounded_output_semantics() {
    let fixture = ShellFixture::new();
    // 100ms includes sandbox-exec/dyld/shell startup, so it cannot guarantee
    // that an initial printf ran on a loaded Intel CI host. Exercise the short
    // budget before deliberately delayed output here. Exact preservation of
    // already-written stdout AND stderr is tested with a readiness handshake
    // against the same production collector in shell::platform::tests.
    let timeout = fixture.run_with_timeout(
        "/bin/sleep 10; printf after-timeout; printf after-timeout-stderr >&2; : > timeout-escaped",
        100,
    );
    assert_eq!(timeout["timed_out"], true);
    assert_ne!(timeout["exit_code"], 0);
    assert_eq!(timeout["stdout"], "");
    assert_eq!(timeout["stderr"], "");
    assert!(!fixture.workspace.join("timeout-escaped").exists());

    // Output truncation must not depend on producing 1 MiB within 100ms on
    // a shared CI runner. Emit a finite 2 MiB and test timeout independently.
    let bounded = fixture.run_with_timeout(
        "/usr/bin/awk 'BEGIN { for (i = 0; i < 1048576; i++) print \"x\" }'",
        30_000,
    );
    let stdout = bounded["stdout"].as_str().unwrap();
    let stderr = bounded["stderr"].as_str().unwrap();
    assert!(stdout.len() + stderr.len() <= 1024 * 1024);
    assert_eq!(bounded["timed_out"], false);
    assert_eq!(bounded["exit_code"], 0);
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

    fn install_process_fixture(&self) {
        let destination = self.workspace.join("process-escape-fixture");
        fs::copy(compiled_process_fixture(), &destination).unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o755)).unwrap();
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

fn compiled_process_fixture() -> &'static Path {
    static COMPILED_FIXTURE: OnceLock<PathBuf> = OnceLock::new();
    COMPILED_FIXTURE
        .get_or_init(|| {
            let build_directory = tempfile::tempdir().unwrap().keep();
            let output = build_directory.join("process-escape-fixture");
            let source =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/process_escape.rs");
            let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
            let result = Command::new(rustc)
                .arg("--edition=2021")
                .arg(&source)
                .arg("-o")
                .arg(&output)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "could not compile red-team process fixture: {}",
                String::from_utf8_lossy(&result.stderr)
            );
            output
        })
        .as_path()
}

fn clear_close_on_exec(fd: i32) {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    assert_ne!(flags, -1);
    assert_ne!(
        unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) },
        -1
    );
    assert_eq!(
        unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
}

fn tool_request(tool_call_id: &str, command: String, timeout_ms: u64) -> ToolCallRequest {
    ToolCallRequest {
        message_type: "tool_call.request".into(),
        run_id: "run_shell_red_team".into(),
        tool_call_id: tool_call_id.into(),
        name: "shell_exec".into(),
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
