//! Test tool only. Never launched by Hatch, its runtime, or its installer.
use serde::Serialize;
use std::path::PathBuf;

#[cfg(windows)]
mod windows;

const USAGE: &str = "hatch-windows-sandbox-probe --opt-in --runtime-root <WINDOWS_BUNDLED_RUNTIME> [--mode lpac|appcontainer] [--timeout-seconds 120]\n\nWindows x64 only. Copies the runtime into a fresh temporary directory, grants ACLs ONLY there, creates/deletes a temporary AppContainer profile, and prints JSON. Never uses a host fallback. Exit 0 = every required check and cleanup passed; 1 = failure/inconclusive; 2 = invalid invocation/unsupported platform.";

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Lpac,
    Appcontainer,
}

#[derive(Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Options {
    runtime_root: PathBuf,
    mode: Mode,
    timeout_seconds: u64,
}

fn parse(args: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut args = args.into_iter();
    let mut opt_in = false;
    let mut runtime_root = None;
    let mut mode = Mode::Lpac;
    let mut timeout_seconds = 120;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--opt-in" => opt_in = true,
            "--runtime-root" => {
                runtime_root = Some(PathBuf::from(args.next().ok_or("Missing runtime root")?))
            }
            "--mode" => {
                mode = match args.next().as_deref() {
                    Some("lpac") => Mode::Lpac,
                    Some("appcontainer") => Mode::Appcontainer,
                    _ => return Err("Mode must be lpac or appcontainer".into()),
                }
            }
            "--timeout-seconds" => {
                timeout_seconds = args
                    .next()
                    .ok_or("Missing timeout")?
                    .parse()
                    .map_err(|_| "Invalid timeout")?;
                if !(1..=600).contains(&timeout_seconds) {
                    return Err("Timeout must be 1..600 seconds".into());
                }
            }
            _ => return Err(format!("Unknown argument: {arg}")),
        }
    }
    if !opt_in {
        return Err("Explicit --opt-in is required; nothing was created".into());
    }
    Ok(Options {
        runtime_root: runtime_root.ok_or("--runtime-root is required")?,
        mode,
        timeout_seconds,
    })
}

// CommandLineToArgvW/CRT-compatible argument quoting, not shell quoting.
// Commands are fixed scripts and argv; no user-provided command text is run.
#[cfg(any(windows, test))]
fn quote_arg(value: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
        } else {
            out.push_str(&"\\".repeat(slashes));
        }
        slashes = 0;
        out.push(ch);
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return;
    }
    let options = match parse(args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}\n{USAGE}");
            std::process::exit(2);
        }
    };
    #[cfg(not(windows))]
    {
        let _ = options;
        eprintln!("Unsupported platform: this probe only EXECUTES on Windows; no probe ran.");
        std::process::exit(2);
    }
    #[cfg(windows)]
    {
        let report = windows::run(options);
        println!(
            "{}",
            serde_json::to_string_pretty(&report).expect("serializable report")
        );
        if !report.passed {
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn opt_in_and_runtime_are_required() {
        assert!(parse(args(&["--runtime-root", "C:\\runtime"])).is_err());
        assert!(parse(args(&["--opt-in"])).is_err());
        let options = parse(args(&["--opt-in", "--runtime-root", "C:\\runtime"])).unwrap();
        assert_eq!(options.mode, Mode::Lpac);
        assert_eq!(options.runtime_root, PathBuf::from("C:\\runtime"));
        assert_eq!(options.timeout_seconds, 120);
        assert!(parse(args(&["--opt-in", "--runtime-root", "x", "--mode", "host"])).is_err());
    }
    #[test]
    fn quoting_preserves_unicode_quotes_and_trailing_backslashes() {
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("中文 directory"), "\"中文 directory\"");
        assert_eq!(quote_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_arg("C:\\folder\\"), "\"C:\\folder\\\\\"");
    }
}
